import assert from "node:assert/strict";
import test from "node:test";
import type { RunState, TaskId, TaskSummaryProjection, WorkspaceId } from "@guild/contracts";
import { sidebarTaskStatus, workspaceTaskStatus } from "./task-status.js";

function task(activeRunState?: RunState, queuedTurnCount = 0): TaskSummaryProjection {
  return Object.freeze({
    taskId: "task-status" as TaskId,
    workspaceId: "workspace-status" as WorkspaceId,
    title: "Status",
    pinned: false,
    archived: false,
    updatedAtMs: 1,
    queuedTurnCount,
    ...(activeRunState === undefined ? {} : { activeRunState }),
  });
}

test("sidebar task status gives permission and terminal problems distinct states", () => {
  assert.equal(sidebarTaskStatus(task("awaiting_permission")), "permission");
  assert.equal(sidebarTaskStatus(task("failed")), "failed");
  assert.equal(sidebarTaskStatus(task("interrupted")), "interrupted");
  assert.equal(sidebarTaskStatus(task("cancelled")), "cancelled");
});

test("sidebar task status keeps active work ahead of queued follow-ups", () => {
  assert.equal(sidebarTaskStatus(task("running", 2)), "running");
  assert.equal(sidebarTaskStatus(task("completed", 2)), "queued");
  assert.equal(sidebarTaskStatus(task("completed")), "idle");
});

test("workspace status exposes the most actionable state while its tasks are collapsed", () => {
  assert.equal(workspaceTaskStatus([]), "idle");
  assert.equal(workspaceTaskStatus([task("completed"), task("failed")]), "failed");
  assert.equal(workspaceTaskStatus([task("failed"), task("running")]), "running");
  assert.equal(workspaceTaskStatus([task("running"), task("awaiting_permission")]), "permission");
});

import { nextUnreadTaskIds, taskStatusSnapshot } from "./task-status.js";

function named(taskId: string, activeRunState?: RunState): TaskSummaryProjection {
  return Object.freeze({ ...task(activeRunState), taskId: taskId as TaskId });
}

test("a task that finishes quietly while another task is open gets the new-result mark", () => {
  const before = taskStatusSnapshot([named("a", "running"), named("b", "completed")]);
  const after = [named("a", "completed"), named("b", "completed")];
  assert.deepEqual([...nextUnreadTaskIds(before, after, "b", new Set())], ["a"]);
});

test("failure, cancellation, interruption and the open task never get the mark", () => {
  const before = taskStatusSnapshot([named("a", "running"), named("b", "running"), named("c", "running"), named("d", "running")]);
  const after = [named("a", "failed"), named("b", "cancelled"), named("c", "interrupted"), named("d", "completed")];
  assert.deepEqual([...nextUnreadTaskIds(before, after, "d", new Set())], []);
});

test("opening a task clears its mark, a first sighting never sets one, and gone tasks are dropped", () => {
  const unread = new Set(["a", "gone"]);
  assert.deepEqual([...nextUnreadTaskIds(new Map(), [named("a", "completed"), named("n", "completed")], "a", unread)], []);
  assert.deepEqual([...nextUnreadTaskIds(new Map(), [named("a", "completed")], undefined, unread)], ["a"]);
});

test("an unchanged answer keeps the same set so memoized rows do not re-render", () => {
  const unread = new Set(["a"]);
  assert.equal(nextUnreadTaskIds(taskStatusSnapshot([named("a", "completed")]), [named("a", "completed")], undefined, unread), unread);
});
