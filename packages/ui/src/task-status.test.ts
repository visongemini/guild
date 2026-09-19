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
