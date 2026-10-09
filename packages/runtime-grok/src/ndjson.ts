import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import {
  assertJsonValue,
  isNonArrayObject,
  type JsonObject,
} from "./json-value.js";

export type NdjsonFaultCode =
  | "blank_line"
  | "decoder_closed"
  | "frame_too_large"
  | "invalid_utf8"
  | "malformed_json"
  | "non_object_frame"
  | "truncated_frame";

export class NdjsonProtocolError extends Error {
  readonly code: NdjsonFaultCode;
  readonly framesBeforeFault: readonly JsonObject[];
  readonly terminal = true;

  constructor(
    code: NdjsonFaultCode,
    message: string,
    framesBeforeFault: readonly JsonObject[] = [],
  ) {
    super(message);
    this.name = "NdjsonProtocolError";
    this.code = code;
    this.framesBeforeFault = Object.freeze([...framesBeforeFault]);
  }
}

export type NdjsonDecoderOptions = {
  readonly maxFrameBytes?: number;
};

export type NdjsonDecoderState = "open" | "ended" | "faulted";

// An 8 MiB decoded ACP media payload expands to roughly 10.7 MiB in base64 plus JSON framing.
const DEFAULT_MAX_FRAME_BYTES = 12 * 1024 * 1024;

/**
 * Terminal, no-resynchronization NDJSON decoder (PC-TRN-003).
 * The byte limit covers bytes before LF, including a CR when CRLF is used.
 */
export class NdjsonDecoder {
  readonly maxFrameBytes: number;
  /** Bytes of an incomplete line carried across pushes, copied so callers may reuse their buffers. */
  private pendingPieces: Uint8Array[] = [];
  private pendingBytes = 0;
  // Stateless between decode() calls (no `stream` option), so one instance serves every line.
  private readonly utf8 = new TextDecoder("utf-8", { fatal: true });
  private currentState: NdjsonDecoderState = "open";
  private terminalError: NdjsonProtocolError | undefined;

  constructor(options: NdjsonDecoderOptions = {}) {
    const limit = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError("maxFrameBytes must be a positive safe integer");
    }
    this.maxFrameBytes = limit;
  }

  get state(): NdjsonDecoderState {
    return this.currentState;
  }

  get fault(): NdjsonProtocolError | undefined {
    return this.terminalError;
  }

  /**
   * Returns completed frames. If a later frame in this chunk faults, the thrown error carries the
   * earlier frames in `framesBeforeFault`; consumers must admit them in order before handling the
   * terminal fault.
   */
  push(chunk: Uint8Array): readonly JsonObject[] {
    this.assertOpen();
    const frames: JsonObject[] = [];
    const length = chunk.length;
    let start = 0;
    while (start < length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        if (this.pendingBytes + (length - start) > this.maxFrameBytes) {
          this.fail(
            "frame_too_large",
            `NDJSON frame exceeds ${this.maxFrameBytes} bytes`,
            frames,
          );
        }
        this.pendingPieces.push(new Uint8Array(chunk.subarray(start, length)));
        this.pendingBytes += length - start;
        break;
      }
      if (this.pendingBytes + (newline - start) > this.maxFrameBytes) {
        this.fail(
          "frame_too_large",
          `NDJSON frame exceeds ${this.maxFrameBytes} bytes`,
          frames,
        );
      }
      frames.push(this.finishLine(chunk.subarray(start, newline), frames));
      start = newline + 1;
    }
    return frames;
  }

  end(): readonly JsonObject[] {
    this.assertOpen();
    if (this.pendingBytes === 0) {
      this.currentState = "ended";
      return [];
    }

    const text = this.decodePending();
    if (text.trim().length === 0) {
      this.clearPending();
      this.currentState = "ended";
      return [];
    }
    this.fail("truncated_frame", "stdout ended with an unterminated NDJSON frame");
  }

  /** `tail` is the part of the line inside the current chunk; earlier parts are pending. */
  private finishLine(tail: Uint8Array, framesBeforeFault: readonly JsonObject[]): JsonObject {
    let bytes: Uint8Array;
    if (this.pendingBytes === 0) {
      bytes = tail;
    } else {
      this.pendingPieces.push(tail);
      bytes = Buffer.concat(this.pendingPieces, this.pendingBytes + tail.length);
      this.clearPending();
    }
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) {
      bytes = bytes.subarray(0, bytes.length - 1);
    }

    let text: string;
    try {
      text = this.utf8.decode(bytes);
    } catch {
      this.fail(
        "invalid_utf8",
        "NDJSON frame is not valid UTF-8",
        framesBeforeFault,
      );
    }
    if (text.trim().length === 0) {
      this.fail(
        "blank_line",
        "blank NDJSON lines are forbidden",
        framesBeforeFault,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      this.fail(
        "malformed_json",
        "NDJSON frame is not valid JSON",
        framesBeforeFault,
      );
    }
    try {
      assertJsonValue(parsed);
    } catch {
      this.fail(
        "malformed_json",
        "NDJSON frame is not a strict JSON value",
        framesBeforeFault,
      );
    }
    if (!isNonArrayObject(parsed)) {
      this.fail(
        "non_object_frame",
        "NDJSON frame must be a non-array JSON object",
        framesBeforeFault,
      );
    }
    return parsed as JsonObject;
  }

  private decodePending(): string {
    try {
      return this.utf8.decode(Buffer.concat(this.pendingPieces, this.pendingBytes));
    } catch {
      this.fail("invalid_utf8", "unterminated NDJSON bytes are not valid UTF-8");
    }
  }

  private clearPending(): void {
    this.pendingPieces = [];
    this.pendingBytes = 0;
  }

  private assertOpen(): void {
    if (this.currentState === "faulted" && this.terminalError !== undefined) {
      throw this.terminalError;
    }
    if (this.currentState === "ended") {
      throw new NdjsonProtocolError("decoder_closed", "NDJSON decoder has ended");
    }
  }

  private fail(
    code: NdjsonFaultCode,
    message: string,
    framesBeforeFault: readonly JsonObject[] = [],
  ): never {
    const error = new NdjsonProtocolError(code, message, framesBeforeFault);
    this.currentState = "faulted";
    this.terminalError = error;
    this.clearPending();
    throw error;
  }
}

export class NdjsonEncoder {
  encode(value: unknown): string {
    return encodeNdjson(value);
  }
}

/** Returns exactly one object frame terminated by one LF. */
export function encodeNdjson(value: unknown): string {
  if (!isNonArrayObject(value)) {
    throw new NdjsonProtocolError(
      "non_object_frame",
      "outbound NDJSON frame must be a non-array JSON object",
    );
  }
  try {
    assertJsonValue(value);
  } catch (cause) {
    throw new NdjsonProtocolError(
      "malformed_json",
      cause instanceof Error ? cause.message : "outbound value is not JSON",
    );
  }
  return `${JSON.stringify(value)}\n`;
}
