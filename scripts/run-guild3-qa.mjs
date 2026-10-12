/**
 * Guild 3.0 live acceptance QA (docs/20 section 6) on an ISOLATED data directory.
 *
 * It launches the UNPACKAGED app (apps/desktop, built with `npm run build`) with
 *   GUILD_DEV_DATA_DIR=<tmp data dir>      (dev hook, ignored by a packaged app)
 *   GUILD_DEV_CLAUDE_CAPTURE_OFF=1         (keeps QA turns out of the owner's OpenViking store)
 * a remote debugging port and --mute-audio, and drives it over CDP: the preload API
 * (`window.guild.*`) for task flow and the DOM for the picker, the reminder, settings and the
 * browser pane. It never touches /Applications/Guild.app or ~/Library/Application Support/Guild-v2.
 *
 * Seeding (seed-guild3-qa.mjs) confirms the two model sources through the store's confirm function,
 * which replaces the native confirmation dialog for QA only. Key values are never read into output:
 * Guild reads the key file itself. This script reads the two key values only to prove that no copy
 * of them landed in the data directory or the logs (in memory, booleans and counts only).
 *
 * Checks: A Grok queued turns, B Claude file task + restart/resume, C Opus -> DeepSeek, one way (the
 * Claude rows are disabled afterwards, the router refuses claude-* models and never sees a Claude
 * credential), D Local model, E browser pane + agent tools + take over (on a fresh native Claude task,
 * the checked one has left the subscription for good), F settings tabs, G reduced capability
 * (usage popover), H permission card lifecycle after a UI approval.
 * Environment: GUILD_QA_STAMP (reuse a run), GUILD_QA_ONLY=A,B (subset), GUILD_QA_KEEP_APP=1.
 *
 * Usage: node scripts/run-guild3-qa.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedQaData } from "./seed-guild3-qa.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const desktopRoot = join(repoRoot, "apps", "desktop");
const electronBinary = join(desktopRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
const keyFile = join(homedir(), ".config", "guild", "keys.env");

const stamp = process.env.GUILD_QA_STAMP ?? new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "").replace("T", "-");
const workspaceDir = `/tmp/guild3-qa-ws-${stamp}`;
const dataDir = `/tmp/guild3-qa-data-${stamp}`;
const evidenceDir = `/tmp/guild3-qa-evidence-${stamp}`;
const only = new Set((process.env.GUILD_QA_ONLY ?? "A,B,C,D,E,F,G,H").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

mkdirSync(evidenceDir, { recursive: true });
const consoleLog = join(evidenceDir, "qa-console.log");

function log(...parts) {
  const line = `${new Date().toISOString().slice(11, 19)} ${parts.join(" ")}`;
  console.log(line);
  appendFileSync(consoleLog, `${line}\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, probe, { timeout = 30_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timeout:${label}`);
}

/** Error text for reports: bounded, and never anything shaped like a credential. */
function safeText(value, max = 400) {
  const text = String(value ?? "").replace(/[\r\n\t]+/gu, " ").slice(0, max);
  return text.replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{6,}/gu, "[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [REDACTED]");
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

function listProcesses() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.stdout.split("\n").map((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match === null ? undefined : { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  }).filter((entry) => entry !== undefined);
}

function descendantsOf(rootPid, processes = listProcesses()) {
  const found = new Map();
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const entry of processes) {
      if (entry.ppid === parent && !found.has(entry.pid)) {
        found.set(entry.pid, entry);
        queue.push(entry.pid);
      }
    }
  }
  return [...found.values()];
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Whether the process environment names a variable. Only a boolean leaves this function. */
function processEnvHas(pid, name) {
  const result = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const text = result.stdout ?? "";
  return new RegExp(`(?:^|\\s)${name}=`, "u").test(text);
}

function processEnvValueIs(pid, name, value) {
  const result = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return (result.stdout ?? "").includes(` ${name}=${value}`);
}

/** Whether a variable of the process environment starts with `prefix`. Only a boolean leaves this function. */
function processEnvValueStartsWith(pid, name, prefix) {
  const result = spawnSync("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return (result.stdout ?? "").includes(` ${name}=${prefix}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

// ---------------------------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------------------------

let debugPort = 0;
let app; // { child, pid, descendantsSeen: Map<pid, command> }
let launchCount = 0;

async function launchApp() {
  launchCount += 1;
  const out = openSync(join(evidenceDir, `electron-launch-${launchCount}.log`), "a");
  const child = spawn(electronBinary, [".", `--remote-debugging-port=${debugPort}`, "--mute-audio"], {
    cwd: desktopRoot,
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      GUILD_DEV_DATA_DIR: dataDir,
      GUILD_DEV_CLAUDE_CAPTURE_OFF: "1",
    },
  });
  closeSync(out);
  app = { child, pid: child.pid, descendantsSeen: new Map() };
  child.once("exit", (code, signal) => log(`app pid ${child.pid} exited code=${code} signal=${signal}`));
  log(`launched app pid ${child.pid} debug port ${debugPort} data ${dataDir}`);
  await connectCdp();
  await cdp.send("Runtime.enable");
  await until("renderer api", async () => cdp.evaluate("typeof window.guild === 'object' && typeof window.guild.bootstrap === 'function'").catch(() => false), { timeout: 60_000 });
}

function trackDescendants() {
  if (app === undefined) return;
  for (const entry of descendantsOf(app.pid)) app.descendantsSeen.set(entry.pid, entry.command.slice(0, 160));
}

/** Graceful quit first (so the engine processes are closed by Guild itself), then escalation. */
async function quitApp() {
  if (app === undefined) return { stage: "none" };
  trackDescendants();
  const { child, pid } = app;
  const exited = () => !alive(pid);
  let stage = "already_exited";
  if (!exited()) {
    stage = "cdp_browser_close";
    try {
      const version = await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((response) => response.json());
      const socket = new WebSocket(version.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await sleep(500);
      socket.close();
    } catch { /* escalate */ }
    await until("app exit after Browser.close", async () => exited(), { timeout: 12_000 }).catch(() => undefined);
  }
  if (!exited()) {
    stage = "sigterm";
    process.kill(pid, "SIGTERM");
    await until("app exit after SIGTERM", async () => exited(), { timeout: 20_000 }).catch(() => undefined);
  }
  if (!exited()) {
    stage = "sigkill";
    try { process.kill(-pid, "SIGKILL"); } catch { /* group gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    await sleep(1000);
  }
  await sleep(1500);
  const leftovers = [...app.descendantsSeen.keys()].filter((childPid) => alive(childPid));
  const leftoverCommands = leftovers.map((childPid) => safeText(app.descendantsSeen.get(childPid), 110));
  for (const childPid of leftovers) { try { process.kill(childPid, "SIGKILL"); } catch { /* gone */ } }
  const result = { stage, pid, descendantsSeen: app.descendantsSeen.size, leftoversKilled: leftovers.length, leftoverCommands, portClosed: !(await portOpen(debugPort)) };
  log("quit", JSON.stringify(result));
  child.removeAllListeners();
  cdp.close();
  app = undefined;
  return result;
}

// ---------------------------------------------------------------------------------------------
// CDP
// ---------------------------------------------------------------------------------------------

class CdpClient {
  constructor() { this.socket = undefined; this.nextId = 1; this.pending = new Map(); }

  async attach(webSocketUrl) {
    this.close();
    const socket = new WebSocket(webSocketUrl);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return;
      const operation = this.pending.get(message.id);
      if (operation === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) operation.reject(new Error(JSON.stringify(message.error).slice(0, 300)));
      else operation.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const operation of this.pending.values()) operation.reject(new Error("cdp_closed"));
      this.pending.clear();
    });
    this.socket = socket;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (result.exceptionDetails !== undefined) {
      throw new Error(safeText(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "cdp_evaluation_failed"));
    }
    return result.result.value;
  }

  close() {
    try { this.socket?.close(); } catch { /* closed */ }
    this.socket = undefined;
  }
}

