/**
 * Typed, bounded signals from the official runtime's `_x.ai/*` extension notifications (F1b).
 *
 * Only the notifications listed in `XAI_SIGNAL_NOTIFICATIONS` are ever turned into a signal; the
 * ACP adapter ignores every other extension notification without storing it. A signal keeps only
 * enum-like identifiers and counts: never prompt text, hook names or output, tool arguments,
 * usage payloads, signatures, MCP settings or any other free text. Signals are ephemeral: they
 * drive display state and are never persisted.
 */

import type { GrokModelCatalog } from "./grok-models.js";

/** Every extension notification Guild understands; anything else is dropped at the adapter. */
export const XAI_SIGNAL_NOTIFICATIONS = Object.freeze([
  "_x.ai/queue/changed",
  "_x.ai/sessions/changed",
  "_x.ai/session_notification",
  "_x.ai/session/prompt_complete",
  "_x.ai/session/setup",
  "_x.ai/mcp/init_progress",
  "_x.ai/models/update",
] as const);

/** `_x.ai/session_notification` subtypes that become signals. */
export const XAI_SESSION_NOTIFICATION_SUBTYPES = Object.freeze([
  "hook_run_started",
  "hook_execution",
  "tool_call_delta_chunk",
  "pending_interaction",
  "interaction_resolved",
  "retry_state",
  "response_completed",
  "turn_completed",
  "model_changed",
] as const);

export const XAI_SIGNAL_LIMITS = Object.freeze({
  identifierLength: 64,
  maxCount: 1_000_000,
  maxSessions: 32,
  maxElapsedMs: 86_400_000,
});

/** Bounded lowercase-or-mixed identifier such as `user_prompt_submit` or `run_terminal_command`. */
export type XaiIdentifier = string;

export type XaiSessionActivity = "working" | "idle" | "other";

export type XaiSignal =
  | Readonly<{
      kind: "queue_changed";
      /** Entries waiting in the runtime's own prompt queue. */
      queued: number;
      /** Zero-based position of the first waiting prompt; absent when none waits. */
      firstPosition?: number;
      /** True while the runtime is executing a prompt other than the waiting ones. */
      running: boolean;
    }>
  | Readonly<{
      kind: "sessions_changed";
      sessions: readonly Readonly<{ sessionId: string; activity: XaiSessionActivity }>[];
    }>
  | Readonly<{ kind: "hook_run_started"; event: XaiIdentifier; count: number; toolName?: XaiIdentifier }>
  | Readonly<{
      kind: "hook_execution";
      event: XaiIdentifier;
      runs: number;
      failed: number;
      maxElapsedMs: number;
    }>
  | Readonly<{ kind: "tool_call_delta_chunk"; toolName: XaiIdentifier }>
  | Readonly<{ kind: "pending_interaction"; interaction: XaiIdentifier }>
  | Readonly<{ kind: "interaction_resolved" }>
  | Readonly<{
      kind: "retry_state";
      /** True while the runtime is retrying; false once it reports the retry ended. */
      active: boolean;
      attempt: number;
      maxRetries: number;
      /** Coarse category reported by the runtime (for example `http`); the reason text is dropped. */
      errorType?: XaiIdentifier;
    }>
  | Readonly<{ kind: "response_completed" }>
  | Readonly<{ kind: "turn_completed"; stopReason?: XaiIdentifier }>
  | Readonly<{ kind: "prompt_complete"; stopReason?: XaiIdentifier }>
  | Readonly<{ kind: "model_changed"; modelId: string; reasoningEffort?: string }>
  | Readonly<{ kind: "session_setup"; phase: XaiIdentifier }>
  | Readonly<{ kind: "mcp_init_progress"; connected: number; total: number }>
  | Readonly<{ kind: "models_update"; catalog: GrokModelCatalog }>;

export type XaiSignalKind = XaiSignal["kind"];

/** One accepted notification with the monotonic receive time the adapter stamped on it. */
export type XaiSignalEnvelope = Readonly<{
  /** Session the notification names; null for pre-session setup notifications. */
  sessionId: string | null;
  signal: XaiSignal;
  receivedMonotonicMs: number;
}>;
