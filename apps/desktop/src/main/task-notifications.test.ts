import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunState, TaskId, TaskSummaryProjection, WorkspaceId } from "@guild/contracts";
import { collectTaskNotificationEvents, deliverTaskNotification, taskNotificationBody } from "./task-notifications.js";

const taskId = "task-notification" as TaskId;
const workspaceId = "workspace-notification" as WorkspaceId;

function task(activeRunState?: RunState): TaskSummaryProjection {
  return Object.freeze({
    taskId,
    workspaceId,
    title: "Long task",
    pinned: false,
    archived: false,
    updatedAtMs: 1,
    ...(activeRunState === undefined ? {} : { activeRunState }),
  });
}

describe("background task notification transitions", () => {
  it("delivers without activation and invokes reveal only after the click event", () => {
    let click: (() => void) | undefined;
    let shows = 0;
    let reveals = 0;
    deliverTaskNotification({
      on: (_event, listener) => { click = listener; },
      show: () => { shows += 1; },
    }, () => { reveals += 1; });
    assert.equal(shows, 1);
    assert.equal(reveals, 0);
    click?.();
    assert.equal(reveals, 1);
  });
  it("suppresses historical terminal state on first observation", () => {
    const result = collectTaskNotificationEvents(undefined, [task("completed")]);
    assert.deepEqual(result.events, []);
  });

  it("notifies once for permission and once for completion", () => {
    const started = collectTaskNotificationEvents(undefined, [task("running")]);
    const permission = collectTaskNotificationEvents(started.snapshot, [task("awaiting_permission")]);
    assert.deepEqual(permission.events.map((event) => event.kind), ["permission"]);
    const repeated = collectTaskNotificationEvents(permission.snapshot, [task("awaiting_permission")]);
    assert.deepEqual(repeated.events, []);
    const resumed = collectTaskNotificationEvents(repeated.snapshot, [task("running")]);
    const completed = collectTaskNotificationEvents(resumed.snapshot, [task("completed")]);
    assert.deepEqual(completed.events.map((event) => event.kind), ["completed"]);
  });

  it("reports failures and interruptions but not an explicit cancellation", () => {
    for (const state of ["failed", "interrupted"] as const) {
      const started = collectTaskNotificationEvents(undefined, [task("running")]);
      const terminal = collectTaskNotificationEvents(started.snapshot, [task(state)]);
      assert.deepEqual(terminal.events.map((event) => event.kind), [state]);
    }
    const started = collectTaskNotificationEvents(undefined, [task("cancel_requested")]);
    const cancelled = collectTaskNotificationEvents(started.snapshot, [task("cancelled")]);
    assert.deepEqual(cancelled.events, []);
  });

  it("can notify again after a later run starts", () => {
    const initial = collectTaskNotificationEvents(undefined, [task("completed")]);
    const running = collectTaskNotificationEvents(initial.snapshot, [task("running")]);
    const completed = collectTaskNotificationEvents(running.snapshot, [task("completed")]);
    assert.equal(completed.events.length, 1);
  });

  it("builds concise bilingual notification copy", () => {
    const event = Object.freeze({
      taskId,
      title: `  ${"very long task ".repeat(12)}  `,
      kind: "permission" as const,
    });
    const chinese = taskNotificationBody(event, "zh-CN");
    const english = taskNotificationBody(event, "en-US");
    assert.match(chinese, /正在等待授权$/u);
    assert.match(english, /is waiting for approval$/u);
    assert.match(chinese, /…/u);
    assert.ok(chinese.length < 100);
    assert.ok(english.length < 110);
  });
});
