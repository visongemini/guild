import assert from "node:assert/strict";
import test from "node:test";
import type {
  QueuedTurnProjection,
  RunId,
  TaskId,
  TimelineItemProjection,
} from "@guild/contracts";
import { visibleRunStatus } from "./run-status.js";

const TASK_ID = "task-run-status" as TaskId;
const RUN_ID = "run-active" as RunId;

test("shows every official pre-activity stage without inventing runtime work", () => {
  const items = [user(10, RUN_ID, "Go")];
  assert.deepEqual(visibleRunStatus("queued", items, []), {
    stage: "queued",
    startedAtMs: 10,
  });
  assert.deepEqual(visibleRunStatus("starting", items, []), {
    stage: "preparing",
    startedAtMs: 10,
  });
  assert.deepEqual(visibleRunStatus("running", items, []), {
    stage: "waiting_for_grok",
    startedAtMs: 10,
  });
  assert.deepEqual(visibleRunStatus("completing", items, []), {
    stage: "completing",
    startedAtMs: 10,
  });
  assert.deepEqual(visibleRunStatus("cancel_requested", items, []), {
    stage: "stopping",
    startedAtMs: 10,
  });
});

test("hands status ownership to the real timeline after the first Grok event", () => {
  const items = [
    user(10, RUN_ID, "Go"),
    thought(11, RUN_ID, "Thinking"),
  ];
  assert.equal(visibleRunStatus("running", items, []), undefined);
});

test("a queued follow-up never replaces the active run waiting anchor", () => {
  const queued: QueuedTurnProjection = Object.freeze({
    queueId: "queue-next",
    text: "Next",
    createdAtMs: 20,
  });
  const items = [
    user(10, RUN_ID, "Go"),
    user(20, "run-next" as RunId, "Next"),
  ];
  assert.deepEqual(visibleRunStatus("running", items, [queued]), {
    stage: "waiting_for_grok",
    startedAtMs: 10,
  });
});

test("permission status is shown only until the permission card is visible", () => {
  const items = [user(10, RUN_ID, "Go")];
  assert.deepEqual(visibleRunStatus("awaiting_permission", items, []), {
    stage: "awaiting_permission",
    startedAtMs: 10,
  });
  assert.equal(
    visibleRunStatus("awaiting_permission", [...items, permission(11, RUN_ID)], []),
    undefined,
  );
});

test("terminal runs never leave a foreground loader behind", () => {
  const items = [user(10, RUN_ID, "Go")];
  for (const state of ["completed", "failed", "cancelled", "interrupted"] as const) {
    assert.equal(visibleRunStatus(state, items, []), undefined);
  }
});

function base(sequence: number, runId: RunId) {
  return {
    entryId: `entry-${sequence}`,
    taskId: TASK_ID,
    runId,
    sequence,
    createdAtMs: sequence,
    updatedAtMs: sequence,
  } as const;
}

function user(sequence: number, runId: RunId, text: string): TimelineItemProjection {
  return Object.freeze({ ...base(sequence, runId), kind: "user", status: "completed", text });
}

function thought(sequence: number, runId: RunId, text: string): TimelineItemProjection {
  return Object.freeze({
    ...base(sequence, runId),
    kind: "thought",
    status: "streaming",
    text,
    startedAtMs: sequence,
    elapsedMs: 0,
  });
}

function permission(sequence: number, runId: RunId): TimelineItemProjection {
  return Object.freeze({
    ...base(sequence, runId),
    kind: "permission",
    status: "waiting",
    permissionId: "permission-1",
    title: "Confirm",
    options: Object.freeze([]),
  });
}

test("a Steer message is not the user message that started the turn", () => {
  const user = (entryId: string, createdAtMs: number, extra: Record<string, unknown> = {}) => ({
    entryId, taskId: "t", runId: "r1", sequence: createdAtMs, createdAtMs, updatedAtMs: createdAtMs, status: "completed", kind: "user", text: entryId, ...extra,
  }) as unknown as import("@guild/contracts").TimelineItemProjection;
  const thought = { entryId: "th", taskId: "t", runId: "r1", sequence: 2_500, createdAtMs: 2_500, updatedAtMs: 2_600, status: "streaming", kind: "thought", text: "x", startedAtMs: 2_500, elapsedMs: 100 } as unknown as import("@guild/contracts").TimelineItemProjection;
  const items = [user("u1", 1_000), thought, user("steer", 3_000, { interjection: { interjectionId: "i1", state: "pending" } })];
  // The turn is already thinking; the Steer message right after it must not bring "waiting for Grok" back.
  assert.equal(visibleRunStatus("running", items, []), undefined);
});
