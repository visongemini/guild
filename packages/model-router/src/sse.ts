import { isJsonObject, type JsonObject } from "./json.js";

export interface SseEvent {
  /** The event exactly as received, including its terminating blank line. */
  readonly raw: string;
  /** Parsed `data:` payload when it is a JSON object. */
  readonly json: JsonObject | undefined;
}

const MAX_PENDING_CHARS = 16 * 1024 * 1024;

/**
 * Limits on what `SseBlockSequencer` may hold back for higher blocks while a lower block is open:
 * the raw event text in bytes, and the blocks waiting behind the lowest open one.
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
export const MAX_BUFFERED_BLOCKS = 64;

export type SseOverflow = "bytes" | "blocks";

/** An Anthropic-style stream error event; the client treats it as the end of the stream. */
export function sseErrorEvent(type: string, message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type, message } })}\n\n`;
}

function parseData(raw: string): JsonObject | undefined {
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  if (data.length === 0) return undefined;
  try {
    const value: unknown = JSON.parse(data.join("\n"));
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function toEvent(raw: string): SseEvent {
  return { raw, json: parseData(raw) };
}

/** Incremental server-sent-events splitter; events end at a blank line (LF or CRLF). */
export class SseParser {
  private pending = "";
  private scanFrom = 0;
  private readonly decoder = new TextDecoder("utf-8");

  push(chunk: Uint8Array): SseEvent[] {
    this.pending += this.decoder.decode(chunk, { stream: true });
    return this.drain();
  }

  /** Flushes whatever is left when the stream ends. */
  end(): SseEvent[] {
    this.pending += this.decoder.decode();
    const events = this.drain();
    if (this.pending.length > 0) events.push(toEvent(this.pending));
    this.pending = "";
    this.scanFrom = 0;
    return events;
  }

  private drain(): SseEvent[] {
    const events: SseEvent[] = [];
    const boundary = /\r?\n\r?\n/gu;
    boundary.lastIndex = this.scanFrom;
    let start = 0;
    for (let match = boundary.exec(this.pending); match !== null; match = boundary.exec(this.pending)) {
      const end = match.index + match[0].length;
      events.push(toEvent(this.pending.slice(start, end)));
      start = end;
    }
    this.pending = this.pending.slice(start);
    if (this.pending.length > MAX_PENDING_CHARS) {
      events.push(toEvent(this.pending));
      this.pending = "";
    }
    this.scanFrom = Math.max(0, this.pending.length - 3);
    return events;
  }
}

type BlockQueue = { events: string[]; bytes: number; stopped: boolean };

function blockIndex(event: JsonObject): number | undefined {
  const index = event.index;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * Re-sequences content blocks so a block's events are emitted before any event of a higher
 * index (llama.cpp opens the text block before closing the thinking block and sends the
 * thinking signature late). Events of higher blocks are buffered until every lower block has
 * stopped. `message_*`, `ping` and unparsable events pass through in order; message_delta,
 * message_stop and error first flush any buffered blocks so nothing is lost or reordered after
 * the message ends.
 *
 * What is held back, and how many blocks are tracked, is bounded (`MAX_BUFFERED_BYTES`,
 * `MAX_BUFFERED_BLOCKS`), and both limits are checked before an event or a block is added: a stream
 * of ever-lower block starts is counted like any other. When a limit is hit the sequencer drops
 * everything it holds, reports it through `overflow` and accepts nothing more; the owner must end
 * the client stream and abort the upstream.
 */
export class SseBlockSequencer {
  private readonly blocks = new Map<number, BlockQueue>();
  private bufferedBytes = 0;
  private overflowed: SseOverflow | undefined;

  /** Set once a buffering limit was exceeded; stays set. */
  get overflow(): SseOverflow | undefined {
    return this.overflowed;
  }

  accept(event: SseEvent): string[] {
    if (this.overflowed !== undefined) return [];
    const json = event.json;
    const type = json?.type;
    if (json !== undefined && typeof type === "string" && type.startsWith("content_block_")) {
      const index = blockIndex(json);
      if (index !== undefined) return this.acceptBlockEvent(type, index, event.raw);
    }
    if (type === "message_delta" || type === "message_stop" || type === "error") {
      return [...this.flushAll(), event.raw];
    }
    return [event.raw];
  }

  /** Call once when the upstream stream ends. */
  finish(): string[] {
    return this.flushAll();
  }

  /**
   * The lowest index among the tracked blocks. The scan is bounded: `acceptBlockEvent` refuses to
   * track more than `MAX_BUFFERED_BLOCKS + 1` blocks, so this never walks more than that many keys.
   */
  private lowestOpen(): number | undefined {
    let lowest: number | undefined;
    for (const index of this.blocks.keys()) {
      if (lowest === undefined || index < lowest) lowest = index;
    }
    return lowest;
  }

  private acceptBlockEvent(type: string, index: number, raw: string): string[] {
    if (type === "content_block_start" && !this.blocks.has(index)) {
      // Every tracked block except the lowest waits behind it, and a new lowest block (a smaller index
      // than every open one) turns the old lowest into a waiting block. The cap therefore applies to
      // every insertion, the streamed-through one included, and is checked before the block is added.
      if (this.blocks.size >= MAX_BUFFERED_BLOCKS + 1) {
        this.trip("blocks");
        return [];
      }
      const lowest = this.lowestOpen();
      const created: BlockQueue = { events: [], bytes: 0, stopped: false };
      this.blocks.set(index, created);
      if (lowest === undefined || index < lowest) return [raw];
      this.hold(created, raw);
      return [];
    }
    const lowest = this.lowestOpen();
    const block = this.blocks.get(index);
    if (block === undefined) return [raw];
    if (index !== lowest) {
      this.hold(block, raw);
      if (type === "content_block_stop") block.stopped = true;
      return [];
    }
    if (type !== "content_block_stop") return [raw];
    this.blocks.delete(index);
    return [raw, ...this.promote()];
  }

  /** Holds a raw event back for a block that must wait for a lower one; over the cap it holds nothing. */
  private hold(block: BlockQueue, raw: string): void {
    const size = Buffer.byteLength(raw);
    if (this.bufferedBytes + size > MAX_BUFFERED_BYTES) {
      this.trip("bytes");
      return;
    }
    block.events.push(raw);
    block.bytes += size;
    this.bufferedBytes += size;
  }

  private trip(reason: SseOverflow): void {
    this.overflowed = reason;
    this.blocks.clear();
    this.bufferedBytes = 0;
  }

  /** Emits the buffered events of each next-lowest block, stopping at the first still open. */
  private promote(): string[] {
    const out: string[] = [];
    for (let index = this.lowestOpen(); index !== undefined; index = this.lowestOpen()) {
      const block = this.blocks.get(index);
      if (block === undefined) break;
      for (const raw of block.events) out.push(raw);
      this.bufferedBytes -= block.bytes;
      block.events = [];
      block.bytes = 0;
      if (!block.stopped) break;
      this.blocks.delete(index);
    }
    return out;
  }

  private flushAll(): string[] {
    const out: string[] = [];
    const indexes = [...this.blocks.keys()].sort((a, b) => a - b);
    for (const index of indexes) for (const raw of this.blocks.get(index)?.events ?? []) out.push(raw);
    this.blocks.clear();
    this.bufferedBytes = 0;
    return out;
  }
}
