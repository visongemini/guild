/**
 * First-token phase tracker (F1b).
 *
 * A pure, deterministic reducer that answers one question while a turn runs: what is Guild
 * actually waiting for right now? It is fed
 *  - Guild-authoritative facts (runtime starting, session opening, prompt written, streamed
 *    thought/message content, tool state, permission open/closed), and
 *  - the allowlisted `_x.ai/*` signals (queue, hooks, tool preparation, retry, setup progress).
 * Every input carries a monotonic timestamp. The tracker owns no timers: the renderer's 1 Hz
 * display tick is the only clock that runs while a turn is active.
 *
 * The projection is ephemeral display state. Wall-clock anchors are calibrated once per turn
 * (`begin`) and derived from monotonic input times, so they stay stable while a phase lasts and
 * a structurally shared projection does not churn.
 */

import {
  type GuildRunPhase,
  type RunPhaseProjection,
  type XaiSignal,
} from "@guild/contracts";

export type RunPhaseStage = "starting_runtime" | "opening_session" | "prompt_sent";

export type RunPhaseToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type RunPhaseInput =
  | Readonly<{ type: "opening_session" }>
  | Readonly<{ type: "prompt_sent" }>
  | Readonly<{ type: "signal"; signal: XaiSignal }>
  | Readonly<{ type: "content"; kind: "thought" | "message" }>
  | Readonly<{
      type: "tool";
      toolCallId: string;
      status: RunPhaseToolStatus;
      /** Safe identifier used when the runtime announced no tool name (for example the ACP tool kind). */
      fallbackName: string;
    }>
  | Readonly<{ type: "permission"; open: boolean }>;

export interface RunPhaseTracker {
  readonly active: boolean;
  /** Starts a turn; a no-op while one is already active. */
  begin(atMs: number, wallNowMs: number, stage?: RunPhaseStage): void;
  /** Applies one input. Returns true when the projection changed and a publish is worthwhile. */
  apply(input: RunPhaseInput, atMs: number): boolean;
  end(): void;
  snapshot(): RunPhaseProjection | undefined;
}

type Derived = Readonly<{
  phase: GuildRunPhase;
  queuePosition?: number;
  hookCount?: number;
  toolName?: string;
  attempt?: number;
  maxRetries?: number;
  mcpConnected?: number;
  mcpTotal?: number;
}>;

const MAX_PENDING_TOOL_NAMES = 8;
const MAX_TRACKED_TOOLS = 64;

