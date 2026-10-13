import { realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { isClaudeModelId } from "@guild/contracts";
import type {
  GuildEngine,
  GuildGrokPermissionMode,
  GuildGrokStartupSettings,
} from "@guild/contracts";
import {
  AdapterPinError,
  verifyClaudeAdapterPin,
  verifyCodexAdapterPin,
  type ClaudeAdapterPin,
  type CodexAdapterPin,
} from "./adapter-pin.js";
import { verifyCodexCorePin, type CodexCorePin } from "./codex-core-pin.js";
import { isMachOExecutableFile } from "./executable-pin.js";
import {
  GROK_ACP_PRODUCTION_ARGV,
  createGrokAcpProductionArgv,
} from "./grok-acp-profile.js";

/**
 * PC-ENG-001: one runtime package, two engines. An `EngineProfile` is everything the process
 * host and the ACP adapter need to know about an engine: how to build its argv, which
 * environment it may see, how its executable is pinned, whether Guild authenticates for it, which
 * ACP dialect it speaks and which Grok-only features exist for it (PC-FALLBACK-001).
 */

/** Wire differences between the official Grok agent and the ACP adapters (Claude, Codex). */
export type AcpDialect = "grok" | "claude" | "codex";

/** Every dialect but Grok's belongs to a user-installed ACP adapter that Guild does not authenticate for. */
export function isAdapterDialect(dialect: AcpDialect): boolean {
  return dialect !== "grok";
}

/**
 * `macho-binary`: the engine is one Mach-O executable, copied to a private stage and verified by
 * SHA-256. `node-script`: the pinned executable is `node` (same Mach-O pin) and argv[0] is an
 * adapter script that runs in place, verified by `ClaudeAdapterPin` before every spawn.
 */
export type EnginePinStrategy = "macho-binary" | "node-script";

/** `auto-single`: authenticate when exactly one method is advertised. `never`: Guild never authenticates. */
export type EngineAuthPolicy = "auto-single" | "never";

export type EngineFeatureFlags = Readonly<{
  /** `_x.ai/usage` account billing. */
  billing: boolean;
  /** Mid-turn Steer. For Claude it additionally needs `_meta.steering.supported` at initialize. */
  steer: boolean;
  /** Conversation rewind (`_x.ai/rewind/*`). */
  conversationRewind: boolean;
  /** Allowlisted `_x.ai/*` notifications. */
  xaiSignals: boolean;
  /** Turns the runtime starts itself (for example the interject fallback). */
  agentInitiatedTurns: boolean;
}>;

export type EnvironmentPolicy = Readonly<{
  version: string;
  allowedKeys: ReadonlySet<string>;
  allowedKeyPrefixes: readonly string[];
  deniedKeys: ReadonlySet<string>;
  deniedKeyPrefixes: readonly string[];
  /** Home-relative directories appended to PATH before the system fallback. */
  pathHomeDirectories: readonly string[];
  /** Guild-owned values, never inherited from the parent. */
  fixedValues: Readonly<Record<string, string>>;
  /** Force NO_PROXY / no_proxy to include 127.0.0.1 and localhost. */
  loopbackNoProxy: boolean;
  /** Fill USER from the account database when the parent environment has none. */
  ensureUser: boolean;
  /** Keys a caller may add per spawn, each with its value validator. Anything else is rejected. */
  perSpawnKeys: Readonly<Record<string, (value: string) => boolean>>;
}>;

export type GrokLaunch = Readonly<{
  engine: "grok";
  /** Process-level settings; the model and effort are applied per session. */
  runtimeSettings?: Readonly<{
    permissionMode: GuildGrokPermissionMode;
    startup?: GuildGrokStartupSettings;
  }>;
}>;

export type ClaudeLaunch = Readonly<{
  engine: "claude";
  adapter: ClaudeAdapterPin;
  /** Real path of the located `claude` binary; becomes CLAUDE_CODE_EXECUTABLE. */
  claudeExecutablePath: string;
  /**
   * Per-spawn variables of a routed session (see `CLAUDE_PER_SPAWN_ENVIRONMENT`). Keys outside the profile
   * allowlist are rejected.
   */
  extraEnvironment?: Readonly<Record<string, string>>;
}>;

export type CodexLaunch = Readonly<{
  engine: "codex";
  adapter: CodexAdapterPin;
  /** The Codex core the adapter ships; becomes CODEX_PATH, so the checked file is the one that runs. */
  core: CodexCorePin;
}>;

export type EngineLaunch = GrokLaunch | ClaudeLaunch | CodexLaunch;

export type EngineLaunchPlan = Readonly<{
  argv: readonly string[];
  environmentPolicyVersion: string;
  buildEnvironment: (
    baseEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  ) => Readonly<Record<string, string>>;
  /** Extra checks run immediately before spawn; a throw becomes a preflight failure. */
  verifyBeforeSpawn?: () => Promise<void>;
  /** Values that must never appear in diagnostics (for example a token-bearing URL). */
  redactValues: readonly string[];
}>;

export type EngineProfile = Readonly<{
  engine: GuildEngine;
  dialect: AcpDialect;
  pinStrategy: EnginePinStrategy;
  authPolicy: EngineAuthPolicy;
  features: EngineFeatureFlags;
  environment: EnvironmentPolicy;
  /** argv after the pinned executable. */
  buildArgv: (launch: EngineLaunch) => readonly string[];
  /** Validates `launch` against the profile and composes the spawn plan. Throws TypeError on invalid input. */
  planLaunch: (launch: EngineLaunch) => EngineLaunchPlan;
}>;

const MACOS_FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHARED_DENIED_KEYS = Object.freeze([
  "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "BASH_ENV", "ENV", "ZDOTDIR",
] as const);
const SHARED_ALLOWED_KEYS = Object.freeze([
  "PATH", "LANG", "TMPDIR", "TMP", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "SSH_AUTH_SOCK",
] as const);

/** The throwaway auth token a routed session carries: `guild-router-` and 32 random hex characters. */
const ROUTED_AUTH_TOKEN_PATTERN = /^guild-router-[0-9a-f]{32}$/u;

export const GROK_ENVIRONMENT_POLICY_VERSION = "macos-posix-v3";
export const CLAUDE_ENVIRONMENT_POLICY_VERSION = "macos-posix-claude-v1";
export const CODEX_ENVIRONMENT_POLICY_VERSION = "macos-posix-codex-v1";

/**
 * Grok: OpenViking memory is for Claude Code and Codex only (owner decision, 2026-10-10), but grok
 * imports the OpenViking Claude plugin. The fixed values below turn every plugin hook into a
 * no-op (no recall, no capture), point its config files at nothing, and point its MCP proxy at a
 * closed local port, so a Guild Grok session can neither read nor write the memory store.
 * External Claude and Cursor instruction imports are switched off too.
 */
const GROK_OPENVIKING_OFF_ENVIRONMENT = Object.freeze({
  OPENVIKING_MEMORY_ENABLED: "0",
  OPENVIKING_CONFIG_FILE: "/dev/null",
  OPENVIKING_CLI_CONFIG_FILE: "/dev/null",
  OPENVIKING_URL: "http://127.0.0.1:9",
  OPENVIKING_BASE_URL: "http://127.0.0.1:9",
} as const);

const GROK_FIXED_ENVIRONMENT = Object.freeze({
  GROK_CLAUDE_AGENTS_ENABLED: "false",
  GROK_CLAUDE_RULES_ENABLED: "false",
  GROK_CURSOR_AGENTS_ENABLED: "false",
  GROK_CURSOR_RULES_ENABLED: "false",
  ...GROK_OPENVIKING_OFF_ENVIRONMENT,
} as const);

export const GROK_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  version: GROK_ENVIRONMENT_POLICY_VERSION,
  allowedKeys: new Set<string>([...SHARED_ALLOWED_KEYS, "LC_ALL", "LC_CTYPE"]),
  allowedKeyPrefixes: Object.freeze([]),
  deniedKeys: new Set<string>(SHARED_DENIED_KEYS),
  deniedKeyPrefixes: Object.freeze(["DYLD_", "LD_"]),
  pathHomeDirectories: Object.freeze([join(".grok", "bin"), join(".local", "bin")]),
  fixedValues: GROK_FIXED_ENVIRONMENT,
  loopbackNoProxy: false,
  ensureUser: false,
  perSpawnKeys: Object.freeze({}),
});

