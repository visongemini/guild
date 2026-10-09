import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DESKTOP_EVENT_CHANNELS,
  DESKTOP_IPC_CHANNELS,
  GUILD_STREAM_DELTA_LIMITS,
  type StreamDeltaEvent,
} from "@guild/contracts";
import { createStreamDeltaForwarder } from "./stream-delta-channel.js";

type Sent = { readonly channel: string; readonly payload: StreamDeltaEvent };

function fakeWindow(label: string) {
  const sent: Sent[] = [];
  const state = { windowDestroyed: false, contentsDestroyed: false };
  const makeContents = () => ({
    label,
    isDestroyed: () => state.contentsDestroyed,
    send: (channel: string, payload: StreamDeltaEvent) => { sent.push({ channel, payload }); },
  });
  const window = {
    webContents: makeContents(),
    isDestroyed: () => state.windowDestroyed,
  };
  return { window, sent, state, makeContents };
}

const delta = Object.freeze({
  taskId: "task-1",
  runId: "run-1",
  entryId: "assistant-1",
  kind: "assistant",
  offset: 12,
  appendText: " more text",
  revision: 4,
  updatedAtMs: 1_700_000_000_000,
});

test("stream deltas leave main only through the registered channel as validated copies", () => {
  const { window, sent } = fakeWindow("primary");
  const forward = createStreamDeltaForwarder(window);
  assert.equal(forward(delta), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.channel, DESKTOP_IPC_CHANNELS.streamDelta);
  assert.ok(DESKTOP_EVENT_CHANNELS.includes(sent[0]!.channel as never));
  assert.deepEqual(sent[0]!.payload, delta);
  assert.notEqual(sent[0]!.payload, delta, "the renderer receives a copy, not the producer's object");
  assert.equal(Object.isFrozen(sent[0]!.payload), true);
});

test("malformed, unregistered-shape, and oversized deltas are dropped before they reach the renderer", () => {
  const { window, sent } = fakeWindow("primary");
  const forward = createStreamDeltaForwarder(window);
  const rejected: unknown[] = [
    undefined,
    null,
    "delta",
    [delta],
    { ...delta, extra: "field" },
    { ...delta, kind: "tool" },
    { ...delta, taskId: "" },
    { ...delta, offset: -1 },
    { ...delta, offset: 2.5 },
    { ...delta, revision: 0 },
    { ...delta, appendText: "" },
    { ...delta, appendText: "x".repeat(GUILD_STREAM_DELTA_LIMITS.maxAppendTextLength + 1) },
    { ...delta, appendText: "nul\0byte" },
    { ...delta, runId: undefined },
  ];
  for (const candidate of rejected) assert.equal(forward(candidate), false, JSON.stringify(candidate)?.slice(0, 80));
  assert.deepEqual(sent, []);
  assert.equal(forward(delta), true, "a valid event still passes after rejections");
});

test("delivery is bound to the registered window and its original web contents", () => {
  const primary = fakeWindow("primary");
  const other = fakeWindow("other");
  const forward = createStreamDeltaForwarder(primary.window);
  assert.equal(forward(delta), true);
  assert.equal(other.sent.length, 0, "another window never receives the registered window's stream");

  // A replaced web contents is a different identity than the one that was registered.
  const replaced = { ...primary.window, webContents: primary.makeContents() };
  const replacedForward = createStreamDeltaForwarder(primary.window);
  (primary.window as { webContents: unknown }).webContents = replaced.webContents;
  assert.equal(replacedForward(delta), false);
  assert.equal(primary.sent.length, 1);
});

test("a destroyed window or destroyed web contents receives nothing", () => {
  const first = fakeWindow("first");
  const forwardFirst = createStreamDeltaForwarder(first.window);
  first.state.windowDestroyed = true;
  assert.equal(forwardFirst(delta), false);
  assert.deepEqual(first.sent, []);

  const second = fakeWindow("second");
  const forwardSecond = createStreamDeltaForwarder(second.window);
  second.state.contentsDestroyed = true;
  assert.equal(forwardSecond(delta), false);
  assert.deepEqual(second.sent, []);
});

test("the preload allow-list mirrors the contract registry and exposes no generic IPC", async () => {
  const preload = await readFile(new URL("../../src/preload/index.cts", import.meta.url), "utf8");
  const table = /const DESKTOP_IPC_CHANNELS = Object\.freeze\(\{([\s\S]*?)\} as const\);/u.exec(preload);
  assert.ok(table !== null, "preload keeps its own frozen channel table");
  const mirrored = Object.fromEntries(
    [...table[1]!.matchAll(/^\s*([A-Za-z]+): "([^"]+)",?$/gmu)].map((match) => [match[1]!, match[2]!]),
  );
  assert.deepEqual(mirrored, { ...DESKTOP_IPC_CHANNELS }, "preload and contracts must list identical channels");

  // Subscriptions: only registered event channels, with the Electron event object stripped.
  const subscriptions = [...preload.matchAll(/ipcRenderer\.on\(([^,]+),/gu)].map((match) => match[1]!.trim());
  assert.deepEqual(subscriptions.sort(), [
    "DESKTOP_IPC_CHANNELS.projectionChanged",
    "DESKTOP_IPC_CHANNELS.streamDelta",
  ]);
  assert.match(preload, /ipcRenderer\.removeListener\(DESKTOP_IPC_CHANNELS\.streamDelta, wrapped\)/u);
  assert.match(
    preload,
    /const wrapped = \(_event: Electron\.IpcRendererEvent, delta: StreamDeltaEvent\) => listener\(delta\);/u,
  );
  // No generic channel access reaches the renderer.
  assert.doesNotMatch(preload, /ipcRenderer\.(?:send|sendSync|postMessage|sendToHost|once|addListener)\(/u);
  assert.doesNotMatch(preload, /exposeInMainWorld\("(?!guild")/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld\("guild", Object\.freeze\(api\)\);/u);
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/u);
});
