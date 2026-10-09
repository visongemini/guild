import assert from "node:assert/strict";
import test from "node:test";
import { GUILD_RUN_PHASES, GUILD_RUN_PHASE_SENT_NOTICE_MS, isRunPhase, parseRunPhaseProjection } from "./run-phase.js";
import { XAI_SESSION_NOTIFICATION_SUBTYPES, XAI_SIGNAL_NOTIFICATIONS } from "./xai-signals.js";

test("the phase projection accepts only enum-like phases, counts and a bounded tool identifier", () => {
  assert.equal(GUILD_RUN_PHASE_SENT_NOTICE_MS, 10_000);
  for (const phase of GUILD_RUN_PHASES) {
    assert.equal(isRunPhase(phase), true);
    assert.deepEqual(
      parseRunPhaseProjection({ phase, turnStartedAtMs: 1_790_000_000_000, phaseStartedAtMs: 1_790_000_000_500 }),
      { phase, turnStartedAtMs: 1_790_000_000_000, phaseStartedAtMs: 1_790_000_000_500 },
    );
  }
  assert.deepEqual(
    parseRunPhaseProjection({
      phase: "running_tool", turnStartedAtMs: 1, phaseStartedAtMs: 2, toolName: "run_terminal_command",
      hookCount: 2, queuePosition: 3, attempt: 1, maxRetries: 15, mcpConnected: 3, mcpTotal: 7,
    }),
    {
      phase: "running_tool", turnStartedAtMs: 1, phaseStartedAtMs: 2, queuePosition: 3, hookCount: 2,
      toolName: "run_terminal_command", attempt: 1, maxRetries: 15, mcpConnected: 3, mcpTotal: 7,
    },
  );
  const base = { phase: "thinking", turnStartedAtMs: 1, phaseStartedAtMs: 2 };
  for (const bad of [
    null, "x", [], { ...base, phase: "free_text" }, { ...base, extra: "raw payload" },
    { ...base, turnStartedAtMs: -1 }, { ...base, phaseStartedAtMs: 1.5 }, { ...base, hookCount: -1 },
    { ...base, queuePosition: 2_000_000 }, { ...base, toolName: "rm -rf /" }, { ...base, toolName: "x".repeat(65) },
    { phase: "thinking" },
  ]) {
    assert.throws(() => parseRunPhaseProjection(bad), /invalid_run_phase/u, JSON.stringify(bad));
  }
  assert.equal(isRunPhase("running"), false);
});

test("the extension allowlist is exactly the F1b set plus the Steer echo and nothing leaks in by prefix", () => {
  assert.deepEqual([...XAI_SIGNAL_NOTIFICATIONS].sort(), [
    "_x.ai/mcp/init_progress",
    "_x.ai/models/update",
    "_x.ai/queue/changed",
    "_x.ai/session/interjection",
    "_x.ai/session/prompt_complete",
    "_x.ai/session/setup",
    "_x.ai/session_notification",
    "_x.ai/sessions/changed",
  ]);
  assert.deepEqual([...XAI_SESSION_NOTIFICATION_SUBTYPES].sort(), [
    "hook_execution", "hook_run_started", "interaction_resolved", "model_changed", "pending_interaction",
    "response_completed", "retry_state", "tool_call_delta_chunk", "turn_completed",
  ]);
  for (const forbidden of ["_x.ai/mcp/servers_updated", "_x.ai/mcp/server_status", "_x.ai/settings/update", "_x.ai/session/fork", "_x.ai/rewind/execute"]) {
    assert.equal((XAI_SIGNAL_NOTIFICATIONS as readonly string[]).includes(forbidden), false, forbidden);
  }
});
