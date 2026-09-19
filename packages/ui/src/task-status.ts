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
