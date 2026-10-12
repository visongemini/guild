import { createHash } from "node:crypto";
import { isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import type { ProvenanceStore, SourceKind } from "./types.js";

const HASH_LENGTH = 32;
const MIN_ANTHROPIC_SIGNATURE_LENGTH = 100;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const EMPTY_TEXT = "(empty)";

export function signatureHash(signature: string): string {
  return createHash("sha256").update(signature, "utf8").digest("hex").slice(0, HASH_LENGTH);
}

/** Anthropic signatures are long base64 strings; used only when provenance is unknown. */
export function looksLikeAnthropicSignature(signature: string): boolean {
  return signature.length > MIN_ANTHROPIC_SIGNATURE_LENGTH && BASE64_PATTERN.test(signature);
}

export interface ThinkingTarget {
  readonly sourceId: string;
  readonly kind: SourceKind;
}

export interface ThinkingSanitizeResult {
  readonly body: JsonObject;
  readonly kept: number;
  readonly dropped: number;
}

function isThinkingBlock(block: JsonValue): block is JsonObject {
  return isJsonObject(block) && (block.type === "thinking" || block.type === "redacted_thinking");
}

/** The opaque value that proves who produced a block: `signature`, or `data` when redacted. */
function proofOf(block: JsonObject): string {
  const value = block.type === "redacted_thinking" ? block.data : block.signature;
  return typeof value === "string" ? value : "";
}

function keepsBlock(block: JsonObject, target: ThinkingTarget, store: ProvenanceStore): boolean {
  const proof = proofOf(block);
  // An unsigned block (empty or missing signature) proves nothing about who produced it: no target keeps it.
  if (proof.length === 0) return false;
  const producer = store.get(signatureHash(proof));
  if (producer !== undefined) return producer === target.sourceId;
  return target.kind === "anthropic" && looksLikeAnthropicSignature(proof);
}

/**
 * Drops thinking blocks the target source did not produce. Unsigned (empty-signature) blocks are
 * dropped for every target. Unknown provenance is dropped for online/local targets; for Anthropic
 * only long base64 signatures survive. The input body is returned unchanged (same reference) when
 * nothing is dropped.
 */
export function sanitizeThinking(
  body: JsonObject,
  target: ThinkingTarget,
  store: ProvenanceStore,
): ThinkingSanitizeResult {
  if (!Array.isArray(body.messages)) return { body, kept: 0, dropped: 0 };
  let kept = 0;
  let dropped = 0;
  const messages = body.messages.map((message): JsonValue => {
    if (!isJsonObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      return message;
    }
    const content: JsonValue[] = [];
    let changed = false;
    for (const block of message.content) {
      if (!isThinkingBlock(block)) {
        content.push(block);
      } else if (keepsBlock(block, target, store)) {
        kept += 1;
        content.push(block);
      } else {
        dropped += 1;
        changed = true;
      }
    }
    if (!changed) return message;
    return { ...message, content: content.length > 0 ? content : [{ type: "text", text: EMPTY_TEXT }] };
  });
  if (dropped === 0) return { body, kept, dropped };
  return { body: { ...body, messages }, kept, dropped };
}

/**
 * Records which source produced each thinking signature seen in a response. An empty signature
 * is never recorded (local servers send one, but it identifies nobody); such blocks are dropped
 * from the history by `sanitizeThinking`.
 */
export class ProvenanceRecorder {
  private readonly store: ProvenanceStore;
  private readonly sourceId: string;
  private readonly seen = new Set<string>();

  constructor(store: ProvenanceStore, sourceId: string) {
    this.store = store;
    this.sourceId = sourceId;
  }

  /** One decoded SSE event payload. */
  observeEvent(event: JsonObject): void {
    if (event.type === "content_block_start") {
      if (isJsonObject(event.content_block)) this.observeBlock(event.content_block);
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (isJsonObject(delta) && delta.type === "signature_delta") {
        this.recordProof(typeof delta.signature === "string" ? delta.signature : "");
      }
    }
  }

  /** A complete non-streamed message response. */
  observeMessage(message: JsonObject): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (isJsonObject(block)) this.observeBlock(block);
    }
  }

  private observeBlock(block: JsonObject): void {
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      this.recordProof(proofOf(block));
    }
  }

  private recordProof(proof: string): void {
    if (proof.length === 0) return;
    const hash = signatureHash(proof);
    if (this.seen.has(hash)) return;
    this.seen.add(hash);
    this.store.put(hash, this.sourceId);
  }
}
