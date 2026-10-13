import { GUILD_MAX_MESSAGE_LENGTH } from "@guild/contracts/desktop-ipc";

export type ComposerSendFailure = "claude_start" | "engine_start" | "message" | "recovery" | "runtime" | "workspace";

export function isComposerTextTooLong(text: string): boolean {
  return text.length > GUILD_MAX_MESSAGE_LENGTH;
}

export function classifyComposerSendFailure(cause: unknown): ComposerSendFailure {
  const text = causeText(cause);
  if (text.includes("workspace_folder_missing")) return "workspace";
  if (text.includes("session_recovery_context_required")) return "recovery";
  // PC-ENG-002: Claude is still starting; the task keeps its session and the next send retries.
  if (text.includes("claude_start_timeout")) return "claude_start";
  // PC-ENG-003: the same for an add-on engine (Codex); the task says which engine it is.
  if (text.includes("engine_start_timeout")) return "engine_start";
  if (
    text.includes("invalid_draft") ||
    text.includes("invalid_message") ||
    text.includes("message_too_long")
  ) {
    return "message";
  }
  return "runtime";
}

function causeText(cause: unknown): string {
  if (cause instanceof Error) {
    const nested = cause.cause === undefined ? "" : causeText(cause.cause);
    return `${cause.message} ${nested}`;
  }
  return String(cause);
}
