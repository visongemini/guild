import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRunPhaseProjection, type XaiSignal } from "@guild/contracts";
import { createRunPhaseTracker, type RunPhaseInput, type RunPhaseTracker } from "./run-phase.js";

const WALL_AT_ZERO = 1_790_000_000_000;

function started(stage?: Parameters<RunPhaseTracker["begin"]>[2], at = 1_000): RunPhaseTracker {
  const tracker = createRunPhaseTracker();
  tracker.begin(at, WALL_AT_ZERO + at, stage);
  return tracker;
}

const signal = (value: XaiSignal): RunPhaseInput => ({ type: "signal", signal: value });
const hookStarted = (count = 1, event = "user_prompt_submit"): RunPhaseInput =>
  signal({ kind: "hook_run_started", event, count });
const hookDone = (event = "user_prompt_submit"): RunPhaseInput =>
  signal({ kind: "hook_execution", event, runs: 1, failed: 0, maxElapsedMs: 8 });
const queue = (queued: number, firstPosition: number | undefined, running = false): RunPhaseInput =>
  signal({ kind: "queue_changed", queued, ...(firstPosition === undefined ? {} : { firstPosition }), running });

describe("run phase tracker", () => {
  it("walks the pre-prompt stages and reports the MCP progress while a session opens", () => {
    const tracker = started();
    assert.equal(tracker.snapshot()?.phase, "starting_runtime");
    assert.equal(tracker.apply({ type: "opening_session" }, 1_300), true);
    assert.deepEqual(tracker.snapshot(), {
      phase: "opening_session",
      turnStartedAtMs: WALL_AT_ZERO + 1_000,
      phaseStartedAtMs: WALL_AT_ZERO + 1_300,
    });
    assert.equal(tracker.apply(signal({ kind: "mcp_init_progress", connected: 3, total: 7 }), 1_900), true);
    assert.deepEqual(
      [tracker.snapshot()?.mcpConnected, tracker.snapshot()?.mcpTotal, tracker.snapshot()?.phaseStartedAtMs],
      [3, 7, WALL_AT_ZERO + 1_300],
    );
    // Progress is detail only: the phase clock keeps running.
    assert.equal(tracker.apply(signal({ kind: "mcp_init_progress", connected: 3, total: 7 }), 2_000), false);
    assert.equal(tracker.apply({ type: "prompt_sent" }, 2_500), true);
    assert.deepEqual(tracker.snapshot(), {
      phase: "prompt_sent",
      turnStartedAtMs: WALL_AT_ZERO + 1_000,
      phaseStartedAtMs: WALL_AT_ZERO + 2_500,
    });
    // MCP progress after the prompt is not part of this turn.
    assert.equal(tracker.apply(signal({ kind: "mcp_init_progress", connected: 7, total: 7 }), 2_600), false);
  });

  it("stays on Sent until the runtime shows it took the prompt up, then follows the signals", () => {
    const tracker = started("prompt_sent");
    assert.equal(tracker.snapshot()?.phase, "prompt_sent");
    // Unrelated notices do not count as acceptance.
    assert.equal(tracker.apply(signal({ kind: "sessions_changed", sessions: [{ sessionId: "s", activity: "idle" }] }), 1_100), false);
    assert.equal(tracker.apply(signal({ kind: "model_changed", modelId: "grok-4.7" }), 1_110), false);
    assert.equal(tracker.apply(signal({ kind: "turn_completed", stopReason: "end_turn" }), 1_120), false);
    assert.equal(tracker.snapshot()?.phase, "prompt_sent");

    assert.equal(tracker.apply(signal({ kind: "sessions_changed", sessions: [{ sessionId: "s", activity: "working" }] }), 1_200), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
    assert.equal(tracker.snapshot()?.phaseStartedAtMs, WALL_AT_ZERO + 1_200);
    assert.equal(tracker.apply(hookStarted(2), 1_240), true);
    assert.deepEqual(
      [tracker.snapshot()?.phase, tracker.snapshot()?.hookCount],
      ["running_hooks", 2],
    );
    assert.equal(tracker.apply(hookStarted(3), 1_300), true, "a new hook count is a visible change");
    assert.equal(tracker.snapshot()?.phaseStartedAtMs, WALL_AT_ZERO + 1_240, "but it does not restart the phase clock");
    assert.equal(tracker.apply(hookDone(), 9_300), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
    assert.equal(tracker.apply({ type: "content", kind: "thought" }, 13_000), true);
    assert.equal(tracker.snapshot()?.phase, "thinking");
    assert.equal(tracker.apply({ type: "content", kind: "message" }, 14_500), true);
    assert.equal(tracker.snapshot()?.phase, "responding");
    assert.equal(tracker.apply({ type: "content", kind: "message" }, 14_600), false, "more chunks of the same kind change nothing");
    assert.equal(tracker.apply(signal({ kind: "response_completed" }), 20_000), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
  });

  it("shows a queue place only when something is ahead", () => {
    const tracker = started("prompt_sent");
    // The runtime's own transient 'prompt at position 0, nothing running' is not a queue.
    assert.equal(tracker.apply(queue(1, 0, false), 1_010), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
    assert.equal(tracker.snapshot()?.queuePosition, undefined);

    assert.equal(tracker.apply(queue(1, 0, true), 1_020), true);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.queuePosition], ["queued", 1]);
    assert.equal(tracker.apply(queue(2, 1, true), 1_030), true);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.queuePosition], ["queued", 2]);
    assert.equal(tracker.apply(queue(0, undefined, true), 1_040), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
  });

  it("derives tool preparation, tool execution and permission waits from Guild state plus the delta signal", () => {
    const tracker = started("prompt_sent");
    tracker.apply(hookStarted(), 1_010);
    tracker.apply(hookDone(), 1_020);
    assert.equal(tracker.apply(signal({ kind: "tool_call_delta_chunk", toolName: "run_terminal_command" }), 2_000), true);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.toolName], ["preparing_tool", "run_terminal_command"]);
    assert.equal(tracker.apply(signal({ kind: "tool_call_delta_chunk", toolName: "run_terminal_command" }), 2_010), false);

    // pre_tool_use hooks outrank the tool states while they run.
    tracker.apply(signal({ kind: "response_completed" }), 2_200);
    assert.equal(tracker.apply(hookStarted(1, "pre_tool_use"), 2_210), true);
    assert.equal(tracker.snapshot()?.phase, "running_hooks");
    tracker.apply({ type: "tool", toolCallId: "call-1", status: "pending", fallbackName: "execute" }, 2_220);
    tracker.apply(hookDone("pre_tool_use"), 2_230);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.toolName], ["preparing_tool", "run_terminal_command"]);

    // Guild's own permission request and the runtime's notice both count; either alone is enough.
    assert.equal(tracker.apply({ type: "permission", open: true }, 2_240), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_permission");
    assert.equal(tracker.apply(signal({ kind: "pending_interaction", interaction: "permission" }), 2_241), false);
    assert.equal(tracker.apply({ type: "permission", open: false }, 2_300), false, "the runtime notice still holds the wait");
    assert.equal(tracker.apply(signal({ kind: "interaction_resolved" }), 2_310), true);
    assert.equal(tracker.snapshot()?.phase, "preparing_tool");

    assert.equal(tracker.apply({ type: "tool", toolCallId: "call-1", status: "in_progress", fallbackName: "execute" }, 2_400), true);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.toolName], ["running_tool", "run_terminal_command"]);
    assert.equal(tracker.apply({ type: "tool", toolCallId: "call-1", status: "completed", fallbackName: "execute" }, 9_400), true);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
    assert.equal(tracker.snapshot()?.toolName, undefined);

    // A tool the runtime never named falls back to the ACP kind identifier.
    tracker.apply({ type: "tool", toolCallId: "call-2", status: "pending", fallbackName: "read" }, 9_410);
    tracker.apply({ type: "tool", toolCallId: "call-2", status: "in_progress", fallbackName: "read" }, 9_420);
    assert.deepEqual([tracker.snapshot()?.phase, tracker.snapshot()?.toolName], ["running_tool", "read"]);
    tracker.apply({ type: "tool", toolCallId: "call-2", status: "failed", fallbackName: "read" }, 9_430);
    assert.equal(tracker.snapshot()?.phase, "waiting_for_model");
  });

  it("shows retries with their attempt and clears them on progress or when the runtime says they ended", () => {
    const tracker = started("prompt_sent");
    tracker.apply({ type: "content", kind: "thought" }, 1_100);
    assert.equal(tracker.apply(signal({ kind: "retry_state", active: true, attempt: 1, maxRetries: 15, errorType: "http" }), 1_200), true);
    assert.deepEqual(
      [tracker.snapshot()?.phase, tracker.snapshot()?.attempt, tracker.snapshot()?.maxRetries],
      ["retrying", 1, 15],
    );
    assert.equal(tracker.apply(signal({ kind: "retry_state", active: true, attempt: 2, maxRetries: 15 }), 3_200), true);
    assert.equal(tracker.snapshot()?.attempt, 2);
    assert.equal(tracker.snapshot()?.phaseStartedAtMs, WALL_AT_ZERO + 1_200);
    assert.equal(tracker.apply(signal({ kind: "retry_state", active: false, attempt: 2, maxRetries: 15 }), 4_000), true);
    assert.equal(tracker.snapshot()?.phase, "thinking");
    tracker.apply(signal({ kind: "retry_state", active: true, attempt: 1, maxRetries: 15 }), 4_100);
    assert.equal(tracker.apply({ type: "content", kind: "message" }, 4_200), true);
    assert.equal(tracker.snapshot()?.phase, "responding");
  });

  it("computes stable wall-clock anchors from monotonic input and never lets time run backwards", () => {
    const tracker = started("prompt_sent", 50_000);
    const first = tracker.snapshot();
    assert.equal(first?.turnStartedAtMs, WALL_AT_ZERO + 50_000);
    tracker.apply(hookStarted(), 50_040);
    const hooks = tracker.snapshot();
    assert.equal(hooks?.turnStartedAtMs, WALL_AT_ZERO + 50_000);
    assert.equal(hooks?.phaseStartedAtMs, WALL_AT_ZERO + 50_040);
    // A stale timestamp from another source is clamped to the latest one seen.
    tracker.apply(hookDone(), 49_000);
    const clamped = tracker.snapshot();
    assert.equal(clamped?.phase, "waiting_for_model");
    assert.equal(clamped?.phaseStartedAtMs, WALL_AT_ZERO + 50_040);
    assert.ok((clamped?.phaseStartedAtMs ?? 0) >= (clamped?.turnStartedAtMs ?? 1));
    // Repeated snapshots of an unchanged state are equal and frozen, so projections share structure.
    assert.deepEqual(tracker.snapshot(), tracker.snapshot());
    assert.equal(Object.isFrozen(tracker.snapshot()), true);
  });

  it("is inert outside a turn and ignores everything that arrives after the turn ended", () => {
    const tracker = createRunPhaseTracker();
    assert.equal(tracker.active, false);
    assert.equal(tracker.apply(hookStarted(), 1), false);
    assert.equal(tracker.snapshot(), undefined);
    tracker.begin(10, WALL_AT_ZERO + 10, "prompt_sent");
    assert.equal(tracker.active, true);
    tracker.begin(99, WALL_AT_ZERO + 99, "starting_runtime");
    assert.equal(tracker.snapshot()?.turnStartedAtMs, WALL_AT_ZERO + 10, "begin during a turn does not restart it");
    tracker.apply(hookStarted(), 20);
    tracker.end();
    assert.equal(tracker.active, false);
    assert.equal(tracker.snapshot(), undefined);
    assert.equal(tracker.apply(queue(0, undefined), 30), false);
    tracker.begin(100, WALL_AT_ZERO + 100, "prompt_sent");
    assert.deepEqual(tracker.snapshot(), {
      phase: "prompt_sent",
      turnStartedAtMs: WALL_AT_ZERO + 100,
      phaseStartedAtMs: WALL_AT_ZERO + 100,
    });
  });

  it("follows the live timeline recorded from grok 1.0.50 and every projection validates", () => {
    // Offsets (ms) from a real turn: prompt at 6.27 s, 8 s user_prompt_submit hook, a permissioned tool.
    const tracker = createRunPhaseTracker();
    const phases: string[] = [];
    const record = (): void => {
      const snapshot = tracker.snapshot();
      if (snapshot !== undefined) {
        parseRunPhaseProjection(snapshot);
        if (phases.at(-1) !== snapshot.phase) phases.push(snapshot.phase);
      }
    };
    tracker.begin(0, WALL_AT_ZERO, "starting_runtime"); record();
    tracker.apply({ type: "opening_session" }, 20); record();
    tracker.apply(signal({ kind: "session_setup", phase: "agent_build" }), 100); record();
    tracker.apply(signal({ kind: "mcp_init_progress", connected: 7, total: 7 }), 1_400); record();
    tracker.apply({ type: "prompt_sent" }, 1_500); record();
    tracker.apply(signal({ kind: "sessions_changed", sessions: [{ sessionId: "s", activity: "working" }] }), 1_510); record();
    tracker.apply(queue(1, 0, false), 1_511); record();
    tracker.apply(queue(0, undefined, true), 1_512); record();
    tracker.apply(hookStarted(1), 1_530); record();
    tracker.apply(hookDone(), 9_500); record();
    tracker.apply({ type: "content", kind: "thought" }, 13_600); record();
    tracker.apply(signal({ kind: "tool_call_delta_chunk", toolName: "run_terminal_command" }), 15_000); record();
    tracker.apply(signal({ kind: "response_completed" }), 15_200); record();
    tracker.apply(hookStarted(1, "pre_tool_use"), 15_210); record();
    tracker.apply({ type: "tool", toolCallId: "c", status: "pending", fallbackName: "execute" }, 15_220); record();
    tracker.apply(hookDone("pre_tool_use"), 15_260); record();
    tracker.apply(signal({ kind: "pending_interaction", interaction: "permission" }), 15_261); record();
    tracker.apply({ type: "permission", open: true }, 15_262); record();
    tracker.apply({ type: "permission", open: false }, 20_000); record();
    tracker.apply(signal({ kind: "interaction_resolved" }), 20_001); record();
    tracker.apply({ type: "tool", toolCallId: "c", status: "in_progress", fallbackName: "execute" }, 20_010); record();
    tracker.apply({ type: "tool", toolCallId: "c", status: "completed", fallbackName: "execute" }, 32_000); record();
    tracker.apply({ type: "content", kind: "message" }, 34_000); record();
    tracker.apply(signal({ kind: "response_completed" }), 35_000); record();
    tracker.apply(hookStarted(1, "stop"), 35_010); record();
    tracker.apply(hookDone("stop"), 35_070); record();
    assert.deepEqual(phases, [
      "starting_runtime", "opening_session", "prompt_sent", "waiting_for_model", "running_hooks",
      "waiting_for_model", "thinking", "preparing_tool", "running_hooks",
      "preparing_tool", "waiting_for_permission", "preparing_tool", "running_tool", "waiting_for_model",
      "responding", "waiting_for_model", "running_hooks", "waiting_for_model",
    ]);
  });
});
