/**
 * NDJSON decoder throughput on a synthetic ~20 MB stdout stream.
 *
 * Usage: node scripts/bench/ndjson-bench.mjs --root <repo> [--mb 20] [--chunk 65536] [--runs 5]
 *
 * The stream mixes small JSON-RPC style frames with large tool-output frames, delivered in
 * pipe-sized chunks so frames straddle chunk boundaries (and some multibyte characters do too).
 */
import { performance } from "node:perf_hooks";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, item, index, all) =>
  item.startsWith("--") ? [...pairs, [item.slice(2), all[index + 1]]] : pairs, []));
const root = resolve(args.root ?? ".");
const targetBytes = Number(args.mb ?? 20) * 1024 * 1024;
const chunkBytes = Number(args.chunk ?? 65_536);
const runs = Number(args.runs ?? 5);
const { NdjsonDecoder } = await import(
  pathToFileURL(join(root, "packages/runtime-grok/dist/ndjson.js")).href
);

const encoder = new TextEncoder();
const frames = [];
let total = 0;
for (let index = 0; total < targetBytes; index += 1) {
  const large = index % 40 === 39;
  const body = large
    ? `tool output line ${index} 你好 \u{1F600} `.repeat(Math.floor(200_000 / 24))
    : `chunk ${index}`.repeat(8);
  const line = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: body } } },
  })}\n`;
  const bytes = encoder.encode(line);
  frames.push(bytes);
  total += bytes.length;
}
const stream = new Uint8Array(total);
let cursor = 0;
for (const bytes of frames) { stream.set(bytes, cursor); cursor += bytes.length; }

function decodeOnce() {
  const decoder = new NdjsonDecoder();
  let count = 0;
  const start = performance.now();
  for (let offset = 0; offset < stream.length; offset += chunkBytes) {
    count += decoder.push(stream.subarray(offset, Math.min(stream.length, offset + chunkBytes))).length;
  }
  decoder.end();
  return { ms: performance.now() - start, count };
}

decodeOnce();
const samples = [];
let frameCount = 0;
for (let run = 0; run < runs; run += 1) {
  const { ms, count } = decodeOnce();
  samples.push(ms);
  frameCount = count;
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({
  root,
  streamMB: Math.round(total / 1048576 * 10) / 10,
  frames: frameCount,
  chunkBytes,
  medianMs: Math.round(median * 10) / 10,
  minMs: Math.round(samples[0] * 10) / 10,
  throughputMBps: Math.round((total / 1048576) / (median / 1000) * 10) / 10,
}));
