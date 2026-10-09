#!/usr/bin/env node
/**
 * Persistence benchmark for the Guild 2.2 speed plan (WP2 and WP3).
 *
 * Works against the built @guild/persistence package (run `npm run build` first).
 * Every scenario runs on a fresh copy-on-write clone of the given database, so the
 * source file is never modified. Only counts and timings are printed, never content.
 *
 *   node scripts/bench/persistence-bench.mjs --db /path/to/guild.sqlite3 \
 *     [--label before] [--out result.json] [--chunks 2000] [--interval-ms 5] \
 *     [--repeat 3] [--only open-clean,open-unclean,task-open,search,stream]
 *
 * Scenarios:
 *   open-clean    openGuildPersistence on a database whose last shutdown was clean.
 *   open-unclean  same, after clearing guild_meta.clean_shutdown (crash recovery path).
 *   task-open     restore + context tokens + first page of the task with the most entries.
 *   search        one common word and one rare word through the store search path.
 *   stream        a synthetic stream of small text chunks written through
 *                 commitLiveRuntimeEvent, the same write path the live service uses.
 *                 With --repeat N it runs N times on fresh clones; the run with the median
 *                 total is reported as "stream" and all runs as "streamRuns".
 */
import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import {
  createRuntimeTurnEvent,
  parseAdapterEpoch,
  parseIdempotencyKey,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
} from "@guild/contracts";
import { openGuildPersistence, SCHEMA_VERSION } from "@guild/persistence";

const originalSetTimeout = globalThis.setTimeout;

function parseArguments(argv) {
  const options = {
    db: process.env.GUILD_BENCH_DB,
    label: "run",
    out: undefined,
    chunks: 2000,
    intervalMs: 5,
    repeat: 1,
    only: new Set(["open-clean", "open-unclean", "task-open", "search", "stream"]),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--db") options.db = value;
    else if (flag === "--label") options.label = value;
    else if (flag === "--out") options.out = value;
    else if (flag === "--chunks") options.chunks = Number(value);
    else if (flag === "--interval-ms") options.intervalMs = Number(value);
    else if (flag === "--repeat") options.repeat = Math.max(1, Number(value));
    else if (flag === "--only") options.only = new Set(String(value).split(","));
    else continue;
    index += 1;
  }
  if (options.db === undefined || !existsSync(options.db)) {
    throw new Error("pass --db <path to a COPY of guild.sqlite3> (or set GUILD_BENCH_DB)");
  }
  return options;
}

function unwrap(result) {
  if (!result.ok) throw new Error(`unexpected result: ${result.reason}`);
  return result.value;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

/** CPU time (user + system) of this process since `start`, in milliseconds. */
function cpuMsSince(start) {
  const used = process.cpuUsage(start);
  return (used.user + used.system) / 1000;
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalMs: round(total),
    p50Ms: round(percentile(sorted, 0.5), 3),
    p99Ms: round(percentile(sorted, 0.99), 3),
    maxMs: round(sorted.at(-1) ?? 0, 3),
  };
}

/** Fresh clone of the source database in its own temporary directory. */
function cloneDatabase(source) {
  const directory = mkdtempSync(join(tmpdir(), "guild-persistence-bench-"));
  const path = join(directory, "guild.sqlite3");
  copyFileSync(source, path, constants.COPYFILE_FICLONE);
  return {
    path,
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  };
}

function rawUserVersion(path) {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("PRAGMA user_version").get().user_version;
  } finally {
    raw.close();
  }
}

function rawExec(path, sql, ...parameters) {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare(sql).all(...parameters);
  } finally {
    raw.close();
  }
}

function setCleanShutdown(path, clean) {
  rawExec(path, "UPDATE guild_meta SET clean_shutdown = ? WHERE singleton = 1", clean ? 1 : 0);
}

/** When the clone predates the current schema, migrate it once and report the cost separately. */
function migrateIfNeeded(path) {
  if (rawUserVersion(path) === SCHEMA_VERSION) return 0;
  const started = performance.now();
  const store = openGuildPersistence({ path });
  store.close();
  return performance.now() - started;
}

function usedBytes(path) {
  const raw = new DatabaseSync(path, { readOnly: true });
  try {
    const pageSize = raw.prepare("PRAGMA page_size").get().page_size;
    const pageCount = raw.prepare("PRAGMA page_count").get().page_count;
    const freelist = raw.prepare("PRAGMA freelist_count").get().freelist_count;
    return (pageCount - freelist) * pageSize;
  } finally {
    raw.close();
  }
}

function openTimed(path) {
  const started = performance.now();
  const store = openGuildPersistence({ path });
  return { store, openMs: performance.now() - started };
}

