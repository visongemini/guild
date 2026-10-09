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

describe("NdjsonDecoder LF splitting and single-pass decoding", () => {
  const samples: readonly string[] = [
    "plain ascii",
    "你好，世界",
    "emoji \u{1F600}\u{1F9D1}\u200D\u{1F4BB} and combining e\u0301",
    "escapes \\n \\t \" quote and \u2028 separator",
    "",
    "x".repeat(2_000),
    "混合 mixed \u{10FFFF} end",
  ];

  function buildStream(count: number, random: () => number): {
    readonly bytes: Uint8Array;
    readonly expected: readonly JsonObject[];
  } {
    const expected: JsonObject[] = [];
    const parts: Uint8Array[] = [];
    for (let index = 0; index < count; index += 1) {
      const text = samples[Math.floor(random() * samples.length)]!;
      const frame: JsonObject = { index, text, nested: { list: [text.length, true, null] } };
      expected.push(frame);
      const ending = random() < 0.4 ? "\r\n" : "\n";
      parts.push(bytes(`${JSON.stringify(frame)}${ending}`));
    }
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return { bytes: joined, expected };
  }

  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
  }

  it("decodes identically for any chunking, including one-byte and multibyte-splitting chunks", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = seeded(seed);
      const { bytes: stream, expected } = buildStream(12, random);
      const whole = decodeChunks([stream]);
      assert.deepEqual(whole, { frames: expected, terminalCode: undefined, terminalState: "ended" });

      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < stream.byteLength;) {
        const size = seed % 5 === 0 ? 1 : 1 + Math.floor(random() * 97);
        chunks.push(stream.subarray(offset, Math.min(stream.byteLength, offset + size)));
        offset += size;
      }
      assert.deepEqual(decodeChunks(chunks), whole, `seed ${seed} with ${chunks.length} chunks`);
    }
  });

  it("splits a frame at every byte, including inside each multibyte scalar and between CR and LF", () => {
    const encoded = bytes(`${JSON.stringify({ text: "aé你\u{1F600}z" })}\r\n{"n":2}\n`);
    for (let first = 0; first <= encoded.byteLength; first += 1) {
      for (let second = first; second <= encoded.byteLength; second += 7) {
        const outcome = decodeChunks([
          encoded.subarray(0, first),
          encoded.subarray(first, second),
          encoded.subarray(second),
        ]);
        assert.deepEqual(outcome, {
          frames: [{ text: "aé你\u{1F600}z" }, { n: 2 }],
          terminalCode: undefined,
          terminalState: "ended",
        }, `splits ${first}/${second}`);
      }
    }
  });

  it("enforces the byte limit exactly at the boundary wherever the line feed lands", () => {
    const payload = '{"k":1}';
    const exact = bytes(`${payload}\n`);
    const options = { maxFrameBytes: payload.length };
    for (let split = 0; split <= exact.byteLength; split += 1) {
      assert.deepEqual(
        decodeChunks([exact.subarray(0, split), exact.subarray(split)], options),
        { frames: [{ k: 1 }], terminalCode: undefined, terminalState: "ended" },
        `exactly maxFrameBytes plus LF, split ${split}`,
      );
    }
    // A CR belongs to the frame bytes, so the same line with CRLF is one byte too long.
    const crlf = bytes(`${payload}\r\n`);
    for (let split = 0; split <= crlf.byteLength; split += 1) {
      assert.deepEqual(
        decodeChunks([crlf.subarray(0, split), crlf.subarray(split)], options),
        { frames: [], terminalCode: "frame_too_large", terminalState: "faulted" },
        `CRLF over the limit, split ${split}`,
      );
    }
    // Over the limit is detected without waiting for the line feed.
    const decoder = new NdjsonDecoder(options);
    assertFault(() => decoder.push(bytes(`${payload}x`)), "frame_too_large");
  });

  it("keeps frames completed before an oversized frame in the same chunk", () => {
    const decoder = new NdjsonDecoder({ maxFrameBytes: 12 });
    const error = assertFault(
      () => decoder.push(bytes('{"a":1}\n{"b":2}\n{"long":"xxxxxxxxxxxxxxxx"}\n')),
      "frame_too_large",
    );
    assert.deepEqual(error.framesBeforeFault, [{ a: 1 }, { b: 2 }]);
  });

  it("is unaffected by the caller reusing its buffer after a partial line", () => {
    const decoder = new NdjsonDecoder();
    const reused = new Uint8Array(16);
    reused.set(bytes('{"text":"你'));
    const firstLength = bytes('{"text":"你').byteLength;
    assert.deepEqual(decoder.push(reused.subarray(0, firstLength)), []);
    reused.fill(0x58);
    reused.set(bytes('好"}\n'));
    assert.deepEqual(decoder.push(reused.subarray(0, bytes('好"}\n').byteLength)), [{ text: "你好" }]);
  });

  it("strips a leading byte order mark exactly like the previous decoder", () => {
    const decoder = new NdjsonDecoder();
    assert.deepEqual(decoder.push(bytes('\uFEFF{"bom":true}\n')), [{ bom: true }]);
    assert.deepEqual(decoder.push(bytes('{"after":1}\n')), [{ after: 1 }]);
  });

  it("reports invalid UTF-8 inside a complete line after earlier frames, whatever the chunking", () => {
    const stream = Uint8Array.of(
      ...bytes('{"ok":1}\n{"bad":"'),
      0xff,
      0xfe,
      ...bytes('"}\n'),
    );
    for (let split = 0; split <= stream.byteLength; split += 1) {
      assert.deepEqual(
        decodeChunks([stream.subarray(0, split), stream.subarray(split)]),
        { frames: [{ ok: 1 }], terminalCode: "invalid_utf8", terminalState: "faulted" },
        `split ${split}`,
      );
    }
  });

  it("decodes a large multi-megabyte frame delivered in pipe-sized chunks", () => {
    const text = "line of tool output 你好\n".repeat(120_000);
    const stream = bytes(`${JSON.stringify({ text })}\n`);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < stream.byteLength; offset += 65_536) {
      chunks.push(stream.subarray(offset, offset + 65_536));
    }
    assert.ok(stream.byteLength > 3 * 1024 * 1024);
    const outcome = decodeChunks(chunks);
    assert.equal(outcome.terminalCode, undefined);
    assert.equal((outcome.frames[0] as { text: string }).text.length, text.length);
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
