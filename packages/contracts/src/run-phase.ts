/**
 * First-token phase indicator (F1b). The running turn shows what Guild is actually waiting for,
 * with total and per-phase elapsed time. The projection is ephemeral display state: it is never
 * persisted and carries only enum-like fields, counts and a bounded tool identifier.
 */

export const GUILD_RUN_PHASES = Object.freeze([
  "starting_runtime",
  "opening_session",
  "prompt_sent",
  "queued",
  "running_hooks",
  "waiting_for_model",
  "thinking",
  "preparing_tool",
  "waiting_for_permission",
  "running_tool",
  "retrying",
  "responding",
] as const);

export type GuildRunPhase = (typeof GUILD_RUN_PHASES)[number];

/** A prompt that has been written but not yet taken up by the runtime gets a soft notice after this. */
export const GUILD_RUN_PHASE_SENT_NOTICE_MS = 10_000;

export type RunPhaseProjection = Readonly<{
  phase: GuildRunPhase;
  /** Wall-clock milliseconds at which the turn began; stable while the turn runs. */
  turnStartedAtMs: number;
  /** Wall-clock milliseconds at which the current phase began; stable while it lasts. */
  phaseStartedAtMs: number;
  /** One-based place in the runtime queue (`queued`). */
  queuePosition?: number;
  /** Hooks running (`running_hooks`). */
  hookCount?: number;
  /** Tool identifier (`preparing_tool`, `running_tool`). */
  toolName?: string;
  /** Retry attempt and its limit (`retrying`). */
  attempt?: number;
  maxRetries?: number;
  /** MCP servers connected and expected while a session opens (`opening_session`). */
  mcpConnected?: number;
  mcpTotal?: number;
}>;

export function isRunPhase(value: unknown): value is GuildRunPhase {
  return typeof value === "string" && (GUILD_RUN_PHASES as readonly string[]).includes(value);
}

/** Strictly validates a phase projection received over IPC or built in tests. */
export function parseRunPhaseProjection(input: unknown): RunPhaseProjection {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("invalid_run_phase");
  }
  const record = input as Record<string, unknown>;
  const allowed = new Set([
    "phase", "turnStartedAtMs", "phaseStartedAtMs", "queuePosition", "hookCount", "toolName",
    "attempt", "maxRetries", "mcpConnected", "mcpTotal",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new TypeError("invalid_run_phase");
  }
  if (!isRunPhase(record["phase"])) throw new TypeError("invalid_run_phase");
  const time = (key: string): number => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError("invalid_run_phase");
    }
    return value;
  };
  const count = (key: string): number | undefined => {
    if (record[key] === undefined) return undefined;
    const value = record[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      throw new TypeError("invalid_run_phase");
    }
    return value;
  };
  const toolName = record["toolName"];
  if (
    toolName !== undefined &&
    (typeof toolName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u.test(toolName))
  ) {
    throw new TypeError("invalid_run_phase");
  }
  const queuePosition = count("queuePosition");
  const hookCount = count("hookCount");
  const attempt = count("attempt");
  const maxRetries = count("maxRetries");
  const mcpConnected = count("mcpConnected");
  const mcpTotal = count("mcpTotal");
  return Object.freeze({
    phase: record["phase"],
    turnStartedAtMs: time("turnStartedAtMs"),
    phaseStartedAtMs: time("phaseStartedAtMs"),
    ...(queuePosition === undefined ? {} : { queuePosition }),
    ...(hookCount === undefined ? {} : { hookCount }),
    ...(toolName === undefined ? {} : { toolName: toolName as string }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(mcpConnected === undefined ? {} : { mcpConnected }),
    ...(mcpTotal === undefined ? {} : { mcpTotal }),
  });
}
