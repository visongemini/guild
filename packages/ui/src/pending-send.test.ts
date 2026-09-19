import assert from "node:assert/strict";
import test from "node:test";
import {
  claimSendInFlight,
  clearPendingSendForTask,
  releaseSendInFlight,
  setPendingSendForTask,
  type PendingSendState,
} from "./pending-send.js";

function pending(taskId: string, submittedAtMs: number): PendingSendState {
  return Object.freeze({ taskId, text: `message-${taskId}`, submittedAtMs });
}

test("pending sends remain isolated by task", () => {
  const first = setPendingSendForTask(new Map(), pending("task-a", 1));
  const both = setPendingSendForTask(first, pending("task-b", 2));
  assert.equal(both.get("task-a")?.text, "message-task-a");
  assert.equal(both.get("task-b")?.text, "message-task-b");
  assert.equal(first.has("task-b"), false);
});

test("a second submit in the same turn cannot claim the same task", () => {
  const first = claimSendInFlight(new Set(), "task-a");
  assert.ok(first);
  assert.equal(claimSendInFlight(first, "task-a"), undefined);
  assert.ok(claimSendInFlight(first, "task-b"));
  assert.equal(releaseSendInFlight(first, "task-a").has("task-a"), false);
});

test("a stale completion cannot clear a newer send for the same task", () => {
  const current = setPendingSendForTask(new Map(), pending("task-a", 2));
  assert.equal(clearPendingSendForTask(current, "task-a", 1), current);
  assert.equal(clearPendingSendForTask(current, "task-a", 2).has("task-a"), false);
});
