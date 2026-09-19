import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type {
  GuildGrokManagementAction,
  GuildGrokManagementParameter,
  RunGrokManagementRequest,
  RunGrokManagementResponse,
} from "@guild/contracts";
import { GUILD_GROK_MANAGEMENT_PARAMETER_KEYS } from "@guild/contracts";
import { buildChildEnvironment } from "@guild/runtime-grok";
import {
  locateOfficialGrokRuntime,
  resolveOfficialGrokEnvironment,
} from "./runtime-locator.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MUTATION_TIMEOUT_MS = 5 * 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const ROUTINE_SETTINGS_FETCH_NOISE = /Settings fetch (?:network error|failed)/u;

export type GrokManagementCommand = Readonly<{
  action: GuildGrokManagementAction;
  args: readonly string[];
  commandLabel: string;
  mutating: boolean;
  requiresConfirmation: boolean;
  timeoutMs: number;
  redactValues: readonly string[];
}>;

/** PC-ACC-001 / PC-GROK-001: closed, literal mapping to documented official CLI operations. */
export function buildGrokManagementCommand(
  request: RunGrokManagementRequest,
): GrokManagementCommand {
  const parameters = request.parameters ?? Object.freeze({});
  assertOnlyParameters(request.action, parameters);
  const args: string[] = [];
  let mutating = false;
  let requiresConfirmation = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const sensitiveValues: string[] = [];

  const destructive = (): void => {
    mutating = true;
    requiresConfirmation = true;
    timeoutMs = MUTATION_TIMEOUT_MS;
  };
  const modifies = (): void => {
    mutating = true;
    timeoutMs = MUTATION_TIMEOUT_MS;
  };

  switch (request.action) {
    case "version": args.push("--version"); break;
    case "models": args.push("models"); break;
    case "inspect": args.push("inspect", "--json"); break;
    case "doctor": args.push("doctor", "--json"); break;
    case "doctor_fixes": args.push("doctor", "fix"); break;
    case "doctor_fix":
      destructive();
      args.push("doctor", "fix");
      pushOptional(args, optionalSafeName(parameters, "id"));
      args.push("--yes");
      break;
    case "disk_usage": args.push("du", "--json"); break;
    case "update_check": args.push("update", "--check", "--json"); break;
    case "update_stable":
      destructive(); timeoutMs = UPDATE_TIMEOUT_MS; args.push("update", "--stable"); break;
    case "update_alpha":
      destructive(); timeoutMs = UPDATE_TIMEOUT_MS; args.push("update", "--alpha"); break;
    case "update_version":
      destructive(); timeoutMs = UPDATE_TIMEOUT_MS;
      args.push("update", "--version", requiredText(parameters, "version", 128));
      break;
    case "update_reinstall":
      destructive(); timeoutMs = UPDATE_TIMEOUT_MS; args.push("update", "--force-reinstall"); break;
    case "setup_preview": args.push("setup", "--json"); break;
    case "setup_apply": destructive(); args.push("setup"); break;
    case "login_oauth": modifies(); args.push("login", "--oauth"); break;
    case "login_device": modifies(); args.push("login", "--device-auth"); break;
    case "logout": destructive(); args.push("logout"); break;
    case "plugin_list": args.push("plugin", "list", "--json"); break;
    case "plugin_available": args.push("plugin", "list", "--json", "--available"); break;
    case "plugin_details": args.push("plugin", "details", safeName(parameters, "name")); break;
    case "plugin_validate":
      args.push("plugin", "validate");
      pushOptional(args, optionalPath(parameters, "path"));
      break;
    case "plugin_install":
      destructive();
      args.push("plugin", "install", "--trust", requiredPositionalText(parameters, "source", 4_096));
      break;
    case "plugin_uninstall":
      destructive();
      args.push("plugin", "uninstall", safeName(parameters, "name"), "--confirm");
      if (booleanParameter(parameters, "keepData")) args.push("--keep-data");
      break;
    case "plugin_update":
      modifies(); args.push("plugin", "update"); pushOptional(args, optionalSafeName(parameters, "name")); break;
    case "plugin_enable": modifies(); args.push("plugin", "enable", safeName(parameters, "name")); break;
    case "plugin_disable": modifies(); args.push("plugin", "disable", safeName(parameters, "name")); break;
    case "plugin_tag_preview":
      args.push("plugin", "tag"); pushOptional(args, optionalPath(parameters, "path")); args.push("--dry-run"); break;
    case "plugin_tag":
      destructive(); args.push("plugin", "tag"); pushOptional(args, optionalPath(parameters, "path"));
      if (booleanParameter(parameters, "push")) args.push("--push");
      if (booleanParameter(parameters, "force")) args.push("--force");
      break;
    case "marketplace_list": args.push("plugin", "marketplace", "list", "--json"); break;
    case "marketplace_add":
      modifies(); args.push("plugin", "marketplace", "add", requiredPositionalText(parameters, "source", 4_096));
      if (booleanParameter(parameters, "force")) args.push("--force");
      break;
    case "marketplace_remove":
      destructive(); args.push("plugin", "marketplace", "remove", requiredPositionalText(parameters, "source", 4_096)); break;
    case "marketplace_update":
      modifies(); args.push("plugin", "marketplace", "update"); pushOptional(args, optionalPositionalText(parameters, "name", 512)); break;
    case "mcp_list": args.push("mcp", "list", "--json"); break;
    case "mcp_doctor":
      args.push("mcp", "doctor"); pushOptional(args, optionalSafeName(parameters, "name")); args.push("--json"); break;
    case "mcp_add": {
      destructive();
      const transport = enumText(parameters, "transport", ["stdio", "http", "sse"] as const, "stdio");
      const scope = enumText(parameters, "scope", ["user", "project"] as const, "user");
      const name = safeName(parameters, "name");
      const endpoint = requiredPositionalText(parameters, "endpoint", 4_096);
      const env = stringArray(parameters, "env", 64, 4_096);
      const headers = stringArray(parameters, "headers", 64, 4_096);
      args.push("mcp", "add", "--transport", transport, "--scope", scope);
      for (const entry of env) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=.+$/u.test(entry)) throw new TypeError("invalid_mcp_environment");
        args.push("--env", entry);
        sensitiveValues.push(entry.slice(entry.indexOf("=") + 1));
      }
      for (const header of headers) {
        if (!/^[^:\r\n]+:\s*[^\r\n]+$/u.test(header)) throw new TypeError("invalid_mcp_header");
        args.push("--header", header);
        sensitiveValues.push(header.slice(header.indexOf(":") + 1).trim());
      }
      args.push(name);
      if (transport === "stdio") {
        args.push("--", endpoint, ...stringArray(parameters, "args", 64, 4_096));
      } else {
        args.push(endpoint);
      }
      break;
    }
    case "mcp_remove":
      destructive(); args.push("mcp", "remove", safeName(parameters, "name"));
      pushScope(args, parameters); break;
    case "mcp_enable": modifies(); args.push("mcp", "enable", safeName(parameters, "name")); break;
    case "mcp_disable": modifies(); args.push("mcp", "disable", safeName(parameters, "name")); break;
    case "memory_clear":
      destructive(); args.push("memory", "clear", `--${enumText(parameters, "scope", ["workspace", "global", "all"] as const, "workspace")}`, "--yes"); break;
    case "sessions_list": args.push("sessions", "list", "--limit", String(integerParameter(parameters, "limit", 1, 200, 50))); break;
    case "sessions_search":
      args.push("sessions", "search", requiredPositionalText(parameters, "query", 512), "--limit", String(integerParameter(parameters, "limit", 1, 200, 50))); break;
    case "session_delete": destructive(); args.push("sessions", "delete", sessionId(parameters)); break;
    case "session_export":
      modifies(); args.push("export", sessionId(parameters), requiredPath(parameters, "output")); break;
    case "session_trace_local":
      modifies(); args.push("trace", sessionId(parameters), "--local", "--json");
      pushOutput(args, parameters); break;
    case "session_trace_upload":
      destructive(); args.push("trace", sessionId(parameters), "--json"); pushOutput(args, parameters); break;
    case "worktree_list":
      args.push("worktree", "list", "--json");
      if (booleanParameter(parameters, "all")) args.push("--all");
      pushNamedOption(args, "--repo", optionalPath(parameters, "repo"));
      pushNamedOption(args, "--type", optionalText(parameters, "type", 128));
      break;
    case "worktree_show": args.push("worktree", "show", requiredPositionalText(parameters, "id", 4_096)); break;
    case "worktree_remove":
      destructive(); args.push("worktree", "rm", ...requiredPositionalArray(parameters, "ids", 64, 4_096));
      if (booleanParameter(parameters, "force")) args.push("--force"); break;
    case "worktree_gc_preview":
      args.push("worktree", "gc", "--dry-run"); pushMaxAge(args, parameters); break;
    case "worktree_gc":
      destructive(); args.push("worktree", "gc"); pushMaxAge(args, parameters);
      if (booleanParameter(parameters, "force")) args.push("--force"); break;
    case "worktree_detach":
      destructive(); args.push("worktree", "detach", requiredPositionalText(parameters, "id", 4_096));
      if (booleanParameter(parameters, "allowCopy")) args.push("--allow-copy"); break;
    case "worktree_salvage":
      destructive(); args.push("worktree", "salvage", requiredPositionalText(parameters, "id", 4_096), "--out", requiredPath(parameters, "output")); break;
    case "worktree_clean_preview":
      args.push("worktree", "clean-artifacts", requiredPositionalText(parameters, "id", 4_096), "--dry-run"); break;
    case "worktree_clean":
      destructive(); args.push("worktree", "clean-artifacts", requiredPositionalText(parameters, "id", 4_096), "--yes"); break;
    case "worktree_db_stats": args.push("worktree", "db", "stats"); break;
    case "worktree_db_path": args.push("worktree", "db", "path"); break;
    case "worktree_db_rebuild": destructive(); args.push("worktree", "db", "rebuild"); break;
    case "leader_list": args.push("leader", "list", "--json"); break;
    case "leader_info":
      args.push("leader", "info", "--json");
      pushNamedOption(args, "--pid", optionalInteger(parameters, "pid", 1, 2_147_483_647));
      break;
    case "leader_kill": destructive(); args.push("leader", "kill"); break;
    case "clone":
      modifies();
      args.push("clone");
      pushNamedOption(args, "--branch", optionalText(parameters, "branch", 512));
      for (const cone of stringArray(parameters, "cones", 64, 4_096)) args.push("--cone", cone);
      if (booleanParameter(parameters, "fullHistory")) args.push("--full-history");
      args.push(requiredPositionalText(parameters, "url", 4_096));
      pushOptional(args, optionalPath(parameters, "directory"));
      break;
  }

  if (requiresConfirmation && request.confirmed !== true) {
    throw new TypeError("grok_management_confirmation_required");
  }
  return Object.freeze({
    action: request.action,
    args: Object.freeze(args),
    commandLabel: `grok ${request.action.replaceAll("_", " ")}`,
    mutating,
    requiresConfirmation,
    timeoutMs,
    redactValues: Object.freeze(sensitiveValues.filter((value) => value.length >= 3)),
  });
}

