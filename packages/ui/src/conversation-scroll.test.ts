import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isConversationPinnedToBottom,
  mergeTimelineWindows,
  retainTimelineWindow,
  scrollTopAfterPrepend,
  shouldLoadEarlierConversation,
} from "./conversation-scroll.js";

test("conversation pin detects the last screen, not a content-sized pane", () => {
  assert.equal(isConversationPinnedToBottom(0, 800, 800), true);
  assert.equal(isConversationPinnedToBottom(1_200, 800, 2_000), true);
  assert.equal(isConversationPinnedToBottom(1_000, 800, 2_000), false);
  assert.equal(isConversationPinnedToBottom(0, 800, 4_000), false);
});

test("earlier history loads at the top or when a collapsed page cannot fill the pane", () => {
  assert.equal(shouldLoadEarlierConversation(true, 0, 800, 2_000), true);
  assert.equal(shouldLoadEarlierConversation(true, 1_000, 800, 2_000), false);
  assert.equal(shouldLoadEarlierConversation(true, 0, 800, 780), true);
  assert.equal(shouldLoadEarlierConversation(false, 0, 800, 780), false);
});

test("prepending history preserves the item already under the reader's eyes", () => {
  assert.equal(scrollTopAfterPrepend(18, 2_000, 3_200), 1_218);
  assert.equal(scrollTopAfterPrepend(0, 800, 800), 0);
  assert.equal(scrollTopAfterPrepend(25, 1_000, 900), 25);
});

test("retained history survives a light live tail and newer logical tool updates replace old ones", () => {
  const base = {
    taskId: "task-1" as never,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: "completed" as const,
  };
  const retained = [
    { ...base, entryId: "assistant-old", sequence: 1, kind: "assistant" as const, text: "old" },
    { ...base, entryId: "tool-old", sequence: 2, kind: "tool" as const, toolCallId: "call-1", title: "old tool", toolKind: "read" as const, toolStatus: "completed" as const, content: [], locations: [] },
  ];
  const incoming = [
    { ...base, entryId: "tool-new", sequence: 10, kind: "tool" as const, toolCallId: "call-1", title: "new tool", toolKind: "read" as const, toolStatus: "completed" as const, content: [], locations: [] },
    { ...base, entryId: "assistant-new", sequence: 11, kind: "assistant" as const, text: "new" },
  ];
  const merged = mergeTimelineWindows(retained, incoming);
  assert.deepEqual(merged.map((item) => item.entryId), [
    "assistant-old",
    "tool-new",
    "assistant-new",
  ]);
});

test("retained task timelines use bounded least-recently-used ordering", () => {
  const first = Object.freeze([]);
  const second = Object.freeze([]);
  const third = Object.freeze([]);
  const cache = new Map();
  retainTimelineWindow(cache, "first", first, 2);
  retainTimelineWindow(cache, "second", second, 2);
  retainTimelineWindow(cache, "first", first, 2);
  retainTimelineWindow(cache, "third", third, 2);
  assert.deepEqual([...cache.keys()], ["first", "third"]);
  assert.equal(cache.get("first"), first);
});

test("retained task timeline bounds reject invalid capacities", () => {
  assert.throws(
    () => retainTimelineWindow(new Map(), "task", Object.freeze([]), 0),
    /invalid_maximum_task_count/,
  );
});

test("the conversation region owns the only flexible main-pane row", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-rows:\s*68px auto auto auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /grid-area:\s*conversation/);
  assert.match(css, /\.guild-conversation[^{]*\{[^}]*overflow-y:\s*auto/);
});
