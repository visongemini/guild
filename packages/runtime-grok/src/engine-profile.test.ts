import assert from "node:assert/strict";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ClaudeAdapterPin } from "./adapter-pin.js";
import {
  CLAUDE_ENGINE_PROFILE,
  CLAUDE_ENVIRONMENT_POLICY,
  CLAUDE_ENVIRONMENT_POLICY_VERSION,
  GROK_ENGINE_PROFILE,
  GROK_ENVIRONMENT_POLICY,
  assertPerSpawnEnvironment,
  buildEngineEnvironment,
  engineProfileFor,
  type ClaudeLaunch,
} from "./engine-profile.js";
import { GROK_ACP_PRODUCTION_ARGV } from "./grok-acp-profile.js";
import { buildChildEnvironment } from "./process-host.js";

const adapter: ClaudeAdapterPin = Object.freeze({
  packageRoot: "/opt/adapter",
  entryPath: "/opt/adapter/dist/index.js",
  version: "0.89.1",
  fingerprintSha256: "0".repeat(64),
});

function claudeLaunch(overrides: Partial<ClaudeLaunch> = {}): ClaudeLaunch {
  return { engine: "claude", adapter, claudeExecutablePath: "/opt/claude/versions/2.1.291", ...overrides };
}

describe("engine profiles (PC-ENG-001)", () => {
  it("describes both engines with the documented policies and feature flags", () => {
    assert.deepEqual(
      [GROK_ENGINE_PROFILE.engine, GROK_ENGINE_PROFILE.dialect, GROK_ENGINE_PROFILE.pinStrategy, GROK_ENGINE_PROFILE.authPolicy],
      ["grok", "grok", "macho-binary", "auto-single"],
    );
    assert.deepEqual(GROK_ENGINE_PROFILE.features, {
      billing: true,
      steer: true,
      conversationRewind: true,
      xaiSignals: true,
      agentInitiatedTurns: true,
    });
    assert.deepEqual(
      [CLAUDE_ENGINE_PROFILE.engine, CLAUDE_ENGINE_PROFILE.dialect, CLAUDE_ENGINE_PROFILE.pinStrategy, CLAUDE_ENGINE_PROFILE.authPolicy],
      ["claude", "claude", "node-script", "never"],
    );
    assert.deepEqual(CLAUDE_ENGINE_PROFILE.features, {
      billing: false,
      steer: true,
      conversationRewind: false,
      xaiSignals: false,
      agentInitiatedTurns: false,
    });
    assert.equal(engineProfileFor("grok"), GROK_ENGINE_PROFILE);
    assert.equal(engineProfileFor("claude"), CLAUDE_ENGINE_PROFILE);
    assert.equal(Object.isFrozen(GROK_ENGINE_PROFILE.features) && Object.isFrozen(CLAUDE_ENGINE_PROFILE.features), true);
  });

  it("builds the Grok argv exactly as before and the Claude argv as the adapter entry only", () => {
    assert.equal(GROK_ENGINE_PROFILE.buildArgv({ engine: "grok" }), GROK_ACP_PRODUCTION_ARGV);
    assert.deepEqual(
      GROK_ENGINE_PROFILE.buildArgv({ engine: "grok", runtimeSettings: { permissionMode: "default" } }),
      GROK_ACP_PRODUCTION_ARGV,
    );
    const argv = CLAUDE_ENGINE_PROFILE.buildArgv(claudeLaunch());
    assert.deepEqual(argv, ["/opt/adapter/dist/index.js"]);
    assert.equal(argv.includes("--rules"), false);
  });

  it("rejects a launch for the other engine or with unusable paths", () => {
    assert.throws(() => GROK_ENGINE_PROFILE.planLaunch(claudeLaunch()), TypeError);
    assert.throws(() => CLAUDE_ENGINE_PROFILE.planLaunch({ engine: "grok" }), TypeError);
    assert.throws(
      () => CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch({ claudeExecutablePath: "claude" })),
      TypeError,
    );
    assert.throws(
      () => CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch({ adapter: { ...adapter, entryPath: "dist/index.js" } })),
      TypeError,
    );
  });
});

