import type { TaskSummaryProjection } from "@guild/contracts";
import { sidebarTaskStatus } from "./task-status.js";

/** How many other tasks the strip above the conversation may show. */
export const ATTENTION_STRIP_LIMIT = 4;

/**
 * The "in progress" strip lists the other tasks that are working or waiting for the user. A task that
 * failed, was interrupted or cancelled is not in progress, the open task is already on screen, and an
 * archived task is out of the way, so none of them belong here. Newest activity first.
 */
export function attentionStripTasks(
  tasks: readonly TaskSummaryProjection[],
  openTaskId: string | undefined,
  limit: number = ATTENTION_STRIP_LIMIT,
): readonly TaskSummaryProjection[] {
  return Object.freeze(tasks
    .filter((task) => {
      if (task.archived || task.taskId === openTaskId) return false;
      const status = sidebarTaskStatus(task);
      return status === "running" || status === "permission";
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, limit));
}
