/**
 * Main-process publish/projection benchmark (no Electron UI).
 *
 * Drives the real live desktop service with a scripted fake runtime:
 *   1. seed   - run ~72 scripted turns so one task holds ~500 conversation rows,
 *               including large tool outputs and diffs (written to a template dir).
 *   2. stream - copy the template, open the service, then stream 500 chunks and
 *               report publish cost and IPC payload bytes.
 *
 * Usage:
 *   node scripts/bench/render-publish-bench.mjs seed   --root <repo> --data <dir>
 *   node scripts/bench/render-publish-bench.mjs stream --root <repo> --data <dir> \
 *        [--scenario text|mixed] [--chunks 500] [--gap-ms 4] [--json out.json]
 *
 * `--root` selects which build to measure (a repo checkout with compiled dist/),
 * so the same script measures the original and the optimized code.
 * Run through scripts/bench/run-render-bench.mjs to also get a CPU-profile breakdown.
 */
import { realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
const root = resolve(args.root ?? ".");
const dataDir = resolve(args.data ?? join(tmpdir(), "guild-render-bench"));
const workspaceDir = join(dataDir, "workspace");
let workspaceRoot = workspaceDir;
const templateDir = join(dataDir, "template");

if (mode !== "seed" && mode !== "stream") {
  console.error("usage: render-publish-bench.mjs seed|stream --root <repo> --data <dir>");
  process.exit(2);
}

const { createLiveDesktopService } = await import(
  pathToFileURL(join(root, "apps/desktop/dist/main/live-service.js")).href
);

async function seed() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(templateDir, { recursive: true });
  workspaceRoot = realpathSync(workspaceDir);
  const service = newService(templateDir);
  const initial = await service.chooseWorkspace();
  const task = await service.createTask(initial.workspaces[0].workspaceId);
  const taskId = task.task.taskId;
  const turns = Number(args.turns ?? 72);
  for (let turn = 0; turn < turns; turn += 1) {
    await service.sendMessage(taskId, `seed-${turn}`);
    await waitFor(async () => {
      const view = (await service.bootstrap()).activeTask;
      return view?.task.activeRunState === "completed" && (view.task.queuedTurnCount ?? 0) === 0;
    });
  }
  const bigView = (await service.bootstrap()).activeTask;
  const bigTimelineItems = bigView.timeline.length;
  // Many small tasks across several workspaces make the sidebar realistic.
  const extraTasks = Number(args["extra-tasks"] ?? 120);
  const extraWorkspaces = Number(args["extra-workspaces"] ?? 4);
  const workspaceIds = [initial.workspaces[0].workspaceId];
  for (let index = 1; index < extraWorkspaces; index += 1) {
    const dir = join(dataDir, `workspace-${index}`);
    await mkdir(dir, { recursive: true });
    workspaceQueue.push(dir);
    const next = await service.chooseWorkspace();
    workspaceIds.push(next.workspaces.find((candidate) => !workspaceIds.includes(candidate.workspaceId)).workspaceId);
  }
  for (let index = 0; index < extraTasks; index += 1) {
    const extra = await service.createTask(workspaceIds[index % workspaceIds.length]);
    await service.sendMessage(extra.task.taskId, `extra-task-${index}`);
    await waitFor(async () => {
      const projection = await service.bootstrap();
      return projection.workspaces.flatMap((workspace) => workspace.tasks)
        .find((candidate) => candidate.taskId === extra.task.taskId)?.activeRunState === "completed";
    });
  }
  await service.openTask(taskId);
  await writeFile(join(templateDir, "bench-meta.json"), JSON.stringify({ taskId }));
  console.log(JSON.stringify({
    seeded: true,
    turns,
    bigTaskTimelineItems: bigTimelineItems,
    extraTasks,
    snapshotBytesWithBigTaskActive: serialize(await service.bootstrap()).byteLength,
  }));
  await service.close();
}

