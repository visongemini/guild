import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSummaryProjection, TaskViewProjection, WorkspaceProjection } from "@guild/contracts";
import { engineMarkerLetter, hasMixedEngines, taskEngineFixed, taskEngineOf } from "./task-engine.js";

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
  assert.equal(taskEngineOf(task({ engine: "codex" })), "codex");
  assert.equal(taskEngineOf(task({ engine: "gemini" })), "gemini");
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
  // A third engine counts like any other, even when Grok is not among them.
  assert.equal(hasMixedEngines([workspace("codex", "codex")]), false);
  assert.equal(hasMixedEngines([workspace("claude", "codex")]), true);
  assert.equal(hasMixedEngines([workspace(undefined), workspace("codex")]), true);
  // Gemini is one more engine like the others.
  assert.equal(hasMixedEngines([workspace("gemini", "gemini")]), false);
  assert.equal(hasMixedEngines([workspace("gemini"), workspace("codex")]), true);
});

test("each engine has its own marker letter, and Claude and Codex do not share one (PC-ENG-003)", () => {
  assert.deepEqual(
    (["grok", "claude", "codex"] as const).map((engine) => engineMarkerLetter(engine)),
    ["G", "C", "X"],
  );
  assert.equal(new Set((["grok", "claude", "codex"] as const).map((engine) => engineMarkerLetter(engine))).size, 3);
});

test("Gemini's marker is the letter pair Ge, distinct from Grok's G and every other engine's letter (PC-ENG-004)", () => {
  const engines = ["grok", "claude", "codex", "gemini"] as const;
  assert.deepEqual(engines.map((engine) => engineMarkerLetter(engine)), ["G", "C", "X", "Ge"]);
  assert.equal(new Set(engines.map((engine) => engineMarkerLetter(engine))).size, engines.length);
  // Two letters at most, so the marker keeps its fixed box.
  assert.equal(engines.every((engine) => engineMarkerLetter(engine).length <= 2), true);
});