const cdp = new CdpClient();

async function connectCdp() {
  const target = await until("guild page target", async () => {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      return targets.find((candidate) => candidate.type === "page" && String(candidate.url).startsWith("guild-app://"));
    } catch { return undefined; }
  }, { timeout: 90_000, interval: 500 });
  await cdp.attach(target.webSocketDebuggerUrl);
}

const call = (method, argument = {}) => cdp.evaluate(`window.guild.${method}(${JSON.stringify(argument)})`);

let shotSequence = 0;
async function shot(check, label, client = cdp) {
  const name = `${check}-${String(++shotSequence).padStart(2, "0")}-${label.replace(/[^A-Za-z0-9_-]+/gu, "-")}.png`;
  try {
    const result = await client.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(evidenceDir, name), Buffer.from(result.data, "base64"));
    return name;
  } catch (error) {
    log(`screenshot failed ${name}: ${safeText(error.message, 120)}`);
    return undefined;
  }
}

/** The page shown inside the browser pane is its own CDP target. */
async function paneClient(urlPrefix) {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page" && String(candidate.url).startsWith(urlPrefix));
  if (target === undefined) return undefined;
  const client = new CdpClient();
  await client.attach(target.webSocketDebuggerUrl);
  return client;
}

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

const locate = (selector, textPattern) => `(() => {
  const pattern = ${textPattern === undefined ? "null" : `new RegExp(${JSON.stringify(textPattern)}, "iu")`};
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => pattern === null || pattern.test(candidate.textContent || ""));
  if (!element) return null;
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height, text: (element.textContent || "").trim().slice(0, 100), disabled: element.disabled === true };
})()`;

async function clickDom(selector, textPattern, { timeout = 15_000 } = {}) {
  const found = await until(`dom ${selector} ${textPattern ?? ""}`, async () => {
    const value = await cdp.evaluate(locate(selector, textPattern));
    return value !== null && value.width > 0 && value.height > 0 ? value : undefined;
  }, { timeout, interval: 200 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: found.x, y: found.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: found.x, y: found.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: found.x, y: found.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(200);
  return found;
}

const domExists = (selector, textPattern) => cdp.evaluate(`(() => {
  const pattern = ${textPattern === undefined ? "null" : `new RegExp(${JSON.stringify(textPattern)}, "iu")`};
  return [...document.querySelectorAll(${JSON.stringify(selector)})].some((candidate) => pattern === null || pattern.test(candidate.textContent || ""));
})()`);

const domText = (selector) => cdp.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((element) => (element.innerText || element.textContent || "").trim()).join("\\n---\\n")`);

// ---------------------------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------------------------

const permissionLog = [];
let workspaceId;

function assistantTextOf(view, runId) {
  return view.timeline.filter((item) => item.kind === "assistant" && (runId === undefined || item.runId === runId)).map((item) => item.text).join("\n");
}

const occurrences = (text, needle) => text.split(needle).length - 1;

function chooseAllow(options) {
  return options.find((option) => option.kind === "allow_once") ?? options.find((option) => option.kind === "allow_always") ?? options.find((option) => !String(option.kind).startsWith("reject"));
}

/**
 * Polls a task until its run is terminal and the queue is empty, approving every permission card the
 * way a user would (screenshot of the first card of each wait, then allow once).
 */
async function waitForRun(check, taskId, runId, { timeout = 300_000, onTick, approve = true } = {}) {
  const decided = new Set();
  let cardShot = false;
  const deadline = Date.now() + timeout;
  let view;
  while (Date.now() < deadline) {
    view = await call("openTask", { taskId });
    if (approve) {
      for (const item of view.timeline) {
        if (item.kind !== "permission" || item.status !== "waiting" || decided.has(item.permissionId)) continue;
        if (!cardShot) {
          cardShot = true;
          await sleep(400);
          await shot(check, "permission-card");
        }
        const option = chooseAllow(item.options);
        if (option === undefined) throw new Error("no_allow_option");
        decided.add(item.permissionId);
        permissionLog.push({ check, title: safeText(item.title, 120), option: option.kind });
        log(`${check} approve "${safeText(item.title, 80)}" (${option.kind})`);
        await call("decidePermission", { taskId, runId: item.runId, permissionId: item.permissionId, decision: { type: "selected", optionId: option.optionId } });
      }
    }
    if (onTick !== undefined) await onTick(view);
    const state = view.task.activeRunState;
    const sawRun = runId === undefined || view.timeline.some((item) => item.runId === runId);
    if (sawRun && state !== undefined && TERMINAL.has(state) && view.queuedTurns.length === 0) {
      if (state !== "completed") {
        const error = view.timeline.filter((item) => item.kind === "error").at(-1)?.text;
        throw new Error(`run ${state}${error === undefined ? "" : `: ${safeText(error, 300)}`}`);
      }
      return { view, approvals: decided.size };
    }
    await sleep(onTick === undefined ? 600 : 350);
  }
  throw new Error(`timeout:run ${check} (state ${view?.task.activeRunState ?? "unknown"})`);
}

async function sendAndWait(check, taskId, text, options) {
  const sent = await call("sendMessage", { taskId, text });
  if (sent.status !== "started") throw new Error(`send_not_started:${sent.status}`);
  const done = await waitForRun(check, taskId, sent.runId, options);
  return { ...done, runId: sent.runId };
}

async function pickModel(check, namePattern) {
  const trigger = await until("model picker trigger", async () => {
    const value = await cdp.evaluate(locate(".guild-model-picker-trigger"));
    return value !== null && !value.disabled ? value : undefined;
  }, { timeout: 60_000 });
  const open = await domExists(".guild-model-popover");
  if (!open) await clickDom(".guild-model-picker-trigger");
  await until("model popover", () => domExists(".guild-model-popover"), { timeout: 10_000 });
  await sleep(300);
  const rows = await cdp.evaluate(`[...document.querySelectorAll(".guild-model-group")].map((group) => ({
    group: (group.querySelector(".guild-model-heading")?.textContent || "").trim(),
    rows: [...group.querySelectorAll(".guild-model-row")].map((row) => (row.querySelector("strong")?.textContent || row.textContent || "").trim()),
  }))`);
  await shot(check, `picker-before-${namePattern.replace(/^\^\\s\*/u, "")}`);
  await clickDom(".guild-model-row", namePattern);
  return { triggerBefore: trigger.text, groups: rows };
}

async function waitSelection(taskId, modelPattern, { timeout = 120_000 } = {}) {
  return until(`selection ${modelPattern}`, async () => {
    const view = await call("openTask", { taskId });
    const modelId = view.modelSelection.modelId ?? "";
    return new RegExp(modelPattern, "iu").test(modelId) && view.modelSelection.canChange === true ? view : undefined;
  }, { timeout, interval: 500 });
}

/** Opens the picker, records its groups and rows, takes a screenshot and closes it again. */
async function snapshotPicker(check, label, taskId) {
  await until("model picker trigger", async () => {
    const value = await cdp.evaluate(locate(".guild-model-picker-trigger"));
    return value !== null ? value : undefined;
  }, { timeout: 30_000 });
  const triggerText = await cdp.evaluate(`document.querySelector(".guild-model-picker-trigger")?.textContent?.trim() ?? ""`);
  const disabled = await cdp.evaluate(`document.querySelector(".guild-model-picker-trigger")?.disabled === true`);
  let groups = [];
  if (!disabled) {
    await clickDom(".guild-model-picker-trigger");
    await until("model popover", () => domExists(".guild-model-popover"), { timeout: 10_000 });
    await sleep(300);
    groups = await cdp.evaluate(`[...document.querySelectorAll(".guild-model-group")].map((group) => ({
      group: (group.querySelector(".guild-model-heading")?.textContent || "").trim(),
      rows: [...group.querySelectorAll(".guild-model-row")].map((row) => (row.querySelector("strong")?.textContent || row.textContent || "").trim()),
      empty: (group.querySelector(".guild-model-hint")?.textContent || "").trim(),
    }))`);
  }
  const selection = taskId === undefined ? undefined : (await call("openTask", { taskId })).modelSelection;
  await shot(check, label);
  await cdp.evaluate(`document.querySelector(".guild-model-picker")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(300);
  return { triggerText, disabled, groups, selection };
}

/** After a terminal run: stale permission cards and a stuck "Counting changes" line are visible defects. */
async function settleUi(check) {
  const read = () => cdp.evaluate(`({
    permissionCards: document.querySelectorAll(".guild-permission").length,
    counting: /Counting changes/u.test(document.querySelector(".guild-conversation")?.innerText ?? ""),
  })`);
  const deadline = Date.now() + 20_000;
  let seen = await read();
  while ((seen.permissionCards > 0 || seen.counting) && Date.now() < deadline) {
    await sleep(500);
    seen = await read();
  }
  return { stalePermissionCards: seen.permissionCards, countingChangesStuck: seen.counting };
}

/** Seconds from "initialized" to "session established / load failed" per adapter epoch of a task, from runtime.jsonl. */
function sessionStartupLatency(taskId) {
  const rows = readLines(join(dataDir, "diagnostics", "runtime.jsonl")).filter((entry) => entry.taskId === taskId);
  const startedAt = new Map();
  const result = [];
  for (const entry of rows) {
    const at = Date.parse(entry.occurredAtIso);
    if (entry.event === "initialized") startedAt.set(entry.adapterEpoch, at);
    if (["established", "load_began", "load_failed"].includes(entry.event) && startedAt.has(entry.adapterEpoch)) {
      result.push({ epoch: entry.adapterEpoch, event: entry.event, reason: entry.reason ?? null, secondsAfterInitialize: Math.round((at - startedAt.get(entry.adapterEpoch)) / 100) / 10 });
    }
  }
  return result;
}

function adapterProcess() {
  trackDescendants();
  return descendantsOf(app.pid).find((entry) => /claude-agent-acp/u.test(entry.command));
}

function claudeTranscripts() {
  const root = join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((name) => name.includes(`guild3-qa-ws-${stamp}`)).flatMap((name) =>
    readdirSync(join(root, name)).filter((file) => file.endsWith(".jsonl")).map((file) => join(root, name, file)));
}

function readLines(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return undefined; } }).filter(Boolean) : [];
}