async function stream() {
  const scenario = args.scenario ?? "text";
  const chunks = Number(args.chunks ?? 500);
  const gapMs = Number(args["gap-ms"] ?? 4);
  const runDir = await mkdtemp(join(tmpdir(), "guild-render-bench-run-"));
  await cp(templateDir, runDir, { recursive: true });
  const service = newService(runDir, { scenario, chunks, gapMs });
  const { taskId } = JSON.parse(await readFile(join(templateDir, "bench-meta.json"), "utf8"));
  await service.bootstrap();
  await service.openTask(taskId);
  const sidebarTasks = (await service.bootstrap()).workspaces
    .reduce((count, workspace) => count + workspace.tasks.length, 0);

  const metrics = {
    projections: 0,
    projectionBytes: 0,
    projectionSerializeMs: 0,
    deltas: 0,
    deltaBytes: 0,
    deltaSerializeMs: 0,
  };
  let markCompleted;
  const completed = new Promise((resolveCompleted) => { markCompleted = resolveCompleted; });
  let streaming = false;
  let sawLiveRun = false;
  const unsubscribe = service.subscribe((projection) => {
    const start = performance.now();
    const bytes = serialize(projection).byteLength;
    metrics.projectionSerializeMs += performance.now() - start;
    metrics.projections += 1;
    metrics.projectionBytes += bytes;
    // Completion is observed from pushed projections so polling never adds build work.
    const state = projection.activeTask?.task.activeRunState;
    if (streaming && state !== undefined && state !== "completed") sawLiveRun = true;
    if (streaming && sawLiveRun && state === "completed") markCompleted();
  });
  const unsubscribeDelta = typeof service.subscribeStreamDeltas === "function"
    ? service.subscribeStreamDeltas((delta) => {
        const start = performance.now();
        const bytes = serialize(delta).byteLength;
        metrics.deltaSerializeMs += performance.now() - start;
        metrics.deltas += 1;
        metrics.deltaBytes += bytes;
      })
    : () => undefined;

  // Warm the JIT and statement caches with one idle bootstrap before measuring.
  await service.bootstrap();
  const idleBuild = [];
  for (let index = 0; index < 5; index += 1) {
    const start = performance.now();
    await service.bootstrap();
    idleBuild.push(performance.now() - start);
  }

  const loopDelay = monitorEventLoopDelay({ resolution: 1 });
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  const wall0 = performance.now();
  loopDelay.enable();
  streaming = true;
  await service.sendMessage(taskId, scenario === "mixed" ? "bench-mixed" : "bench-text");
  await Promise.race([
    completed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("bench_wait_timeout")), 120_000).unref()),
  ]);
  // Let trailing throttled publishes drain so their cost is counted.
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 700));
  loopDelay.disable();
  const wallMs = performance.now() - wall0;
  const cpu = process.cpuUsage(cpu0);
  const elu = performance.eventLoopUtilization(elu0);
  unsubscribe();
  unsubscribeDelta();

  const finalView = (await service.bootstrap()).activeTask;
  const result = {
    root,
    scenario,
    chunks,
    gapMs,
    sidebarTasks,
    timelineItems: finalView.timeline.length,
    snapshotBytes: serialize(await service.bootstrap()).byteLength,
    idleBootstrapMs: round(median(idleBuild)),
    wallMs: round(wallMs),
    cpuMs: round((cpu.user + cpu.system) / 1000),
    eventLoopUtilization: round(elu.utilization, 3),
    eventLoopDelayMaxMs: round(loopDelay.max / 1e6),
    eventLoopDelayP99Ms: round(loopDelay.percentile(99) / 1e6),
    eventLoopDelayMeanMs: round(loopDelay.mean / 1e6),
    ...Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value)])),
    ipcBytesTotal: metrics.projectionBytes + metrics.deltaBytes,
  };
  await service.close();
  await rm(runDir, { recursive: true, force: true });
  console.log(JSON.stringify(result, null, 2));
  if (args.json !== undefined) await writeFile(args.json, `${JSON.stringify(result, null, 2)}\n`);
}