/**
 * Claude (docs/20 3.2): no OpenViking kill-switch block (D-060), nothing inherited that selects a
 * different endpoint, credential, binary or Node behaviour. A routed session adds exactly the
 * per-spawn keys below. ANTHROPIC_BASE_URL must stay on the loopback, and it always comes with a
 * throwaway ANTHROPIC_AUTH_TOKEN: with a base URL alone Claude Code sends its subscription token to that
 * URL, with an auth token it sends only that token (D-061). There is no key for ANTHROPIC_API_KEY.
 * The model variables keep Claude Code's background requests and subagents on the routed model instead
 * of a claude-* model, which the router refuses.
 *
 * USER and LOGNAME are allowed because Claude Code finds its login in the macOS Keychain by
 * account name: with USER missing `claude auth status` reports "not logged in" (verified with
 * claude 2.1.291 on 2026-10-12). They are identity names, not credentials.
 */
export const CLAUDE_PER_SPAWN_ENVIRONMENT: Readonly<Record<string, (value: string) => boolean>> = Object.freeze({
  ANTHROPIC_BASE_URL: isLoopbackHttpUrl,
  ANTHROPIC_AUTH_TOKEN: (value: string) => ROUTED_AUTH_TOKEN_PATTERN.test(value),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (value: string) => value === "1",
  ANTHROPIC_SMALL_FAST_MODEL: isClaudeModelId,
  CLAUDE_CODE_SUBAGENT_MODEL: isClaudeModelId,
  ENABLE_TOOL_SEARCH: (value: string) => /^(?:true|false|auto(?::\d{1,3})?)$/u.test(value),
  OPENVIKING_AUTO_CAPTURE: (value: string) => value === "true" || value === "false",
});

