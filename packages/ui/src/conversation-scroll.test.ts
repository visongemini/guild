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

type PermissionOption = { readonly optionId: string; readonly name: string; readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" };

function timelineBase(sequence: number, status: "completed" | "waiting" = "completed") {
  return { taskId: "task-1" as never, createdAtMs: sequence, updatedAtMs: sequence, status, sequence };
}

function textItem(entryId: string, sequence: number, kind: "user" | "assistant" = "assistant") {
  return { ...timelineBase(sequence), entryId, kind, text: entryId } as const;
}

function toolItem(entryId: string, sequence: number, toolStatus: "pending" | "completed") {
  return {
    ...timelineBase(sequence),
    entryId,
    kind: "tool" as const,
    toolCallId: "call-write",
    title: "Write dom.txt",
    toolKind: "edit" as const,
    toolStatus,
    content: [],
    locations: [],
  };
}

function permissionItem(permissionId: string, sequence: number, options: readonly PermissionOption[]) {
  return {
    ...timelineBase(sequence, "waiting"),
    entryId: permissionId,
    kind: "permission" as const,
    permissionId,
    title: "Needs your approval",
    options,
  };
}

const CLAUDE_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "allow_always", name: "Yes, and allow similar commands", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
const GROK_OPTIONS: readonly PermissionOption[] = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

for (const [engine, options] of [["claude", CLAUDE_OPTIONS], ["grok", GROK_OPTIONS]] as const) {
  test(`${engine} flow: a decided permission card leaves the merged timeline (pending, decided, gone)`, () => {
    const user = textItem("user-1", 1, "user");
    const pendingProjection = [user, toolItem("tool-1", 2, "pending"), permissionItem("permission-1", 3, options)];
    const whilePending = mergeTimelineWindows([], pendingProjection);
    assert.deepEqual(whilePending.map((item) => item.entryId), ["user-1", "tool-1", "permission-1"]);

    // Approved: main drops the pending request, the tool completes, the answer arrives.
    const decidedProjection = [user, toolItem("tool-1", 2, "completed"), textItem("assistant-1", 4)];
    const afterDecision = mergeTimelineWindows(whilePending, decidedProjection);
    assert.deepEqual(afterDecision.map((item) => item.entryId), ["user-1", "tool-1", "assistant-1"]);
    assert.equal(afterDecision.some((item) => item.kind === "permission"), false);
    // The cache keeps the cleaned window, so the next publish cannot bring the card back.
    assert.equal(mergeTimelineWindows(afterDecision, decidedProjection).some((item) => item.kind === "permission"), false);
  });
}

test("a decided card is dropped even when it was cancelled and the run ended without a newer item", () => {
  const retained = mergeTimelineWindows([], [textItem("user-1", 1, "user"), permissionItem("permission-1", 2, CLAUDE_OPTIONS)]);
  const afterCancel = mergeTimelineWindows(retained, [textItem("user-1", 1, "user")]);
  assert.deepEqual(afterCancel.map((item) => item.entryId), ["user-1"]);
});

test("only the decided card goes when two requests were pending", () => {
  const first = permissionItem("permission-1", 3, CLAUDE_OPTIONS);
  const second = permissionItem("permission-2", 4, CLAUDE_OPTIONS);
  const retained = mergeTimelineWindows([], [textItem("user-1", 1, "user"), first, second]);
  const merged = mergeTimelineWindows(retained, [textItem("user-1", 1, "user"), second]);
  assert.deepEqual(merged.map((item) => item.entryId), ["user-1", "permission-2"]);
});

test("a still-pending card stays, and a paged window never drops items outside its page range", () => {
  const earlier = [textItem("user-1", 1, "user"), textItem("assistant-1", 2), toolItem("tool-early", 3, "completed")];
  // The first window was the recent page; the reader then loaded an earlier page that also
  // carries the pending card (main appends it to every projection).
  const recentPage = [textItem("user-9", 90, "user"), permissionItem("permission-1", 91, CLAUDE_OPTIONS)];
  const withEarlier = mergeTimelineWindows(mergeTimelineWindows([], recentPage), [...earlier, ...recentPage]);
  assert.deepEqual(withEarlier.map((item) => item.entryId), [
    "user-1", "assistant-1", "tool-early", "user-9", "permission-1",
  ]);
  // A later light projection holds only the newest page: the earlier history stays, the card
  // stays while pending, and it goes once decided.
  const stillPending = mergeTimelineWindows(withEarlier, recentPage);
  assert.deepEqual(stillPending.map((item) => item.entryId), [
    "user-1", "assistant-1", "tool-early", "user-9", "permission-1",
  ]);
  const decided = mergeTimelineWindows(stillPending, [textItem("user-9", 90, "user"), textItem("assistant-9", 92)]);
  assert.deepEqual(decided.map((item) => item.entryId), [
    "user-1", "assistant-1", "tool-early", "user-9", "assistant-9",
  ]);
});

test("a pending card whose sequence is below the incoming page start is kept while pending", () => {
  // Main orders a pending card by a hint that can fall behind the page start in a long task.
  const stale = permissionItem("permission-1", 501, CLAUDE_OPTIONS);
  const page = [textItem("user-900", 900, "user"), stale];
  assert.equal(mergeTimelineWindows([], page).some((item) => item.kind === "permission"), true);
  assert.equal(
    mergeTimelineWindows(mergeTimelineWindows([], page), [textItem("user-900", 900, "user")])
      .some((item) => item.kind === "permission"),
    false,
  );
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
  assert.match(css, /grid-template-rows:\s*52px auto auto auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /grid-area:\s*conversation/);
  assert.match(css, /\.guild-conversation[^{]*\{[^}]*overflow-y:\s*auto/);
});