function routerEvents() {
  const directory = join(dataDir, "diagnostics");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith("router.jsonl")).sort().reverse().flatMap((name) => readLines(join(directory, name)));
}

// ---------------------------------------------------------------------------------------------
// Local web page for the browser check
// ---------------------------------------------------------------------------------------------

let pageServer;
let pagePort = 0;
const pageHits = [];

async function startPageServer() {
  pageServer = createHttpServer((request, response) => {
    pageHits.push(`${request.method} ${request.url}`);
    if (request.url?.startsWith("/clicked")) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Guild QA Page</title></head>
<body style="font: 20px sans-serif; margin: 32px">
<h1>Guild QA Page</h1>
<p id="status">Status: idle</p>
<button id="press" type="button" style="font-size: 20px; padding: 8px 16px">Press me</button>
<script>
let n = 0;
document.getElementById("press").addEventListener("click", () => {
  n += 1;
  document.getElementById("status").textContent = "Status: clicked " + n + " time(s) - QA-OK";
  fetch("/clicked?n=" + n);
});
</script></body></html>`);
  });
  await new Promise((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  pagePort = pageServer.address().port;
  log(`page server on 127.0.0.1:${pagePort}`);
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

const results = [];
const state = { claudeTaskId: undefined, grokTaskId: undefined };

async function runCheck(id, title, fn) {
  if (!only.has(id[0])) return;
  const record = { id, title, status: "fail", evidence: [], details: {} };
  results.push(record);
  log(`== ${id} ${title}`);
  try {
    record.details = (await fn(record)) ?? {};
    record.status = "pass";
  } catch (error) {
    record.status = "fail";
    record.error = safeText(error.message ?? error, 500);
    log(`${id} FAILED: ${record.error}`);
    await shot(id, "failure-state");
  }
  record.evidence = readdirSync(evidenceDir).filter((name) => name.startsWith(`${id}-`) && name.endsWith(".png")).sort();
  log(`== ${id} ${record.status.toUpperCase()}`);
  writeFileSync(join(evidenceDir, "results.json"), JSON.stringify({ stamp, results, permissionLog }, null, 2));
}

function skip(id, title, reason) {
  if (!only.has(id[0])) return;
  results.push({ id, title, status: "skip", evidence: [], details: { reason } });
  log(`== ${id} SKIP ${reason}`);
}

async function checkA() {
  const created = await call("createTask", { workspaceId });
  const taskId = created.task.taskId;
  state.grokTaskId = taskId;
  const first = await call("sendMessage", { taskId, text: "Reply with exactly: GROK-QA-1" });
  const second = await call("sendMessage", { taskId, text: "Reply with exactly: GROK-QA-2" });
  if (first.status !== "started") throw new Error(`first turn ${first.status}`);
  if (second.status !== "queued") throw new Error(`second turn ${second.status}, expected queued`);
  const { view } = await waitForRun("A", taskId, first.runId, { timeout: 240_000, approve: false });
  // The queued turn starts after the first run ends; wait until both replies are present.
  const done = await until("grok second reply", async () => {
    const next = await call("openTask", { taskId });
    const text = assistantTextOf(next);
    return text.includes("GROK-QA-1") && text.includes("GROK-QA-2") && next.queuedTurns.length === 0 && TERMINAL.has(next.task.activeRunState ?? "") ? next : undefined;
  }, { timeout: 240_000, interval: 800 });
  const errors = done.timeline.filter((item) => item.kind === "error" || item.kind === "notice");
  if (errors.length > 0) throw new Error(`unexpected timeline notice/error: ${safeText(errors[0].text, 200)}`);
  await shot("A", "grok-two-turns");
  const runs = [...new Set(done.timeline.filter((item) => item.runId !== undefined).map((item) => item.runId))];
  const runtimeLog = readLines(join(dataDir, "diagnostics", "runtime.jsonl")).filter((entry) => entry.taskId === taskId);
  const initialized = runtimeLog.filter((entry) => entry.event === "initialized").length;
  if (initialized !== 1) throw new Error(`grok engine initialized ${initialized} times, expected one session process`);
  return {
    taskId, engine: done.task.engine ?? "grok", firstStatus: first.status, secondStatus: second.status,
    runs: runs.length, replyOne: occurrences(assistantTextOf(done), "GROK-QA-1"), replyTwo: occurrences(assistantTextOf(done), "GROK-QA-2"),
    grokProcessInitializations: initialized, firstViewState: view.task.activeRunState,
  };
}

async function checkB(record) {
  await call("setClaudeSettings", { model: null, reasoningEffort: null, permissionMode: "default" });
  const created = await call("createTask", { workspaceId, engine: "claude" });
  const taskId = created.task.taskId;
  state.claudeTaskId = taskId;
  await call("openTask", { taskId });
  const firstPicker = await snapshotPicker("B", "picker-new-task-before-first-turn", taskId);
  const saved = await call("setTaskRuntimeSettings", { taskId, model: "opus", reasoningEffort: null });
  const details = { taskId, pickerBeforeFirstTurn: firstPicker, preSessionOpusSelection: saved.status, preSessionOpusReason: saved.reason ?? null };
  const prompt = "Create a file named hello.txt in the workspace root containing exactly the text hi (no newline needed). Then read it back with a tool and tell me its content. End your reply with FILE-QA-OK.";
  const turn = await sendAndWait("B", taskId, prompt, { timeout: 360_000 });
  const reply = assistantTextOf(turn.view, turn.runId);
  const filePath = join(workspaceDir, "hello.txt");
  const fileText = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  if (fileText === undefined || fileText.trim() !== "hi") throw new Error(`hello.txt content ${JSON.stringify(fileText)}`);
  if (!/\bhi\b/iu.test(reply)) throw new Error("reply does not mention hi");
  const tools = turn.view.timeline.filter((item) => item.kind === "tool" && item.runId === turn.runId);
  details.toolCalls = tools.length;
  details.permissionCardsApproved = turn.approvals;
  details.replyHasMarker = reply.includes("FILE-QA-OK");
  details.helloTxt = fileText;
  details.afterApprovalUi = await settleUi("B");
  await shot("B", "claude-file-task");
  const adapter = adapterProcess();
  details.nativeNoGateway = adapter !== undefined && !processEnvHas(adapter.pid, "ANTHROPIC_BASE_URL");
  details.nativeNoRouterToken = adapter !== undefined && !processEnvHas(adapter.pid, "ANTHROPIC_AUTH_TOKEN");
  details.captureOffHookInEnv = adapter !== undefined && processEnvValueIs(adapter.pid, "OPENVIKING_AUTO_CAPTURE", "false");
  if (!details.nativeNoGateway) throw new Error("native Claude session has ANTHROPIC_BASE_URL (or adapter not found)");
  if (!details.nativeNoRouterToken) throw new Error("native Claude session has an ANTHROPIC_AUTH_TOKEN");
  const engineStatus = turn.view.engineStatus ?? {};
  details.accountLabelPresent = typeof engineStatus.accountLabel === "string" && engineStatus.accountLabel.length > 0;
  details.routedFlag = engineStatus.routed === true;
  const before = claudeTranscripts();
  details.transcriptsBeforeRestart = before.length;

  // Restart: quit and relaunch on the same data dir, then continue the same task.
  record.details = details;
  const quit = await quitApp();
  details.quit = quit;
  await launchApp();
  const reopened = await call("openTask", { taskId });
  details.engineAfterRestart = reopened.task.engine;
  if (reopened.task.engine !== "claude") throw new Error("task engine changed across restart");
  const follow = "Without using any tools: what exact text did the hello.txt file you created earlier contain? Reply with just that text. End with RESUME-QA-OK.";
  details.issues = [];
  let resumed;
  try {
    resumed = await sendAndWait("B", taskId, follow, { timeout: 360_000 });
  } catch (error) {
    // A slow Claude Code start-up can outlast Guild's session load window; record it, wait out the retry backoff, try once more.
    details.issues.push(`first follow-up after restart failed: ${safeText(error.message, 160)}`);
    await shot("B", "restore-first-attempt-failed");
    await sleep(20_000);
    resumed = await sendAndWait("B", taskId, follow, { timeout: 360_000 });
  }
  details.sessionStartupLatency = sessionStartupLatency(taskId);
  const resumedReply = assistantTextOf(resumed.view, resumed.runId);
  details.resumedReplyMentionsHi = /\bhi\b/iu.test(resumedReply);
  details.noSessionRestoredNotice = !resumed.view.timeline.some((item) => item.kind === "notice" && item.noticeType === "session_restored");
  const after = claudeTranscripts();
  details.transcriptsAfterRestart = after.length;
  const holders = after.filter((path) => readFileSync(path, "utf8").includes("RESUME-QA-OK") && readFileSync(path, "utf8").includes("FILE-QA-OK"));
  details.transcriptHoldingBothTurns = holders.length;
  await shot("B", "after-restart-resumed");
  if (!details.resumedReplyMentionsHi) throw new Error("follow-up after restart did not recall hello.txt content");
  if (!details.noSessionRestoredNotice) throw new Error("session was replaced, not resumed");
  if (holders.length !== 1) throw new Error(`expected exactly one Claude transcript holding both turns, found ${holders.length}`);
  return details;
}

async function checkC() {
  const taskId = state.claudeTaskId;
  await call("openTask", { taskId });
  const details = {};
  const picked = await pickModel("C", "^\\s*DeepSeek V4 Flash");
  details.pickerGroups = picked.groups;
  const dialog = await until("one-way and online reminder dialog", async () => (await domExists(".guild-online-reminder")) ? true : undefined, { timeout: 15_000 });
  void dialog;
  // The task has run on the subscription, so the first switch carries both messages in ONE dialog (D-061, PC-PRIV-001).
  details.reminderTitle = safeText(await domText(".guild-online-reminder .guild-dialog-header"), 160);
  details.reminderBody = safeText(await domText(".guild-online-reminder-body"), 600);
  details.dialogCount = await cdp.evaluate(`document.querySelectorAll(".guild-online-reminder").length`);
  await shot("C", "one-way-and-online-reminder-dialog");
  if (details.dialogCount !== 1) throw new Error(`expected one dialog, found ${details.dialogCount}`);
  if (!/switch back to a Claude subscription/iu.test(details.reminderTitle)) throw new Error("the dialog does not say the switch is one way");
  if (!/local relay/iu.test(details.reminderBody) || !/DeepSeek/u.test(details.reminderBody)) throw new Error("the dialog lacks the one-way text or the vendor");
  await clickDom(".guild-online-reminder .guild-dialog-footer button.primary");
  const routedView = await waitSelection(taskId, "deepseek-v4-flash", { timeout: 180_000 });
  details.routedFlag = routedView.engineStatus?.routed === true;
  const adapter = adapterProcess();
  details.routedEnv = adapter === undefined ? "adapter missing" : {
    baseUrlSet: processEnvHas(adapter.pid, "ANTHROPIC_BASE_URL"),
    // Claude Code sends this throwaway token to the router, never its subscription token (D-061).
    authTokenIsRouterToken: processEnvValueStartsWith(adapter.pid, "ANTHROPIC_AUTH_TOKEN", "guild-router-"),
    noApiKey: !processEnvHas(adapter.pid, "ANTHROPIC_API_KEY"),
    nonessentialTrafficOff: processEnvValueIs(adapter.pid, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    subagentOnRoutedModel: processEnvValueIs(adapter.pid, "CLAUDE_CODE_SUBAGENT_MODEL", "deepseek-v4-flash"),
    smallFastOnRoutedModel: processEnvValueIs(adapter.pid, "ANTHROPIC_SMALL_FAST_MODEL", "deepseek-v4-flash"),
    toolSearch: processEnvValueIs(adapter.pid, "ENABLE_TOOL_SEARCH", "true"),
    captureOff: processEnvValueIs(adapter.pid, "OPENVIKING_AUTO_CAPTURE", "false"),
  };
  const env = details.routedEnv;
  if (typeof env === "string" || !env.baseUrlSet || !env.authTokenIsRouterToken || !env.noApiKey || !env.nonessentialTrafficOff || !env.subagentOnRoutedModel || !env.smallFastOnRoutedModel) {
    throw new Error(`the routed process environment is wrong: ${JSON.stringify(env)}`);
  }
  await shot("C", "deepseek-selected");
  const turn = await sendAndWait("C", taskId, "List the files in the workspace with a tool and reply DONE", { timeout: 420_000 });
  const reply = assistantTextOf(turn.view, turn.runId);
  const tools = turn.view.timeline.filter((item) => item.kind === "tool" && item.runId === turn.runId);
  details.deepseekToolCalls = tools.length;
  details.deepseekToolStatuses = tools.map((item) => item.toolStatus);
  details.deepseekPermissionCards = turn.approvals;
  details.deepseekReplyTail = safeText(reply.slice(-200), 200);
  await shot("C", "deepseek-tool-turn");
  if (!/DONE/u.test(reply)) throw new Error("DeepSeek reply lacks DONE");
  if (tools.length === 0 || !tools.some((item) => item.toolStatus === "completed")) throw new Error("DeepSeek turn used no completed tool");

  // One way: the Claude rows are shown disabled with the note, a click on one changes nothing, and the main process refuses the choice.
  await clickDom(".guild-model-picker-trigger");
  await until("model popover", () => domExists(".guild-model-popover"), { timeout: 10_000 });
  await sleep(300);
  details.lockedClaudeRows = await cdp.evaluate(`document.querySelectorAll(".guild-model-row.locked[aria-disabled='true']").length`);
  details.lockedClaudeNote = safeText(await domText(".guild-model-group-note"), 200);
  await shot("C", "claude-rows-disabled-after-routing");
  if (details.lockedClaudeRows === 0 || !/cannot go back to a Claude subscription/iu.test(details.lockedClaudeNote)) throw new Error("the Claude rows of a routed task are not disabled with the note");
  await clickDom(".guild-model-row.locked");
  await sleep(1500);
  const stillRouted = await call("openTask", { taskId });
  details.selectionAfterClickOnLockedRow = stillRouted.modelSelection.modelId;
  if (stillRouted.modelSelection.modelId !== "deepseek-v4-flash") throw new Error("a click on a disabled Claude row changed the selection");
  await cdp.evaluate(`document.querySelector(".guild-model-picker")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  const refused = await call("setTaskRuntimeSettings", { taskId, model: "opus", reasoningEffort: null });
  details.mainRefusal = { status: refused.status, reason: refused.reason ?? null };
  if (refused.status !== "refused" || refused.reason !== "claude_locked") throw new Error(`main did not refuse a Claude model for a routed task: ${JSON.stringify(details.mainRefusal)}`);

  // The conversation continues on the third-party model, with what the Claude turns said before the switch.
  const recall = await sendAndWait("C", taskId, "Without using any tools: what does hello.txt contain? Answer in one short sentence.", { timeout: 360_000 });
  const recallReply = assistantTextOf(recall.view, recall.runId);
  details.recallReplyTail = safeText(recallReply.slice(-200), 200);
  if (!/\bhi\b/iu.test(recallReply)) throw new Error("DeepSeek did not recall hello.txt from the Claude turns");

  // Router log proof: only third-party sources; nothing went to Anthropic and no Claude credential ever reached the router.
  const events = routerEvents().filter((entry) => entry.event === "router.request");
  const byModel = (pattern) => events.filter((entry) => pattern.test(String(entry.fields.model ?? "")));
  const deepseek = byModel(/deepseek/iu);
  const claudeModels = byModel(/^claude-/iu);
  details.router = {
    requests: events.length,
    deepseekRequests: deepseek.length,
    deepseekAuthInAndReplaced: deepseek.filter((entry) => entry.fields.authIn === true && entry.fields.authReplaced === true).length,
    deepseekFromOtherSource: deepseek.filter((entry) => entry.fields.source !== "deepseek").length,
    deepseekOk: deepseek.filter((entry) => entry.fields.status === 200).length,
    anthropicSourceRequests: events.filter((entry) => entry.fields.source === "anthropic").length,
    claudeModelRequests: claudeModels.length,
    claudeModelRequestsAnswered2xx: claudeModels.filter((entry) => entry.fields.status >= 200 && entry.fields.status < 300).length,
    anthropicCredentialRejections: events.filter((entry) => entry.fields.outcome === "anthropic_credential_rejected").length,
    thirdPartyWithoutKeyReplacement: events.filter((entry) => entry.fields.source !== "none" && entry.fields.authReplaced !== true && entry.fields.route === "messages").length,
    unknownModelRejections: events.filter((entry) => entry.fields.outcome === "unknown_model").length,
  };
  const r = details.router;
  if (r.deepseekRequests === 0 || r.deepseekAuthInAndReplaced !== r.deepseekRequests) throw new Error(`DeepSeek requests lack authIn/authReplaced: ${JSON.stringify(r)}`);
  if (r.deepseekFromOtherSource !== 0) throw new Error("a DeepSeek model id was routed to another source");
  if (r.anthropicSourceRequests !== 0) throw new Error(`a request was served by Anthropic: ${JSON.stringify(r)}`);
  if (r.claudeModelRequestsAnswered2xx !== 0) throw new Error(`a claude-* model request was served: ${JSON.stringify(r)}`);
  if (r.anthropicCredentialRejections !== 0) throw new Error(`a Claude credential reached the router: ${JSON.stringify(r)}`);
  if (r.thirdPartyWithoutKeyReplacement !== 0) throw new Error("a third-party request went out without key replacement");
  return details;
}

async function checkD() {
  const taskId = state.claudeTaskId;
  await call("openTask", { taskId });
  const details = {};
  await pickModel("D", "^\\s*Local Model 27B");
  await sleep(1000);
  details.reminderShown = await domExists(".guild-online-reminder");
  if (details.reminderShown) throw new Error("a Local model asked for the Online reminder");
  await waitSelection(taskId, "local-27b-model", { timeout: 180_000 });
  await shot("D", "local-selected");
  const startedAt = Date.now();
  const turn = await sendAndWait("D", taskId, "Reply with exactly: LOCAL-QA-OK", { timeout: 420_000 });
  const reply = assistantTextOf(turn.view, turn.runId);
  details.seconds = Math.round((Date.now() - startedAt) / 1000);
  details.markerOccurrences = occurrences(reply, "LOCAL-QA-OK");
  details.assistantItems = turn.view.timeline.filter((item) => item.kind === "assistant" && item.runId === turn.runId).length;
  details.replyTail = safeText(reply.slice(-240), 240);
  details.afterReplyUi = await settleUi("D");
  await shot("D", "local-reply");
  if (details.markerOccurrences !== 1) throw new Error(`LOCAL-QA-OK appears ${details.markerOccurrences} times`);
  const events = routerEvents().filter((entry) => entry.event === "router.request" && entry.fields.source === "lan-llama");
  details.routerLocalRequests = events.length;
  details.routerLocalAuthReplaced = events.filter((entry) => entry.fields.authReplaced === true && entry.fields.authIn === true).length;
  details.routerLocalOk = events.filter((entry) => entry.fields.status === 200).length;
  if (events.length === 0) throw new Error("no router request for the local source");
  return details;
}

async function checkE() {
  // The browser tools belong to the Claude engine, not to routing. The task checked above has left the Claude
  // subscription for good (D-061), so the agent drives the pane from a fresh native Claude task on Opus.
  const created = await call("createTask", { workspaceId, engine: "claude" });
  const taskId = created.task.taskId;
  await call("openTask", { taskId });
  const details = { taskId };
  const chosen = await call("setTaskRuntimeSettings", { taskId, model: "opus", reasoningEffort: null });
  if (chosen.status === "refused") throw new Error(`could not choose Opus for the browser task: ${chosen.reason}`);

  // Open the workbench, the Browser tab, and navigate through the address bar.
  const expanded = await cdp.evaluate(`document.querySelector(".guild-workbench-trigger")?.getAttribute("aria-expanded")`);
  if (expanded !== "true") await clickDom(".guild-workbench-trigger");
  await clickDom(".guild-workbench-tabs [role='tab']", "Browser");
  await until("browser address bar", () => domExists(".guild-browser-address"), { timeout: 15_000 });
  await shot("E", "browser-tab-empty");
  const url = `http://127.0.0.1:${pagePort}/`;
  await clickDom(".guild-browser-address");
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 4, commands: ["selectAll"] });
  await cdp.send("Input.insertText", { text: url });
  await sleep(200);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await until("pane navigated", async () => (await domExists(".guild-browser-tab.selected", "Guild QA Page")) ? true : undefined, { timeout: 30_000 });
  details.navigatedViaAddressBar = true;
  const pane = await paneClient(`http://127.0.0.1:${pagePort}/`);
  details.paneTargetFound = pane !== undefined;
  if (pane !== undefined) {
    details.statusBefore = await pane.evaluate(`document.getElementById("status").textContent`);
    await shot("E", "pane-page-before", pane);
  }
  await shot("E", "browser-tab-loaded");

  // Agent: read_page, click, get_text. The badge is sampled while the agent works.
  let operatingShot = false;
  let sawOperating = false;
  const onTick = async () => {
    const operating = await domExists(".guild-browser-agent.operating");
    if (operating) {
      sawOperating = true;
      if (!operatingShot) {
        operatingShot = true;
        await shot("E", "agent-operating-badge");
      }
    }
  };
  const prompt = "Use the guild-browser tools: read_page, click the button named Press me, then get_text and report the status line.";
  const turn = await sendAndWait("E", taskId, prompt, { timeout: 480_000, onTick });
  const reply = assistantTextOf(turn.view, turn.runId);
  const tools = turn.view.timeline.filter((item) => item.kind === "tool" && item.runId === turn.runId);
  details.toolTitles = tools.map((item) => safeText(item.title, 60));
  details.permissionCards = turn.approvals;
  details.sawOperatingBadge = sawOperating;
  details.replyTail = safeText(reply.slice(-300), 300);
  details.pageHits = pageHits.filter((hit) => hit.startsWith("GET /clicked"));
  if (pane !== undefined) details.statusAfter = await pane.evaluate(`document.getElementById("status").textContent`);
  details.afterAgentTurnUi = await settleUi("E");
  await shot("E", "after-agent-click");
  if (pane !== undefined) await shot("E", "pane-page-after", pane);
  if (!/clicked 1|QA-OK/iu.test(reply)) throw new Error("reply does not mention the changed status");
  if (details.pageHits.length === 0) throw new Error("the page never received the click");

  // Take over: the agent tool must come back paused; Resume restores control.
  await clickDom(".guild-browser-agent button", "Take over");
  await until("paused badge", () => domExists(".guild-browser-agent.paused"), { timeout: 10_000 });
  await shot("E", "taken-over-paused");
  const pausedTurn = await sendAndWait("E", taskId, "Call the guild-browser get_text tool exactly once and quote what the tool returned, word for word.", { timeout: 360_000 });
  const pausedItems = pausedTurn.view.timeline.filter((item) => item.runId === pausedTurn.runId);
  const pausedEvidence = JSON.stringify(pausedItems.map((item) => item.kind === "tool" ? item.content : item.text ?? ""));
  details.pausedToolReturnedPaused = /Paused by the user/iu.test(pausedEvidence);
  details.pausedReplyTail = safeText(assistantTextOf(pausedTurn.view, pausedTurn.runId).slice(-240), 240);
  await shot("E", "paused-tool-result");
  if (!details.pausedToolReturnedPaused) throw new Error("the tool call during Take over did not report paused");
  await clickDom(".guild-browser-agent button", "Resume agent");
  await until("resumed badge", async () => !(await domExists(".guild-browser-agent.paused")), { timeout: 10_000 });
  const resumed = await sendAndWait("E", taskId, "Call the guild-browser get_text tool once and tell me the status line.", { timeout: 360_000 });
  details.resumedReplyTail = safeText(assistantTextOf(resumed.view, resumed.runId).slice(-240), 240);
  details.resumeWorks = /clicked|QA-OK/iu.test(details.resumedReplyTail);
  await shot("E", "after-resume");
  pane?.close();
  if (!details.resumeWorks) throw new Error("after Resume the agent could not read the page");
  return details;
}