const workspaceQueue = [];
function newService(databaseDir, script = {}) {
  return createLiveDesktopService({
    appVersion: "bench",
    databasePath: join(databaseDir, "guild.sqlite3"),
    stagingRoot: join(databaseDir, "staging"),
    chooseWorkspace: async () => workspaceQueue.shift() ?? workspaceDir,
    runtimeFactory: async ({ adapterEpoch, sink }) => ({
      runtimeVersion: "Bench Grok 1.0",
      adapter: new BenchAdapter(adapterEpoch, sink, script),
    }),
  });
}

class BenchAdapter {
  state = "created";
  sequence = 0;
  constructor(adapterEpoch, sink, script) {
    this.adapterEpoch = adapterEpoch;
    this.sink = sink;
    this.script = script;
    this.sessionId = "bench-session";
  }
  async start() {
    this.state = "ready";
    return Object.freeze({
      protocolVersion: 1,
      agentCapabilities: Object.freeze({
        loadSession: false,
        resumeSession: true,
        prompt: Object.freeze({ image: false, audio: false, embeddedContext: false }),
      }),
      authMethods: Object.freeze([]),
      agentInfo: Object.freeze({ name: "Bench Grok", version: "1.0" }),
    });
  }
  async authenticate() {}
  async officialBilling() { return Object.freeze({ creditUsagePercent: 0 }); }
  async setModel() {}
  async setMode() {}
  async setConfigOption() { return Object.freeze([]); }
  async newSession() {
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "new",
      state: {},
    });
    return this.session("new");
  }
  async resumeSession() {
    await this.sink.commitSessionEstablished({
      identity: { adapterEpoch: this.adapterEpoch, sessionId: this.sessionId },
      establishedBy: "resume",
      state: {},
    });
    return this.session("resume");
  }
  async loadSession() { throw new Error("not supported"); }
  async cancel() { return writeReceipt(); }
  async close() { this.state = "closed"; }
  session(establishedBy) {
    return Object.freeze({
      adapterEpoch: this.adapterEpoch,
      sessionId: this.sessionId,
      establishedBy,
    });
  }
  async prompt(session, text) {
    try {
      return await this.runPrompt(session, text);
    } catch (cause) {
      if (process.env.BENCH_DEBUG === "1") console.error("bench prompt error", cause);
      throw cause;
    }
  }
  async runPrompt(session, text) {
    this.sequence += 1;
    const identity = {
      adapterEpoch: this.adapterEpoch,
      sessionId: session.sessionId,
      promptSequence: this.sequence,
    };
    await this.sink.commitPromptAccepted({ identity, write: writeReceipt() });
    const emit = (payload) => this.sink.commitUpdate({
      identity,
      ingestMode: "live",
      promptSequence: this.sequence,
      update: { type: "turn", payload: { sessionId: session.sessionId, received: received(), ...payload } },
    });
    if (text.startsWith("seed-")) {
      await seedTurn(emit, Number(text.slice(5)));
    } else if (text === "bench-text") {
      await emit({ type: "agent_thought_chunk", text: "Planning the answer." });
      await streamText(emit, this.script.chunks ?? 500, this.script.gapMs ?? 4, 0);
    } else if (text === "bench-mixed") {
      await emit({ type: "agent_thought_chunk", text: "Planning the answer." });
      await streamText(emit, this.script.chunks ?? 500, this.script.gapMs ?? 4, 8);
    } else {
      await emit({ type: "agent_text_chunk", text: `reply:${text}` });
    }
    const terminal = Object.freeze({
      type: "prompt_terminal",
      sessionId: session.sessionId,
      stopReason: "end_turn",
      classification: "completed",
      received: received(),
    });
    await this.sink.commitPromptTerminal({ identity, terminal });
    return terminal;
  }
}

