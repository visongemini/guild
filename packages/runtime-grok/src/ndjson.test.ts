import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeNdjson,
  NdjsonDecoder,
  NdjsonProtocolError,
  type NdjsonDecoderOptions,
  type NdjsonDecoderState,
} from "./ndjson.js";
import type { JsonObject } from "./json-value.js";

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function assertFault(
  operation: () => unknown,
  code: NdjsonProtocolError["code"],
): NdjsonProtocolError {
  let found: unknown;
  try {
    operation();
  } catch (cause) {
    found = cause;
  }
  assert.ok(found instanceof NdjsonProtocolError);
  assert.equal(found.code, code);
  assert.equal(found.terminal, true);
  return found;
}

type DecodeOutcome = {
  readonly frames: readonly JsonObject[];
  readonly terminalCode: NdjsonProtocolError["code"] | undefined;
  readonly terminalState: NdjsonDecoderState;
};

function decodeChunks(
  chunks: readonly Uint8Array[],
  options: NdjsonDecoderOptions = {},
): DecodeOutcome {
  const decoder = new NdjsonDecoder(options);
  const frames: JsonObject[] = [];
  let terminalCode: NdjsonProtocolError["code"] | undefined;

  const admit = (operation: () => readonly JsonObject[]): boolean => {
    try {
      frames.push(...operation());
      return true;
    } catch (cause) {
      assert.ok(cause instanceof NdjsonProtocolError);
      frames.push(...cause.framesBeforeFault);
      terminalCode = cause.code;
      return false;
    }
  };

  for (const chunk of chunks) {
    if (!admit(() => decoder.push(chunk))) {
      return { frames, terminalCode, terminalState: decoder.state };
    }
  }
  admit(() => decoder.end());
  return { frames, terminalCode, terminalState: decoder.state };
}

