import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StreamDeltaEvent, TimelineItemProjection } from "@guild/contracts";
import { MessageBody, StreamOverlayContext } from "./App.js";
import {
  MAX_OVERLAY_ENTRIES,
  mergeStreamText,
  StreamOverlayStore,
  type StreamOverlayRecord,
} from "./stream-overlay.js";

function delta(patch: Partial<StreamDeltaEvent> & Pick<StreamDeltaEvent, "offset" | "appendText" | "revision">): StreamDeltaEvent {
  return {
    taskId: "task-1" as never,
    entryId: "assistant-1",
    kind: "assistant",
    updatedAtMs: 1,
    ...patch,
  };
}

function item(patch: Partial<TimelineItemProjection> & { text: string }): TimelineItemProjection {
  return {
    entryId: "assistant-1",
    taskId: "task-1",
    sequence: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    status: "streaming",
    kind: "assistant",
    ...patch,
  } as TimelineItemProjection;
}

function store(activeTask: string | undefined = "task-1") {
  const state = { active: activeTask };
  return { store: new StreamOverlayStore(() => state.active), state };
}

const record = (patch: Partial<StreamOverlayRecord>): StreamOverlayRecord => ({
  taskId: "task-1", kind: "assistant", startOffset: 0, text: "", revision: 1, ...patch,
});

test("merged text is the projection when it is ahead or equal, and projection plus suffix when behind", () => {
  const overlay = record({ startOffset: 5, text: "world" });
  assert.equal(mergeStreamText("hello", overlay), "helloworld");
  assert.equal(mergeStreamText("hellowo", overlay), "helloworld", "partially caught up");
  assert.equal(mergeStreamText("helloworld", overlay), "helloworld");
  assert.equal(mergeStreamText("helloworld!!", overlay), "helloworld!!", "newer projection wins");
  assert.equal(mergeStreamText("hel", overlay), "hel", "a gap is never papered over");
  assert.equal(mergeStreamText("anything", undefined), "anything");
  assert.equal(mergeStreamText("", record({ startOffset: 0, text: "first chunk" })), "first chunk");
});

test("contiguous deltas accumulate and become visible only on flush", () => {
  const { store: overlays } = store();
  assert.equal(overlays.apply(delta({ offset: 0, appendText: "Hel", revision: 1 })), true);
  assert.equal(overlays.apply(delta({ offset: 3, appendText: "lo ", revision: 2 })), true);
  assert.equal(overlays.apply(delta({ offset: 6, appendText: "world", revision: 3 })), true);
  assert.equal(overlays.get("assistant-1"), undefined, "nothing is published before the frame");
  let notifications = 0;
  overlays.subscribe(() => { notifications += 1; });
  overlays.flush();
  assert.equal(notifications, 1, "one notification per frame however many deltas arrived");
  assert.equal(overlays.get("assistant-1")?.text, "Hello world");
  assert.equal(overlays.get("assistant-1")?.revision, 3);
  overlays.flush();
  assert.equal(notifications, 1, "an empty frame does not notify");
});

test("duplicate, stale, overlapping and gapped deltas never corrupt the text", () => {
  const { store: overlays } = store();
  overlays.apply(delta({ offset: 0, appendText: "abc", revision: 1 }));
  assert.equal(overlays.apply(delta({ offset: 0, appendText: "abc", revision: 1 })), false, "same revision");
  assert.equal(overlays.apply(delta({ offset: 0, appendText: "ab", revision: 2 })), false, "fully covered");
  assert.equal(overlays.apply(delta({ offset: 1, appendText: "bcdef", revision: 3 })), true, "overlap trims the repeated part");
  overlays.flush();
  assert.equal(overlays.get("assistant-1")?.text, "abcdef");
  // A gap cannot be bridged: restart from the new delta so the next projection decides.
  assert.equal(overlays.apply(delta({ offset: 10, appendText: "XYZ", revision: 4 })), true);
  overlays.flush();
  const restarted = overlays.get("assistant-1");
  assert.equal(restarted?.startOffset, 10);
  assert.equal(restarted?.text, "XYZ");
  assert.equal(mergeStreamText("abcdef", restarted), "abcdef", "stale projection is not extended across the gap");
  assert.equal(mergeStreamText("abcdefghij", restarted), "abcdefghijXYZ", "a caught-up projection continues seamlessly");
  assert.equal(overlays.apply(delta({ offset: 13, appendText: "!", revision: 5, kind: "thought" })), false, "kind change");
});

test("malformed deltas are rejected defensively", () => {
  const { store: overlays } = store();
  const bad: unknown[] = [
    delta({ offset: 0, appendText: "", revision: 1 }),
    delta({ offset: -1, appendText: "a", revision: 1 }),
    delta({ offset: 1.5, appendText: "a", revision: 1 }),
    delta({ offset: 0, appendText: "a", revision: Number.NaN }),
    { ...delta({ offset: 0, appendText: "a", revision: 1 }), entryId: "" },
    { ...delta({ offset: 0, appendText: "a", revision: 1 }), kind: "tool" },
    { ...delta({ offset: 0, appendText: "a", revision: 1 }), appendText: 5 },
  ];
  for (const candidate of bad) assert.equal(overlays.apply(candidate as StreamDeltaEvent), false);
  overlays.flush();
  assert.equal(overlays.get("assistant-1"), undefined);
});

