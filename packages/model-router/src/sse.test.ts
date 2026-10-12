import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LLAMA_CPP_EVENTS,
  NORMALIZED_EVENTS,
  STOP_0,
  STOP_1,
  TEXT_DELTA,
  TEXT_START,
  THINKING_DELTA,
  THINKING_START,
  MESSAGE_START,
  MESSAGE_DELTA,
  MESSAGE_STOP,
  sseEvent,
} from "./fixtures/llama-cpp-stream.js";
import type { JsonObject } from "./json.js";
import { MAX_BUFFERED_BLOCKS, MAX_BUFFERED_BYTES, SseBlockSequencer, SseParser, sseErrorEvent, type SseEvent } from "./sse.js";

const encoder = new TextEncoder();

function streamText(events: readonly Record<string, unknown>[]): string {
  return events.map(sseEvent).join("");
}

function splitInto(text: string, size: number): Uint8Array[] {
  const bytes = encoder.encode(text);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.subarray(at, at + size));
  return chunks;
}

function normalize(chunks: readonly Uint8Array[]): string {
  const parser = new SseParser();
  const sequencer = new SseBlockSequencer();
  let out = "";
  for (const chunk of chunks) {
    for (const event of parser.push(chunk)) out += sequencer.accept(event).join("");
  }
  for (const event of parser.end()) out += sequencer.accept(event).join("");
  out += sequencer.finish().join("");
  return out;
}

function types(text: string): string[] {
  return text
    .split("\n\n")
    .filter((part) => part.length > 0)
    .map((part) => {
      const data = part.split("\n").find((line) => line.startsWith("data: "));
      const json = JSON.parse(String(data).slice(6)) as { type: string; index?: number; delta?: { type?: string } };
      return `${json.type}${json.index === undefined ? "" : `#${json.index}`}${typeof json.delta?.type === "string" ? `:${json.delta.type}` : ""}`;
    });
}

describe("SseParser", () => {
  it("splits events across arbitrary chunk boundaries and keeps their raw text", () => {
    const text = streamText(LLAMA_CPP_EVENTS);
    for (const size of [1, 2, 3, 7, 64, 100000]) {
      const parser = new SseParser();
      const raws: string[] = [];
      for (const chunk of splitInto(text, size)) raws.push(...parser.push(chunk).map((event) => event.raw));
      raws.push(...parser.end().map((event) => event.raw));
      assert.equal(raws.join(""), text, `chunk size ${size}`);
      assert.equal(raws.length, LLAMA_CPP_EVENTS.length, `chunk size ${size}`);
    }
  });

  it("handles CRLF framing, multi-line data and comments", () => {
    const parser = new SseParser();
    const events = parser.push(encoder.encode(': keepalive\r\n\r\nevent: x\r\ndata: {"type":\r\ndata: "ping"}\r\n\r\ndata: [DONE]\n\n'));
    assert.equal(events.length, 3);
    assert.equal(events[0]?.json, undefined);
    assert.deepEqual(events[1]?.json, { type: "ping" });
    assert.equal(events[2]?.json, undefined);
  });

  it("decodes multibyte characters split across chunks", () => {
    const event = sseEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "\u4f60\u597d" } });
    const bytes = encoder.encode(event);
    const parser = new SseParser();
    const split = bytes.indexOf(0xe4) + 1;
    const found = [...parser.push(bytes.subarray(0, split)), ...parser.push(bytes.subarray(split))];
    assert.equal(found.length, 1);
    assert.equal(found[0]?.raw, event);
  });

  it("flushes an unterminated trailing event on end()", () => {
    const parser = new SseParser();
    assert.equal(parser.push(encoder.encode('data: {"type":"ping"}')).length, 0);
    const rest = parser.end();
    assert.equal(rest.length, 1);
    assert.deepEqual(rest[0]?.json, { type: "ping" });
  });
});