export async function runOfficialGrokManagement(input: {
  readonly request: RunGrokManagementRequest;
  readonly workingDirectory: string;
  readonly signal: AbortSignal;
  readonly onOutput?: (output: string) => void;
}): Promise<RunGrokManagementResponse> {
  const command = buildGrokManagementCommand(input.request);
  const workingDirectory = await realpath(input.workingDirectory);
  const [located, environment] = await Promise.all([
    locateOfficialGrokRuntime(),
    resolveOfficialGrokEnvironment(),
  ]);
  const startedAtMs = Date.now();
  const result = await executeBounded({
    executablePath: located.executablePath,
    args: command.args,
    cwd: workingDirectory,
    environment: buildChildEnvironment(environment),
    timeoutMs: command.timeoutMs,
    signal: input.signal,
    onOutput: (stdout, stderr) => {
      const output = sanitizeManagementOutput(
        input.request.action,
        [stdout, stderr].filter((part) => part.trim().length > 0).join("\n"),
        command.redactValues,
      );
      if (output.length > 0) input.onOutput?.(output);
    },
  });
  const output = sanitizeManagementOutput(
    input.request.action,
    [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join("\n"),
    command.redactValues,
  );
  return Object.freeze({
    action: input.request.action,
    commandLabel: command.commandLabel,
    completedAtIso: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAtMs),
    output: output.length > 0
      ? output
      : result.termination === "aborted"
        ? "Cancelled because Guild is closing."
        : result.termination === "timed_out"
          ? "The official Grok command exceeded its time limit."
          : result.code === 0 ? "OK" : `Exited with code ${result.code ?? "unknown"}`,
    status: result.code === 0 && result.termination === undefined ? "completed" : "failed",
  });
}

type ExecutionResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
  termination?: "aborted" | "timed_out";
}>;

async function executeBounded(input: {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onOutput?: (stdout: string, stderr: string) => void;
}): Promise<ExecutionResult> {
  if (input.signal.aborted) {
    return Object.freeze({ code: null, stdout: "", stderr: "", termination: "aborted" });
  }
  return await new Promise<ExecutionResult>((resolvePromise) => {
    const child = spawn(input.executablePath, input.args, {
      cwd: input.cwd,
      detached: true,
      env: input.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let finishing = false;
    let termination: ExecutionResult["termination"];
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= MAX_OUTPUT_BYTES) return current + chunk.length;
      target.push(chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - current)));
      return current + chunk.length;
    };
    const emitOutput = (): void => {
      try {
        input.onOutput?.(
          Buffer.concat(stdout).toString("utf8"),
          Buffer.concat(stderr).toString("utf8"),
        );
      } catch {
        // Progress rendering is best-effort and must never interrupt the owned process.
      }
    };
    const scheduleOutput = (): void => {
      if (progressTimer !== undefined) return;
      progressTimer = setTimeout(() => {
        progressTimer = undefined;
        emitOutput();
      }, 200);
      progressTimer.unref();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const retained = stdoutBytes < MAX_OUTPUT_BYTES;
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
      if (retained) scheduleOutput();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const retained = stderrBytes < MAX_OUTPUT_BYTES;
      stderrBytes = collect(stderr, chunk, stderrBytes);
      if (retained) scheduleOutput();
    });
    const signalOwnedProcess = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch { /* already gone or not signalable */ }
      }
    };
    const finish = (code: number | null): void => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      if (progressTimer !== undefined) clearTimeout(progressTimer);
      progressTimer = undefined;
      emitOutput();
      input.signal.removeEventListener("abort", abort);
      // The direct CLI may have exited after spawning descendants. The
      // management operation owns the whole detached group, so no descendant
      // may survive the response or application shutdown.
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 0); signalOwnedProcess("SIGKILL"); } catch { /* group is gone */ }
      }
      settled = true;
      resolvePromise(Object.freeze({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(termination === undefined ? {} : { termination }),
      }));
    };
    const terminate = (reason: "aborted" | "timed_out"): void => {
      if (settled || termination !== undefined) return;
      termination = reason;
      signalOwnedProcess("SIGTERM");
      killTimer = setTimeout(() => signalOwnedProcess("SIGKILL"), 1_500);
      killTimer.unref();
      forceSettleTimer = setTimeout(() => finish(null), 3_000);
      forceSettleTimer.unref();
    };
    const abort = (): void => terminate("aborted");
    input.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate("timed_out"), input.timeoutMs);
    timer.unref();
    child.once("error", (cause) => {
      if (settled || finishing) return;
      stderr.push(Buffer.from(cause.message));
      finish(null);
    });
    child.once("close", finish);
  });
}

