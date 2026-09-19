import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TaskSummaryProjection, WorkspaceProjection } from "@guild/contracts";
import { resolveContextMenuSeed } from "./context-menu.js";

describe("context menu projection", () => {
  it("recovers the complete current workspace before counting or managing it", () => {
    const workspaceId = "workspace-1" as WorkspaceProjection["workspaceId"];
    const active = task("task-active", workspaceId, false, "running");
    const archived = task("task-archived", workspaceId, true);
    const matching = task("task-match", workspaceId, false);
    const complete = Object.freeze({
      workspaceId,
      name: "Project",
      archived: false,
      tasks: Object.freeze([active, archived, matching]),
    });
    const filtered = Object.freeze({ ...complete, tasks: Object.freeze([matching]) });

    const resolved = resolveContextMenuSeed([complete], { type: "workspace", workspace: filtered });

    assert.equal(resolved.type, "workspace");
    if (resolved.type !== "workspace") assert.fail("workspace menu was not resolved");
    assert.equal(resolved.workspace.tasks.length, 3);
    assert.equal(resolved.workspace.tasks[0]?.activeRunState, "running");
    assert.equal(resolved.workspace.tasks[1]?.archived, true);
  });

  it("refreshes a task menu with the latest run and queue state", () => {
    const workspaceId = "workspace-1" as WorkspaceProjection["workspaceId"];
    const stale = task("task-1", workspaceId, false);
    const current = Object.freeze({ ...stale, activeRunState: "running" as const, queuedTurnCount: 1 });
    const workspace = Object.freeze({
      workspaceId,
      name: "Project",
      archived: false,
      tasks: Object.freeze([current]),
    });

    const resolved = resolveContextMenuSeed([workspace], { type: "task", task: stale });

    assert.equal(resolved.type, "task");
    if (resolved.type !== "task") assert.fail("task menu was not resolved");
    assert.equal(resolved.task.activeRunState, "running");
    assert.equal(resolved.task.queuedTurnCount, 1);
  });
});

function task(
  taskId: string,
  workspaceId: WorkspaceProjection["workspaceId"],
  archived: boolean,
  activeRunState?: TaskSummaryProjection["activeRunState"],
): TaskSummaryProjection {
  return Object.freeze({
    taskId: taskId as TaskSummaryProjection["taskId"],
    workspaceId,
    title: taskId,
    pinned: false,
    archived,
    updatedAtMs: 1,
    queuedTurnCount: 0,
    ...(activeRunState === undefined ? {} : { activeRunState }),
  });
}
