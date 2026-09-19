import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import { slashCommandStatus } from "./command-status.js";

const base = {
  taskId: "task-1",
  runId: "run-1",
  createdAtMs: 1,
  updatedAtMs: 1,
  status: "completed",
} as const;

describe("slash command lifecycle status", () => {
  it("shows immediate acknowledgement before a silent command emits activity", () => {
    const items = [{
      ...base,
      entryId: "user-1",
      sequence: 1,
      kind: "user",
      text: "/goal polish the game",
    }] as unknown as readonly TimelineItemProjection[];

    assert.deepEqual(slashCommandStatus(items, "running"), {
      commandName: "goal",
      runState: "running",
      hasRuntimeActivity: false,
    });
  });

  it("summarizes the latest real tool without inventing command-specific events", () => {
    const items = [
      { ...base, entryId: "user-1", sequence: 1, kind: "user", text: "/goal polish" },
      {
        ...base,
        entryId: "tool-1",
        sequence: 2,
        kind: "tool",
        title: "Read DemoHud.cs",
        toolKind: "read",
        toolStatus: "completed",
        content: [],
      },
    ] as unknown as readonly TimelineItemProjection[];

    assert.deepEqual(slashCommandStatus(items, "running"), {
      commandName: "goal",
      runState: "running",
      hasRuntimeActivity: true,
      latestToolTitle: "Read DemoHud.cs",
      latestToolKind: "read",
    });
  });

  it("surfaces official worker activity without mixing child text into the root timeline", () => {
    const items = [{
      ...base,
      entryId: "user-1",
      sequence: 1,
      kind: "user",
      text: "/goal polish the game",
    }] as unknown as readonly TimelineItemProjection[];

    assert.deepEqual(slashCommandStatus(items, "running", {
      activity: "searching",
      workerCount: 2,
      toolKinds: Object.freeze(["read", "search"]),
    }), {
      commandName: "goal",
      runState: "running",
      hasRuntimeActivity: true,
      liveActivity: "searching",
      liveToolKinds: ["read", "search"],
      workerCount: 2,
    });
  });

  it("keeps a concrete tool ahead of a later plan refresh", () => {
    const items = [
      { ...base, entryId: "user-1", sequence: 1, kind: "user", text: "/goal polish" },
      { ...base, entryId: "tool-1", sequence: 2, kind: "tool", toolCallId: "read-1", runtimeReplayKind: "tool", title: "Read source", toolKind: "read", toolStatus: "in_progress", content: [] },
      { ...base, entryId: "plan-1", sequence: 3, kind: "tool", toolCallId: "plan:run-1", runtimeReplayKind: "plan", title: "Plan", toolKind: "other", toolStatus: "in_progress", content: [] },
    ] as unknown as readonly TimelineItemProjection[];
    assert.equal(slashCommandStatus(items, "running")?.latestToolTitle, "Read source");
  });

  it("keeps a terminal acknowledgement only when the runtime returned no authored response", () => {
    const command = {
      ...base,
      entryId: "user-1",
      sequence: 1,
      kind: "user",
      text: "/context",
    } as unknown as TimelineItemProjection;
    assert.equal(slashCommandStatus([command], "completed")?.runState, "completed");
    assert.equal(slashCommandStatus([
      command,
      { ...base, entryId: "assistant-1", sequence: 2, kind: "assistant", text: "Done" } as unknown as TimelineItemProjection,
    ], "completed"), undefined);
  });

  it("does not attach an old command status after a newer user turn", () => {
    const items = [
      { ...base, entryId: "user-1", sequence: 1, kind: "user", text: "/context" },
      { ...base, entryId: "user-2", sequence: 2, kind: "user", text: "continue" },
    ] as unknown as readonly TimelineItemProjection[];
    assert.equal(slashCommandStatus(items, "running"), undefined);
  });
});
