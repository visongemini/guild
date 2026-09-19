/**
 * Run states and command events (PC-RUN-001, PC-RUN-002, PC-RUN-003, PC-PERM-001).
 * Transition table: docs/08-STATE-MACHINES.md section 1.
 */

import type { AdapterEpoch, IdempotencyKey, SessionId } from "./ids.js";
import type { PermissionIdentity } from "./runtime-envelope.js";

export const RUN_STATES = Object.freeze([
  "queued",
  "starting",
  "running",
  "awaiting_permission",
  "completing",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const);

export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const);

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export function isTerminalRunState(
  state: RunState,
): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export const RUN_EFFECTS = Object.freeze([
  "record_dispatch",
  "persist_cancel_intent",
  "persist_prompt_correlation",
  "persist_permission_request",
  "persist_diagnostic",
  "persist_process_reason_close_epoch",
  "persist_exactly_once_resolution",
  "stage_terminal_response",
  "persist_explicit_error_close_permissions",
  "commit_final_output",
  "persist_recoverable_failure",
  "persist_cancel_intent_discard_completion",
  "close_permissions_commit_cancellation",
  "record_proof_close_epoch",
  "stage_truthful_result",
  "preserve_cancel_intent_and_terminal_reason",
  "persist_reason_expire_permissions_close_epoch",
  "persist_chronological_output",
  "return_exact_safe_permission_response",
  "record_local_not_dispatched_proof",
] as const);

export type RunEffect = (typeof RUN_EFFECTS)[number];

type Keyed = { readonly idempotencyKey: IdempotencyKey };

/** Permission admitted/resolution events carry the exact six-field identity (PC-PERM-001). */
type PermissionKeyed = Keyed & { readonly identity: PermissionIdentity };

export type RunEvent =
  | ({
      readonly type: "scheduler_dispatch";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
    } & Keyed)
  | ({ readonly type: "user_cancel" } & Keyed)
  | ({
      readonly type: "prompt_accepted";
      readonly sessionId: SessionId;
      readonly adapterEpoch: AdapterEpoch;
    } & Keyed)
  | ({ readonly type: "launch_failure" } & Keyed)
  | ({ readonly type: "process_lost_after_prompt" } & Keyed)
  | ({ readonly type: "permission_admitted" } & PermissionKeyed)
  | ({ readonly type: "permission_resolved_continue" } & PermissionKeyed)
  | ({ readonly type: "successful_terminal_response" } & Keyed)
  | ({ readonly type: "protocol_terminal_error" } & Keyed)
  | ({ readonly type: "final_commit_succeeded" } & Keyed)
  | ({ readonly type: "final_commit_failed" } & Keyed)
  | ({ readonly type: "cancel_wins_before_commit" } & Keyed)
  | ({ readonly type: "runtime_confirms_cancellation" } & Keyed)
  | ({ readonly type: "process_exit_confirms_cancellation" } & Keyed)
  | ({ readonly type: "ownership_lost_before_completion" } & Keyed)
  | { readonly type: "renderer_reload" }
  | { readonly type: "os_suspend" }
  | { readonly type: "os_resume" }
  | { readonly type: "transient_silence" }
  | ({ readonly type: "application_quit" } & Keyed)
  | ({ readonly type: "permission_denial" } & PermissionKeyed)
  | ({ readonly type: "permission_cancelled" } & PermissionKeyed)
  | ({ readonly type: "permission_expired" } & PermissionKeyed)
  | ({ readonly type: "permission_orphaned" } & PermissionKeyed)
  | ({ readonly type: "cancel_notification_written" } & Keyed)
  | ({
      readonly type: "live_update";
      readonly channel: LiveUpdateChannel;
    } & Keyed)
  | { readonly type: "stale_identity_event" };

export type RunEventType = RunEvent["type"];

export const LIVE_UPDATE_CHANNELS = Object.freeze(["session", "tool"] as const);
export type LiveUpdateChannel = (typeof LIVE_UPDATE_CHANNELS)[number];