function scenarioOpen(options, clean) {
  const clone = cloneDatabase(options.db);
  try {
    const migrationMs = migrateIfNeeded(clone.path);
    setCleanShutdown(clone.path, clean);
    const { store, openMs } = openTimed(clone.path);
    const recovered = store.recoveredAfterUncleanShutdown;
    store.close();
    return {
      migrationMs: round(migrationMs),
      openAndVerifyMs: round(openMs),
      recoveredAfterUncleanShutdown: recovered,
    };
  } finally {
    clone.cleanup();
  }
}

function largestTask(path) {
  const rows = rawExec(
    path,
    `SELECT task_id, COUNT(*) AS entries FROM conversation_entries
     GROUP BY task_id ORDER BY entries DESC LIMIT 1`,
  );
  return { taskId: rows[0].task_id, entries: rows[0].entries };
}

function time(label, work, timings) {
  const started = performance.now();
  const value = work();
  timings[label] = round(performance.now() - started);
  return value;
}

function scenarioTaskOpen(options) {
  const clone = cloneDatabase(options.db);
  try {
    migrateIfNeeded(clone.path);
    setCleanShutdown(clone.path, true);
    const target = largestTask(clone.path);
    const { store, openMs } = openTimed(clone.path);
    try {
      const taskId = unwrap(parseTaskId(target.taskId));
      const timings = {};
      time("loadTaskMetadata", () => store.loadTaskMetadata(taskId), timings);
      time("restoreTask", () => store.restoreTask(taskId), timings);
      const tokens = time("loadLatestContextTokensUsed", () => store.loadLatestContextTokensUsed(taskId), timings);
      const page = time("listRecentConversationEntries(200)", () =>
        store.listRecentConversationEntries({ taskId, limit: 200 }), timings);
      time("countConversationEntries", () => store.countConversationEntries(taskId), timings);
      time("loadContextWindowSize", () => store.loadContextWindowSize(taskId), timings);
      time("listQueuedTurns", () => store.listQueuedTurns(taskId), timings);
      const totalMs = Object.values(timings).reduce((sum, value) => sum + value, 0);
      return {
        taskEntries: target.entries,
        contextTokensFound: tokens !== undefined,
        firstPageEntries: page.length,
        openMs: round(openMs),
        timingsMs: timings,
        totalFirstOpenMs: round(totalMs),
      };
    } finally {
      store.close();
    }
  } finally {
    clone.cleanup();
  }
}

