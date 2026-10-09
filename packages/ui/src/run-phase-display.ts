import type { GuildRunPhase, RunPhaseProjection } from "@guild/contracts";
import { GUILD_RUN_PHASE_SENT_NOTICE_MS } from "@guild/contracts/run-phase";
import type { GuildMessages } from "./locales.js";

/*
 * Pure label and time derivation for the running-turn phase line. The component only owns the
 * 1 Hz clock; everything it shows is computed here from the projection and a timestamp, so tests
 * need no DOM.
 */
export const RUN_PHASE_SENT_NOTICE_MS = GUILD_RUN_PHASE_SENT_NOTICE_MS;

export type RunPhaseDisplay = Readonly<{
  phase: GuildRunPhase;
  label: string;
  /** Whole seconds since the turn began. */
  totalSeconds: number;
  /** Whole seconds since the current phase began. */
  phaseSeconds: number;
  /** False when the phase began with the turn or lasted exactly as long as it, so it adds nothing. */
  showPhaseSeconds: boolean;
  /** "Sent" for ten seconds without pickup: a calm hint, never an error state. */
  softNotice: boolean;
  /** For example "23s . total 35s" or "total 12s". */
  timeText: string;
}>;

function elapsedSeconds(nowMs: number, startedAtMs: number): number {
  if (startedAtMs <= 0) return 0;
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

export function runPhaseLabel(
  projection: RunPhaseProjection,
  softNotice: boolean,
  messages: GuildMessages,
): string {
  switch (projection.phase) {
    case "starting_runtime":
      return messages.runPhaseStartingRuntime;
    case "opening_session": {
      const base = messages.runPhaseOpeningSession;
      return projection.mcpConnected !== undefined && projection.mcpTotal !== undefined
        ? `${base} \u00b7 ${messages.runPhaseMcp(projection.mcpConnected, projection.mcpTotal)}`
        : base;
    }
    case "prompt_sent":
      return softNotice ? messages.runPhasePromptSentSlow : messages.runPhasePromptSent;
    case "queued":
      return messages.runPhaseQueued(projection.queuePosition);
    case "running_hooks":
      return messages.runPhaseRunningHooks(projection.hookCount);
    case "waiting_for_model":
      return messages.runPhaseWaitingForModel;
    case "thinking":
      return messages.runPhaseThinking;
    case "preparing_tool":
      return messages.runPhasePreparingTool(projection.toolName);
    case "waiting_for_permission":
      return messages.runPhaseWaitingForPermission;
    case "running_tool":
      return messages.runPhaseRunningTool(projection.toolName);
    case "retrying":
      return messages.runPhaseRetrying(projection.attempt, projection.maxRetries);
    case "responding":
      return messages.runPhaseResponding;
  }
}

export function describeRunPhase(
  projection: RunPhaseProjection,
  nowMs: number,
  messages: GuildMessages,
): RunPhaseDisplay {
  const totalSeconds = elapsedSeconds(nowMs, projection.turnStartedAtMs);
  const phaseSeconds = elapsedSeconds(nowMs, projection.phaseStartedAtMs);
  const showPhaseSeconds = projection.phaseStartedAtMs !== projection.turnStartedAtMs &&
    phaseSeconds !== totalSeconds;
  const softNotice = projection.phase === "prompt_sent" &&
    nowMs - projection.phaseStartedAtMs >= RUN_PHASE_SENT_NOTICE_MS;
  return Object.freeze({
    phase: projection.phase,
    label: runPhaseLabel(projection, softNotice, messages),
    totalSeconds,
    phaseSeconds,
    showPhaseSeconds,
    softNotice,
    timeText: messages.runPhaseTime(
      showPhaseSeconds ? messages.runDuration(phaseSeconds) : undefined,
      messages.runDuration(totalSeconds),
    ),
  });
}

/** Phases that ended earlier in this turn, as the projection stream showed them. */
export type RunPhaseTrailEntry = Readonly<{
  projection: RunPhaseProjection;
  /** The next phase's `phaseStartedAtMs` minus this phase's: exact, taken from the projection. */
  durationMs: number;
}>;

export type RunPhaseHistory = Readonly<{
  last: RunPhaseProjection;
  trail: readonly RunPhaseTrailEntry[];
}>;

/** Only the most recent phases are worth a glance; older ones fall off the faint trail. */
export const RUN_PHASE_TRAIL_LIMIT = 3;

export function startRunPhaseHistory(projection: RunPhaseProjection): RunPhaseHistory {
  return Object.freeze({ last: projection, trail: Object.freeze([]) });
}

/**
 * Folds the next projection into the history. The trail is built only from transitions this
 * view actually saw: a phase that ended before the line mounted is simply not on it, and a new
 * turn starts a new trail. Nothing is inferred or reconstructed.
 */
export function advanceRunPhaseHistory(
  history: RunPhaseHistory,
  next: RunPhaseProjection,
): RunPhaseHistory {
  if (next === history.last) return history;
  if (next.turnStartedAtMs !== history.last.turnStartedAtMs) return startRunPhaseHistory(next);
  if (next.phaseStartedAtMs === history.last.phaseStartedAtMs) {
    // The same phase with refreshed details (a tool name, a retry count): keep the trail.
    return Object.freeze({ last: next, trail: history.trail });
  }
  const durationMs = next.phaseStartedAtMs - history.last.phaseStartedAtMs;
  if (durationMs < 0) return startRunPhaseHistory(next);
  const trail = [...history.trail, Object.freeze({ projection: history.last, durationMs })]
    .slice(-RUN_PHASE_TRAIL_LIMIT);
  return Object.freeze({ last: next, trail: Object.freeze(trail) });
}

export type RunPhaseTrailDisplay = Readonly<{ key: string; text: string }>;

/** Trail items as text; phases shorter than one whole second add nothing and are left out. */
export function describeRunPhaseTrail(
  history: RunPhaseHistory,
  messages: GuildMessages,
): readonly RunPhaseTrailDisplay[] {
  return Object.freeze(history.trail.flatMap((entry, index) => {
    const seconds = Math.floor(entry.durationMs / 1_000);
    if (seconds < 1) return [];
    return [Object.freeze({
      key: `${entry.projection.phaseStartedAtMs}-${index}`,
      text: `${runPhaseLabel(entry.projection, false, messages)} ${messages.runDuration(seconds)}`,
    })];
  }));
}