export function sanitizeManagementOutput(
  action: GuildGrokManagementAction,
  raw: string,
  redactValues: readonly string[] = [],
): string {
  let output = raw
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARACTERS, "")
    .split(/\r?\n/u)
    .filter((line) => !ROUTINE_SETTINGS_FETCH_NOISE.test(line))
    .join("\n")
    .trim();
  if (output.length === 0) return "";
  if (looksLikeJson(output)) {
    try {
      const parsed = JSON.parse(output) as unknown;
      output = JSON.stringify(sanitizeJson(parsed, action), null, 2);
    } catch {
      // Never stream an incomplete structured document: a quoted credential
      // key may arrive before its closing value and cannot yet be sanitized structurally.
      return "";
    }
  }
  for (const value of redactValues) output = output.replaceAll(value, "<redacted>");
  output = output
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1<redacted>@")
    .replace(
      /((?:["'])?(?:token|secret|password|authorization|api[_-]?key)(?:["'])?\s*[:=]\s*)(["'])(?:(?!\2).)*\2/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
    )
    .replace(
      /((?:["'])?(?:token|secret|password|authorization|api[_-]?key)(?:["'])?\s*[:=]\s*)(?!["'])[^\s,;}]+/giu,
      "$1<redacted>",
    );
  if (action === "models") output = officialModelsOnly(output);
  return output.slice(0, MAX_OUTPUT_BYTES);
}

