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

export function toDesktopIpcFailure(cause: unknown): Error {
  const message = cause instanceof Error ? cause.message : "";
  if (
    message === WORKSPACE_FOLDER_MISSING ||
    message === SESSION_RECOVERY_CONTEXT_REQUIRED ||
    message === MESSAGE_TOO_LONG
  ) {
    return new Error(message);
  }
  return new Error("guild_operation_failed");
}
