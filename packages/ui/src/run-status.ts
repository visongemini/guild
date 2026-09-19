import type {
  QueuedTurnProjection,
  RunState,
  TimelineItemProjection,
} from "@guild/contracts";

export type VisibleRunStage =
  | "queued"
  | "preparing"
  | "waiting_for_grok"
  | "completing"
  | "awaiting_permission"
  | "stopping";

export type VisibleRunStatus = Readonly<{
  stage: VisibleRunStage;
  startedAtMs: number;
}>;

type TimelineUser = TimelineItemProjection & { readonly kind: "user" };

/**
 * Keep the foreground honest while the official process has not emitted a
 * visible activity item yet. Once Grok starts streaming thought, authored
 * text, a tool, or a permission, the normal timeline owns the status.
 */
export function visibleRunStatus(
  runState: RunState | undefined,
  items: readonly TimelineItemProjection[],
  queuedTurns: readonly QueuedTurnProjection[],
): VisibleRunStatus | undefined {
  if (
    runState === undefined ||
    runState === "completed" ||
    runState === "failed" ||
    runState === "cancelled" ||
    runState === "interrupted"
  ) return undefined;

  const currentUser = currentRunUser(items, queuedTurns);
  const startedAtMs = currentUser?.createdAtMs ?? items.at(-1)?.updatedAtMs ?? 0;

  if (runState === "queued") return Object.freeze({ stage: "queued", startedAtMs });
  if (runState === "starting") return Object.freeze({ stage: "preparing", startedAtMs });
  if (runState === "completing") return Object.freeze({ stage: "completing", startedAtMs });
  if (runState === "cancel_requested") return Object.freeze({ stage: "stopping", startedAtMs });
  if (runState === "awaiting_permission") {
    const permissionVisible = currentUser !== undefined && items.some((item) =>
      item.sequence > currentUser.sequence &&
      item.kind === "permission" &&
      item.status === "waiting" &&
      sameRun(item, currentUser));
    return permissionVisible
      ? undefined
      : Object.freeze({ stage: "awaiting_permission", startedAtMs });
  }

  if (currentUser === undefined) {
    return Object.freeze({ stage: "waiting_for_grok", startedAtMs });
  }
  const visibleRuntimeActivity = items.some((item) =>
    item.sequence > currentUser.sequence &&
    item.kind !== "user" &&
    sameRun(item, currentUser));
  return visibleRuntimeActivity
    ? undefined
    : Object.freeze({ stage: "waiting_for_grok", startedAtMs: currentUser.createdAtMs });
}

function currentRunUser(
  items: readonly TimelineItemProjection[],
  queuedTurns: readonly QueuedTurnProjection[],
): TimelineUser | undefined {
  const firstQueuedAtMs = Math.min(
    ...queuedTurns.map((turn) => turn.createdAtMs),
    Number.POSITIVE_INFINITY,
  );
  return [...items].reverse().find(
    (item): item is TimelineUser =>
      item.kind === "user" && item.createdAtMs < firstQueuedAtMs,
  );
}

function sameRun(
  item: TimelineItemProjection,
  user: TimelineUser,
): boolean {
  return user.runId === undefined || item.runId === user.runId;
}