async function seedTurn(emit, turn) {
  const large = turn % 5 === 0;
  await emit({ type: "agent_thought_chunk", text: `Thinking about step ${turn}. ` });
  await emit({ type: "agent_thought_chunk", text: "Reading the relevant files first." });
  await emit({
    type: "tool_call_create",
    toolCallId: `read-${turn}`,
    title: `Read src/module-${turn}.ts`,
    kind: "read",
    status: "in_progress",
    locations: [{ path: join(workspaceRoot, `src/module-${turn}.ts`), line: 10 }],
  });
  await emit({
    type: "tool_call_update",
    toolCallId: `read-${turn}`,
    status: "completed",
    content: [{ type: "text", text: filler(large ? 22_000 : 5_000, turn) }],
  });
  await emit({
    type: "tool_call_create",
    toolCallId: `edit-${turn}`,
    title: `Edit src/module-${turn}.ts`,
    kind: "edit",
    status: "in_progress",
    locations: [{ path: join(workspaceRoot, `src/module-${turn}.ts`), line: 12 }],
  });
  await emit({
    type: "tool_call_update",
    toolCallId: `edit-${turn}`,
    status: "completed",
    content: [{
      type: "diff",
      path: join(workspaceRoot, `src/module-${turn}.ts`),
      oldText: filler(3_000, turn + 1),
      newText: filler(3_200, turn + 2),
    }],
  });
  for (let part = 0; part < 4; part += 1) {
    await emit({
      type: "agent_text_chunk",
      messageId: `m-${turn}`,
      text: `${part === 0 ? "" : "\n\n"}${paragraph(turn, part)}`,
    });
  }
}

async function streamText(emit, chunks, gapMs, toolEvery) {
  let toolsStarted = 0;
  for (let index = 0; index < chunks; index += 1) {
    const text = index % 40 === 39
      ? `${token(index)}\n\n`
      : `${token(index)} `;
    await emit({ type: "agent_text_chunk", messageId: "m-stream", text });
    if (toolEvery > 0 && index % Math.ceil(chunks / toolEvery) === 0 && index > 0) {
      toolsStarted += 1;
      await emit({
        type: "tool_call_create",
        toolCallId: `stream-tool-${toolsStarted}`,
        title: `Run check ${toolsStarted}`,
        kind: "execute",
        status: "in_progress",
      });
      await emit({
        type: "tool_call_update",
        toolCallId: `stream-tool-${toolsStarted}`,
        status: "completed",
        content: [{ type: "text", text: filler(12_000, index) }],
      });
    }
    if (gapMs > 0) await new Promise((resolveTimer) => setTimeout(resolveTimer, gapMs));
  }
}

const WORDS = ["streaming", "render", "frame", "token", "markdown", "list", "code", "panel", "queue",
  "update", "snapshot", "delta", "viewport", "commit", "layout", "style"];
function token(index) {
  return `${WORDS[index % WORDS.length]}${index % 7 === 0 ? "," : ""}`;
}
function paragraph(turn, part) {
  const words = [];
  for (let index = 0; index < 48; index += 1) words.push(WORDS[(turn * 7 + part * 3 + index) % WORDS.length]);
  return part === 2
    ? `- ${words.slice(0, 8).join(" ")}\n- ${words.slice(8, 16).join(" ")}\n- ${words.slice(16, 24).join(" ")}`
    : `${words.join(" ")}.`;
}
function filler(length, seed) {
  const lines = [];
  let total = 0;
  for (let line = 0; total < length; line += 1) {
    const text = `${(seed * 31 + line).toString(16)} ${WORDS[(seed + line) % WORDS.length]} line ${line} of generated output\n`;
    lines.push(text);
    total += text.length;
  }
  return lines.join("").slice(0, length);
}

function received() {
  return Object.freeze({ wallClockIso: new Date().toISOString(), monotonicMs: performance.now() });
}
function writeReceipt() {
  return Object.freeze({
    type: "write_completed",
    messageType: "request",
    requestId: 1,
    bytes: 1,
    evidence: "local_writer_completion",
    remoteAcceptance: "not_evidenced",
  });
}

async function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 20));
  }
  throw new Error("bench_wait_timeout");
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
function parseArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item.startsWith("--")) parsed[item.slice(2)] = argv[++index];
    else parsed._.push(item);
  }
  return parsed;
}

if (mode === "seed") await seed();
else await stream();