export function createRunPhaseTracker(): RunPhaseTracker {
  let active = false;
  let stage: RunPhaseStage = "starting_runtime";
  let accepted = false;
  let wallOffsetMs = 0;
  let lastAtMs = 0;
  let turnStartedAtMs = 0;
  let phaseStartedAtMs = 0;
  let derived: Derived | undefined;

  let mcp: Readonly<{ connected: number; total: number }> | undefined;
  let queuePosition: number | undefined;
  let hookCount = 0;
  let content: "thought" | "message" | undefined;
  let retry: Readonly<{ attempt: number; maxRetries: number }> | undefined;
  let guildPermissionOpen = false;
  let runtimePermissionOpen = false;
  let deltaToolNames: string[] = [];
  const pendingTools = new Map<string, string>();
  const runningTools = new Map<string, string>();

  const wallAt = (atMs: number): number => Math.max(0, Math.round(wallOffsetMs + atMs));

  function reset(): void {
    active = false;
    accepted = false;
    derived = undefined;
    mcp = undefined;
    queuePosition = undefined;
    hookCount = 0;
    content = undefined;
    retry = undefined;
    guildPermissionOpen = false;
    runtimePermissionOpen = false;
    deltaToolNames = [];
    pendingTools.clear();
    runningTools.clear();
  }

  function derive(): Derived {
    if (stage === "starting_runtime") return { phase: "starting_runtime" };
    if (stage === "opening_session") {
      return {
        phase: "opening_session",
        ...(mcp === undefined ? {} : { mcpConnected: mcp.connected, mcpTotal: mcp.total }),
      };
    }
    if (!accepted) return { phase: "prompt_sent" };
    if (guildPermissionOpen || runtimePermissionOpen) return { phase: "waiting_for_permission" };
    if (retry !== undefined) {
      return { phase: "retrying", attempt: retry.attempt, maxRetries: retry.maxRetries };
    }
    if (queuePosition !== undefined) return { phase: "queued", queuePosition };
    if (hookCount > 0) return { phase: "running_hooks", hookCount };
    const running = lastValue(runningTools);
    if (running !== undefined) return { phase: "running_tool", toolName: running };
    const preparing = lastValue(pendingTools) ?? deltaToolNames[0];
    if (preparing !== undefined) return { phase: "preparing_tool", toolName: preparing };
    if (content === "message") return { phase: "responding" };
    if (content === "thought") return { phase: "thinking" };
    return { phase: "waiting_for_model" };
  }

  /** Recomputes the phase; returns true when anything visible changed. */
  function refresh(atMs: number): boolean {
    const next = derive();
    const previous = derived;
    derived = next;
    if (previous === undefined) {
      phaseStartedAtMs = wallAt(atMs);
      return true;
    }
    if (previous.phase !== next.phase) {
      phaseStartedAtMs = wallAt(atMs);
      return true;
    }
    return (
      previous.queuePosition !== next.queuePosition ||
      previous.hookCount !== next.hookCount ||
      previous.toolName !== next.toolName ||
      previous.attempt !== next.attempt ||
      previous.maxRetries !== next.maxRetries ||
      previous.mcpConnected !== next.mcpConnected ||
      previous.mcpTotal !== next.mcpTotal
    );
  }

  /** Any sign that the runtime took the prompt up: queue, working activity, hooks, content, tools. */
  function markAccepted(): void {
    if (stage === "prompt_sent") accepted = true;
  }

  function applySignal(signal: XaiSignal): void {
    switch (signal.kind) {
      case "session_setup":
        return;
      case "mcp_init_progress":
        if (stage === "starting_runtime" || stage === "opening_session") {
          mcp = Object.freeze({ connected: signal.connected, total: signal.total });
        }
        return;
      case "models_update":
      case "model_changed":
      case "turn_completed":
      case "prompt_complete":
        // Terminal truth comes from the prompt response Guild owns, not from these notices.
        return;
      default:
        break;
    }
    if (stage !== "prompt_sent") return;
    switch (signal.kind) {
      case "queue_changed":
        markAccepted();
        queuePosition = signal.queued > 0 && signal.firstPosition !== undefined &&
            (signal.running || signal.firstPosition >= 1)
          ? signal.firstPosition + 1
          : undefined;
        return;
      case "sessions_changed":
        if (signal.sessions.some((session) => session.activity === "working")) markAccepted();
        return;
      case "hook_run_started":
        markAccepted();
        hookCount = Math.max(1, signal.count);
        return;
      case "hook_execution":
        markAccepted();
        hookCount = 0;
        return;
      case "tool_call_delta_chunk":
        markAccepted();
        if (!deltaToolNames.includes(signal.toolName)) {
          deltaToolNames.push(signal.toolName);
          if (deltaToolNames.length > MAX_PENDING_TOOL_NAMES) deltaToolNames.shift();
        }
        return;
      case "pending_interaction":
        markAccepted();
        if (signal.interaction === "permission") runtimePermissionOpen = true;
        return;
      case "interaction_resolved":
        runtimePermissionOpen = false;
        return;
      case "retry_state":
        markAccepted();
        retry = signal.active
          ? Object.freeze({ attempt: signal.attempt, maxRetries: signal.maxRetries })
          : undefined;
        return;
      case "response_completed":
        markAccepted();
        content = undefined;
        retry = undefined;
        return;
    }
  }

  return {
    get active(): boolean {
      return active;
    },
    begin(atMs, wallNowMs, initialStage = "starting_runtime") {
      if (active) return;
      reset();
      active = true;
      stage = initialStage;
      wallOffsetMs = wallNowMs - atMs;
      lastAtMs = atMs;
      turnStartedAtMs = wallAt(atMs);
      refresh(atMs);
    },
    apply(input, atMs) {
      if (!active) return false;
      const at = Math.max(atMs, lastAtMs);
      lastAtMs = at;
      switch (input.type) {
        case "opening_session":
          if (stage === "starting_runtime") stage = "opening_session";
          break;
        case "prompt_sent":
          if (stage !== "prompt_sent") {
            stage = "prompt_sent";
            mcp = undefined;
          }
          break;
        case "signal":
          applySignal(input.signal);
          break;
        case "content":
          markAccepted();
          content = input.kind;
          retry = undefined;
          deltaToolNames = [];
          break;
        case "tool": {
          markAccepted();
          content = undefined;
          retry = undefined;
          if (input.status === "pending") {
            if (pendingTools.size < MAX_TRACKED_TOOLS || pendingTools.has(input.toolCallId)) {
              pendingTools.set(input.toolCallId, deltaToolNames.shift() ?? input.fallbackName);
            }
          } else if (input.status === "in_progress") {
            const name = pendingTools.get(input.toolCallId) ??
              runningTools.get(input.toolCallId) ??
              deltaToolNames.shift() ??
              input.fallbackName;
            pendingTools.delete(input.toolCallId);
            if (runningTools.size < MAX_TRACKED_TOOLS || runningTools.has(input.toolCallId)) {
              runningTools.set(input.toolCallId, name);
            }
          } else {
            pendingTools.delete(input.toolCallId);
            runningTools.delete(input.toolCallId);
          }
          break;
        }
        case "permission":
          markAccepted();
          guildPermissionOpen = input.open;
          break;
      }
      return refresh(at);
    },
    end() {
      reset();
    },
    snapshot() {
      if (!active || derived === undefined) return undefined;
      return Object.freeze({
        phase: derived.phase,
        turnStartedAtMs,
        phaseStartedAtMs,
        ...(derived.queuePosition === undefined ? {} : { queuePosition: derived.queuePosition }),
        ...(derived.hookCount === undefined ? {} : { hookCount: derived.hookCount }),
        ...(derived.toolName === undefined ? {} : { toolName: derived.toolName }),
        ...(derived.attempt === undefined ? {} : { attempt: derived.attempt }),
        ...(derived.maxRetries === undefined ? {} : { maxRetries: derived.maxRetries }),
        ...(derived.mcpConnected === undefined ? {} : { mcpConnected: derived.mcpConnected }),
        ...(derived.mcpTotal === undefined ? {} : { mcpTotal: derived.mcpTotal }),
      });
    },
  };
}

function lastValue(map: ReadonlyMap<string, string>): string | undefined {
  let last: string | undefined;
  for (const value of map.values()) last = value;
  return last;
}
