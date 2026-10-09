import type { TaskSummaryProjection } from "@guild/contracts";

export type SidebarTaskStatus =
  | "idle"
  | "running"
  | "queued"
  | "permission"
  | "failed"
  | "interrupted"
  | "cancelled";

export function sidebarTaskStatus(task: TaskSummaryProjection): SidebarTaskStatus {
  if (task.activeRunState === "awaiting_permission") return "permission";
  if (task.activeRunState === "failed") return "failed";
  if (task.activeRunState === "interrupted") return "interrupted";
  if (task.activeRunState === "cancelled") return "cancelled";
  if (
    task.activeRunState === "queued" ||
    task.activeRunState === "starting" ||
    task.activeRunState === "running" ||
    task.activeRunState === "completing" ||
    task.activeRunState === "cancel_requested"
  ) return "running";
  if ((task.queuedTurnCount ?? 0) > 0) return "queued";
  return "idle";
}

const WORKSPACE_STATUS_PRIORITY: readonly SidebarTaskStatus[] = Object.freeze([
  "permission",
  "running",
  "queued",
  "failed",
  "interrupted",
  "cancelled",
  "idle",
]);

export function workspaceTaskStatus(
  tasks: readonly TaskSummaryProjection[],
): SidebarTaskStatus {
  const statuses = new Set(tasks.map(sidebarTaskStatus));
  return WORKSPACE_STATUS_PRIORITY.find((status) => statuses.has(status)) ?? "idle";
}

/** The statuses in which a run is still working; a task leaving them quietly has a new result. */
function isWorking(status: SidebarTaskStatus): boolean {
  return status === "running";
}

/**
 * Which tasks carry a "new result" mark. The projection has no unread flag, so the mark is derived
 * from what the window itself saw: a task that stopped working without failing, being cancelled or
 * being interrupted, while it was not the open task, has something new to read. Opening the task
 * clears it, and a task that no longer exists is dropped. `previous` is the status each task had in
 * the last projection; a task seen for the first time never gets the mark.
 */
export function nextUnreadTaskIds(
  previous: ReadonlyMap<string, SidebarTaskStatus>,
  tasks: readonly TaskSummaryProjection[],
  activeTaskId: string | undefined,
  unread: ReadonlySet<string>,
): ReadonlySet<string> {
  const next = new Set<string>();
  const present = new Set<string>(tasks.map((task) => task.taskId));
  for (const taskId of unread) if (present.has(taskId) && taskId !== activeTaskId) next.add(taskId);
  for (const task of tasks) {
    if (task.taskId === activeTaskId) continue;
    const before = previous.get(task.taskId);
    const now = sidebarTaskStatus(task);
    if (before !== undefined && isWorking(before) && now === "idle") next.add(task.taskId);
  }
  const unchanged = next.size === unread.size && [...next].every((taskId) => unread.has(taskId));
  return unchanged ? unread : next;
}

/** Status of every task by id, the `previous` argument of the next `nextUnreadTaskIds` call. */
export function taskStatusSnapshot(
  tasks: readonly TaskSummaryProjection[],
): ReadonlyMap<string, SidebarTaskStatus> {
  return new Map(tasks.map((task) => [task.taskId, sidebarTaskStatus(task)]));
}