function assertOnlyParameters(
  action: GuildGrokManagementAction,
  parameters: Readonly<Record<string, GuildGrokManagementParameter>>,
): void {
  const allowed = GUILD_GROK_MANAGEMENT_PARAMETER_KEYS[action] as readonly string[];
  for (const key of Object.keys(parameters)) {
    if (!allowed.includes(key)) throw new TypeError(`unexpected_grok_management_parameter_${key}`);
  }
}

function officialModelsOnly(output: string): string {
  const lines = output.split(/\r?\n/u).filter((line) => {
    const normalized = line.trim();
    return normalized === "You are logged in with grok.com." ||
      /^Default model:\s*grok-/u.test(normalized) ||
      /^[*-]\s+grok-/u.test(normalized) ||
      normalized === "Available models:";
  });
  return lines.join("\n").trim();
}

function sanitizeJson(value: unknown, action: GuildGrokManagementAction, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, action, key));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [childKey, childValue] of Object.entries(value)) {
      const normalized = childKey.toLowerCase();
      if (/token|secret|password|authorization|api[_-]?key/u.test(normalized)) {
        result[childKey] = "<redacted>";
      } else if (action === "mcp_list" && normalized === "env" && childValue !== null && typeof childValue === "object") {
        result[childKey] = Object.fromEntries(Object.keys(childValue).map((name) => [name, "<configured>"]));
      } else if (action === "inspect" && ["projectInstructions", "externalCompat"].includes(childKey)) {
        result[childKey] = summarizeConfiguredValue(childValue);
      } else {
        result[childKey] = sanitizeJson(childValue, action, childKey);
      }
    }
    return result;
  }
  if (typeof value === "string" && /header|env/u.test(key.toLowerCase())) return "<configured>";
  return value;
}

function summarizeConfiguredValue(value: unknown): unknown {
  if (Array.isArray(value)) return { configured: value.length > 0, count: value.length };
  if (value !== null && typeof value === "object") return { configured: Object.keys(value).length > 0, keys: Object.keys(value) };
  if (typeof value === "string") return { configured: value.length > 0, characters: value.length };
  return value;
}

function looksLikeJson(value: string): boolean {
  return value.startsWith("{") || value.startsWith("[");
}

function parameter(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): GuildGrokManagementParameter | undefined {
  return parameters[key];
}

function requiredText(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, max: number): string {
  const value = parameter(parameters, key);
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || value.includes("\0")) {
    throw new TypeError(`invalid_grok_management_${key}`);
  }
  return value.trim();
}

function optionalText(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, max: number): string | undefined {
  const value = parameter(parameters, key);
  if (value === undefined || value === "") return undefined;
  return requiredText(parameters, key, max);
}

function requiredPositionalText(
  parameters: Readonly<Record<string, GuildGrokManagementParameter>>,
  key: string,
  max: number,
): string {
  const value = requiredText(parameters, key, max);
  if (value.startsWith("-")) throw new TypeError(`invalid_grok_management_${key}`);
  return value;
}