async function openSettings() {
  if (await domExists(".guild-dialog-settings")) return;
  await clickDom(".guild-profile");
  await until("account popover", () => domExists(".guild-account-popover"), { timeout: 10_000 });
  await clickDom(".guild-profile-settings");
  await until("settings dialog", () => domExists(".guild-dialog-settings"), { timeout: 10_000 });
}

async function checkF() {
  const details = {};
  await openSettings();
  await clickDom("#guild-settings-tab-engines");
  await sleep(500);
  details.enginesPanel = safeText(await domText("#guild-settings-panel-engines"), 500);
  await shot("F", "settings-engines");
  await clickDom("#guild-settings-tab-sources");
  await until("sources panel", () => domExists("#guild-settings-panel-sources"), { timeout: 10_000 });
  await sleep(800);
  const panel = await domText("#guild-settings-panel-sources");
  details.sourcesPanel = safeText(panel, 600);
  details.confirmedCount = occurrences(panel, "Confirmed");
  details.needsConfirmation = /Needs confirmation/iu.test(panel);
  details.namesDeepSeek = /DeepSeek/u.test(panel);
  details.namesLocal = /BDV llama\.cpp/u.test(panel);
  await shot("F", "settings-model-sources");
  await cdp.evaluate(`document.querySelector(".guild-dialog-settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
  const sources = await call("listModelSources");
  details.apiSources = sources.sources.map((source) => ({ id: source.id, kind: source.kind, confirmedHost: source.confirmedHost, hasKeyField: Object.keys(source).some((key) => /^(key|secret|token|apiKey)$/iu.test(key)) }));
  if (details.confirmedCount < 2 || details.needsConfirmation || !details.namesDeepSeek || !details.namesLocal) throw new Error(`sources tab does not show both sources confirmed: ${JSON.stringify({ c: details.confirmedCount, n: details.needsConfirmation })}`);
  if (details.apiSources.some((source) => source.confirmedHost === null || source.hasKeyField)) throw new Error("source projection not confirmed or carries a key field");
  return details;
}

async function checkG(id, label) {
  const details = {};
  const taskId = state.claudeTaskId;
  await call("openTask", { taskId });
  await sleep(500);
  if (await domExists(".guild-dialog-settings")) await cdp.evaluate(`document.querySelector(".guild-dialog-settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  if (!(await domExists(".guild-account-popover"))) await clickDom(".guild-profile");
  await until("usage popover", () => domExists(".guild-account-popover"), { timeout: 10_000 });
  await sleep(600);
  details.claudeCardPresent = await domExists(".guild-usage-card-claude");
  details.cardText = safeText(await domText(".guild-usage-card"), 300);
  details.grokUsageLink = await domExists(".guild-usage-link");
  details.mentionsGrok = /grok/iu.test(await domText(".guild-account-popover .guild-usage-card"));
  const view = await call("openTask", { taskId });
  details.accountLabel = typeof view.engineStatus?.accountLabel === "string" ? safeText(view.engineStatus.accountLabel, 60) : null;
  details.labelShownInCard = details.accountLabel !== null && details.cardText.includes(details.accountLabel);
  details.loginRequired = view.engineStatus?.loginRequired === true;
  await shot(id, `usage-popover-${label}`);
  await cdp.evaluate(`document.querySelector(".guild-account-popover")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  if (!details.claudeCardPresent || details.grokUsageLink || details.mentionsGrok) throw new Error(`usage popover is not the reduced Claude one: ${JSON.stringify(details)}`);
  if (!details.labelShownInCard) throw new Error(`Claude account label missing from the popover (${label})`);
  return details;
}

async function checkH(id, engine, fileName) {
  const details = { engine };
  if (engine === "grok") {
    // Grok must ask before writing for the card to appear.
    const settings = (await call("bootstrap")).runtimeSettings;
    details.grokPermissionMode = settings.permissionMode;
    if (settings.permissionMode !== "default") {
      await call("setRuntimeSettings", { model: settings.model, reasoningEffort: settings.reasoningEffort, permissionMode: "default", startup: settings.startup });
    }
  }
  const created = await call("createTask", { workspaceId, engine });
  const taskId = created.task.taskId;
  await call("openTask", { taskId });
  const sent = await call("sendMessage", { taskId, text: `Create a file named ${fileName} in the workspace root containing exactly: ok` });
  const sawCard = await until("pending permission card or end of run", async () => {
    if (await domExists(".guild-permission")) return "card";
    const view = await call("openTask", { taskId });
    return TERMINAL.has(view.task.activeRunState ?? "") && view.timeline.some((item) => item.runId === sent.runId) ? "ended" : undefined;
  }, { timeout: 300_000, interval: 300 });
  if (sawCard === "ended") {
    details.noPermissionCardShown = true;
    await shot(id, "no-card-run-ended");
    throw new Error("the run ended without ever showing a permission card (inconclusive)");
  }
  await sleep(500);
  details.pendingCardTitle = safeText(await domText(".guild-permission-title"), 120);
  await shot(id, "card-pending");
  await clickDom(".guild-permission-actions button.primary");
  // The first card was decided through the DOM above; any further card of the same run goes through the API.
  const done = await waitForRun(id, taskId, sent.runId, { timeout: 300_000, approve: true });
  details.fileWritten = existsSync(join(workspaceDir, fileName));
  details.timelinePermissionItemsAfterRun = done.view.timeline.filter((item) => item.kind === "permission").length;
  details.afterUiApproval = await settleUi(id);
  await shot(id, "after-ui-approval");
  if (!details.fileWritten) throw new Error(`${fileName} was not written after the UI approval`);
  if (details.afterUiApproval.stalePermissionCards > 0) throw new Error("the permission card is still shown (with live buttons) after it was approved and the run completed");
  if (details.afterUiApproval.countingChangesStuck) throw new Error("'Counting changes' never settled");
  return details;
}

// ---------------------------------------------------------------------------------------------
// Secret scan, cleanup, report
// ---------------------------------------------------------------------------------------------

function* walk(root) {
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) yield* walk(path);
    else if (name.isFile()) yield path;
  }
}

function keyValues() {
  const wanted = new Set(["DEEPSEEK_API_KEY", "QWEN_LOCAL_API_KEY"]);
  const values = [];
  for (const line of readFileSync(keyFile, "utf8").split("\n")) {
    const match = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/u.exec(line.trim());
    if (match !== null && wanted.has(match[1])) values.push(match[2].replace(/^["']|["']$/gu, ""));
  }
  return values.filter((value) => value.length >= 12);
}

function scanSecrets() {
  const roots = [
    { name: "data-dir", path: dataDir },
    { name: "evidence-logs", path: evidenceDir },
    ...[...new Set(claudeTranscripts().map((path) => join(path, "..")))].map((path) => ({ name: "claude-transcripts", path })),
  ];
  const secretValues = keyValues();
  const summary = { filesScanned: 0, bytesScanned: 0, keyValueHits: 0, boundarySkHits: 0, boundaryBearerHits: 0, literalSkHits: 0, literalBearerHits: 0, literalSkFiles: [], boundaryFiles: [] };
  for (const root of roots) {
    if (!existsSync(root.path)) continue;
    for (const path of walk(root.path)) {
      if (path.endsWith(".png")) continue;
      const size = statSync(path).size;
      if (size > 256 * 1024 * 1024) continue;
      const text = readFileSync(path).toString("latin1");
      summary.filesScanned += 1;
      summary.bytesScanned += size;
      for (const value of secretValues) if (text.includes(value)) summary.keyValueHits += 1;
      const literalSk = occurrences(text, "sk-");
      const literalBearer = occurrences(text, "Bearer ");
      const boundarySk = (text.match(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{8,}/gu) ?? []).length;
      const boundaryBearer = (text.match(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gu) ?? []).length;
      summary.literalSkHits += literalSk;
      summary.literalBearerHits += literalBearer;
      summary.boundarySkHits += boundarySk;
      summary.boundaryBearerHits += boundaryBearer;
      if (literalSk > 0 || literalBearer > 0) summary.literalSkFiles.push({ root: root.name, file: path.replace(root.path, ""), sk: literalSk, bearer: literalBearer, boundarySk, boundaryBearer });
      if (boundarySk > 0 || boundaryBearer > 0) summary.boundaryFiles.push(`${root.name}:${path.replace(root.path, "")}`);
    }
  }
  summary.literalSkFiles = summary.literalSkFiles.slice(0, 25);
  return summary;
}

function cleanClaudeTranscripts() {
  const root = join(homedir(), ".claude", "projects");
  const removed = [];
  if (!existsSync(root)) return removed;
  for (const name of readdirSync(root)) {
    if (!name.includes(`guild3-qa-ws-${stamp}`)) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function writeReport(extra) {
  const lines = [`# Guild 3.0 live acceptance QA ${stamp}`, "", `Workspace: ${workspaceDir}`, `Data dir: ${dataDir}`, `Evidence: ${evidenceDir}`, "", "| Check | Result | Evidence |", "|---|---|---|"];
  for (const result of results) {
    const issues = Array.isArray(result.details?.issues) && result.details.issues.length > 0 ? ` (issues: ${result.details.issues.join("; ")})` : "";
    lines.push(`| ${result.id} ${result.title} | ${result.status.toUpperCase()}${result.error === undefined ? "" : ` - ${result.error}`}${issues} | ${result.evidence.join(", ")} |`);
  }
  lines.push("", "```json", JSON.stringify({ results, permissionLog, ...extra }, null, 2), "```", "");
  writeFileSync(join(evidenceDir, "report.md"), lines.join("\n"));
  writeFileSync(join(evidenceDir, "results.json"), JSON.stringify({ stamp, results, permissionLog, ...extra }, null, 2));
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  log(`stamp ${stamp}; checks ${[...only].join(",")}`);
  if (!existsSync(electronBinary)) throw new Error("electron binary missing; run npm install");
  if (!existsSync(join(desktopRoot, "dist", "main", "index.js"))) throw new Error("apps/desktop is not built; run npm run build");

  if (!existsSync(workspaceDir)) {
    mkdirSync(workspaceDir, { recursive: true });
    for (const args of [["init", "-q"], ["config", "user.email", "qa@example.invalid"], ["config", "user.name", "Guild QA"]]) {
      spawnSync("/usr/bin/git", args, { cwd: workspaceDir });
    }
    writeFileSync(join(workspaceDir, "README.md"), "# Guild 3.0 QA workspace\n");
    spawnSync("/usr/bin/git", ["add", "-A"], { cwd: workspaceDir });
    spawnSync("/usr/bin/git", ["commit", "-q", "-m", "init"], { cwd: workspaceDir });
  }
  if (!existsSync(join(dataDir, "guild.sqlite3"))) {
    const seeded = await seedQaData({ dataDir, workspaceDir });
    log("seeded", JSON.stringify({ workspace: seeded.canonicalPath, sources: seeded.sources }));
  }
  await startPageServer();
  debugPort = await freePort();
  await launchApp();
  const bootstrap = await call("bootstrap");
  workspaceId = bootstrap.workspaces.find((workspace) => workspace.name === `guild3-qa-ws-${stamp}`)?.workspaceId;
  if (workspaceId === undefined) throw new Error("seeded workspace missing");
  log(`app version ${bootstrap.appVersion}; workspaces ${bootstrap.workspaces.length}; engines ${JSON.stringify(bootstrap.claude ?? {}).slice(0, 200)}`);
  await shot("setup", "bootstrap");

  await runCheck("A", "Grok: two queued turns in one session", checkA);
  await runCheck("B", "Claude: file task, permission card, restart and resume", checkB);
  if (state.claudeTaskId === undefined || results.find((entry) => entry.id === "B")?.status !== "pass") {
    for (const [id, title] of [["C", "Opus -> DeepSeek, one way"], ["D", "Local model"], ["E", "Browser pane"]]) {
      skip(id, title, "blocked: check B did not pass");
    }
  } else {
    await runCheck("G1", "Reduced capability: usage popover (native session)", () => checkG("G1", "native"));
    await runCheck("C", "Opus -> DeepSeek, one way: dialog, env, disabled Claude rows, router proof", checkC);
    await runCheck("D", "Local Model 27B, no duplicated text", checkD);
    await runCheck("E", "Browser pane: navigate, agent tools, take over, resume", checkE);
  }
  await runCheck("F", "Settings: Engines and Model sources tabs", checkF);
  if (state.claudeTaskId !== undefined) await runCheck("G2", "Reduced capability: usage popover (routed session)", () => checkG("G2", "routed"));
  await runCheck("H1", "Claude: permission card clears after a UI approval", () => checkH("H1", "claude", "dom.txt"));
  await runCheck("H2", "Grok: permission card clears after a UI approval", () => checkH("H2", "grok", "dom-grok.txt"));

  const quit = process.env.GUILD_QA_KEEP_APP === "1" ? { stage: "kept" } : await quitApp();
  pageServer?.close();
  const secrets = scanSecrets();
  const removedTranscripts = cleanClaudeTranscripts();
  const portClosed = !(await portOpen(debugPort));
  const extra = { quit, secrets, removedTranscripts, portClosed, pageHits };
  writeReport(extra);
  log("secret scan", JSON.stringify({ ...secrets, literalSkFiles: undefined, boundaryFiles: undefined }));
  log("removed claude transcripts", JSON.stringify(removedTranscripts));
  const failed = results.filter((entry) => entry.status === "fail");
  log(`RESULT ${results.map((entry) => `${entry.id}:${entry.status}`).join(" ")}`);
  process.exitCode = failed.length === 0 && secrets.keyValueHits === 0 ? 0 : 1;
}

main().catch(async (error) => {
  log(`FATAL ${safeText(error.stack ?? error.message, 800)}`);
  try { await quitApp(); } catch { /* best effort */ }
  pageServer?.close();
  writeReport({ fatal: safeText(error.message, 300) });
  process.exitCode = 2;
});
