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
  private pending: number[] = [];
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
    for (const byte of chunk) {
      if (byte === 0x0a) {
        frames.push(this.finishLine(frames));
        continue;
      }
      if (this.pending.length >= this.maxFrameBytes) {
        this.fail(
          "frame_too_large",
          `NDJSON frame exceeds ${this.maxFrameBytes} bytes`,
          frames,
        );
      }
      this.pending.push(byte);
    }
    return frames;
  }

  end(): readonly JsonObject[] {
    this.assertOpen();
    if (this.pending.length === 0) {
      this.currentState = "ended";
      return [];
    }

    const text = this.decodePending();
    if (text.trim().length === 0) {
      this.pending = [];
      this.currentState = "ended";
      return [];
    }
    this.fail("truncated_frame", "stdout ended with an unterminated NDJSON frame");
  }

  private finishLine(framesBeforeFault: readonly JsonObject[]): JsonObject {
    let bytes = this.pending;
    this.pending = [];
    if (bytes.at(-1) === 0x0d) {
      bytes = bytes.slice(0, -1);
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
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
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(this.pending),
      );
    } catch {
      this.fail("invalid_utf8", "unterminated NDJSON bytes are not valid UTF-8");
    }
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
    this.pending = [];
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
