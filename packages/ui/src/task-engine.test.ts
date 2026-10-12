import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSummaryProjection, TaskViewProjection, WorkspaceProjection } from "@guild/contracts";
import { hasMixedEngines, taskEngineFixed, taskEngineOf } from "./task-engine.js";

const task = (patch: Partial<TaskSummaryProjection> = {}): TaskSummaryProjection => ({
  taskId: "t" as never, workspaceId: "w" as never, title: "T", pinned: false, archived: false, updatedAtMs: 1, ...patch,
});
const view = (patch: Partial<Pick<TaskViewProjection, "timeline" | "queuedTurns" | "hasEarlierTimeline">> & { summary?: Partial<TaskSummaryProjection> } = {}) => ({
  task: task(patch.summary),
  timeline: patch.timeline ?? [],
  queuedTurns: patch.queuedTurns ?? [],
  hasEarlierTimeline: patch.hasEarlierTimeline ?? false,
});

test("a task without an engine is a Grok task", () => {
  assert.equal(taskEngineOf(undefined), "grok");
  assert.equal(taskEngineOf(task()), "grok");
  assert.equal(taskEngineOf(task({ engine: "claude" })), "claude");
});

test("the engine is open for a fresh task and fixed by anything a Run leaves behind", () => {
  assert.equal(taskEngineFixed(view(), false), false);
  assert.equal(taskEngineFixed(view({ timeline: [{ kind: "user" } as never] }), false), true);
  assert.equal(taskEngineFixed(view({ hasEarlierTimeline: true }), false), true);
  assert.equal(taskEngineFixed(view({ queuedTurns: [{ queueId: "q", text: "x", createdAtMs: 1 }] }), false), true);
  assert.equal(taskEngineFixed(view({ summary: { activeRunState: "starting" } }), false), true);
  // A message being sent right now already counts.
  assert.equal(taskEngineFixed(view(), true), true);
  // Without a task there is nothing to choose.
  assert.equal(taskEngineFixed(undefined, false), true);
});

test("markers appear only while both engines are in use", () => {
  const workspace = (...engines: (TaskSummaryProjection["engine"])[]): Pick<WorkspaceProjection, "tasks"> => ({
    tasks: engines.map((engine, index) => task({ taskId: `t${index}` as never, ...(engine === undefined ? {} : { engine }) })),
  });
  assert.equal(hasMixedEngines([]), false);
  assert.equal(hasMixedEngines([workspace(undefined, "grok")]), false);
  assert.equal(hasMixedEngines([workspace("claude", "claude")]), false);
  assert.equal(hasMixedEngines([workspace(undefined, "claude")]), true);
  assert.equal(hasMixedEngines([workspace("grok"), workspace("claude")]), true);
});