describe("Grok environment policy stays byte-for-byte", () => {
  it("is what buildChildEnvironment returns", () => {
    const parent = {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      LC_MESSAGES: "C",
      ANTHROPIC_API_KEY: "must-not-pass",
      HTTPS_PROXY: "http://proxy.invalid",
      NODE_OPTIONS: "--inspect",
    };
    assert.deepEqual(buildChildEnvironment(parent), buildEngineEnvironment(GROK_ENVIRONMENT_POLICY, parent));
    const environment = buildChildEnvironment(parent);
    assert.equal(environment.LC_MESSAGES, undefined, "Grok keeps only LC_ALL and LC_CTYPE");
    assert.equal(environment.OPENVIKING_MEMORY_ENABLED, "0");
    assert.equal(environment.NO_PROXY, undefined, "Grok does not force NO_PROXY");
    assert.equal(environment.CLAUDE_CODE_EXECUTABLE, undefined);
  });
});

describe("Claude environment policy (docs/20 section 3.2)", () => {
  const rich = {
    PATH: "/usr/bin:/bin",
    HOME: "/somewhere/else",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    LC_MESSAGES: "C",
    USER: "someone",
    LOGNAME: "someone",
    TMPDIR: "/tmp/x/",
    TMP: "/tmp/x",
    TEMP: "/tmp/x",
    HTTP_PROXY: "http://proxy.invalid:8080",
    https_proxy: "http://proxy.invalid:8080",
    ALL_PROXY: "socks5h://proxy.invalid:1080",
    NO_PROXY: "10.0.0.0/8,localhost",
    SSL_CERT_FILE: "/etc/ssl/cert.pem",
    SSL_CERT_DIR: "/etc/ssl/certs",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    ANTHROPIC_API_KEY: "sk-must-not-pass",
    ANTHROPIC_BASE_URL: "http://evil.invalid",
    ANTHROPIC_AUTH_TOKEN: "token",
    CLAUDE_CODE_OAUTH_TOKEN: "token",
    CLAUDE_CODE_EXECUTABLE: "/tmp/other-claude",
    CLAUDE_CODE_USE_BEDROCK: "1",
    NODE_OPTIONS: "--require /tmp/hook.js",
    NODE_PATH: "/tmp/modules",
    ELECTRON_RUN_AS_NODE: "1",
    DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
    LD_PRELOAD: "/tmp/x.so",
    BASH_ENV: "/tmp/rc",
    OPENVIKING_MEMORY_ENABLED: "1",
    OPENVIKING_AUTO_CAPTURE: "true",
    GROK_API_KEY: "xai-nope",
  };

  it("allowlists the documented keys and strips every endpoint, credential and loader variable", () => {
    const environment = buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, rich);
    const kept = Object.keys(environment).sort();
    assert.deepEqual(kept, [
      "ALL_PROXY", "HOME", "HTTP_PROXY", "LANG", "LC_ALL", "LC_MESSAGES", "LOGNAME", "NO_PROXY", "PATH",
      "SSH_AUTH_SOCK", "SSL_CERT_DIR", "SSL_CERT_FILE", "TEMP", "TMP", "TMPDIR", "USER",
      "https_proxy", "no_proxy",
    ].sort());
    assert.equal(environment.USER, "someone");
    assert.equal(environment.LOGNAME, "someone");
    assert.equal(environment.HOME, homedir(), "HOME is the real home, not an inherited value");
    assert.equal(Object.isFrozen(environment), true);
  });

  it("keeps the account name Claude Code needs to find its Keychain login, filling USER when it is missing", () => {
    assert.equal(buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, {}).USER, userInfo().username);
    assert.equal(buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, { USER: "" }).USER, userInfo().username);
    assert.equal(buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, { USER: "alias" }).USER, "alias");
    assert.equal(buildEngineEnvironment(GROK_ENVIRONMENT_POLICY, { USER: "alias" }).USER, undefined, "Grok never saw USER");
  });

  it("adds no OpenViking kill-switch block and no Grok-only values", () => {
    const environment = buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, {});
    for (const key of Object.keys(environment)) {
      assert.equal(key.startsWith("OPENVIKING_"), false, key);
      assert.equal(key.startsWith("GROK_"), false, key);
    }
  });

  it("always includes the loopback in NO_PROXY and no_proxy, keeping existing entries", () => {
    const bare = buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, {});
    assert.equal(bare.NO_PROXY, "127.0.0.1,localhost");
    assert.equal(bare.no_proxy, "127.0.0.1,localhost");
    const merged = buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, rich);
    assert.equal(merged.NO_PROXY, "127.0.0.1,localhost,10.0.0.0/8");
    assert.equal(merged.no_proxy, merged.NO_PROXY);
    const lower = buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, { no_proxy: "internal.example, localhost" });
    assert.equal(lower.NO_PROXY, "127.0.0.1,localhost,internal.example");
  });

  it("extends PATH with the user's local bin and the system fallback", () => {
    assert.equal(
      buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, { PATH: "/usr/bin:/bin" }).PATH,
      `/usr/bin:/bin:${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin`,
    );
  });

  it("sets CLAUDE_CODE_EXECUTABLE to the pinned claude path through the launch plan only", () => {
    const plan = CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch());
    const environment = plan.buildEnvironment(rich);
    assert.equal(environment.CLAUDE_CODE_EXECUTABLE, "/opt/claude/versions/2.1.291");
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(plan.environmentPolicyVersion, CLAUDE_ENVIRONMENT_POLICY_VERSION);
    assert.deepEqual(plan.argv, ["/opt/adapter/dist/index.js"]);
    assert.equal(typeof plan.verifyBeforeSpawn, "function");
  });

  it("accepts only the routed-session keys per spawn and validates their values", () => {
    const routed = {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:43120/0123456789abcdef0123456789abcdef/",
      ANTHROPIC_AUTH_TOKEN: "guild-router-0123456789abcdef0123456789abcdef",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_SMALL_FAST_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
      ENABLE_TOOL_SEARCH: "true",
      OPENVIKING_AUTO_CAPTURE: "false",
    };
    const plan = CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch({ extraEnvironment: routed }));
    const environment = plan.buildEnvironment({ ANTHROPIC_BASE_URL: "http://evil.invalid", PATH: "/usr/bin" });
    assert.equal(environment.ANTHROPIC_BASE_URL, routed.ANTHROPIC_BASE_URL, "the caller's value wins over an inherited one");
    assert.equal(environment.ENABLE_TOOL_SEARCH, "true");
    assert.equal(environment.OPENVIKING_AUTO_CAPTURE, "false");
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, routed.ANTHROPIC_AUTH_TOKEN);
    assert.equal(environment.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash");
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(
      plan.redactValues,
      [routed.ANTHROPIC_BASE_URL, routed.ANTHROPIC_AUTH_TOKEN],
      "the token-bearing URL and the throwaway auth token are redacted from diagnostics",
    );

    for (const rejected of [
      { ANTHROPIC_API_KEY: "sk-x" },
      { CLAUDE_CODE_EXECUTABLE: "/tmp/claude" },
      { NODE_OPTIONS: "--inspect" },
      { PATH: "/tmp" },
      { OPENVIKING_MEMORY_ENABLED: "1" },
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
      { ANTHROPIC_BASE_URL: "http://192.168.1.2:8080/t/" },
      { ANTHROPIC_BASE_URL: "http://user:pass@127.0.0.1:8080/" },
      { ANTHROPIC_BASE_URL: "not a url" },
      { ENABLE_TOOL_SEARCH: "yes" },
      { OPENVIKING_AUTO_CAPTURE: "1" },
      // Only the throwaway token shape is a valid auth token: never a real credential, never an empty one.
      { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-real-subscription-token" },
      { ANTHROPIC_AUTH_TOKEN: "guild-router-short" },
      { ANTHROPIC_AUTH_TOKEN: "" },
      { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" },
      { ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-flash" },
      { CLAUDE_CODE_SUBAGENT_MODEL: "has space" },
      { CLAUDE_CODE_SUBAGENT_MODEL: "" },
      { ANTHROPIC_SMALL_FAST_MODEL: "m".repeat(200) },
      { ["__proto__"]: "x" },
    ]) {
      assert.throws(
        () => CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch({ extraEnvironment: JSON.parse(JSON.stringify(rejected)) as Record<string, string> })),
        TypeError,
        JSON.stringify(rejected),
      );
    }
    assert.throws(() => assertPerSpawnEnvironment(GROK_ENVIRONMENT_POLICY, { OPENVIKING_AUTO_CAPTURE: "false" }), TypeError);
    for (const accepted of ["http://localhost:8080/t/", "http://[::1]:8080/t/", "http://127.0.0.1:1/"]) {
      assert.doesNotThrow(() => assertPerSpawnEnvironment(CLAUDE_ENVIRONMENT_POLICY, { ANTHROPIC_BASE_URL: accepted }), accepted);
    }
  });

  it("rejects invalid parent environment keys and values without echoing them", () => {
    for (const parent of [{ "": "secret" }, { "A=B": "secret" }, { ["A\0B"]: "secret" }, { SAFE: "sec\0ret" }]) {
      assert.throws(
        () => buildEngineEnvironment(CLAUDE_ENVIRONMENT_POLICY, parent),
        (cause: unknown) => cause instanceof TypeError && !cause.message.includes("secret"),
      );
    }
  });
});
