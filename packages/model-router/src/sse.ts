import { isJsonObject, type JsonObject } from "./json.js";

export interface SseEvent {
  /** The event exactly as received, including its terminating blank line. */
  readonly raw: string;
  /** Parsed `data:` payload when it is a JSON object. */
  readonly json: JsonObject | undefined;
}

const MAX_PENDING_CHARS = 16 * 1024 * 1024;

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

type BlockQueue = { events: string[]; stopped: boolean };

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
 */
export class SseBlockSequencer {
  private readonly blocks = new Map<number, BlockQueue>();

  accept(event: SseEvent): string[] {
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

  private lowestOpen(): number | undefined {
    let lowest: number | undefined;
    for (const index of this.blocks.keys()) {
      if (lowest === undefined || index < lowest) lowest = index;
    }
    return lowest;
  }

  private acceptBlockEvent(type: string, index: number, raw: string): string[] {
    const lowest = this.lowestOpen();
    if (type === "content_block_start" && !this.blocks.has(index)) {
      this.blocks.set(index, { events: [], stopped: false });
      if (lowest === undefined || index < lowest) return [raw];
      this.blocks.get(index)?.events.push(raw);
      return [];
    }
    const block = this.blocks.get(index);
    if (block === undefined) return [raw];
    if (index !== lowest) {
      block.events.push(raw);
      if (type === "content_block_stop") block.stopped = true;
      return [];
    }
    if (type !== "content_block_stop") return [raw];
    this.blocks.delete(index);
    return [raw, ...this.promote()];
  }

  /** Emits the buffered events of each next-lowest block, stopping at the first still open. */
  private promote(): string[] {
    const out: string[] = [];
    for (let index = this.lowestOpen(); index !== undefined; index = this.lowestOpen()) {
      const block = this.blocks.get(index);
      if (block === undefined) break;
      out.push(...block.events);
      block.events = [];
      if (!block.stopped) break;
      this.blocks.delete(index);
    }
    return out;
  }

  private flushAll(): string[] {
    const out: string[] = [];
    const indexes = [...this.blocks.keys()].sort((a, b) => a - b);
    for (const index of indexes) out.push(...(this.blocks.get(index)?.events ?? []));
    this.blocks.clear();
    return out;
  }
}
