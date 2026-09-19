import type { TimelineItemProjection } from "@guild/contracts";

/** PC-CONV-001: the conversation pane is the only scrollport. */

export function isConversationPinnedToBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = 72,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= thresholdPx;
}

export function shouldLoadEarlierConversation(
  hasEarlier: boolean,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  thresholdPx = 72,
): boolean {
  if (!hasEarlier) return false;
  return scrollTop <= thresholdPx || scrollHeight <= clientHeight + thresholdPx;
}

export function scrollTopAfterPrepend(
  previousScrollTop: number,
  previousScrollHeight: number,
  nextScrollHeight: number,
): number {
  return Math.max(0, previousScrollTop + Math.max(0, nextScrollHeight - previousScrollHeight));
}

export function mergeTimelineWindows(
  retained: readonly TimelineItemProjection[],
  incoming: readonly TimelineItemProjection[],
): readonly TimelineItemProjection[] {
  const merged = new Map<string, TimelineItemProjection>();
  for (const item of retained) merged.set(timelineIdentity(item), item);
  for (const item of incoming) merged.set(timelineIdentity(item), item);
  return Object.freeze([...merged.values()].sort((left, right) =>
    left.sequence - right.sequence ||
    left.updatedAtMs - right.updatedAtMs ||
    left.entryId.localeCompare(right.entryId)));
}

export const MAX_RETAINED_TASK_TIMELINES = 16;

export function retainTimelineWindow(
  cache: Map<string, readonly TimelineItemProjection[]>,
  taskId: string,
  timeline: readonly TimelineItemProjection[],
  maximumTaskCount = MAX_RETAINED_TASK_TIMELINES,
): void {
  if (!Number.isSafeInteger(maximumTaskCount) || maximumTaskCount < 1) {
    throw new RangeError("invalid_maximum_task_count");
  }
  cache.delete(taskId);
  cache.set(taskId, timeline);
  while (cache.size > maximumTaskCount) {
    const oldestTaskId = cache.keys().next().value as string | undefined;
    if (oldestTaskId === undefined) break;
    cache.delete(oldestTaskId);
  }
}

function timelineIdentity(item: TimelineItemProjection): string {
  return item.kind === "tool" && item.toolCallId !== undefined
    ? `tool:${item.toolCallId}`
    : `entry:${item.entryId}`;
}
