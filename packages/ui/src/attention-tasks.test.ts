import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSummaryProjection } from "@guild/contracts";
import { ATTENTION_STRIP_LIMIT, attentionStripTasks } from "./attention-tasks.js";

const task = (id: string, patch: Partial<TaskSummaryProjection> = {}): TaskSummaryProjection => ({
  taskId: id, workspaceId: "w", title: id, pinned: false, archived: false, updatedAtMs: 1_000, ...patch,
}) as unknown as TaskSummaryProjection;

test("only other tasks that are running or waiting for the user make the strip", () => {
  const tasks = [
    task("open", { activeRunState: "running" }),
    task("running", { activeRunState: "running", updatedAtMs: 2_000 }),
    task("waiting", { activeRunState: "awaiting_permission", updatedAtMs: 3_000 }),
    task("starting", { activeRunState: "starting", updatedAtMs: 500 }),
    task("failed", { activeRunState: "failed" }),
    task("interrupted", { activeRunState: "interrupted" }),
    task("cancelled", { activeRunState: "cancelled" }),
    task("completed", { activeRunState: "completed" }),
    task("queued-idle", { queuedTurnCount: 2 }),
    task("idle"),
    task("archived", { activeRunState: "running", archived: true }),
  ];
  assert.deepEqual(attentionStripTasks(tasks, "open").map((entry) => entry.taskId), ["waiting", "running", "starting"]);
});

test("the strip is empty, so it can be hidden, when nothing else is in progress", () => {
  assert.deepEqual(attentionStripTasks([task("open", { activeRunState: "running" }), task("failed", { activeRunState: "failed" })], "open"), []);
  assert.deepEqual(attentionStripTasks([], undefined), []);
});

test("with no open task every running task counts, newest first, up to the limit", () => {
  const many = Array.from({ length: 7 }, (_, index) => task(`t${index}`, { activeRunState: "running", updatedAtMs: index }));
  const shown = attentionStripTasks(many, undefined);
  assert.equal(shown.length, ATTENTION_STRIP_LIMIT);
  assert.deepEqual(shown.map((entry) => entry.taskId), ["t6", "t5", "t4", "t3"]);
});
