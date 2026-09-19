import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import {
  activityGroupState,
  activityToolKinds,
  groupTimeline,
  isBareSymbolReply,
  streamingActivity,
} from "./timeline.js";

const base = {
  taskId: "task-1",
  runId: "run-1",
  sequence: 1,
  createdAtMs: 1,
  updatedAtMs: 1,
  status: "completed",
} as const;

test("adjacent thought and tool fragments are coalesced without crossing authored messages", () => {
  const items = [
    { ...base, entryId: "thought-1", kind: "thought", text: "A", startedAtMs: 1, elapsedMs: 10 },
    { ...base, entryId: "tool-1", kind: "tool", title: "Read", toolKind: "read", toolStatus: "completed", content: [], locations: [] },
    { ...base, entryId: "thought-2", kind: "thought", text: "B", startedAtMs: 1, elapsedMs: 20 },
    { ...base, entryId: "assistant-1", kind: "assistant", text: "done" },
    { ...base, entryId: "tool-2", kind: "tool", title: "Search", toolKind: "search", toolStatus: "completed", content: [], locations: [] },
  ] as unknown as readonly TimelineItemProjection[];
  const groups = groupTimeline(items);
  assert.equal(groups.length, 3);
  assert.equal(groups[0]?.type, "activity");
  assert.equal(groups[1]?.type, "single");
  assert.equal(groups[2]?.type, "activity");
  if (groups[0]?.type === "activity") assert.equal(groups[0].items.length, 3);
  if (groups[2]?.type === "activity") assert.equal(groups[2].items.length, 1);
});

test("activity groups never merge two Grok runs", () => {
  const items = [
    { ...base, entryId: "old-thought", kind: "thought", text: "old", startedAtMs: 1, elapsedMs: 10 },
    { ...base, runId: "run-2", entryId: "new-thought", kind: "thought", text: "new", startedAtMs: 2, elapsedMs: 5 },
  ] as unknown as readonly TimelineItemProjection[];
  const groups = groupTimeline(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.type, "activity");
  assert.equal(groups[1]?.type, "activity");
});

test("a restored-session card replaces only its matching transport error", () => {
  const items = [
    {
      ...base,
      entryId: "error-restored",
      kind: "error",
      text: "connection interrupted",
      incidentId: "incident-restored",
      status: "failed",
    },
    {
      ...base,
      entryId: "error-unresolved",
      kind: "error",
      text: "another interruption",
      incidentId: "incident-unresolved",
      status: "failed",
      sequence: 2,
    },
    {
      ...base,
      entryId: "restored",
      kind: "notice",
      text: "session restored",
      noticeType: "session_restored",
      incidentId: "incident-restored",
      sequence: 3,
    },
  ] as unknown as readonly TimelineItemProjection[];

  const groups = groupTimeline(items);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.type, "single");
  assert.equal(groups[1]?.type, "single");
  if (groups[0]?.type === "single") assert.equal(groups[0].item.entryId, "error-unresolved");
  if (groups[1]?.type === "single") assert.equal(groups[1].item.entryId, "restored");
});

test("an unresolved transport error remains visible", () => {
  const error = {
    ...base,
    entryId: "error",
    kind: "error",
    text: "connection interrupted",
    incidentId: "incident",
    status: "failed",
  } as unknown as TimelineItemProjection;
  const groups = groupTimeline([error]);
  assert.equal(groups.length, 1);
  if (groups[0]?.type === "single") assert.equal(groups[0].item.entryId, "error");
});

test("terminal Run state overrides stale streaming and pending activity flags", () => {
  const interrupted = [
    { ...base, status: "interrupted", entryId: "thought", kind: "thought", text: "old", startedAtMs: 1, elapsedMs: 10 },
    { ...base, status: "interrupted", entryId: "tool", kind: "tool", title: "Build", toolKind: "execute", toolStatus: "pending", content: [], locations: [] },
  ] as unknown as readonly TimelineItemProjection[];
  assert.equal(activityGroupState(interrupted), "interrupted");

  const active = [
    { ...base, status: "streaming", entryId: "active", kind: "thought", text: "new", startedAtMs: 1, elapsedMs: 10 },
  ] as unknown as readonly TimelineItemProjection[];
  assert.equal(activityGroupState(active), "streaming");
});

test("symbol-only replies bypass Markdown structural parsing", () => {
  assert.equal(isBareSymbolReply("+"), true);
  assert.equal(isBareSymbolReply(" > "), true);
  assert.equal(isBareSymbolReply(">="), true);
  assert.equal(isBareSymbolReply("**bold**"), false);
  assert.equal(isBareSymbolReply("+\n-"), false);
  assert.equal(isBareSymbolReply(""), false);
});

test("collapsed activity exposes unique tool kinds in first-use order", () => {
  const items = [
    { ...base, entryId: "tool-1", kind: "tool", title: "Read", toolKind: "read", toolStatus: "completed", content: [], locations: [] },
    { ...base, entryId: "tool-2", kind: "tool", title: "Read more", toolKind: "read", toolStatus: "completed", content: [], locations: [] },
    { ...base, entryId: "tool-3", kind: "tool", title: "Search", toolKind: "search", toolStatus: "completed", content: [], locations: [] },
  ] as unknown as readonly TimelineItemProjection[];
  assert.deepEqual(activityToolKinds(items), ["read", "search"]);
});

test("live activity labels follow official ACP plan and tool state", () => {
  const planning = [{
    ...base,
    entryId: "plan-1",
    kind: "tool",
    toolCallId: "plan:run-1",
    runtimeReplayKind: "plan",
    title: "Plan",
    toolKind: "other",
    toolStatus: "in_progress",
    content: [],
    locations: [],
  }] as unknown as readonly TimelineItemProjection[];
  const editing = [{
    ...base,
    entryId: "edit-1",
    kind: "tool",
    toolCallId: "edit-1",
    runtimeReplayKind: "tool",
    title: "Edit file",
    toolKind: "edit",
    toolStatus: "in_progress",
    content: [],
    locations: [],
  }] as unknown as readonly TimelineItemProjection[];
  assert.equal(streamingActivity(planning), "planning");
  assert.equal(streamingActivity(editing), "editing");
  assert.equal(streamingActivity([...editing, ...planning]), "editing");
});

test("large activity groups remain ordered and frozen without mutating their input", () => {
  const items = Object.freeze(Array.from({ length: 10_000 }, (_, index) => Object.freeze({
    ...base, entryId: `tool-${index}`, kind: "tool" as const, title: "Read",
    toolKind: "read" as const, toolStatus: "completed" as const, content: [], locations: [],
  }))) as unknown as readonly TimelineItemProjection[];
  const groups = groupTimeline(items);
  assert.equal(groups.length, 1);
  assert.equal(Object.isFrozen(groups), true);
  const group = groups[0]!;
  assert.equal(Object.isFrozen(group), true);
  assert.equal(group.type, "activity");
  if (group.type !== "activity") assert.fail("missing activity group");
  assert.equal(Object.isFrozen(group.items), true);
  assert.equal(group.items.length, items.length);
  for (let index = 0; index < items.length; index += 1) {
    assert.equal(group.items[index], items[index]);
  }
});