export const CLAUDE_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  version: CLAUDE_ENVIRONMENT_POLICY_VERSION,
  allowedKeys: new Set<string>([...SHARED_ALLOWED_KEYS, "USER", "LOGNAME"]),
  allowedKeyPrefixes: Object.freeze(["LC_"]),
  deniedKeys: new Set<string>(SHARED_DENIED_KEYS),
  deniedKeyPrefixes: Object.freeze(["DYLD_", "LD_", "ANTHROPIC_", "CLAUDE_CODE_"]),
  pathHomeDirectories: Object.freeze([join(".local", "bin")]),
  fixedValues: Object.freeze({}),
  loopbackNoProxy: true,
  ensureUser: true,
  perSpawnKeys: CLAUDE_PER_SPAWN_ENVIRONMENT,
});

/**
 * Codex (docs/21 4.1): the Claude allowlist, and nothing from the parent that selects a credential, a
 * provider, a state directory or the Codex binary (no `CODEX_*`, no `OPENAI_*`: the adapter reads
 * `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, `CODEX_PATH`, `CODEX_CONFIG`, `MODEL_PROVIDER` and
 * `DEFAULT_AUTH_REQUEST` from its environment, and the allowlist drops all of them). Guild-owned values: the
 * pinned core as `CODEX_PATH`, and OpenViking off. The Codex plugin ignores `OPENVIKING_MEMORY_ENABLED`, so recall
 * and capture have their own switches here, and the Grok block (config files to nothing, URLs to a closed
 * loopback port) keeps the plugin's MCP proxy from reaching the store as well.
 *
 * USER and LOGNAME are identity names, not credentials; they match what the login lookup of a user-installed
 * engine expects (verified with codex-acp 2.2.2: the clean environment of the spike carried both).
 */