test("deltas for any task but the one being viewed are rejected, and a switch drops the old overlays", () => {
  const { store: overlays, state } = store("task-1");
  assert.equal(overlays.apply(delta({ taskId: "task-2" as never, offset: 0, appendText: "late", revision: 1 })), false);
  overlays.apply(delta({ offset: 0, appendText: "mine", revision: 1 }));
  overlays.flush();
  assert.equal(overlays.get("assistant-1")?.text, "mine");
  state.active = "task-2";
  assert.equal(overlays.get("assistant-1"), undefined, "a foreign task's overlay is invisible immediately");
  assert.equal(overlays.apply(delta({ offset: 4, appendText: "still task-1", revision: 2 })), false);
  assert.equal(overlays.apply(delta({ taskId: "task-2" as never, entryId: "other", offset: 0, appendText: "new", revision: 1 })), true);
  overlays.flush();
  state.active = "task-1";
  assert.equal(overlays.get("assistant-1"), undefined, "switching back does not resurrect stale text");
});

test("reconcile drops overlays a projection has caught up with or that stopped streaming", () => {
  const { store: overlays } = store();
  overlays.apply(delta({ offset: 0, appendText: "hello world", revision: 2 }));
  overlays.apply(delta({ entryId: "thought-1", kind: "thought", offset: 0, appendText: "hmm", revision: 1 }));
  overlays.flush();
  overlays.reconcile([item({ text: "hello" })]);
  assert.equal(overlays.get("assistant-1")?.text, "hello world", "still behind the deltas: keep");
  overlays.reconcile([item({ text: "hello world" }), item({ entryId: "thought-1", kind: "thought", text: "hm" } as never)]);
  assert.equal(overlays.get("assistant-1"), undefined, "caught up: dropped");
  assert.equal(overlays.get("thought-1")?.text, "hmm");
  overlays.reconcile([item({ entryId: "thought-1", kind: "thought", status: "completed", text: "hm" } as never)]);
  assert.equal(overlays.get("thought-1"), undefined, "a finished entry's projection is final");
  overlays.apply(delta({ entryId: "future", offset: 0, appendText: "early", revision: 1 }));
  overlays.flush();
  overlays.reconcile([item({ text: "x" })]);
  assert.equal(overlays.get("future")?.text, "early", "deltas may legitimately precede their entry's first projection");
});

test("a delta stream that outruns a lagging projection still displays the newest text", () => {
  // The projection is built from the database, which may trail what was streamed.
  const { store: overlays } = store();
  overlays.apply(delta({ offset: 0, appendText: "The quick ", revision: 1 }));
  overlays.apply(delta({ offset: 10, appendText: "brown fox", revision: 2 }));
  overlays.flush();
  const lagging = item({ text: "The qu" });
  overlays.reconcile([lagging]);
  assert.equal(mergeStreamText(lagging.kind === "assistant" ? lagging.text : "", overlays.get("assistant-1")), "The quick brown fox");
  overlays.apply(delta({ offset: 19, appendText: " jumps", revision: 3 }));
  overlays.flush();
  assert.equal(mergeStreamText("The quick brown fox", overlays.get("assistant-1")), "The quick brown fox jumps");
  const caughtUp = item({ text: "The quick brown fox jumps over" });
  overlays.reconcile([caughtUp]);
  assert.equal(overlays.get("assistant-1"), undefined);
});

test("memory stays bounded when many entries stream", () => {
  const { store: overlays } = store();
  for (let index = 0; index < MAX_OVERLAY_ENTRIES * 3; index += 1) {
    overlays.apply(delta({ entryId: `entry-${index}`, offset: 0, appendText: "x", revision: 1 }));
    if (index % 5 === 0) overlays.flush();
  }
  overlays.flush();
  const survivors = Array.from({ length: MAX_OVERLAY_ENTRIES * 3 }, (_, index) => overlays.get(`entry-${index}`))
    .filter((value) => value !== undefined);
  assert.ok(survivors.length <= MAX_OVERLAY_ENTRIES);
  assert.ok(overlays.get(`entry-${MAX_OVERLAY_ENTRIES * 3 - 1}`) !== undefined, "newest entries survive");
});

test("a streaming message body renders snapshot plus overlay, and a finished one ignores the overlay", () => {
  const { store: overlays } = store();
  overlays.apply(delta({ offset: 0, appendText: "Streaming **bold", revision: 1 }));
  overlays.flush();
  const render = (text: string, streaming: boolean) => renderToStaticMarkup(
    createElement(StreamOverlayContext.Provider, { value: overlays },
      createElement(MessageBody, {
        entryId: "assistant-1", text, streaming, locale: "en-US", onOpenExternal: () => undefined,
      })));
  assert.match(render("", true), /Streaming \*\*bold/u);
  assert.match(render("Stream", true), /Streaming \*\*bold/u);
  assert.doesNotMatch(render("Final text", false), /Streaming/u);
  assert.match(render("Final **text**", false), /<strong>text<\/strong>/u);
  // Without a provider (a row rendered on its own) the projection text is shown unchanged.
  assert.match(renderToStaticMarkup(createElement(MessageBody, {
    entryId: "assistant-1", text: "plain snapshot", streaming: true, locale: "en-US", onOpenExternal: () => undefined,
  })), /plain snapshot/u);
});