describe("SseBlockSequencer", () => {
  it("re-sequences the recorded llama.cpp order into conformant block order", () => {
    const out = normalize(splitInto(streamText(LLAMA_CPP_EVENTS), 4096));
    assert.equal(out, streamText(NORMALIZED_EVENTS));
    assert.deepEqual(types(out), [
      "message_start",
      "content_block_start#0",
      "content_block_delta#0:thinking_delta",
      "content_block_delta#0:signature_delta",
      "content_block_stop#0",
      "content_block_start#1",
      "content_block_delta#1:text_delta",
      "content_block_stop#1",
      "message_delta",
      "message_stop",
    ]);
  });

  it("gives the same result for every chunking", () => {
    const text = streamText(LLAMA_CPP_EVENTS);
    const expected = streamText(NORMALIZED_EVENTS);
    for (const size of [1, 5, 33, 200]) assert.equal(normalize(splitInto(text, size)), expected, `chunk size ${size}`);
  });

  it("emits the open lowest block immediately and buffers only the higher block", () => {
    const sequencer = new SseBlockSequencer();
    const parser = new SseParser();
    const emitted = (payload: Record<string, unknown>): string[] =>
      parser.push(encoder.encode(sseEvent(payload))).flatMap((event) => sequencer.accept(event));
    assert.equal(emitted(MESSAGE_START).length, 1);
    assert.equal(emitted(THINKING_START).length, 1);
    assert.equal(emitted(THINKING_DELTA).length, 1);
    assert.equal(emitted(TEXT_START).length, 0);
    assert.equal(emitted(TEXT_DELTA).length, 0);
    const closing = emitted(STOP_0);
    assert.deepEqual(closing.map((raw) => raw), [sseEvent(STOP_0), sseEvent(TEXT_START), sseEvent(TEXT_DELTA)]);
    assert.deepEqual(emitted(STOP_1), [sseEvent(STOP_1)]);
  });

  it("leaves an already conformant stream byte-identical", () => {
    const text = streamText(NORMALIZED_EVENTS);
    assert.equal(normalize(splitInto(text, 9)), text);
  });

  it("orders three blocks that arrive reversed and stops buffered out of order", () => {
    const start = (index: number): Record<string, unknown> => ({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    const delta = (index: number, text: string): Record<string, unknown> => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } });
    const stop = (index: number): Record<string, unknown> => ({ type: "content_block_stop", index });
    const input = [
      MESSAGE_START,
      start(0),
      start(1),
      start(2),
      delta(2, "c"),
      delta(1, "b"),
      delta(0, "a"),
      stop(2),
      stop(1),
      stop(0),
      MESSAGE_DELTA,
      MESSAGE_STOP,
    ];
    const out = types(normalize(splitInto(streamText(input), 50)));
    assert.deepEqual(out, [
      "message_start",
      "content_block_start#0",
      "content_block_delta#0:text_delta",
      "content_block_stop#0",
      "content_block_start#1",
      "content_block_delta#1:text_delta",
      "content_block_stop#1",
      "content_block_start#2",
      "content_block_delta#2:text_delta",
      "content_block_stop#2",
      "message_delta",
      "message_stop",
    ]);
  });

  it("passes ping and unparsable events through in order without disturbing buffered blocks", () => {
    const ping = 'event: ping\ndata: {"type": "ping"}\n\n';
    const comment = ": comment\n\n";
    const done = "data: [DONE]\n\n";
    const text = streamText([MESSAGE_START, THINKING_START, TEXT_START]) + ping + comment + done + streamText([STOP_0, STOP_1]);
    const expected =
      streamText([MESSAGE_START, THINKING_START]) + ping + comment + done + streamText([STOP_0, TEXT_START, STOP_1]);
    assert.equal(normalize(splitInto(text, 16)), expected);
  });

  it("flushes buffered blocks before message_delta when a lower block never stopped", () => {
    const out = types(normalize(splitInto(streamText([MESSAGE_START, THINKING_START, TEXT_START, TEXT_DELTA, MESSAGE_DELTA, MESSAGE_STOP]), 1000)));
    assert.deepEqual(out, [
      "message_start",
      "content_block_start#0",
      "content_block_start#1",
      "content_block_delta#1:text_delta",
      "message_delta",
      "message_stop",
    ]);
  });

  it("flushes remaining buffers when the stream ends without message events", () => {
    const out = types(normalize(splitInto(streamText([THINKING_START, TEXT_START, TEXT_DELTA]), 1000)));
    assert.deepEqual(out, ["content_block_start#0", "content_block_start#1", "content_block_delta#1:text_delta"]);
  });

  it("passes events for blocks it never saw through unchanged", () => {
    const text = streamText([TEXT_DELTA, STOP_1]);
    assert.equal(normalize(splitInto(text, 1000)), text);
  });
});