const CODEX_FIXED_ENVIRONMENT = Object.freeze({
  ...GROK_OPENVIKING_OFF_ENVIRONMENT,
  OPENVIKING_AUTO_RECALL: "false",
  OPENVIKING_AUTO_CAPTURE: "false",
} as const);

export const CODEX_ENVIRONMENT_POLICY: EnvironmentPolicy = Object.freeze({
  version: CODEX_ENVIRONMENT_POLICY_VERSION,
  allowedKeys: new Set<string>([...SHARED_ALLOWED_KEYS, "USER", "LOGNAME"]),
  allowedKeyPrefixes: Object.freeze(["LC_"]),
  deniedKeys: new Set<string>(SHARED_DENIED_KEYS),
  deniedKeyPrefixes: Object.freeze(["DYLD_", "LD_", "CODEX_", "OPENAI_"]),
  pathHomeDirectories: Object.freeze([join(".local", "bin")]),
  fixedValues: CODEX_FIXED_ENVIRONMENT,
  loopbackNoProxy: true,
  ensureUser: true,
  perSpawnKeys: Object.freeze({}),
});

/**
 * The one environment builder: allowlist minus denylist from `baseEnvironment`, then HOME, PATH,
 * the policy's fixed values and finally validated per-spawn keys. Invalid keys or NUL bytes in
 * the parent environment throw without echoing values.
 */
export function buildEngineEnvironment(
  policy: EnvironmentPolicy,
  baseEnvironment: Readonly<Record<string, string | undefined>> = Object.freeze(Object.create(null) as Record<string, string>),
  extra?: Readonly<{
    fixedValues?: Readonly<Record<string, string>>;
    extraEnvironment?: Readonly<Record<string, string>>;
  }>,
): Readonly<Record<string, string>> {
  const result = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (key.length === 0 || key.includes("\0") || key.includes("=") || (value !== undefined && value.includes("\0"))) {
      throw new TypeError("child environment contains an invalid key or value");
    }
    if (value === undefined || isDeniedKey(policy, key) || !isAllowedKey(policy, key)) {
      continue;
    }
    result[key] = value;
  }
  const home = homedir();
  if (home.includes("\0")) {
    throw new TypeError("child environment contains an invalid key or value");
  }
  result.HOME = home;
  if (policy.ensureUser && (result.USER === undefined || result.USER.length === 0)) {
    const account = accountName();
    if (account !== undefined) result.USER = account;
  }
  result.PATH = mergeExecutableSearchPath(result.PATH, home, policy.pathHomeDirectories);
  if (policy.loopbackNoProxy) {
    const noProxy = [...new Set([
      "127.0.0.1",
      "localhost",
      ...splitList(result.NO_PROXY),
      ...splitList(result.no_proxy),
    ])].join(",");
    result.NO_PROXY = noProxy;
    result.no_proxy = noProxy;
  }
  Object.assign(result, policy.fixedValues, extra?.fixedValues);
  for (const [key, value] of Object.entries(extra?.extraEnvironment ?? {})) {
    result[key] = value;
  }
  return Object.freeze(result);
}

/** Rejects any per-spawn key outside the policy allowlist, and any value its validator refuses. */
export function assertPerSpawnEnvironment(
  policy: EnvironmentPolicy,
  extraEnvironment: Readonly<Record<string, string>> | undefined,
): void {
  for (const [key, value] of Object.entries(extraEnvironment ?? {})) {
    const validate = Object.hasOwn(policy.perSpawnKeys, key) ? policy.perSpawnKeys[key] : undefined;
    if (validate === undefined) {
      throw new TypeError(`environment key is not allowed per spawn: ${key.slice(0, 64)}`);
    }
    if (typeof value !== "string" || value.includes("\0") || !validate(value)) {
      throw new TypeError(`environment value is not valid for ${key}`);
    }
  }
}