function optionalPositionalText(
  parameters: Readonly<Record<string, GuildGrokManagementParameter>>,
  key: string,
  max: number,
): string | undefined {
  return parameter(parameters, key) === undefined || parameter(parameters, key) === ""
    ? undefined
    : requiredPositionalText(parameters, key, max);
}

function safeName(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): string {
  const value = requiredText(parameters, key, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,255}$/u.test(value)) throw new TypeError(`invalid_grok_management_${key}`);
  return value;
}

function optionalSafeName(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): string | undefined {
  return parameter(parameters, key) === undefined || parameter(parameters, key) === "" ? undefined : safeName(parameters, key);
}

function requiredPath(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): string {
  const value = requiredText(parameters, key, 4_096);
  if (!isAbsolute(value) || normalize(value) !== value) throw new TypeError(`invalid_grok_management_${key}`);
  return value;
}

function optionalPath(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): string | undefined {
  return parameter(parameters, key) === undefined || parameter(parameters, key) === "" ? undefined : requiredPath(parameters, key);
}

function booleanParameter(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string): boolean {
  const value = parameter(parameters, key);
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError(`invalid_grok_management_${key}`);
  return value;
}

function integerParameter(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, min: number, max: number, fallback: number): number {
  const value = parameter(parameters, key);
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`invalid_grok_management_${key}`);
  return value;
}

function optionalInteger(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, min: number, max: number): string | undefined {
  const value = parameter(parameters, key);
  if (value === undefined) return undefined;
  return String(integerParameter(parameters, key, min, max, min));
}

function stringArray(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, maxItems: number, maxLength: number): readonly string[] {
  const value = parameter(parameters, key);
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > maxLength || item.includes("\0"))) {
    throw new TypeError(`invalid_grok_management_${key}`);
  }
  return Object.freeze([...value]);
}

function requiredStringArray(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, maxItems: number, maxLength: number): readonly string[] {
  const values = stringArray(parameters, key, maxItems, maxLength);
  if (values.length === 0) throw new TypeError(`invalid_grok_management_${key}`);
  return values;
}

function requiredPositionalArray(
  parameters: Readonly<Record<string, GuildGrokManagementParameter>>,
  key: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  const values = requiredStringArray(parameters, key, maxItems, maxLength);
  if (values.some((value) => value.startsWith("-"))) {
    throw new TypeError(`invalid_grok_management_${key}`);
  }
  return values;
}

function enumText<const Values extends readonly string[]>(parameters: Readonly<Record<string, GuildGrokManagementParameter>>, key: string, values: Values, fallback: Values[number]): Values[number] {
  const value = parameter(parameters, key) ?? fallback;
  if (typeof value !== "string" || !values.includes(value)) throw new TypeError(`invalid_grok_management_${key}`);
  return value as Values[number];
}

function sessionId(parameters: Readonly<Record<string, GuildGrokManagementParameter>>): string {
  const value = requiredText(parameters, "sessionId", 128);
  if (!/^[0-9a-fA-F-]{8,128}$/u.test(value)) throw new TypeError("invalid_grok_management_sessionId");
  return value;
}

function pushOptional(args: string[], value: string | undefined): void {
  if (value !== undefined) args.push(value);
}

function pushNamedOption(args: string[], option: string, value: string | undefined): void {
  if (value !== undefined) args.push(option, value);
}

function pushScope(args: string[], parameters: Readonly<Record<string, GuildGrokManagementParameter>>): void {
  const value = parameter(parameters, "scope");
  if (value !== undefined) args.push("--scope", enumText(parameters, "scope", ["user", "project"] as const, "user"));
}

function pushOutput(args: string[], parameters: Readonly<Record<string, GuildGrokManagementParameter>>): void {
  const output = optionalPath(parameters, "output");
  if (output !== undefined) args.push("--output", output);
}

function pushMaxAge(args: string[], parameters: Readonly<Record<string, GuildGrokManagementParameter>>): void {
  const maxAge = optionalText(parameters, "maxAge", 64);
  if (maxAge !== undefined) {
    if (!/^\d+(?:m|h|d|w)$/u.test(maxAge)) throw new TypeError("invalid_grok_management_maxAge");
    args.push("--max-age", maxAge);
  }
}
