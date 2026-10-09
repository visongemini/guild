/**
 * Runs render-publish-bench.mjs under --cpu-prof and prints main-thread time per phase.
 *
 * Usage:
 *   node scripts/bench/run-render-bench.mjs --root <repo> --data <dir> [--scenario text|mixed] [--label name]
 *
 * "inclusive" figures are sampled CPU time spent inside a function and its callees
 * (200 us sampling), so they approximate main-thread milliseconds consumed by that phase.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const passthrough = process.argv.slice(2);
const labelIndex = passthrough.indexOf("--label");
const forwarded = labelIndex < 0
  ? passthrough
  : [...passthrough.slice(0, labelIndex), ...passthrough.slice(labelIndex + 2)];
const profileDir = await mkdtemp(join(tmpdir(), "guild-render-bench-prof-"));
const child = spawnSync(
  process.execPath,
  [
    "--cpu-prof",
    `--cpu-prof-dir=${profileDir}`,
    "--cpu-prof-interval=200",
    join(here, "render-publish-bench.mjs"),
    "stream",
    ...forwarded,
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (child.status !== 0) {
  console.error(child.stderr || child.stdout);
  process.exit(child.status ?? 1);
}
const bench = JSON.parse(child.stdout.slice(child.stdout.indexOf("{")));
const profileName = (await readdir(profileDir)).find((name) => name.endsWith(".cpuprofile"));
const profile = JSON.parse(await readFile(join(profileDir, profileName), "utf8"));
await rm(profileDir, { recursive: true, force: true });

const summary = summarize(profile, [
  "buildBootstrap",
  "taskView",
  "projectEntry",
  "buildTaskWorkbench",
  "listRecentConversationEntries",
  "decodeMetadata",
  "commitLiveRuntimeEvent",
  "emitStreamDelta",
  "flushStreamDeltas",
  "serialize",
]);
console.log(JSON.stringify({ label: argValue("label"), bench, profile: summary }, null, 2));

function argValue(name) {
  const index = passthrough.indexOf(`--${name}`);
  return index < 0 ? undefined : passthrough[index + 1];
}

function summarize(cpuProfile, names) {
  const nodes = new Map(cpuProfile.nodes.map((node) => [node.id, node]));
  const parent = new Map();
  for (const node of cpuProfile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const selfMicros = new Map();
  const { samples, timeDeltas } = cpuProfile;
  for (let index = 0; index < samples.length; index += 1) {
    const micros = timeDeltas[index + 1] ?? timeDeltas[index] ?? 0;
    selfMicros.set(samples[index], (selfMicros.get(samples[index]) ?? 0) + micros);
  }
  let totalMicros = 0;
  let idleMicros = 0;
  const inclusive = new Map(names.map((name) => [name, 0]));
  for (const [nodeId, micros] of selfMicros) {
    totalMicros += micros;
    const frame = nodes.get(nodeId).callFrame.functionName;
    if (frame === "(idle)") idleMicros += micros;
    const seen = new Set();
    for (let current = nodeId; current !== undefined; current = parent.get(current)) {
      const name = nodes.get(current).callFrame.functionName;
      if (inclusive.has(name) && !seen.has(name)) {
        seen.add(name);
        inclusive.set(name, inclusive.get(name) + micros);
      }
    }
  }
  return {
    profiledMs: Math.round(totalMicros / 100) / 10,
    busyMs: Math.round((totalMicros - idleMicros) / 100) / 10,
    inclusiveMs: Object.fromEntries([...inclusive].map(([name, micros]) => [name, Math.round(micros / 100) / 10])),
  };
}
