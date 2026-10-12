import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { JsonObject } from "./json.js";
import { ProvenanceRecorder, sanitizeThinking, signatureHash } from "./provenance.js";
import type { ProvenanceStore } from "./types.js";

class MemoryStore implements ProvenanceStore {
  readonly entries = new Map<string, string>();
  puts = 0;
  get(hash: string): string | undefined {
    return this.entries.get(hash);
  }
  put(hash: string, sourceId: string): void {
    this.puts += 1;
    this.entries.set(hash, sourceId);
  }
}

const LONG_BASE64 = "Eqw".repeat(40) + "==";

function thinking(signature: string, text = "hmm"): JsonObject {
  return { type: "thinking", thinking: text, signature };
}

function history(...assistantBlocks: JsonObject[]): JsonObject {
  return {
    model: "m",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [...assistantBlocks, { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ],
  };
}

function assistantContent(body: JsonObject): JsonObject[] {
  return (body.messages as JsonObject[])[1]?.content as JsonObject[];
}

describe("signature hash", () => {
  it("is the first 32 hex characters of sha256", () => {
    const expected = createHash("sha256").update("abc", "utf8").digest("hex").slice(0, 32);
    assert.equal(signatureHash("abc"), expected);
    assert.match(signatureHash("anything"), /^[0-9a-f]{32}$/u);
  });
});

describe("thinking sanitize", () => {
  it("keeps blocks the target produced and drops blocks other sources produced", () => {
    const store = new MemoryStore();
    store.put(signatureHash("sig-a"), "deepseek");
    store.put(signatureHash("sig-b"), "other");
    const result = sanitizeThinking(history(thinking("sig-a"), thinking("sig-b")), { sourceId: "deepseek" }, store);
    assert.deepEqual(assistantContent(result.body), [thinking("sig-a"), { type: "text", text: "answer" }]);
    assert.equal(result.kept, 1);
    assert.equal(result.dropped, 1);
  });

  it("drops unknown provenance, however much the signature looks like a long base64 one", () => {
    const store = new MemoryStore();
    for (const sourceId of ["x", "local-1"]) {
      const result = sanitizeThinking(history(thinking(LONG_BASE64), thinking("short")), { sourceId }, store);
      assert.deepEqual(assistantContent(result.body), [{ type: "text", text: "answer" }]);
      assert.equal(result.dropped, 2);
    }
  });

  it("drops a block recorded as produced by anthropic, for every source", () => {
    const store = new MemoryStore();
    store.put(signatureHash(LONG_BASE64), "anthropic");
    store.put(signatureHash("short-anthropic"), "anthropic");
    for (const sourceId of ["deepseek", "local-1"]) {
      const result = sanitizeThinking(history(thinking(LONG_BASE64), thinking("short-anthropic")), { sourceId }, store);
      assert.equal(result.kept, 0, sourceId);
      assert.equal(result.dropped, 2, sourceId);
    }
  });

  it("drops unsigned thinking blocks for every target, even with a stale empty-signature record [PC-ROUTE-003]", () => {
    const missing: JsonObject = { type: "thinking", thinking: "no signature field" };
    const emptyRedacted: JsonObject = { type: "redacted_thinking", data: "" };
    const targets = [{ sourceId: "local-1" }, { sourceId: "local-2" }, { sourceId: "deepseek" }] as const;
    // A row written by an older build attributed the empty signature to local-1; it must stay inert.
    const stale = new MemoryStore();
    stale.put(signatureHash(""), "local-1");
    for (const store of [new MemoryStore(), stale]) {
      for (const target of targets) {
        const result = sanitizeThinking(history(thinking(""), missing, emptyRedacted), target, store);
        assert.deepEqual(assistantContent(result.body), [{ type: "text", text: "answer" }], `${target.sourceId}`);
        assert.equal(result.kept, 0);
        assert.equal(result.dropped, 3);
      }
    }
  });

  it("judges redacted_thinking by its data field", () => {
    const store = new MemoryStore();
    store.put(signatureHash("redacted-data"), "deepseek");
    const redacted = (data: string): JsonObject => ({ type: "redacted_thinking", data });
    const result = sanitizeThinking(history(redacted("redacted-data"), redacted("other-data")), { sourceId: "deepseek" }, store);
    assert.deepEqual(assistantContent(result.body), [redacted("redacted-data"), { type: "text", text: "answer" }]);
  });

  it("returns the same body object when nothing is dropped and ignores non-assistant messages", () => {
    const store = new MemoryStore();
    const body = history();
    assert.equal(sanitizeThinking(body, { sourceId: "a" }, store).body, body);
    const userThinking: JsonObject = { model: "m", messages: [{ role: "user", content: [thinking("x")] }] };
    const result = sanitizeThinking(userThinking, { sourceId: "a" }, store);
    assert.equal(result.body, userThinking);
    assert.equal(result.dropped, 0);
  });

  it("replaces an assistant message that only held dropped thinking with (empty) text", () => {
    const body: JsonObject = { model: "m", messages: [{ role: "assistant", content: [thinking("foreign")] }] };
    const result = sanitizeThinking(body, { sourceId: "a" }, new MemoryStore());
    assert.deepEqual((result.body.messages as JsonObject[])[0]?.content, [{ type: "text", text: "(empty)" }]);
  });

  it("does not mutate the input body", () => {
    const body = history(thinking("foreign"));
    const before = JSON.stringify(body);
    sanitizeThinking(body, { sourceId: "a" }, new MemoryStore());
    assert.equal(JSON.stringify(body), before);
  });
});

describe("provenance recorder", () => {
  it("records signatures from content_block_start and signature_delta events", () => {
    const store = new MemoryStore();
    const recorder = new ProvenanceRecorder(store, "deepseek");
    recorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    recorder.observeEvent({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "", signature: "sig-start" } });
    recorder.observeEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-delta" } });
    recorder.observeEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "x" } });
    recorder.observeEvent({ type: "content_block_start", index: 2, content_block: { type: "text", text: "" } });
    assert.deepEqual([...store.entries.entries()].sort(), [
      [signatureHash("sig-delta"), "deepseek"],
      [signatureHash("sig-start"), "deepseek"],
    ].sort());
  });

  it("records redacted_thinking data and non-streamed message content", () => {
    const store = new MemoryStore();
    const recorder = new ProvenanceRecorder(store, "local-1");
    recorder.observeMessage({
      type: "message",
      content: [
        { type: "thinking", thinking: "t", signature: "sig-json" },
        { type: "redacted_thinking", data: "redacted-json" },
        { type: "text", text: "hello" },
      ],
    });
    recorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "redacted-stream" } });
    assert.equal(store.get(signatureHash("sig-json")), "local-1");
    assert.equal(store.get(signatureHash("redacted-json")), "local-1");
    assert.equal(store.get(signatureHash("redacted-stream")), "local-1");
  });

  it("never records an empty signature, for any source [PC-ROUTE-003]", () => {
    for (const sourceId of ["local-1", "deepseek"]) {
      const store = new MemoryStore();
      const recorder = new ProvenanceRecorder(store, sourceId);
      recorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
      recorder.observeEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } });
      recorder.observeEvent({ type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } });
      recorder.observeEvent({ type: "content_block_start", index: 2, content_block: { type: "redacted_thinking", data: "" } });
      recorder.observeMessage({ content: [{ type: "thinking", thinking: "t", signature: "" }, { type: "redacted_thinking", data: "" }] });
      assert.equal(store.puts, 0, sourceId);
    }
  });

  it("writes each hash once per response", () => {
    const store = new MemoryStore();
    const recorder = new ProvenanceRecorder(store, "local-1");
    for (let i = 0; i < 3; i += 1) {
      recorder.observeEvent({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "sig-once" } });
      recorder.observeEvent({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "sig-once" } });
    }
    assert.equal(store.puts, 1);
  });
});