describe("SseBlockSequencer buffer limits [PC-ROUTE-003]", () => {
  const event = (payload: JsonObject): SseEvent => {
    const raw = sseEvent(payload);
    return { raw, json: payload };
  };
  const start = (index: number): SseEvent => event({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
  const textDelta = (index: number, size: number): SseEvent =>
    event({ type: "content_block_delta", index, delta: { type: "text_delta", text: "x".repeat(size) } });
  const MIB = 1024 * 1024;

  it("limits are 8 MiB and 64 blocks", () => {
    assert.equal(MAX_BUFFERED_BYTES, 8 * MIB);
    assert.equal(MAX_BUFFERED_BLOCKS, 64);
  });

  it("trips on bytes held back for a higher block and then accepts nothing", () => {
    const sequencer = new SseBlockSequencer();
    assert.equal(sequencer.accept(start(0)).length, 1);
    assert.equal(sequencer.accept(start(1)).length, 0);
    for (let i = 0; i < 7; i += 1) assert.equal(sequencer.accept(textDelta(1, MIB)).length, 0);
    assert.equal(sequencer.overflow, undefined, "7 MiB is within the limit");
    assert.equal(sequencer.accept(textDelta(1, MIB)).length, 0);
    assert.equal(sequencer.overflow, "bytes", "just over 8 MiB");
    assert.deepEqual(sequencer.accept(textDelta(0, 10)), [], "nothing is accepted after an overflow");
    assert.deepEqual(sequencer.accept(event({ type: "content_block_stop", index: 0 })), []);
    assert.deepEqual(sequencer.finish(), [], "the held events were dropped");
    assert.equal(sequencer.overflow, "bytes", "the overflow is sticky");
  });

  it("does not count events of the lowest open block, which stream straight through", () => {
    const sequencer = new SseBlockSequencer();
    sequencer.accept(start(0));
    for (let i = 0; i < 12; i += 1) assert.equal(sequencer.accept(textDelta(0, MIB)).length, 1);
    assert.equal(sequencer.overflow, undefined);
  });

  it("gives the bytes back when the lower block stops, so the cap is on what is held at once", () => {
    const sequencer = new SseBlockSequencer();
    sequencer.accept(start(0));
    sequencer.accept(start(1));
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < 5; i += 1) sequencer.accept(textDelta(1, MIB));
      if (round === 0) assert.equal(sequencer.accept(event({ type: "content_block_stop", index: 0 })).length, 1 + 1 + 5);
      assert.equal(sequencer.overflow, undefined, `round ${round}`);
    }
  });

  it("trips on more than 64 blocks waiting behind the lowest open one", () => {
    const sequencer = new SseBlockSequencer();
    assert.equal(sequencer.accept(start(0)).length, 1);
    for (let index = 1; index <= MAX_BUFFERED_BLOCKS; index += 1) sequencer.accept(start(index));
    assert.equal(sequencer.overflow, undefined, "64 waiting blocks are allowed");
    sequencer.accept(start(MAX_BUFFERED_BLOCKS + 1));
    assert.equal(sequencer.overflow, "blocks");
    assert.deepEqual(sequencer.finish(), []);
  });

  it("builds an Anthropic-style error event", () => {
    const text = sseErrorEvent("api_error", "too much");
    assert.equal(text, 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"too much"}}\n\n');
  });
});
