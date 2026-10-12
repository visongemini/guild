import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const WORKSPACE_FOLDER_MISSING = "workspace_folder_missing";
export const SESSION_RECOVERY_CONTEXT_REQUIRED = "session_recovery_context_required";
export const MESSAGE_TOO_LONG = "message_too_long";

export async function workspaceFolderExists(canonicalPath: string): Promise<boolean> {
  if (canonicalPath.length === 0 || !isAbsolute(canonicalPath)) {
    return false;
  }
  try {
    const resolved = await realpath(canonicalPath);
    return (await stat(resolved)).isDirectory();
  } catch {
    return false;
  }
}

export async function assertWorkspaceFolderExists(canonicalPath: string): Promise<void> {
  if (!(await workspaceFolderExists(canonicalPath))) {
    throw new Error(WORKSPACE_FOLDER_MISSING);
  }
}

/** F3: `worktree_<reason>` from a refused isolated-worktree creation; the reason is a fixed code, never a path. */
const WORKTREE_REFUSAL_MESSAGE = /^worktree_[a-z_]{1,48}$/u;

/** Guild 3.0: `model_source_<reason>` from the model sources service; the reason is a fixed code, never a path or key. */
const MODEL_SOURCE_REFUSAL_MESSAGE = /^model_source_[a-z_]{1,48}$/u;

export function toDesktopIpcFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : "";
  if (WORKTREE_REFUSAL_MESSAGE.test(message) || MODEL_SOURCE_REFUSAL_MESSAGE.test(message)) return new Error(message);
  if (
    message === WORKSPACE_FOLDER_MISSING ||
    message === SESSION_RECOVERY_CONTEXT_REQUIRED ||
    message === MESSAGE_TOO_LONG
  ) {
    return new Error(message);
  }
  return new Error("guild_operation_failed");
}