/** The pre-2.2 search: decode every entry of every active task, then match in JavaScript. */
function legacySearch(store, query, limit) {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const matches = [];
  for (const workspace of store.listWorkspaces({ includeArchived: true })) {
    if (workspace.disposition !== "active") continue;
    for (const task of store.listTasks({ workspaceId: workspace.workspaceId })) {
      const entries = [];
      let afterSequence = 0;
      for (;;) {
        const page = store.listConversationEntries({ taskId: task.taskId, afterSequence, limit: 500 });
        if (page.length === 0) break;
        entries.push(...page);
        afterSequence = page.at(-1).sequence;
      }
      for (const entry of entries) {
        if (entry.metadata.hidden === true || !["user", "assistant"].includes(entry.kind)) continue;
        if (entry.text.toLocaleLowerCase("zh-CN").indexOf(needle) < 0) continue;
        matches.push(entry.sequence);
        if (matches.length >= limit) break;
      }
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  return matches.length;
}

function storeSearch(store, query, limit) {
  if (typeof store.searchConversationEntries !== "function") {
    return { path: "legacy-decode-all", hits: legacySearch(store, query, limit) };
  }
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const entries = store.searchConversationEntries({ query, limit });
  const confirmed = entries.filter((entry) => entry.text.toLocaleLowerCase("zh-CN").includes(needle));
  return { path: "sql-like", hits: confirmed.length };
}

function scenarioSearch(options) {
  const clone = cloneDatabase(options.db);
  try {
    migrateIfNeeded(clone.path);
    setCleanShutdown(clone.path, true);
    const { store } = openTimed(clone.path);
    try {
      const result = {};
      for (const [label, query] of [["commonWord", "the"], ["rareWord", "zzqxvbench"]]) {
        const started = performance.now();
        const outcome = storeSearch(store, query, 50);
        result[label] = { ms: round(performance.now() - started), hits: outcome.hits, path: outcome.path };
      }
      return result;
    } finally {
      store.close();
    }
  } finally {
    clone.cleanup();
  }
}

function makeKey(prefix) {
  return unwrap(parseIdempotencyKey(`${prefix}-${randomUUID()}`));
}

function prepareLiveTask(store) {
  const taskId = unwrap(parseTaskId(`bench-task-${randomUUID()}`));
  const runId = unwrap(parseRunId(`bench-run-${randomUUID()}`));
  const sessionId = unwrap(parseSessionId(`bench-session-${randomUUID()}`));
  const adapterEpoch = unwrap(parseAdapterEpoch(1));
  const workspaceId = `bench-workspace-${randomUUID()}`;
  store.createWorkspace({
    workspaceId,
    canonicalPath: `/tmp/guild-bench-${workspaceId}`,
    displayName: "Bench workspace",
  });
  store.createConversationTask({ taskId, workspaceId, title: "Bench task" });
  const attemptId = unwrap(parseSessionAttemptId(`bench-attempt-${randomUUID()}`));
  const started = store.applySessionBinding({
    taskId,
    event: { type: "start_session", attemptId, idempotencyKey: makeKey("bench-start") },
  });
  if (!started.ok) throw new Error(`start_session: ${started.reason}`);
  const established = store.applySessionBinding({
    taskId,
    event: {
      type: "session_new_succeeded",
      sessionId,
      adapterEpoch,
      attemptId,
      idempotencyKey: makeKey("bench-established"),
    },
  });
  if (!established.ok) throw new Error(`session_new_succeeded: ${established.reason}`);
  store.createRun({ taskId, runId });
  const dispatched = store.applyRun({
    taskId,
    runId,
    event: { type: "scheduler_dispatch", sessionId, adapterEpoch, idempotencyKey: makeKey("bench-dispatch") },
  });
  if (!dispatched.ok) throw new Error(`scheduler_dispatch: ${dispatched.reason}`);
  store.commitAdapterEpoch({ taskId, sessionId, adapterEpoch, expectedRevision: 0, status: "alive" });
  store.commitPromptAccepted({
    taskId,
    runId,
    sessionId,
    adapterEpoch,
    promptSequence: 1,
    idempotencyKey: makeKey("bench-accepted"),
  });
  return { taskId, runId, sessionId, adapterEpoch };
}

const CHUNK_TEXTS = ["a", "。", "的", "ing", "the", " ", "code", "，", "x", "\n"];

async function scenarioStream(options) {
  const clone = cloneDatabase(options.db);
  const timerCallbackMs = [];
  let persistenceCpuMs = 0;
  const patchedSetTimeout = (callback, delay, ...rest) =>
    originalSetTimeout((...args) => {
      const started = performance.now();
      const cpuStart = process.cpuUsage();
      try {
        return callback(...args);
      } finally {
        persistenceCpuMs += cpuMsSince(cpuStart);
        timerCallbackMs.push(performance.now() - started);
      }
    }, delay, ...rest);
  try {
    migrateIfNeeded(clone.path);
    setCleanShutdown(clone.path, true);
    const usedBefore = usedBytes(clone.path);
    const { store } = openTimed(clone.path);
    const live = prepareLiveTask(store);
    const callMs = [];
    let receiveSequence = 0;
    const streaming = new Map();
    const thoughtChunks = Math.min(100, Math.floor(options.chunks / 10));
    const sleep = (ms) => new Promise((resolve) => originalSetTimeout(resolve, ms));

    globalThis.setTimeout = patchedSetTimeout;
    const cpuStarted = process.cpuUsage();
    const wallStarted = performance.now();
    for (let index = 0; index < options.chunks; index += 1) {
      const type = index < thoughtChunks ? "agent_thought_chunk" : "agent_text_chunk";
      const kind = type === "agent_text_chunk" ? "assistant" : "thought";
      const text = CHUNK_TEXTS[index % CHUNK_TEXTS.length];
      receiveSequence += 1;
      const event = unwrap(createRuntimeTurnEvent({
        taskId: live.taskId,
        runId: live.runId,
        adapterEpoch: live.adapterEpoch,
        ingestMode: "live",
        receiveSequence,
        idempotencyKey: makeKey("runtime-event"),
        payload: {
          type,
          sessionId: live.sessionId,
          received: { wallClockIso: new Date().toISOString(), monotonicMs: Math.round(performance.now()) },
          text,
        },
      }));
      const previous = streaming.get(kind);
      const mutation = previous === undefined
        ? { type: "create", entryId: `bench-${kind}-${randomUUID()}`, kind, text, status: "streaming" }
        : { type: "append_text", entryId: previous.entryId, expectedRevision: previous.revision, text };
      const cpuStart = process.cpuUsage();
      const started = performance.now();
      const committed = store.commitLiveRuntimeEvent({ event, mutation });
      callMs.push(performance.now() - started);
      persistenceCpuMs += cpuMsSince(cpuStart);
      if (!committed.ok) throw new Error(`chunk ${index}: ${committed.reason}`);
      streaming.set(kind, committed.record);
      await sleep(options.intervalMs);
    }
    const streamWallMs = performance.now() - wallStarted;

    // Terminal: finalize the earlier thought entry, then the terminal event with the final entry.
    const terminalStarted = performance.now();
    const thought = streaming.get("thought");
    if (thought !== undefined) {
      store.finalizeConversationEntry({
        taskId: live.taskId,
        entryId: thought.entryId,
        expectedRevision: thought.revision,
        status: "complete",
      });
    }
    const last = streaming.get("assistant");
    receiveSequence += 1;
    const terminal = unwrap(createRuntimeTurnEvent({
      taskId: live.taskId,
      runId: live.runId,
      adapterEpoch: live.adapterEpoch,
      ingestMode: "live",
      receiveSequence,
      idempotencyKey: makeKey("runtime-event"),
      payload: {
        type: "prompt_terminal",
        sessionId: live.sessionId,
        received: { wallClockIso: new Date().toISOString(), monotonicMs: Math.round(performance.now()) },
        stopReason: "end_turn",
        classification: "completed",
        contextTokensUsed: 4321,
      },
    }));
    const terminalCpuStart = process.cpuUsage();
    const terminalResult = store.commitLiveRuntimeEvent({
      event: terminal,
      mutation: { type: "finalize", entryId: last.entryId, expectedRevision: last.revision, status: "complete" },
      terminalFinalizationIdempotencyKey: makeKey("terminal-finalized"),
    });
    persistenceCpuMs += cpuMsSince(terminalCpuStart);
    if (!terminalResult.ok) throw new Error(`terminal: ${terminalResult.reason}`);
    const terminalMs = performance.now() - terminalStarted;
    const cpu = process.cpuUsage(cpuStarted);
    globalThis.setTimeout = originalSetTimeout;

    const reloaded = store.loadConversationEntry(live.taskId, last.entryId);
    const tokens = store.loadLatestContextTokensUsed(live.taskId);
    const closeStarted = performance.now();
    store.close();
    const closeMs = performance.now() - closeStarted;

    const usedAfter = usedBytes(clone.path);
    const envelopeRows = rawExec(
      clone.path,
      `SELECT COUNT(*) AS rows, COALESCE(SUM(length(event_json)), 0) AS json_bytes
       FROM committed_envelopes WHERE task_id = ?`,
      live.taskId,
    )[0];
    const calls = summarize(callMs);
    const flushes = summarize(timerCallbackMs);
    return {
      chunks: options.chunks,
      intervalMs: options.intervalMs,
      streamWallMs: round(streamWallMs),
      perCall: calls,
      perTimerFlush: flushes,
      terminalCommitMs: round(terminalMs),
      closeMs: round(closeMs),
      totalMainThreadPersistenceMs: round(calls.totalMs + flushes.totalMs + terminalMs),
      // CPU time (user + system) spent inside persistence calls and timers only. Unlike the
      // wall-clock figure above it does not include time spent descheduled on a busy machine.
      persistenceCpuMs: round(persistenceCpuMs),
      // Whole-process CPU over the stream, including the harness's own event building.
      processCpuMs: round((cpu.user + cpu.system) / 1000),
      envelopeRowsWritten: envelopeRows.rows,
      envelopeJsonBytes: envelopeRows.json_bytes,
      dbUsedBytesAdded: usedAfter - usedBefore,
      persistedTextMatchesStream: reloaded.text.length > 0,
      contextTokensRoundTrip: tokens,
    };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    clone.cleanup();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = {
    label: options.label,
    node: process.version,
    schemaVersion: SCHEMA_VERSION,
    sourceBytes: statSync(options.db).size,
    results: {},
  };
  const log = (name, value) => {
    report.results[name] = value;
    console.error(`[${options.label}] ${name}: ${JSON.stringify(value)}`);
  };
  if (options.only.has("open-clean")) log("openClean", scenarioOpen(options, true));
  if (options.only.has("open-unclean")) log("openUnclean", scenarioOpen(options, false));
  if (options.only.has("task-open")) log("taskOpen", scenarioTaskOpen(options));
  if (options.only.has("search")) log("search", scenarioSearch(options));
  if (options.only.has("stream")) {
    const runs = [];
    for (let run = 0; run < options.repeat; run += 1) runs.push(await scenarioStream(options));
    const byTotal = [...runs].sort(
      (a, b) => a.totalMainThreadPersistenceMs - b.totalMainThreadPersistenceMs,
    );
    log("stream", byTotal[Math.floor((byTotal.length - 1) / 2)]);
    if (runs.length > 1) {
      log("streamRuns", runs.map((run) => ({
        totalMainThreadPersistenceMs: run.totalMainThreadPersistenceMs,
        persistenceCpuMs: run.persistenceCpuMs,
        perFlushP99Ms: run.perTimerFlush.p99Ms,
        perFlushMaxMs: run.perTimerFlush.maxMs,
        perCallP99Ms: run.perCall.p99Ms,
        dbUsedBytesAdded: run.dbUsedBytesAdded,
      })));
    }
  }
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out !== undefined) writeFileSync(options.out, text, "utf8");
  process.stdout.write(text);
}

await main();