function isAllowedKey(policy: EnvironmentPolicy, key: string): boolean {
  return policy.allowedKeys.has(key) || policy.allowedKeyPrefixes.some((prefix) => key.startsWith(prefix));
}

function isDeniedKey(policy: EnvironmentPolicy, key: string): boolean {
  return policy.deniedKeys.has(key) || policy.deniedKeyPrefixes.some((prefix) => key.startsWith(prefix));
}

function accountName(): string | undefined {
  try {
    const name = userInfo().username;
    return name.length > 0 && !name.includes("\0") && !name.includes("=") ? name : undefined;
  } catch {
    return undefined;
  }
}

function splitList(value: string | undefined): string[] {
  return (value?.split(",") ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function mergeExecutableSearchPath(
  environmentPath: string | undefined,
  homeDirectory: string,
  homeRelativeDirectories: readonly string[],
): string {
  const directories = [
    environmentPath,
    ...homeRelativeDirectories.map((directory) => join(homeDirectory, directory)),
    MACOS_FALLBACK_PATH,
  ]
    .flatMap((value) => value?.split(":") ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(directories)].join(":");
}

function isLoopbackHttpUrl(value: string): boolean {
  if (value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** Validated launch plan with an explicit argv: the Grok profile for the package-internal test seam. */
export function planGrokLaunchWithArgv(argv: readonly string[]): EngineLaunchPlan {
  return Object.freeze({
    argv: Object.freeze([...argv]),
    environmentPolicyVersion: GROK_ENVIRONMENT_POLICY.version,
    buildEnvironment: (base) => buildEngineEnvironment(GROK_ENVIRONMENT_POLICY, base),
    redactValues: Object.freeze([]),
  });
}

export const GROK_ENGINE_PROFILE: EngineProfile = Object.freeze({
  engine: "grok",
  dialect: "grok",
  pinStrategy: "macho-binary",
  authPolicy: "auto-single",
  features: Object.freeze({
    billing: true,
    steer: true,
    conversationRewind: true,
    xaiSignals: true,
    agentInitiatedTurns: true,
  }),
  environment: GROK_ENVIRONMENT_POLICY,
  buildArgv: (launch) => {
    const grok = requireLaunch(launch, "grok");
    return grok.runtimeSettings === undefined
      ? GROK_ACP_PRODUCTION_ARGV
      : createGrokAcpProductionArgv(grok.runtimeSettings);
  },
  planLaunch: (launch) => planGrokLaunchWithArgv(GROK_ENGINE_PROFILE.buildArgv(launch)),
});

export const CLAUDE_ENGINE_PROFILE: EngineProfile = Object.freeze({
  engine: "claude",
  dialect: "claude",
  pinStrategy: "node-script",
  authPolicy: "never",
  features: Object.freeze({
    billing: false,
    steer: true,
    conversationRewind: false,
    xaiSignals: false,
    agentInitiatedTurns: false,
  }),
  environment: CLAUDE_ENVIRONMENT_POLICY,
  buildArgv: (launch) => {
    const claude = requireLaunch(launch, "claude");
    if (!isAbsolute(claude.adapter.entryPath) || claude.adapter.entryPath.includes("\0")) {
      throw new TypeError("adapter entry path must be an absolute NUL-free path");
    }
    return Object.freeze([claude.adapter.entryPath]);
  },
  planLaunch: (launch) => {
    const claude = requireLaunch(launch, "claude");
    const argv = CLAUDE_ENGINE_PROFILE.buildArgv(claude);
    if (!isAbsolute(claude.claudeExecutablePath) || claude.claudeExecutablePath.includes("\0")) {
      throw new TypeError("claude executable path must be an absolute NUL-free path");
    }
    assertPerSpawnEnvironment(CLAUDE_ENVIRONMENT_POLICY, claude.extraEnvironment);
    // The routed base URL carries the router token in its path; the auth token is a secret of the same kind.
    const redactValues = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
      .map((key) => claude.extraEnvironment?.[key])
      .filter((value): value is string => value !== undefined);
    return Object.freeze({
      argv,
      environmentPolicyVersion: CLAUDE_ENVIRONMENT_POLICY.version,
      buildEnvironment: (base) => buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, base, {
        fixedValues: { CLAUDE_CODE_EXECUTABLE: claude.claudeExecutablePath },
        ...(claude.extraEnvironment === undefined ? {} : { extraEnvironment: claude.extraEnvironment }),
      }),
      verifyBeforeSpawn: async () => {
        await verifyClaudeAdapterPin(claude.adapter);
        await verifyClaudeExecutable(claude.claudeExecutablePath);
      },
      redactValues: Object.freeze(redactValues),
    });
  },
});

export const CODEX_ENGINE_PROFILE: EngineProfile = Object.freeze({
  engine: "codex",
  dialect: "codex",
  pinStrategy: "node-script",
  authPolicy: "never",
  features: Object.freeze({
    billing: false,
    steer: true,
    conversationRewind: false,
    xaiSignals: false,
    agentInitiatedTurns: false,
  }),
  environment: CODEX_ENVIRONMENT_POLICY,
  buildArgv: (launch) => {
    const codex = requireLaunch(launch, "codex");
    if (!isAbsolute(codex.adapter.entryPath) || codex.adapter.entryPath.includes("\0")) {
      throw new TypeError("adapter entry path must be an absolute NUL-free path");
    }
    return Object.freeze([codex.adapter.entryPath]);
  },
  planLaunch: (launch) => {
    const codex = requireLaunch(launch, "codex");
    const argv = CODEX_ENGINE_PROFILE.buildArgv(codex);
    if (!isAbsolute(codex.core.executablePath) || codex.core.executablePath.includes("\0")) {
      throw new TypeError("codex core path must be an absolute NUL-free path");
    }
    return Object.freeze({
      argv,
      environmentPolicyVersion: CODEX_ENVIRONMENT_POLICY.version,
      buildEnvironment: (base) => buildEngineEnvironment(CODEX_ENVIRONMENT_POLICY, base, {
        fixedValues: { CODEX_PATH: codex.core.executablePath },
      }),
      verifyBeforeSpawn: async () => {
        await verifyCodexAdapterPin(codex.adapter);
        await verifyCodexCorePin(codex.core);
      },
      redactValues: Object.freeze([]),
    });
  },
});

/** The claude binary is path-pinned: it must be a real (link-free) Mach-O executable. */
async function verifyClaudeExecutable(path: string): Promise<void> {
  const resolved = await realpath(path).catch(() => undefined);
  if (resolved !== path || !(await isMachOExecutableFile(path))) {
    throw new AdapterPinError("claude_executable_invalid", "claude executable is missing, linked or not a Mach-O binary");
  }
}

function requireLaunch<E extends GuildEngine>(
  launch: EngineLaunch,
  engine: E,
): Extract<EngineLaunch, { readonly engine: E }> {
  if (launch.engine !== engine) {
    throw new TypeError(`launch for engine ${String(launch.engine)} does not match profile ${engine}`);
  }
  return launch as Extract<EngineLaunch, { readonly engine: E }>;
}

export function engineProfileFor(engine: GuildEngine): EngineProfile {
  return engine === "claude" ? CLAUDE_ENGINE_PROFILE : engine === "codex" ? CODEX_ENGINE_PROFILE : GROK_ENGINE_PROFILE;
}
