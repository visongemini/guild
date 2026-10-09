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