describe("NdjsonDecoder (PC-TRN-003)", () => {
  it("decodes arbitrary chunks including a split UTF-8 scalar", () => {
    const decoder = new NdjsonDecoder();
    const encoded = bytes('{"text":"你"}\n');
    const lead = encoded.indexOf(0xe4);
    assert.notEqual(lead, -1);

    assert.deepEqual(decoder.push(encoded.subarray(0, lead + 1)), []);
    assert.deepEqual(decoder.push(encoded.subarray(lead + 1, lead + 2)), []);
    assert.deepEqual(decoder.push(encoded.subarray(lead + 2)), [{ text: "你" }]);
    assert.deepEqual(decoder.end(), []);
    assert.equal(decoder.state, "ended");
  });

  it("decodes multiple LF and CRLF frames from one chunk", () => {
    const decoder = new NdjsonDecoder();
    assert.deepEqual(
      decoder.push(bytes('{"n":1}\n{"n":2}\r\n{"n":3}\n')),
      [{ n: 1 }, { n: 2 }, { n: 3 }],
    );
    assert.deepEqual(decoder.end(), []);
  });

  it("is invariant across every two-part byte-stream split", () => {
    const cases: readonly {
      readonly input: string;
      readonly options?: NdjsonDecoderOptions;
      readonly expected: DecodeOutcome;
    }[] = [
      {
        input: '{"first":1}\n{"second":2}\n',
        expected: {
          frames: [{ first: 1 }, { second: 2 }],
          terminalCode: undefined,
          terminalState: "ended",
        },
      },
      {
        input: '{"valid":true}\n\n',
        expected: {
          frames: [{ valid: true }],
          terminalCode: "blank_line",
          terminalState: "faulted",
        },
      },
      {
        input: '{"valid":true}\n{oops}\n',
        expected: {
          frames: [{ valid: true }],
          terminalCode: "malformed_json",
          terminalState: "faulted",
        },
      },
      {
        input: '{"ok":1}\n{"tooLong":true}\n',
        options: { maxFrameBytes: 8 },
        expected: {
          frames: [{ ok: 1 }],
          terminalCode: "frame_too_large",
          terminalState: "faulted",
        },
      },
    ];

    for (const testCase of cases) {
      const stream = bytes(testCase.input);
      for (let split = 0; split <= stream.byteLength; split += 1) {
        assert.deepEqual(
          decodeChunks(
            [stream.subarray(0, split), stream.subarray(split)],
            testCase.options,
          ),
          testCase.expected,
          `split ${split} of ${stream.byteLength} bytes for ${JSON.stringify(testCase.input)}`,
        );
      }
    }
  });

  it("decodes a multibyte Chinese scalar from one-byte chunks", () => {
    const stream = bytes('{"text":"你"}\n');
    assert.deepEqual(
      decodeChunks(Array.from(stream, (byte) => Uint8Array.of(byte))),
      {
        frames: [{ text: "你" }],
        terminalCode: undefined,
        terminalState: "ended",
      },
    );
  });

  it("carries an immutable ordered copy of frames completed before a same-call fault", () => {
    const decoder = new NdjsonDecoder();
    const error = assertFault(
      () => decoder.push(bytes('{"first":1}\n{"second":2}\n{oops}\n')),
      "malformed_json",
    );
    assert.deepEqual(error.framesBeforeFault, [{ first: 1 }, { second: 2 }]);
    assert.equal(Object.isFrozen(error.framesBeforeFault), true);
    assert.equal(decoder.fault, error);
  });

  it("treats blank lines as terminal and never resynchronizes", () => {
    for (const line of ["\n", "\r\n", "  \t\n"]) {
      const decoder = new NdjsonDecoder();
      const first = assertFault(() => decoder.push(bytes(line)), "blank_line");
      assert.equal(decoder.state, "faulted");
      let second: unknown;
      try {
        decoder.push(bytes('{"ignored":true}\n'));
      } catch (cause) {
        second = cause;
      }
      assert.equal(second, first);
    }
  });

  it("terminally rejects malformed JSON, primitives, and arrays", () => {
    const cases: readonly [string, NdjsonProtocolError["code"]][] = [
      ["{oops}\n", "malformed_json"],
      ["null\n", "non_object_frame"],
      ["4\n", "non_object_frame"],
      ['"text"\n', "non_object_frame"],
      ["[]\n", "non_object_frame"],
    ];
    for (const [input, code] of cases) {
      const decoder = new NdjsonDecoder();
      assertFault(() => decoder.push(bytes(input)), code);
      assert.equal(decoder.state, "faulted");
    }
  });

  it("terminally rejects non-finite numbers produced by JSON.parse", () => {
    const decoder = new NdjsonDecoder();
    assertFault(
      () => decoder.push(bytes('{"nested":[0,{"overflow":1e400}]}\n')),
      "malformed_json",
    );
    assert.equal(decoder.state, "faulted");
  });

  it("terminally rejects invalid UTF-8, including across chunks", () => {
    const decoder = new NdjsonDecoder();
    assert.deepEqual(decoder.push(Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3)), []);
    assertFault(() => decoder.push(Uint8Array.of(0x28, 0x22, 0x7d, 0x0a)), "invalid_utf8");
  });

  it("faults as soon as the configured byte limit is exceeded", () => {
    const decoder = new NdjsonDecoder({ maxFrameBytes: 2 });
    assert.deepEqual(decoder.push(bytes("{}")), []);
    assertFault(() => decoder.push(bytes(" \n")), "frame_too_large");
  });

  it("distinguishes clean whitespace EOF from a truncated frame", () => {
    for (const suffix of ["", " ", "\t\r "]) {
      const decoder = new NdjsonDecoder();
      decoder.push(bytes(suffix));
      assert.deepEqual(decoder.end(), []);
      assert.equal(decoder.state, "ended");
    }

    const truncated = new NdjsonDecoder();
    truncated.push(bytes('{"partial":true}'));
    assertFault(() => truncated.end(), "truncated_frame");
  });
});

describe("NDJSON encoding", () => {
  it("emits exactly JSON.stringify(object) followed by LF", () => {
    const value = { jsonrpc: "2.0", id: 1, method: "initialize" };
    assert.equal(encodeNdjson(value), `${JSON.stringify(value)}\n`);
  });

  it("rejects non-object and non-JSON outbound values", () => {
    assertFault(() => encodeNdjson([]), "non_object_frame");
    assertFault(() => encodeNdjson({ bad: undefined }), "malformed_json");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assertFault(() => encodeNdjson(cyclic), "malformed_json");
  });
});
