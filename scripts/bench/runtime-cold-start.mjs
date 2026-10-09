/**
 * Runtime cold-start benchmark (no Electron UI, no prompts).
 *
 * Times locate + pin/spawn + initialize + authenticate + session/new against the real installed
 * official `grok`, using the compiled runtime-grok package (GrokProcessHost, ACP v1 request
 * encoders) and the desktop runtime locator. It never sends session/prompt and never reads the
 * auth file; authentication stays inside the official process. Each run creates one empty
 * session in a fixed scratch working directory.
 *
 * The ACP responses are read with a tiny NDJSON loop instead of AcpV1Adapter on purpose: the
 * adapter rejects any `available_commands_update` above 128 entries, and an installed `grok`
 * with many user skills advertises more than that, which faults the adapter right after
 * session/new. That is independent of startup cost and would make the benchmark unusable.
 *
 * Usage (after `npm run build`):
 *   node scripts/bench/runtime-cold-start.mjs [--runs 5]
 *
 * Modes (all reported):
 *   cold    fresh node process + empty staging root for every run (first launch ever)
 *   restart fresh node process + shared staging root (app relaunch, on-disk caches present)
 *   warm    one node process, shared staging root, sequential runs after one discarded warm-up
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  locateOfficialGrokRuntime,
  resolveOfficialGrokEnvironment,
} from "../../apps/desktop/dist/main/runtime-locator.js";
import {
  ACP_V1_METHODS,
  GrokProcessHost,
  encodeInitializeParams,
  encodeNewSessionParams,
} from "../../packages/runtime-grok/dist/index.js";

const SELF = fileURLToPath(import.meta.url);
const PHASES = ["locate", "start", "initialize", "authenticate", "session_new", "total", "close"];

/** Minimal JSON-RPC client over the owned process: request/response only, notifications ignored. */
function createRpc(host) {
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  host.onEvent((event) => {
    if (event.type === "stdout_data") {
      buffer += Buffer.from(event.chunk).toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line);
        const waiter = message.method === undefined ? pending.get(message.id) : undefined;
        if (waiter === undefined) continue;
        pending.delete(message.id);
        if (message.error !== undefined) waiter.reject(new Error(`rpc_error:${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      }
    } else if (event.type === "process_exit") {
      for (const waiter of pending.values()) waiter.reject(new Error("bench_process_exited"));
      pending.clear();
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        host.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`).catch(reject);
      });
    },
  };
}

async function runOnce(stagingRoot, workingDirectory) {
  const marks = {};
  const t0 = performance.now();
  const [located, environment] = await Promise.all([
    locateOfficialGrokRuntime(),
    resolveOfficialGrokEnvironment(),
  ]);
  marks.locate = performance.now() - t0;

  const host = new GrokProcessHost({
    executablePath: located.executablePath,
    expectedSha256: located.sha256,
    workingDirectory,
    stagingRoot,
    baseEnvironment: environment,
  });
  const rpc = createRpc(host);
  try {
    let t = performance.now();
    await host.start();
    marks.start = performance.now() - t;

    t = performance.now();
    const initialized = await rpc.request(ACP_V1_METHODS.initialize, encodeInitializeParams());
    marks.initialize = performance.now() - t;

    t = performance.now();
    const methods = initialized.authMethods ?? [];
    const method = methods.length === 1 ? methods[0].id : initialized._meta?.defaultAuthMethodId;
    if (method === undefined) throw new Error("bench_auth_method_unavailable");
    await rpc.request(ACP_V1_METHODS.authenticate, { methodId: method });
    marks.authenticate = performance.now() - t;

    t = performance.now();
    await rpc.request(ACP_V1_METHODS.sessionNew, encodeNewSessionParams(workingDirectory));
    marks.session_new = performance.now() - t;
    marks.total = performance.now() - t0;
  } finally {
    const t = performance.now();
    await host.stop().catch(() => undefined);
    marks.close = performance.now() - t;
  }
  return marks;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarize(label, rows) {
  const line = {};
  for (const phase of PHASES) line[phase] = Math.round(median(rows.map((row) => row[phase] ?? 0)));
  console.log(`${label.padEnd(8)} median ms ${JSON.stringify(line)}`);
  const totals = rows.map((row) => Math.round(row.total));
  console.log(`${"".padEnd(8)} totals ms ${JSON.stringify(totals)}`);
}

function runChild(stagingRoot, workingDirectory) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SELF, "--child", "--staging", stagingRoot, "--cwd", workingDirectory],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`bench child exited ${code}`));
      else resolve(JSON.parse(out.trim().split("\n").at(-1)));
    });
  });
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv.includes("--child")) {
  const marks = await runOnce(argValue("--staging"), argValue("--cwd"));
  console.log(JSON.stringify(marks));
} else {
  const runs = Number.parseInt(argValue("--runs") ?? "5", 10);
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-bench-runtime-")));
  // One fixed working directory: grok keeps a per-cwd session folder under ~/.grok/sessions,
  // so a throwaway cwd per run would leave a new folder behind on every run.
  const workingDirectory = join(await realpath(tmpdir()), "guild-bench-runtime-cwd");
  await mkdir(workingDirectory, { recursive: true });
  try {
    const cold = [];
    for (let i = 0; i < runs; i += 1) {
      const staging = join(root, `cold-${i}`);
      await mkdir(staging, { mode: 0o700 });
      cold.push(await runChild(staging, workingDirectory));
    }
    summarize("cold", cold);

    const sharedStaging = join(root, "shared");
    await mkdir(sharedStaging, { mode: 0o700 });
    await runOnce(sharedStaging, workingDirectory); // discarded warm-up (also seeds on-disk caches)
    const restart = [];
    for (let i = 0; i < runs; i += 1) restart.push(await runChild(sharedStaging, workingDirectory));
    summarize("restart", restart);

    const warm = [];
    for (let i = 0; i < runs; i += 1) warm.push(await runOnce(sharedStaging, workingDirectory));
    summarize("warm", warm);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
