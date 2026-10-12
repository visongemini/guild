import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { JsonObject } from "./json.js";
import { looksLikeAnthropicSignature, ProvenanceRecorder, sanitizeThinking, signatureHash } from "./provenance.js";
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

describe("anthropic signature heuristic", () => {
  it("accepts only base64 strings longer than 100 characters", () => {
    assert.equal(looksLikeAnthropicSignature(LONG_BASE64), true);
    assert.equal(looksLikeAnthropicSignature("A".repeat(100)), false);
    assert.equal(looksLikeAnthropicSignature("A".repeat(101)), true);
    assert.equal(looksLikeAnthropicSignature("A".repeat(120) + "!"), false);
    assert.equal(looksLikeAnthropicSignature("A".repeat(60) + " " + "B".repeat(60)), false);
    assert.equal(looksLikeAnthropicSignature(""), false);
  });
});

describe("thinking sanitize", () => {
  it("keeps blocks the target produced and drops blocks other sources produced", () => {
    const store = new MemoryStore();
    store.put(signatureHash("sig-a"), "deepseek");
    store.put(signatureHash("sig-b"), "other");
    const result = sanitizeThinking(history(thinking("sig-a"), thinking("sig-b")), { sourceId: "deepseek", kind: "online" }, store);
    assert.deepEqual(assistantContent(result.body), [thinking("sig-a"), { type: "text", text: "answer" }]);
    assert.equal(result.kept, 1);
    assert.equal(result.dropped, 1);
  });

  it("drops unknown provenance for online and local targets", () => {
    const store = new MemoryStore();
    for (const kind of ["online", "local"] as const) {
      const result = sanitizeThinking(history(thinking(LONG_BASE64), thinking("short")), { sourceId: "x", kind }, store);
      assert.deepEqual(assistantContent(result.body), [{ type: "text", text: "answer" }]);
      assert.equal(result.dropped, 2);
    }
  });

  it("keeps unknown provenance for anthropic only when the signature is long base64", () => {
    const store = new MemoryStore();
    const result = sanitizeThinking(
      history(thinking(LONG_BASE64), thinking("short"), thinking("A".repeat(120) + "!")),
      { sourceId: "anthropic", kind: "anthropic" },
      store,
    );
    assert.deepEqual(assistantContent(result.body), [thinking(LONG_BASE64), { type: "text", text: "answer" }]);
    assert.equal(result.kept, 1);
    assert.equal(result.dropped, 2);
  });

  it("drops a long base64 signature that is recorded as foreign when the target is anthropic", () => {
    const store = new MemoryStore();
    store.put(signatureHash(LONG_BASE64), "deepseek");
    const result = sanitizeThinking(history(thinking(LONG_BASE64)), { sourceId: "anthropic", kind: "anthropic" }, store);
    assert.equal(result.dropped, 1);
  });

  it("keeps a short signature recorded as produced by anthropic", () => {
    const store = new MemoryStore();
    store.put(signatureHash("short-anthropic"), "anthropic");
    const result = sanitizeThinking(history(thinking("short-anthropic")), { sourceId: "anthropic", kind: "anthropic" }, store);
    assert.equal(result.kept, 1);
    assert.equal(result.dropped, 0);
  });

  it("treats an empty signature as the local source that produced it, else drops it", () => {
    const store = new MemoryStore();
    const missing: JsonObject = { type: "thinking", thinking: "no signature field" };
    const unrecorded = sanitizeThinking(history(thinking(""), missing), { sourceId: "local-1", kind: "local" }, store);
    assert.equal(unrecorded.dropped, 2);

    store.put(signatureHash(""), "local-1");
    const own = sanitizeThinking(history(thinking(""), missing), { sourceId: "local-1", kind: "local" }, store);
    assert.equal(own.kept, 2);
    assert.equal(own.dropped, 0);
    for (const target of [
      { sourceId: "deepseek", kind: "online" },
      { sourceId: "anthropic", kind: "anthropic" },
      { sourceId: "local-2", kind: "local" },
    ] as const) {
      assert.equal(sanitizeThinking(history(thinking("")), target, store).dropped, 1);
    }
  });

  it("judges redacted_thinking by its data field", () => {
    const store = new MemoryStore();
    store.put(signatureHash("redacted-data"), "deepseek");
    const redacted = (data: string): JsonObject => ({ type: "redacted_thinking", data });
    const result = sanitizeThinking(history(redacted("redacted-data"), redacted("other-data")), { sourceId: "deepseek", kind: "online" }, store);
    assert.deepEqual(assistantContent(result.body), [redacted("redacted-data"), { type: "text", text: "answer" }]);
  });

  it("returns the same body object when nothing is dropped and ignores non-assistant messages", () => {
    const store = new MemoryStore();
    const body = history();
    assert.equal(sanitizeThinking(body, { sourceId: "a", kind: "online" }, store).body, body);
    const userThinking: JsonObject = { model: "m", messages: [{ role: "user", content: [thinking("x")] }] };
    const result = sanitizeThinking(userThinking, { sourceId: "a", kind: "online" }, store);
    assert.equal(result.body, userThinking);
    assert.equal(result.dropped, 0);
  });

  it("replaces an assistant message that only held dropped thinking with (empty) text", () => {
    const body: JsonObject = { model: "m", messages: [{ role: "assistant", content: [thinking("foreign")] }] };
    const result = sanitizeThinking(body, { sourceId: "a", kind: "online" }, new MemoryStore());
    assert.deepEqual((result.body.messages as JsonObject[])[0]?.content, [{ type: "text", text: "(empty)" }]);
  });

  it("does not mutate the input body", () => {
    const body = history(thinking("foreign"));
    const before = JSON.stringify(body);
    sanitizeThinking(body, { sourceId: "a", kind: "online" }, new MemoryStore());
    assert.equal(JSON.stringify(body), before);
  });
});

describe("provenance recorder", () => {
  it("records signatures from content_block_start and signature_delta events", () => {
    const store = new MemoryStore();
    const recorder = new ProvenanceRecorder(store, "deepseek", "online");
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
    const recorder = new ProvenanceRecorder(store, "anthropic", "anthropic");
    recorder.observeMessage({
      type: "message",
      content: [
        { type: "thinking", thinking: "t", signature: "sig-json" },
        { type: "redacted_thinking", data: "redacted-json" },
        { type: "text", text: "hello" },
      ],
    });
    recorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "redacted-stream" } });
    assert.equal(store.get(signatureHash("sig-json")), "anthropic");
    assert.equal(store.get(signatureHash("redacted-json")), "anthropic");
    assert.equal(store.get(signatureHash("redacted-stream")), "anthropic");
  });

  it("attributes the empty signature to local sources only", () => {
    const local = new MemoryStore();
    const localRecorder = new ProvenanceRecorder(local, "local-1", "local");
    localRecorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    assert.equal(local.get(signatureHash("")), "local-1");

    const online = new MemoryStore();
    const onlineRecorder = new ProvenanceRecorder(online, "deepseek", "online");
    onlineRecorder.observeEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
    onlineRecorder.observeEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } });
    onlineRecorder.observeMessage({ content: [{ type: "thinking", thinking: "t", signature: "" }] });
    assert.equal(online.puts, 0);
  });

  it("writes each hash once per response", () => {
    const store = new MemoryStore();
    const recorder = new ProvenanceRecorder(store, "local-1", "local");
    for (let i = 0; i < 3; i += 1) {
      recorder.observeEvent({ type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "", signature: "" } });
      recorder.observeEvent({ type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: "" } });
    }
    assert.equal(store.puts, 1);
  });
});
