import type { RunState, TaskId, TaskSummaryProjection } from "@guild/contracts";

export type TaskNotificationKind = "permission" | "completed" | "failed" | "interrupted";

export type TaskNotificationEvent = Readonly<{
  taskId: TaskId;
  title: string;
  kind: TaskNotificationKind;
}>;

export type TaskNotificationSnapshot = ReadonlyMap<TaskId, RunState | undefined>;

export function deliverTaskNotification(
  notification: Readonly<{
    on: (event: "click", listener: () => void) => void;
    show: () => void;
  }>,
  onClick: () => void,
): void {
  notification.on("click", onClick);
  notification.show();
}

const MAX_NOTIFICATION_TITLE_LENGTH = 80;

function conciseTitle(title: string): string {
  const normalized = title.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_NOTIFICATION_TITLE_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_NOTIFICATION_TITLE_LENGTH - 1)}…`;
}

export function taskNotificationBody(
  event: TaskNotificationEvent,
  locale: "zh-CN" | "en-US",
): string {
  const title = conciseTitle(event.title);
  if (locale === "zh-CN") {
    if (event.kind === "permission") return `“${title}”正在等待授权`;
    if (event.kind === "completed") return `“${title}”已完成`;
    if (event.kind === "failed") return `“${title}”失败，需要查看`;
    return `“${title}”已中断，可以继续`;
  }
  if (event.kind === "permission") return `“${title}” is waiting for approval`;
  if (event.kind === "completed") return `“${title}” finished`;
  if (event.kind === "failed") return `“${title}” failed and needs attention`;
  return `“${title}” was interrupted and can be continued`;
}

export function collectTaskNotificationEvents(
  previous: TaskNotificationSnapshot | undefined,
  tasks: readonly TaskSummaryProjection[],
): Readonly<{
  snapshot: TaskNotificationSnapshot;
  events: readonly TaskNotificationEvent[];
}> {
  const snapshot = new Map<TaskId, RunState | undefined>();
  const events: TaskNotificationEvent[] = [];
  for (const task of tasks) {
    const current = task.activeRunState;
    snapshot.set(task.taskId, current);
    if (previous === undefined || !previous.has(task.taskId)) continue;
    const prior = previous.get(task.taskId);
    if (current === "awaiting_permission" && prior !== "awaiting_permission") {
      events.push(Object.freeze({ taskId: task.taskId, title: task.title, kind: "permission" }));
      continue;
    }
    if (
      (current === "completed" || current === "failed" || current === "interrupted") &&
      prior !== current
    ) {
      events.push(Object.freeze({
        taskId: task.taskId,
        title: task.title,
        kind: current,
      }));
    }
  }
  return Object.freeze({ snapshot, events: Object.freeze(events) });
}
