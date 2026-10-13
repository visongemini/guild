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
 * Checks: A Grok queued turns, B Claude file task + restart/resume, C Opus -> DeepSeek -> Opus 5.5, two-way
 * (the "Restarts" tags sit on the rows of the other mode, the switching status shows while the engine
 * restarts, the way back runs a native process with no router variable and recalls the DeepSeek turn,
 * and the router never serves Anthropic, a claude-* model or a Claude credential), D Opus -> Local model
 * (cross-mode again, no Online reminder), E browser pane + agent tools + take over (on a fresh native
 * Claude task), F settings tabs, G reduced capability (usage popover), H permission card lifecycle after
 * a UI approval, I Codex (ChatGPT subscription; Guild 3.1): the account's models in the ChatGPT group, the cheapest
 * chosen, one tool turn behind a permission card approved in the UI, the per-turn model line, a Guild restart that
 * resumes the same session with the stored model and permission mode, the engine marker in the sidebar and the Codex
 * section of Settings > Engines, J Gemini (own API key, pay-as-you-go; Guild 3.1): a fresh task on the cheapest Flash
 * model of the session's list, one tool turn behind a permission card approved in the UI, the per-turn model line, a
 * Guild restart that continues the session through session/load, the child's environment (Guild's own home, the key as a
 * presence only, no OAuth / Google Cloud / base-URL variable), the badge in the sidebar and the Gemini section of
 * Settings > Engines, K the Dock icon setting (Settings > General): light and back to dark, each persisted across a restart.
 * Environment: GUILD_QA_STAMP (reuse a run), GUILD_QA_ONLY=A,B (subset), GUILD_QA_KEEP_APP=1,
 * GUILD_QA_CODEX_ACP=<package directory of a codex-acp install> (handed to the unpackaged app as the dev-only
 * GUILD_DEV_CODEX_ACP; check I runs only when it is set; the production lookup is never changed),
 * GUILD_QA_GEMINI_CLI=<package directory of a @google/gemini-cli install> (handed to the unpackaged app as the dev-only
 * GUILD_DEV_GEMINI_CLI; check J runs only when it is set and the key file names GEMINI_API_KEY; the seed confirms the
 * key binding through the store, replacing the native dialog for QA only). Check J spends a few thousand tokens.
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
import { dirname, join } from "node:path";
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
const codexAcpRoot = process.env.GUILD_QA_CODEX_ACP;
const geminiCliRoot = process.env.GUILD_QA_GEMINI_CLI;
const only = new Set((process.env.GUILD_QA_ONLY ?? `A,B,C,D,E,F,G,H${codexAcpRoot === undefined ? "" : ",I"}${geminiCliRoot === undefined ? "" : ",J"},K`).split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
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
      ...(codexAcpRoot === undefined ? {} : { GUILD_DEV_CODEX_ACP: codexAcpRoot }),
      ...(geminiCliRoot === undefined ? {} : { GUILD_DEV_GEMINI_CLI: geminiCliRoot }),
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
  const tags = await readPickerTags();
  await shot(check, `picker-before-${namePattern.replace(/^\^\\s\*/u, "")}`);
  await clickDom(".guild-model-row", namePattern);
  return { triggerBefore: trigger.text, groups: rows, tags };
}

/**
 * What the open picker says about restarts (D-062): per group and row whether it carries the muted tag, that the tag
 * is aria-hidden, the tooltip and the accessible description of the row, and the same for "Use default".
 */
const readPickerTags = () => cdp.evaluate(`(() => {
  const described = (row) => {
    const id = row.getAttribute("aria-describedby");
    return id ? (document.getElementById(id)?.textContent || "").trim() : "";
  };
  const useDefault = document.querySelector(".guild-model-use-default");
  return {
    groups: [...document.querySelectorAll(".guild-model-group")].map((group) => ({
      group: (group.querySelector(".guild-model-heading")?.textContent || "").trim(),
      rows: [...group.querySelectorAll(".guild-model-row")].map((row) => {
        const tag = row.querySelector(".guild-model-restart-tag");
        return {
          name: (row.querySelector("strong")?.textContent || "").trim(),
          tagged: tag !== null,
          tagText: tag === null ? "" : (tag.textContent || "").trim(),
          tagAriaHidden: tag !== null && tag.getAttribute("aria-hidden") === "true",
          title: row.getAttribute("title") || "",
          description: described(row),
          disabled: row.getAttribute("aria-disabled") === "true" || row.classList.contains("locked"),
        };
      }),
    })),
    useDefault: useDefault === null ? null : { tagged: useDefault.querySelector(".guild-model-restart-tag") !== null, title: useDefault.getAttribute("title") || "" },
    groupNotes: document.querySelectorAll(".guild-model-group-note").length,
  };
})()`);

const groupMode = (heading) => /online|local|在线|本地/iu.test(heading) ? "routed" : "native";

/**
 * The rows of the other mode carry the tag, the rows of the task's own mode do not, nothing is disabled and no note
 * explains a lock (there is none any more).
 */
function assertRestartTags(tags, taskMode, label) {
  const problems = [];
  for (const group of tags.groups) {
    const crosses = groupMode(group.group) !== taskMode;
    for (const row of group.rows) {
      if (row.tagged !== crosses) problems.push(`${group.group}/${row.name}: tagged=${row.tagged}, expected ${crosses}`);
      if (row.disabled) problems.push(`${group.group}/${row.name}: disabled`);
      if (crosses && !(row.tagText === "Restarts" || row.tagText === "需重启")) problems.push(`${group.group}/${row.name}: tag text ${JSON.stringify(row.tagText)}`);
      if (crosses && !row.tagAriaHidden) problems.push(`${group.group}/${row.name}: tag is not aria-hidden`);
      if (crosses && !/restarts? claude code|重启 claude code/iu.test(row.title)) problems.push(`${group.group}/${row.name}: no tooltip`);
      if (crosses && !/restarts? claude code|重启 claude code/iu.test(row.description)) problems.push(`${group.group}/${row.name}: no accessible description`);
    }
  }
  if (tags.groups.every((group) => group.rows.length === 0)) problems.push("the picker lists no row");
  if (tags.groupNotes !== 0) problems.push("a lock note is still shown");
  if (tags.useDefault !== null && tags.useDefault.tagged !== (taskMode === "routed")) problems.push(`Use default tagged=${tags.useDefault.tagged}`);
  if (problems.length > 0) throw new Error(`restart tags wrong (${label}): ${safeText(problems.join("; "), 360)}`);
}

/**
 * A cross-mode switch is running (D-062): the picker trigger spins and says Switching, and one status line above
 * the composer hints names the target and says the engine restarts. Waits until the line is gone and fails if it
 * turned into the failure message.
 */
async function observeSwitching(check, label, targetPattern) {
  const line = await until("switching status line", async () => {
    const value = await cdp.evaluate(`(() => {
      const element = document.querySelector(".guild-composer-switch.switching");
      return element ? { text: (element.textContent || "").trim(), role: element.getAttribute("role") } : null;
    })()`);
    return value ?? undefined;
  }, { timeout: 40_000, interval: 100 });
  const trigger = await cdp.evaluate(`({
    text: (document.querySelector(".guild-model-picker-trigger")?.textContent || "").trim(),
    spinner: document.querySelector(".guild-model-picker-trigger .guild-spin") !== null,
  })`);
  const screenshot = await shot(check, label);
  const observed = { statusLine: safeText(line.text, 240), statusRole: line.role, triggerText: trigger.text, triggerSpinner: trigger.spinner, screenshot };
  if (!new RegExp(targetPattern, "iu").test(line.text) || !/restart|重启/iu.test(line.text) || !/30.{1,3}90/u.test(line.text)) {
    throw new Error(`the switching status line is wrong: ${JSON.stringify(observed)}`);
  }
  if (!/switching|切换中/iu.test(trigger.text) || !trigger.spinner) throw new Error(`the picker trigger does not show the switch: ${JSON.stringify(observed)}`);
  await until("switching status line gone", async () => !(await domExists(".guild-composer-switch.switching")), { timeout: 240_000, interval: 400 });
  const failure = await cdp.evaluate(`document.querySelector(".guild-composer-switch.failed")?.textContent?.trim() ?? null`);
  if (failure !== null) throw new Error(`the switch failed: ${safeText(failure, 200)}`);
  return observed;
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

const codexSessionsRoot = join(homedir(), ".codex", "sessions");
let codexRolloutsAtStart; // Set of rollout paths that existed before check I; only newer ones that name the QA workspace are ours.

function codexRolloutFiles() {
  return existsSync(codexSessionsRoot) ? [...walk(codexSessionsRoot)].filter((path) => path.endsWith(".jsonl")) : [];
}

/** Rollouts this run created: new since check I began and naming the QA workspace as their working directory. */
function qaCodexRollouts() {
  if (codexRolloutsAtStart === undefined) return [];
  return codexRolloutFiles().filter((path) => !codexRolloutsAtStart.has(path) && readFileSync(path, "utf8").includes(`guild3-qa-ws-${stamp}`));
}

function cleanCodexRollouts() {
  const removed = [];
  for (const path of qaCodexRollouts()) {
    rmSync(path, { force: true });
    removed.push(path.replace(codexSessionsRoot, ""));
  }
  return removed;
}

function codexAdapterProcess() {
  trackDescendants();
  return descendantsOf(app.pid).find((entry) => /codex-acp/u.test(entry.command) && !/app-server/u.test(entry.command));
}

/** Guild's own home for Gemini (HOME and GEMINI_CLI_HOME of the child), under the data dir. */
const geminiHome = join(dataDir, "engines", "gemini-home");

function geminiProcess() {
  trackDescendants();
  return descendantsOf(app.pid).find((entry) => /gemini\.js\b.*--acp/u.test(entry.command));
}

/** Whether the key file names the variable. Names only: no value is kept. */
function keyFileNames(variable) {
  if (!existsSync(keyFile)) return false;
  return readFileSync(keyFile, "utf8").split("\n").some((line) => new RegExp(`^(?:export\\s+)?${variable}=.+`, "u").test(line.trim()));
}

/** The child's environment as booleans: Guild's home, the key as a presence, and none of the variables that would change the sign-in or the host. */
function geminiEnvironment(pid) {
  const underHome = (name) => [geminiHome, `/private${geminiHome}`].some((root) => processEnvValueStartsWith(pid, name, root));
  return {
    cliHomeIsGuilds: underHome("GEMINI_CLI_HOME"),
    homeIsGuilds: underHome("HOME"),
    keyPresent: processEnvHas(pid, "GEMINI_API_KEY"),
    singleProcess: processEnvValueIs(pid, "GEMINI_CLI_NO_RELAUNCH", "1"),
    envProxy: processEnvValueIs(pid, "NODE_USE_ENV_PROXY", "1"),
    noOAuthSwitch: !processEnvHas(pid, "GOOGLE_GENAI_USE_GCA"),
    noBaseUrl: !processEnvHas(pid, "GOOGLE_GEMINI_BASE_URL"),
    noVertex: !processEnvHas(pid, "GOOGLE_GENAI_USE_VERTEXAI") && !processEnvHas(pid, "GOOGLE_CLOUD_PROJECT"),
    noGoogleKeyOrCredentials: !processEnvHas(pid, "GOOGLE_API_KEY") && !processEnvHas(pid, "GOOGLE_APPLICATION_CREDENTIALS"),
    noOtherEngineKeys: !processEnvHas(pid, "ANTHROPIC_BASE_URL") && !processEnvHas(pid, "ANTHROPIC_AUTH_TOKEN") && !processEnvHas(pid, "OPENAI_API_KEY"),
  };
}

/** The chat files the CLI wrote in Guild's home (what session/load reads). */
function geminiChatFiles() {
  const root = join(geminiHome, ".gemini", "tmp");
  return existsSync(root) ? [...walk(root)].filter((path) => /[\\/]chats[\\/]/u.test(path) && path.endsWith(".jsonl")) : [];
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

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
const state = { claudeTaskId: undefined, grokTaskId: undefined, codexTaskId: undefined, geminiTaskId: undefined };

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

/** The Claude process the app runs for the task now, and what its environment says (booleans only). */
function adapterEnvironment(pid) {
  return {
    pid,
    baseUrlSet: processEnvHas(pid, "ANTHROPIC_BASE_URL"),
    authTokenSet: processEnvHas(pid, "ANTHROPIC_AUTH_TOKEN"),
    // Claude Code sends this throwaway token to the router, never its subscription token (D-061).
    authTokenIsRouterToken: processEnvValueStartsWith(pid, "ANTHROPIC_AUTH_TOKEN", "guild-router-"),
    apiKeySet: processEnvHas(pid, "ANTHROPIC_API_KEY"),
    nonessentialTrafficOff: processEnvValueIs(pid, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1"),
    subagentOnRoutedModel: processEnvValueIs(pid, "CLAUDE_CODE_SUBAGENT_MODEL", "deepseek-v4-flash"),
    smallFastOnRoutedModel: processEnvValueIs(pid, "ANTHROPIC_SMALL_FAST_MODEL", "deepseek-v4-flash"),
    toolSearch: processEnvValueIs(pid, "ENABLE_TOOL_SEARCH", "true"),
    captureOff: processEnvValueIs(pid, "OPENVIKING_AUTO_CAPTURE", "false"),
  };
}

/** Waits for the app to run a Claude process other than `previousPid` (a mode switch replaced it). */
async function waitForNewAdapter(previousPid) {
  return until("a new Claude process after the switch", async () => {
    const adapter = adapterProcess();
    return adapter !== undefined && adapter.pid !== previousPid ? adapter : undefined;
  }, { timeout: 120_000, interval: 500 });
}

function routerSummary() {
  const events = routerEvents().filter((entry) => entry.event === "router.request");
  const byModel = (pattern) => events.filter((entry) => pattern.test(String(entry.fields.model ?? "")));
  const deepseek = byModel(/deepseek/iu);
  const claudeModels = byModel(/^claude-/iu);
  return {
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
}

/** Opens the picker once its trigger is enabled again (a switch or a turn holds the selection). */
async function openPicker() {
  await until("model picker trigger enabled", async () => {
    const value = await cdp.evaluate(locate(".guild-model-picker-trigger"));
    return value !== null && !value.disabled ? value : undefined;
  }, { timeout: 60_000 });
  if (!(await domExists(".guild-model-popover"))) await clickDom(".guild-model-picker-trigger");
  await until("model popover", () => domExists(".guild-model-popover"), { timeout: 10_000 });
  await sleep(300);
}

async function closePicker() {
  await cdp.evaluate(`document.querySelector(".guild-model-picker")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(300);
}

async function checkC() {
  const taskId = state.claudeTaskId;
  await call("openTask", { taskId });
  const details = {};

  // 1. Opus (native) -> DeepSeek (routed). The task has run on the subscription: the Online and Local rows carry the Restarts tag.
  const picked = await pickModel("C", "^\\s*DeepSeek V4 Flash");
  details.pickerGroups = picked.groups;
  details.pickerTagsOnNativeTask = picked.tags;
  assertRestartTags(picked.tags, "native", "native task, Online and Local rows");
  // The Online reminder is the only dialog now: no one-way notice, no local-relay text.
  await until("online reminder dialog", async () => (await domExists(".guild-online-reminder")) ? true : undefined, { timeout: 15_000 });
  details.reminderTitle = safeText(await domText(".guild-online-reminder .guild-dialog-header"), 160);
  details.reminderBody = safeText(await domText(".guild-online-reminder-body"), 600);
  details.dialogCount = await cdp.evaluate(`document.querySelectorAll(".guild-online-reminder").length`);
  await shot("C", "online-reminder-dialog");
  if (details.dialogCount !== 1) throw new Error(`expected one dialog, found ${details.dialogCount}`);
  // D-063: the title is generic ("confirm before sending to an online model"); the vendor is named in the body.
  if (!/online model|在线模型/iu.test(details.reminderTitle) || !/DeepSeek/u.test(details.reminderBody) || !/CLAUDE\.md/u.test(details.reminderBody)) throw new Error("the dialog is not the Online reminder for DeepSeek");
  if (/switch back to a Claude subscription|local relay|cannot go back|不能再切回/iu.test(`${details.reminderTitle} ${details.reminderBody}`)) throw new Error("the dialog still carries the one-way text");
  const nativePid = adapterProcess()?.pid;
  await clickDom(".guild-online-reminder .guild-dialog-footer button.primary");
  details.switchToDeepSeek = await observeSwitching("C", "switching-status-to-deepseek", "DeepSeek V4 Flash");
  await waitSelection(taskId, "deepseek-v4-flash", { timeout: 180_000 });
  details.routedMarkerLogged = readLines(join(dataDir, "diagnostics", "runtime.jsonl")).some((entry) => entry.event === "task_routed" && entry.taskId === taskId);
  const routedAdapter = await waitForNewAdapter(nativePid);
  details.routedEnv = adapterEnvironment(routedAdapter.pid);
  const env = details.routedEnv;
  if (!env.baseUrlSet || !env.authTokenIsRouterToken || env.apiKeySet || !env.nonessentialTrafficOff || !env.subagentOnRoutedModel || !env.smallFastOnRoutedModel || !env.captureOff) {
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

  // 2. On the routed task the Claude rows are ordinary rows again, tagged, and so is "Use default"; nothing is locked.
  await openPicker();
  details.pickerTagsOnRoutedTask = await readPickerTags();
  assertRestartTags(details.pickerTagsOnRoutedTask, "routed", "routed task, Claude rows");
  await shot("C", "claude-rows-restart-tags-on-routed-task");
  // D-064: a routed process lists a poorer set of Claude models (a bare Default row, no older models); only the native
  // process sets the Claude group, so on the routed task it still shows what the native process reported.
  details.claudeGroupOnRoutedTask = await cdp.evaluate(`(() => {
    const group = [...document.querySelectorAll(".guild-model-group")].find((candidate) => /claude/iu.test(candidate.querySelector(".guild-model-heading")?.textContent || ""));
    if (!group) return null;
    return {
      rows: [...group.querySelectorAll(".guild-model-row")].map((row) => (row.querySelector("strong")?.textContent || "").trim()),
      older: (group.querySelector(".guild-model-older")?.textContent || "").trim() || null,
    };
  })()`);
  const claudeGroup = details.claudeGroupOnRoutedTask;
  if (claudeGroup === null) throw new Error("the picker has no Claude group on the routed task");
  if (!claudeGroup.rows.some((name) => /^(?:默认|Default)\s*[（(][^()（）]+[)）]$/u.test(name))) {
    throw new Error(`the Claude default row lost its model name on the routed task: ${JSON.stringify(claudeGroup.rows)}`);
  }
  if (claudeGroup.older === null || !/^(?:更早的模型|Older models)/iu.test(claudeGroup.older)) {
    throw new Error(`the Claude group lost its older-models expander on the routed task: ${JSON.stringify(claudeGroup)}`);
  }
  await closePicker();

  // 3. The conversation continues on the third-party model with what the Claude turns said, and DeepSeek makes up a code word.
  const recall = await sendAndWait("C", taskId, "Without using any tools: what does hello.txt contain? Answer in one short sentence.", { timeout: 360_000 });
  const recallReply = assistantTextOf(recall.view, recall.runId);
  details.recallReplyTail = safeText(recallReply.slice(-200), 200);
  if (!/\bhi\b/iu.test(recallReply)) throw new Error("DeepSeek did not recall hello.txt from the Claude turns");
  const codeTurn = await sendAndWait("C", taskId, "Without using any tools, make up one random code word of eight lowercase letters and reply with exactly: CODE=<word>", { timeout: 360_000 });
  const codeReply = assistantTextOf(codeTurn.view, codeTurn.runId);
  const codeWord = /CODE=\s*([A-Za-z]{6,12})/u.exec(codeReply)?.[1]?.toLowerCase();
  details.codeWordMadeByDeepSeek = codeWord !== undefined;
  if (codeWord === undefined) throw new Error(`DeepSeek did not answer with CODE=<word>: ${safeText(codeReply.slice(-120), 120)}`);
  const routerBeforeBack = routerSummary();

  // 4. DeepSeek (routed) -> Opus 5.5 (native): the process is replaced, runs with no router variable, and resumes the session.
  const routedPid = adapterProcess()?.pid;
  const back = await pickModel("C", "^\\s*Opus \\d");
  details.pickerGroupsOnRoutedTask = back.groups;
  details.switchBackToOpus = await observeSwitching("C", "switching-status-to-opus", "Opus");
  await waitSelection(taskId, "opus", { timeout: 240_000 });
  const nativeAdapter = await waitForNewAdapter(routedPid);
  details.nativeEnvAfterSwitchBack = adapterEnvironment(nativeAdapter.pid);
  const native = details.nativeEnvAfterSwitchBack;
  // The dev capture hook of this script also sets the capture variable for native spawns; the marker path alone is covered by unit tests.
  if (native.baseUrlSet || native.authTokenSet || native.apiKeySet || !native.captureOff) {
    throw new Error(`the native process after the switch back is wrong: ${JSON.stringify(native)}`);
  }
  await shot("C", "opus-selected-after-switch-back");
  const opusTurn = await sendAndWait("C", taskId, "Without using any tools: what eight-letter code word did the assistant make up in its CODE= reply earlier in this conversation? Reply with just that word, then OPUS-BACK-OK.", { timeout: 420_000 });
  const opusReply = assistantTextOf(opusTurn.view, opusTurn.runId);
  details.opusReplyTail = safeText(opusReply.slice(-200), 200);
  details.opusRecalledDeepSeekCode = opusReply.toLowerCase().includes(codeWord);
  details.opusSessionKept = !opusTurn.view.timeline.some((item) => item.kind === "notice" && item.noticeType === "session_restored");
  await shot("C", "opus-recalls-deepseek-turn");
  if (!details.opusRecalledDeepSeekCode) throw new Error("Opus did not recall the code word of the DeepSeek turn");
  if (!details.opusSessionKept) throw new Error("the session was replaced, not resumed, by the switch back");

  // 5. Router log proof: only third-party sources; nothing went to Anthropic, no claude-* model, no Claude credential, and
  // the native Opus turn made no router request at all.
  const r = routerSummary();
  details.router = r;
  details.routerRequestsDuringOpusTurn = r.requests - routerBeforeBack.requests;
  if (r.deepseekRequests === 0 || r.deepseekAuthInAndReplaced !== r.deepseekRequests) throw new Error(`DeepSeek requests lack authIn/authReplaced: ${JSON.stringify(r)}`);
  if (r.deepseekFromOtherSource !== 0) throw new Error("a DeepSeek model id was routed to another source");
  if (r.anthropicSourceRequests !== 0) throw new Error(`a request was served by Anthropic: ${JSON.stringify(r)}`);
  if (r.claudeModelRequests !== 0) throw new Error(`a claude-* model request reached the router: ${JSON.stringify(r)}`);
  if (r.anthropicCredentialRejections !== 0) throw new Error(`a Claude credential reached the router: ${JSON.stringify(r)}`);
  if (r.thirdPartyWithoutKeyReplacement !== 0) throw new Error("a third-party request went out without key replacement");
  if (details.routerRequestsDuringOpusTurn !== 0) throw new Error(`the native Opus turn made ${details.routerRequestsDuringOpusTurn} router requests`);
  return details;
}

async function checkD() {
  // The task of check C is back on Opus 5.5 (native): the switch to the Local model crosses the boundary again.
  const taskId = state.claudeTaskId;
  await call("openTask", { taskId });
  const details = {};
  const nativePid = adapterProcess()?.pid;
  const picked = await pickModel("D", "^\\s*Local Model 27B");
  details.pickerTagsOnNativeTask = picked.tags;
  assertRestartTags(picked.tags, "native", "native task, Online and Local rows");
  await sleep(1000);
  details.reminderShown = await domExists(".guild-online-reminder");
  if (details.reminderShown) throw new Error("a Local model asked for the Online reminder");
  details.switchToLocal = await observeSwitching("D", "switching-status-to-local", "Local Model");
  await waitSelection(taskId, "local-27b-model", { timeout: 180_000 });
  const routedAdapter = await waitForNewAdapter(nativePid);
  const routedEnv = adapterEnvironment(routedAdapter.pid);
  details.routedEnvForLocal = { baseUrlSet: routedEnv.baseUrlSet, authTokenIsRouterToken: routedEnv.authTokenIsRouterToken, apiKeySet: routedEnv.apiKeySet, captureOff: routedEnv.captureOff };
  if (!routedEnv.baseUrlSet || !routedEnv.authTokenIsRouterToken || routedEnv.apiKeySet || !routedEnv.captureOff) {
    throw new Error(`the routed process for the Local model is wrong: ${JSON.stringify(details.routedEnvForLocal)}`);
  }
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
  // The browser tools belong to the Claude engine, not to routing. The task of checks C and D runs on the Local model
  // now, so the agent drives the pane from a fresh native Claude task on Opus.
  const created = await call("createTask", { workspaceId, engine: "claude" });
  const taskId = created.task.taskId;
  await call("openTask", { taskId });
  const details = { taskId };
  const chosen = await call("setTaskRuntimeSettings", { taskId, model: "opus", reasoningEffort: null });
  if (chosen.status === "refused") throw new Error(`could not choose Opus for the browser task: ${chosen.reason}`);

  // Open the workbench, the Browser tab, and navigate through the address bar.
  // Wait until the new task is the open one (the trigger is enabled), then open the workbench only if its tabs
  // are not already showing: reading aria-expanded before the task opened could toggle an open workbench shut.
  await until("task opened", async () => (await cdp.evaluate(`document.querySelector(".guild-workbench-trigger")?.disabled === false`)) ? true : undefined, { timeout: 15_000 });
  await sleep(300);
  if (!(await domExists(".guild-workbench-tabs"))) await clickDom(".guild-workbench-trigger");
  await until("workbench tabs", async () => (await domExists(".guild-workbench-tabs")) ? true : undefined, { timeout: 15_000 });
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

/**
 * I: Codex through its ChatGPT subscription (docs/21 section 5). Guild never reads or sends the Codex login: the
 * adapter and its Codex core use the user's own `codex login`. The adapter is found through the dev-only
 * GUILD_DEV_CODEX_ACP hook (a scratch install); the pins apply to it as to any install.
 */
async function checkI(record) {
  const details = { issues: [] };
  record.details = details; // kept in the report when a step fails
  codexRolloutsAtStart = new Set(codexRolloutFiles());
  const fileName = "codex-qa.txt";

  // 0. Guild found the adapter and the core and says so; nothing about the login is read by Guild.
  const opened = await until("codex engine ready in Settings", async () => {
    const codex = (await call("bootstrap")).runtimeSettings.engines?.codex;
    return codex?.status === "ready" ? codex : undefined;
  }, { timeout: 90_000, interval: 500 });
  details.statusAtOpen = { status: opened.status, version: opened.version ?? null, accountLabel: opened.accountLabel ?? null, permissionMode: opened.permissionMode };
  // Ask before writing, so the card appears for a file in the workspace. Restored in the data dir's own settings at the end.
  await call("setEngineSettings", { engine: "codex", model: null, reasoningEffort: null, permissionMode: "read-only" });

  // 1. A fresh Codex task; a Grok task next to it makes the sidebar show the engine markers.
  const created = await call("createTask", { workspaceId, engine: "codex" });
  const taskId = created.task.taskId;
  state.codexTaskId = taskId;
  details.taskId = taskId;
  details.engineAtCreate = created.task.engine;
  if (created.task.engine !== "codex") throw new Error(`the task engine is ${created.task.engine}`);
  await call("openTask", { taskId });
  // A session without a turn lists the account's models (no prompt is sent).
  await call("loadSlashCommands", { taskId }).catch((error) => details.issues.push(`slash commands: ${safeText(error.message, 120)}`));
  const catalog = await until("codex model list", async () => {
    const models = (await call("bootstrap")).runtimeSettings.modelCatalogs?.codex?.models ?? [];
    return models.length > 0 ? models : undefined;
  }, { timeout: 120_000, interval: 500 });
  details.accountModels = catalog.map((model) => ({ id: model.id, name: model.name, efforts: model.reasoningEfforts.map((effort) => effort.id) }));
  const cheapest = catalog.find((model) => /luna/iu.test(model.id)) ?? catalog.at(-1);
  details.chosenModel = { id: cheapest.id, name: cheapest.name };

  // 2. The ChatGPT group lists those models; the cheapest is chosen in the picker.
  details.viewBeforePick = await call("openTask", { taskId }).then((view) => ({ engine: view.task.engine, canChange: view.modelSelection.canChange, modelId: view.modelSelection.modelId, source: view.modelSelection.source, runState: view.task.activeRunState ?? null, canSend: view.canSend }));
  details.triggerBeforePick = await cdp.evaluate(`(() => { const t = document.querySelector(".guild-model-picker-trigger"); return t ? { text: (t.textContent || "").trim(), disabled: t.disabled === true, title: t.getAttribute("title") || "", aria: t.getAttribute("aria-label") || "" } : null; })()`);
  const picked = await pickModel("I", `^\\s*${escapeRegExp(cheapest.name)}`);
  details.pickerGroups = picked.groups;
  const chatGroup = picked.groups.find((group) => /ChatGPT/u.test(group.group));
  if (chatGroup === undefined) throw new Error(`the picker has no ChatGPT group: ${JSON.stringify(picked.groups.map((group) => group.group))}`);
  if (!cheapest.name || !chatGroup.rows.includes(cheapest.name) || chatGroup.rows.length < catalog.length) {
    throw new Error(`the ChatGPT group does not list the account's models: ${JSON.stringify(chatGroup)}`);
  }
  const selected = await waitSelection(taskId, `^${escapeRegExp(cheapest.id)}$`, { timeout: 60_000 });
  details.selectionAfterPick = { modelId: selected.modelSelection.modelId, source: selected.modelSelection.source };
  const lowest = cheapest.reasoningEfforts.find((effort) => effort.id === "low") ?? cheapest.reasoningEfforts[0];
  if (lowest !== undefined) {
    const saved = await call("setTaskRuntimeSettings", { taskId, model: cheapest.id, reasoningEffort: lowest.id });
    details.effortChoice = { effort: lowest.id, status: saved.status };
    if (saved.status !== "applied" && saved.status !== "saved") throw new Error(`the effort choice was ${saved.status}`);
  }
  await shot("I", "codex-model-chosen");

  // 3. One turn that writes a file: the permission card is decided through the UI.
  // Read-only mode: a write is refused by the sandbox unless Codex asks for approval, which is the card this check needs.
  const prompt = `Run exactly this shell command in the workspace root: printf ok > ${fileName} && cat ${fileName}. The workspace sandbox is read-only, so ask for approval to run it outside the sandbox (escalated permissions) instead of giving up. When it has run, tell me its output and end your reply with CODEX-QA-OK.`;
  const sent = await call("sendMessage", { taskId, text: prompt });
  if (sent.status !== "started") throw new Error(`send_not_started:${sent.status}`);
  const seen = await until("pending permission card or end of run", async () => {
    if (await domExists(".guild-permission")) return "card";
    const view = await call("openTask", { taskId });
    return TERMINAL.has(view.task.activeRunState ?? "") && view.timeline.some((item) => item.runId === sent.runId) ? "ended" : undefined;
  }, { timeout: 300_000, interval: 300 });
  if (seen === "ended") throw new Error("the run ended without a permission card (inconclusive)");
  await sleep(500);
  details.pendingCardTitle = safeText(await domText(".guild-permission-title"), 120);
  details.cardButtons = (await domText(".guild-permission-actions")).split("\n").map((text) => text.trim()).filter(Boolean).slice(0, 8);
  await shot("I", "card-pending");
  await clickDom(".guild-permission-actions button.primary");
  const done = await waitForRun("I", taskId, sent.runId, { timeout: 360_000, approve: true });
  const reply = assistantTextOf(done.view, sent.runId);
  const filePath = join(workspaceDir, fileName);
  const fileText = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  details.fileText = fileText === undefined ? null : fileText.trim();
  details.replyHasMarker = reply.includes("CODEX-QA-OK");
  details.toolCalls = done.view.timeline.filter((item) => item.kind === "tool" && item.runId === sent.runId).length;
  details.afterApprovalUi = await settleUi("I");
  if (fileText === undefined || fileText.trim() !== "ok") throw new Error(`${fileName} content ${JSON.stringify(fileText)}`);
  if (details.afterApprovalUi.stalePermissionCards > 0) throw new Error("the permission card is still shown after it was approved and the run completed");
  if (details.afterApprovalUi.countingChangesStuck) throw new Error("'Counting changes' never settled");

  // 4. The footer names the model of the turn, as the record and as the line under the turn.
  const modelLine = await until("per-turn model line", async () => {
    const text = await domText(".guild-turn-model");
    return text.includes(cheapest.name) ? text : undefined;
  }, { timeout: 20_000, interval: 300 });
  details.turnModelLine = safeText(modelLine, 160);
  details.runModelRecord = (done.view.runModels ?? []).find((entry) => entry.runId === sent.runId)?.label ?? null;
  if (details.runModelRecord !== cheapest.name) throw new Error(`the run's model label is ${JSON.stringify(details.runModelRecord)}, expected ${cheapest.name}`);
  await shot("I", "codex-turn-done");

  // 5. The adapter process: pinned Codex core, no router, no Claude or OpenAI variable, memory plugin switched off.
  const adapter = codexAdapterProcess();
  details.adapterProcess = adapter === undefined ? null : { pid: adapter.pid, command: safeText(adapter.command, 160) };
  details.hasAppServerChild = adapter !== undefined && descendantsOf(adapter.pid).some((entry) => /app-server/u.test(entry.command));
  details.env = adapter === undefined ? null : {
    codexPathSet: processEnvHas(adapter.pid, "CODEX_PATH"),
    codexPathIsCoreInScratch: processEnvValueStartsWith(adapter.pid, "CODEX_PATH", dirname(dirname(dirname(codexAcpRoot)))),
    noAnthropicBase: !processEnvHas(adapter.pid, "ANTHROPIC_BASE_URL"),
    noAnthropicToken: !processEnvHas(adapter.pid, "ANTHROPIC_AUTH_TOKEN"),
    noOpenAiKey: !processEnvHas(adapter.pid, "OPENAI_API_KEY"),
    recallOff: processEnvValueIs(adapter.pid, "OPENVIKING_AUTO_RECALL", "false"),
    captureOff: processEnvValueIs(adapter.pid, "OPENVIKING_AUTO_CAPTURE", "false"),
  };
  if (adapter === undefined || !details.hasAppServerChild) throw new Error("no codex-acp process with a Codex core child was found");
  const badEnv = Object.entries(details.env).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (badEnv.length > 0) throw new Error(`the Codex process environment is wrong: ${badEnv.join(", ")}`);

  // 6. The sidebar row carries the Codex marker; the account card is Codex's own; Settings shows the Codex section.
  const marker = await cdp.evaluate(`(() => { const e = document.querySelector(".guild-task-engine.codex"); return e ? { text: (e.textContent || "").trim(), title: e.getAttribute("title") || "" } : null; })()`);
  details.sidebarMarker = marker;
  // The markers show while the sidebar holds tasks of more than one engine (a full run has Grok and Claude tasks).
  const sidebarEngines = new Set((await call("bootstrap")).workspaces.flatMap((workspace) => workspace.tasks.map((task) => task.engine ?? "grok")));
  details.sidebarEngines = [...sidebarEngines].sort();
  if (sidebarEngines.size > 1) {
    if (marker === null) throw new Error("the sidebar shows no Codex marker");
    // The text is the letter plus the hidden name of the engine; the letter is what the row shows.
    if (!/codex/iu.test(marker.title) || !marker.text.startsWith("X")) throw new Error(`the marker is ${JSON.stringify(marker)}`);
  } else {
    details.issues.push("only Codex tasks in the sidebar: no engine markers are shown, so none was checked (run the other checks too)");
  }
  await shot("I", "sidebar-codex-marker");
  if (!(await domExists(".guild-account-popover"))) await clickDom(".guild-profile");
  await until("usage popover", () => domExists(".guild-account-popover"), { timeout: 10_000 });
  await sleep(500);
  details.accountCard = safeText(await domText(".guild-account-popover .guild-usage-card"), 300);
  details.accountCardHasGrokLink = await domExists(".guild-usage-link");
  await shot("I", "account-card");
  await cdp.evaluate(`document.querySelector(".guild-account-popover")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  if (!/ChatGPT/u.test(details.accountCard) || details.accountCardHasGrokLink || /grok/iu.test(details.accountCard)) {
    throw new Error(`the account card is not Codex's: ${details.accountCard}`);
  }
  await openSettings();
  await clickDom("#guild-settings-tab-engines");
  await sleep(500);
  const sectionText = await domText("#guild-settings-panel-engines .guild-engine-codex");
  details.codexSection = safeText(sectionText, 500);
  details.codexSectionModes = ["Read-only|只读", "Workspace access|工作区访问", "Auto review|自动审查", "Full access|完全访问"].map((pattern) => new RegExp(pattern, "u").test(sectionText));
  await shot("I", "settings-codex-section");
  await cdp.evaluate(`document.querySelector(".guild-dialog-settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
  if (!/Codex/u.test(sectionText) || !/Ready|已就绪/u.test(sectionText) || !details.codexSectionModes.every(Boolean)) {
    throw new Error(`the Codex section of Settings is wrong: ${details.codexSection}`);
  }

  // 7. Quit and reopen Guild: the same session resumes; the stored model and permission mode are applied first.
  record.details = details;
  const rolloutsBefore = qaCodexRollouts().length;
  details.quit = await quitApp();
  await launchApp();
  const reopened = await call("openTask", { taskId });
  details.engineAfterRestart = reopened.task.engine;
  details.selectionAfterRestart = { modelId: reopened.modelSelection.modelId, source: reopened.modelSelection.source };
  if (reopened.task.engine !== "codex") throw new Error("the task engine changed across the restart");
  if (reopened.modelSelection.modelId !== cheapest.id) throw new Error(`the model after the restart is ${reopened.modelSelection.modelId}`);
  if ((reopened.runModels ?? []).find((entry) => entry.runId === sent.runId)?.label !== cheapest.name) throw new Error("the first turn lost its model line across the restart");
  const follow = `Without using any tools: what exact text did ${fileName} contain? Reply with just that text. End with CODEX-RESUME-OK.`;
  let resumed;
  try {
    resumed = await sendAndWait("I", taskId, follow, { timeout: 360_000 });
  } catch (error) {
    details.issues.push(`first follow-up after restart failed: ${safeText(error.message, 160)}`);
    await shot("I", "restore-first-attempt-failed");
    await sleep(20_000);
    resumed = await sendAndWait("I", taskId, follow, { timeout: 360_000 });
  }
  const resumedReply = assistantTextOf(resumed.view, resumed.runId);
  details.resumedReplyMentionsOk = /\bok\b/iu.test(resumedReply);
  details.noSessionRestoredNotice = !resumed.view.timeline.some((item) => item.kind === "notice" && item.noticeType === "session_restored");
  details.sessionModeAfterResume = resumed.view.sessionModes?.currentModeId ?? null;
  details.secondRunModelRecord = (resumed.view.runModels ?? []).find((entry) => entry.runId === resumed.runId)?.label ?? null;
  details.rolloutFilesBeforeRestart = rolloutsBefore;
  const rollouts = qaCodexRollouts();
  details.rolloutFilesAfterRestart = rollouts.length;
  details.rolloutHoldingBothTurns = rollouts.filter((path) => {
    const text = readFileSync(path, "utf8");
    return text.includes("CODEX-QA-OK") && text.includes("CODEX-RESUME-OK");
  }).length;
  await shot("I", "codex-after-restart");
  if (!details.resumedReplyMentionsOk) throw new Error("the resumed turn does not remember the file's content");
  if (details.sessionModeAfterResume !== "read-only") throw new Error(`the permission mode after the resume is ${details.sessionModeAfterResume}`);
  if (details.secondRunModelRecord !== cheapest.name) throw new Error(`the resumed turn ran on ${JSON.stringify(details.secondRunModelRecord)}, expected ${cheapest.name}`);
  if (details.rolloutHoldingBothTurns !== 1) throw new Error(`expected one Codex rollout with both turns, found ${details.rolloutHoldingBothTurns}`);

  // The setting this check changed in the QA data dir goes back to Guild's default.
  await call("setEngineSettings", { engine: "codex", model: null, reasoningEffort: null, permissionMode: "workspace-write" });
  return details;
}

/**
 * J: Gemini with the owner's own API key, paid per use (docs/21 section 8, PC-ENG-004). Guild never shows or stores the
 * key: the seed confirms the binding of the default key file and GEMINI_API_KEY through the store (QA only), Guild reads
 * the key when it starts the child and hands it over as GEMINI_API_KEY alone. The CLI is found through the dev-only
 * GUILD_DEV_GEMINI_CLI hook (a scratch install); the pins apply to it as to any install. Everything printed is a name, a
 * count or a boolean, never a value.
 */
async function checkJ(record) {
  const details = { issues: [] };
  record.details = details; // kept in the report when a step fails
  const fileName = "gemini-qa.txt";

  // 0. Guild found the CLI and a usable, confirmed key, and says so without showing it.
  const opened = await until("gemini engine ready in Settings", async () => {
    const gemini = (await call("bootstrap")).runtimeSettings.engines?.gemini;
    return gemini?.status === "ready" ? gemini : undefined;
  }, { timeout: 90_000, interval: 500 });
  details.statusAtOpen = {
    status: opened.status, version: opened.version ?? null, permissionMode: opened.permissionMode,
    apiKey: { keyVariable: opened.apiKey?.keyVariable, host: opened.apiKey?.host, confirmed: opened.apiKey?.confirmed, state: opened.apiKey?.state, hasKeyField: Object.keys(opened.apiKey ?? {}).some((name) => /^(key|secret|token|value)$/iu.test(name)) },
  };
  if (opened.apiKey?.confirmed !== true || opened.apiKey?.state !== "usable" || opened.apiKey?.host !== "generativelanguage.googleapis.com" || details.statusAtOpen.apiKey.hasKeyField) {
    throw new Error(`the key binding is wrong: ${JSON.stringify(details.statusAtOpen.apiKey)}`);
  }
  if (opened.permissionMode !== "default") throw new Error(`the default Gemini permission mode is ${opened.permissionMode}, expected default (asks first)`);

  // 1. A fresh Gemini task; a Grok task next to it makes the sidebar show the engine markers.
  const created = await call("createTask", { workspaceId, engine: "gemini" });
  const taskId = created.task.taskId;
  state.geminiTaskId = taskId;
  details.taskId = taskId;
  details.engineAtCreate = created.task.engine;
  if (created.task.engine !== "gemini") throw new Error(`the task engine is ${created.task.engine}`);
  await call("openTask", { taskId });
  // A session without a turn lists the models (no prompt is sent, so nothing is billed).
  await call("loadSlashCommands", { taskId }).catch((error) => details.issues.push(`slash commands: ${safeText(error.message, 120)}`));
  const catalog = await until("gemini model list", async () => {
    const models = (await call("bootstrap")).runtimeSettings.modelCatalogs?.gemini?.models ?? [];
    return models.length > 0 ? models : undefined;
  }, { timeout: 120_000, interval: 500 });
  details.sessionModels = catalog.map((model) => ({ id: model.id, name: model.name, efforts: model.reasoningEfforts.length }));
  if (catalog.some((model) => model.id === "auto" || /^auto$/iu.test(model.name))) throw new Error("the model list offers the CLI's own auto choice");
  if (catalog.some((model) => model.reasoningEfforts.length > 0)) throw new Error("a Gemini model carries a reasoning effort row");
  const cheapest = catalog.find((model) => /flash-lite/iu.test(model.id)) ?? catalog.find((model) => /flash/iu.test(model.id)) ?? catalog.at(-1);
  details.chosenModel = { id: cheapest.id, name: cheapest.name };
  if (!/flash/iu.test(cheapest.id)) throw new Error(`no Flash model is listed, so the cheapest one cannot be chosen: ${JSON.stringify(details.sessionModels)}`);

  // 2. The Gemini group lists those models with its muted cost hint; the cheapest is chosen in the picker.
  details.viewBeforePick = await call("openTask", { taskId }).then((view) => ({ engine: view.task.engine, canChange: view.modelSelection.canChange, modelId: view.modelSelection.modelId, source: view.modelSelection.source, runState: view.task.activeRunState ?? null, canSend: view.canSend }));
  await until("model picker trigger", async () => {
    const value = await cdp.evaluate(locate(".guild-model-picker-trigger"));
    return value !== null && !value.disabled ? value : undefined;
  }, { timeout: 60_000 });
  if (!(await domExists(".guild-model-popover"))) await clickDom(".guild-model-picker-trigger");
  await until("model popover", () => domExists(".guild-model-popover"), { timeout: 10_000 });
  await sleep(300);
  details.groupHints = await cdp.evaluate(`[...document.querySelectorAll(".guild-model-group")].map((group) => ({ group: (group.querySelector(".guild-model-heading")?.textContent || "").trim(), hint: (group.querySelector(".guild-model-group-hint")?.textContent || "").trim() }))`);
  const picked = await pickModel("J", `^\\s*${escapeRegExp(cheapest.name)}`);
  details.pickerGroups = picked.groups;
  const geminiGroup = picked.groups.find((group) => /Gemini/u.test(group.group));
  if (geminiGroup === undefined) throw new Error(`the picker has no Gemini group: ${JSON.stringify(picked.groups.map((group) => group.group))}`);
  if (!/pay-as-you-go|按量/iu.test(geminiGroup.group)) throw new Error(`the Gemini group does not say it is pay-as-you-go: ${geminiGroup.group}`);
  const geminiHint = details.groupHints.find((entry) => /Gemini/u.test(entry.group))?.hint ?? "";
  if (!/Google AI Studio/u.test(geminiHint)) throw new Error(`the Gemini group has no cost hint: ${JSON.stringify(geminiHint)}`);
  if (geminiGroup.rows.length < catalog.length || !geminiGroup.rows.includes(cheapest.name)) throw new Error(`the Gemini group does not list the session's models: ${JSON.stringify(geminiGroup)}`);
  if (geminiGroup.rows.some((row) => /^auto\b/iu.test(row))) throw new Error("the Gemini group offers auto");
  const selected = await waitSelection(taskId, `^${escapeRegExp(cheapest.id)}$`, { timeout: 60_000 });
  details.selectionAfterPick = { modelId: selected.modelSelection.modelId, source: selected.modelSelection.source };
  await shot("J", "gemini-model-chosen");

  // 3. One turn that writes a file: the permission card is decided through the UI (the Default mode asks first).
  const prompt = `Use your file-writing tool (write_file) to create a file named ${fileName} in the current directory containing exactly: ok. When it is written, reply with one short sentence and end your reply with GEMINI-QA-OK.`;
  const sent = await call("sendMessage", { taskId, text: prompt });
  if (sent.status !== "started") throw new Error(`send_not_started:${sent.status}`);
  const seen = await until("pending permission card or end of run", async () => {
    if (await domExists(".guild-permission")) return "card";
    const view = await call("openTask", { taskId });
    return TERMINAL.has(view.task.activeRunState ?? "") && view.timeline.some((item) => item.runId === sent.runId) ? "ended" : undefined;
  }, { timeout: 300_000, interval: 300 });
  if (seen === "ended") throw new Error("the run ended without a permission card (inconclusive)");
  await sleep(500);
  details.pendingCardTitle = safeText(await domText(".guild-permission-title"), 120);
  details.cardButtons = (await domText(".guild-permission-actions")).split("\n").map((text) => text.trim()).filter(Boolean).slice(0, 8);
  await shot("J", "card-pending");
  await clickDom(".guild-permission-actions button.primary");
  const done = await waitForRun("J", taskId, sent.runId, { timeout: 360_000, approve: true });
  const reply = assistantTextOf(done.view, sent.runId);
  const filePath = join(workspaceDir, fileName);
  const fileText = existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
  details.fileText = fileText === undefined ? null : fileText.trim();
  details.replyHasMarker = reply.includes("GEMINI-QA-OK");
  details.toolCalls = done.view.timeline.filter((item) => item.kind === "tool" && item.runId === sent.runId).length;
  details.afterApprovalUi = await settleUi("J");
  if (fileText === undefined || fileText.trim() !== "ok") throw new Error(`${fileName} content ${JSON.stringify(fileText)}`);
  if (details.afterApprovalUi.stalePermissionCards > 0) throw new Error("the permission card is still shown after it was approved and the run completed");
  if (details.afterApprovalUi.countingChangesStuck) throw new Error("'Counting changes' never settled");
  // The mode narration and replayed context frames of the CLI never reach the conversation.
  const stray = done.view.timeline.filter((item) => (item.kind === "assistant" || item.kind === "user") && /\[MODE_UPDATE\]|<session_context>|\[Function Response:/u.test(item.text ?? ""));
  details.strayInternalChunks = stray.length;
  if (stray.length > 0) throw new Error("the conversation shows a frame the CLI invented");

  // 4. The footer names the model of the turn, as the record and as the line under the turn.
  const modelLine = await until("per-turn model line", async () => {
    const text = await domText(".guild-turn-model");
    return text.includes(cheapest.name) ? text : undefined;
  }, { timeout: 20_000, interval: 300 });
  details.turnModelLine = safeText(modelLine, 160);
  details.runModelRecord = (done.view.runModels ?? []).find((entry) => entry.runId === sent.runId)?.label ?? null;
  if (details.runModelRecord !== cheapest.name) throw new Error(`the run's model label is ${JSON.stringify(details.runModelRecord)}, expected ${cheapest.name}`);
  await shot("J", "gemini-turn-done");

  // 5. The child: node running the pinned bundle, Guild's own home, the key as a presence only, nothing that would sign in
  // another way or send the key elsewhere.
  const child = geminiProcess();
  details.process = child === undefined ? null : { pid: child.pid, command: safeText(child.command.replace(/\s\/\S*\/gemini\.js/u, " <bundle>/gemini.js"), 160) };
  if (child === undefined) throw new Error("no Gemini CLI process was found");
  details.env = geminiEnvironment(child.pid);
  details.argv = { acp: /\s--acp(\s|$)/u.test(child.command), skipTrust: /\s--skip-trust(\s|$)/u.test(child.command) };
  const badEnv = Object.entries(details.env).filter(([, ok]) => ok !== true).map(([name]) => name);
  if (badEnv.length > 0 || !details.argv.acp || !details.argv.skipTrust) throw new Error(`the Gemini process is wrong: env ${badEnv.join(", ") || "ok"}, argv ${JSON.stringify(details.argv)}`);
  // Guild's settings file for the child, and no sign-in state of any other kind in Guild's home.
  // The model is in the file only for a start that knew it: the first process of the task did not, and the model was
  // applied to its session with session/set_model, so the file is checked for it again after the restart below.
  const readSettingsFile = () => {
    const settingsFile = join(geminiHome, ".gemini", "settings.json");
    const written = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : undefined;
    return written === undefined ? null : {
      selectedType: written.security?.auth?.selectedType ?? null,
      usageStatistics: written.privacy?.usageStatisticsEnabled ?? null,
      autoUpdate: written.general?.enableAutoUpdate ?? null,
      autoUpdateNotification: written.general?.enableAutoUpdateNotification ?? null,
      modelName: written.model?.name ?? null,
    };
  };
  const settingsFileIsGuilds = (file) => file !== null && file.selectedType === "gemini-api-key" && file.usageStatistics === false &&
    file.autoUpdate === false && file.autoUpdateNotification === false;
  details.settingsFile = readSettingsFile();
  details.oauthFileInHome = existsSync(join(geminiHome, ".gemini", "oauth_creds.json"));
  if (!settingsFileIsGuilds(details.settingsFile) || (details.settingsFile.modelName !== null && details.settingsFile.modelName !== cheapest.id)) {
    throw new Error(`Guild's Gemini settings file is wrong: ${JSON.stringify(details.settingsFile)}`);
  }
  if (details.oauthFileInHome) throw new Error("an OAuth credential file exists in Guild's Gemini home");
  details.chatFilesAfterFirstTurn = geminiChatFiles().length;

  // 6. The sidebar row carries the Gemini marker; the account card is Gemini's own; Settings shows the Gemini section.
  const marker = await cdp.evaluate(`(() => { const e = document.querySelector(".guild-task-engine.gemini"); return e ? { text: (e.textContent || "").trim(), title: e.getAttribute("title") || "" } : null; })()`);
  details.sidebarMarker = marker;
  const sidebarEngines = new Set((await call("bootstrap")).workspaces.flatMap((workspace) => workspace.tasks.map((task) => task.engine ?? "grok")));
  details.sidebarEngines = [...sidebarEngines].sort();
  if (sidebarEngines.size > 1) {
    if (marker === null) throw new Error("the sidebar shows no Gemini marker");
    if (!/gemini/iu.test(marker.title) || !marker.text.startsWith("Ge")) throw new Error(`the marker is ${JSON.stringify(marker)}`);
  } else {
    details.issues.push("only Gemini tasks in the sidebar: no engine markers are shown, so none was checked (run the other checks too)");
  }
  await shot("J", "sidebar-gemini-marker");
  if (!(await domExists(".guild-account-popover"))) await clickDom(".guild-profile");
  await until("usage popover", () => domExists(".guild-account-popover"), { timeout: 10_000 });
  await sleep(500);
  details.accountCard = safeText(await domText(".guild-account-popover .guild-usage-card"), 300);
  details.accountCardHasGrokLink = await domExists(".guild-usage-link");
  await shot("J", "account-card");
  await cdp.evaluate(`document.querySelector(".guild-account-popover")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  if (!/Gemini/u.test(details.accountCard) || details.accountCardHasGrokLink || /grok/iu.test(details.accountCard)) {
    throw new Error(`the account card is not Gemini's: ${details.accountCard}`);
  }
  if (/\$\s?\d|cost|费用/iu.test(details.accountCard)) throw new Error(`the account card shows a cost: ${details.accountCard}`);
  if (!/Google AI Studio/u.test(details.accountCard)) details.issues.push("the account card does not defer to Google AI Studio for billing");
  await openSettings();
  await clickDom("#guild-settings-tab-engines");
  await sleep(500);
  const sectionText = await domText("#guild-settings-panel-engines .guild-engine-gemini");
  details.geminiSection = safeText(sectionText, 700);
  details.geminiSectionModes = ["Default", "Auto-edit|Auto edit", "Plan", "Full access|YOLO"].map((pattern) => new RegExp(pattern, "u").test(sectionText));
  details.geminiSectionHasEffortRow = /reasoning effort|推理强度/iu.test(sectionText);
  details.geminiSectionKeyInput = await cdp.evaluate(`[...document.querySelectorAll("#guild-settings-panel-engines .guild-engine-gemini input")].map((input) => ({ type: input.type, name: input.name || "", placeholder: input.placeholder || "" })).filter((input) => /password|secret|key$/iu.test(input.type + input.name))`);
  // The dialog scrolls: bring the Gemini section, then its key binding, into view for the screenshots.
  for (const [selector, label] of [["#guild-settings-panel-engines .guild-engine-gemini", "settings-gemini-section"], ["#guild-settings-panel-engines .guild-engine-gemini .guild-engine-key", "settings-gemini-key-binding"]]) {
    await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`);
    await sleep(300);
    await shot("J", label);
  }
  await cdp.evaluate(`document.querySelector(".guild-dialog-settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await sleep(400);
  if (!/Gemini/u.test(sectionText) || !/Ready|已就绪/u.test(sectionText) || !/GEMINI_API_KEY/u.test(sectionText) || !/generativelanguage\.googleapis\.com/u.test(sectionText) ||
      !details.geminiSectionModes.every(Boolean) || details.geminiSectionHasEffortRow || details.geminiSectionKeyInput.length > 0) {
    throw new Error(`the Gemini section of Settings is wrong: ${details.geminiSection}`);
  }

  // 7. Quit and reopen Guild: the same session continues through session/load; the stored model and mode are applied first.
  record.details = details;
  details.quit = await quitApp();
  await launchApp();
  const reopened = await call("openTask", { taskId });
  details.engineAfterRestart = reopened.task.engine;
  details.selectionAfterRestart = { modelId: reopened.modelSelection.modelId, source: reopened.modelSelection.source };
  if (reopened.task.engine !== "gemini") throw new Error("the task engine changed across the restart");
  if (reopened.modelSelection.modelId !== cheapest.id) throw new Error(`the model after the restart is ${reopened.modelSelection.modelId}`);
  if ((reopened.runModels ?? []).find((entry) => entry.runId === sent.runId)?.label !== cheapest.name) throw new Error("the first turn lost its model line across the restart");
  const follow = `Without using any tools: what exact text did ${fileName} contain? Reply with just that text. End with GEMINI-RESUME-OK.`;
  let resumed;
  try {
    resumed = await sendAndWait("J", taskId, follow, { timeout: 360_000 });
  } catch (error) {
    details.issues.push(`first follow-up after restart failed: ${safeText(error.message, 160)}`);
    await shot("J", "restore-first-attempt-failed");
    await sleep(20_000);
    resumed = await sendAndWait("J", taskId, follow, { timeout: 360_000 });
  }
  const resumedReply = assistantTextOf(resumed.view, resumed.runId);
  details.resumedReplyMentionsOk = /\bok\b/iu.test(resumedReply);
  details.noSessionRestoredNotice = !resumed.view.timeline.some((item) => item.kind === "notice" && item.noticeType === "session_restored");
  details.sessionRecovery = resumed.view.sessionRecovery ?? null;
  details.sessionModeAfterResume = resumed.view.sessionModes?.currentModeId ?? null;
  details.secondRunModelRecord = (resumed.view.runModels ?? []).find((entry) => entry.runId === resumed.runId)?.label ?? null;
  const runtimeEvents = readLines(join(dataDir, "diagnostics", "runtime.jsonl")).filter((entry) => entry.taskId === taskId);
  details.loadCommittedEvents = runtimeEvents.filter((entry) => entry.event === "load_committed").length;
  details.loadFailedEvents = runtimeEvents.filter((entry) => entry.event === "load_failed").length;
  details.chatFilesAfterRestart = geminiChatFiles().length;
  details.chatFilesHoldingBothTurns = geminiChatFiles().filter((path) => {
    const text = readFileSync(path, "utf8");
    return text.includes("GEMINI-QA-OK") || text.includes(fileName) ? text.includes("GEMINI-RESUME-OK") : false;
  }).length;
  const childAfter = geminiProcess();
  details.envAfterRestart = childAfter === undefined ? null : geminiEnvironment(childAfter.pid);
  details.settingsFileAfterRestart = readSettingsFile();
  details.oauthFileAfterRestart = existsSync(join(geminiHome, ".gemini", "oauth_creds.json"));
  await shot("J", "gemini-after-restart");
  if (!details.resumedReplyMentionsOk) throw new Error("the resumed turn does not remember the file's content");
  if (!details.noSessionRestoredNotice || details.sessionRecovery === "replacement_required") throw new Error("the session was replaced instead of loaded");
  if (!settingsFileIsGuilds(details.settingsFileAfterRestart) || details.settingsFileAfterRestart.modelName !== cheapest.id || details.oauthFileAfterRestart) {
    throw new Error(`Guild's Gemini settings file after the restart is wrong: ${JSON.stringify(details.settingsFileAfterRestart)}`);
  }
  if (details.loadCommittedEvents < 1) throw new Error("no session/load was committed after the restart");
  if (details.sessionModeAfterResume !== null && details.sessionModeAfterResume !== "default") throw new Error(`the permission mode after the resume is ${details.sessionModeAfterResume}`);
  if (details.secondRunModelRecord !== cheapest.name) throw new Error(`the resumed turn ran on ${JSON.stringify(details.secondRunModelRecord)}, expected ${cheapest.name}`);
  if (childAfter === undefined || Object.values(details.envAfterRestart).some((ok) => ok !== true)) throw new Error(`the Gemini process environment after the restart is wrong: ${JSON.stringify(details.envAfterRestart)}`);
  return details;
}

/**
 * K: the Dock icon setting (Settings > General, PC-SET-002). Light is chosen, persists across a Guild restart and is
 * reported as applied by the main process, then dark is chosen again. The Dock itself cannot be read over CDP, so the
 * main process's own record of having set the icon stands for it. Needs no engine.
 */
async function checkK() {
  const details = { issues: [] };
  const readRow = () => cdp.evaluate(`(() => {
    const group = document.querySelector('[data-guild-setting="dock-icon"]');
    if (!group) return null;
    const radios = [...group.querySelectorAll('[data-dock-icon]')].map((button) => {
      const image = button.querySelector("img");
      return { icon: button.getAttribute("data-dock-icon"), checked: button.getAttribute("aria-checked") === "true", role: button.getAttribute("role"), label: (button.textContent || "").trim(), previewLoaded: image !== null && image.complete && image.naturalWidth > 0 };
    });
    return { radios, selected: radios.find((radio) => radio.checked)?.icon ?? null, label: (document.getElementById("guild-dock-icon-label")?.textContent || "").trim() };
  })()`);
  const stored = async () => (await call("bootstrap")).generalSettings.dockIcon;
  /** Scrolls the row into view so a screenshot shows it, then takes the screenshot. */
  const shotRow = async (label) => {
    await cdp.evaluate(`document.querySelector('[data-guild-setting="dock-icon"]')?.scrollIntoView({ block: "center" })`);
    await sleep(300);
    await shot("K", label);
  };
  const dockEvents = () => readLines(join(dataDir, "diagnostics", "runtime.jsonl")).map((entry) => entry.event).filter((event) => typeof event === "string" && event.startsWith("dock_icon"));
  const openRow = async () => {
    await openSettings();
    await clickDom("#guild-settings-tab-general");
    await until("dock icon row", async () => (await readRow()) !== null, { timeout: 10_000 });
    await sleep(400);
    return readRow();
  };
  const closeSettings = async () => {
    await cdp.evaluate(`document.querySelector(".guild-dialog-settings")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(400);
  };

  // 1. The default is dark, both choices are named and previewed.
  const initial = await openRow();
  details.initial = { stored: await stored(), selected: initial.selected, label: initial.label, radios: initial.radios.map((radio) => ({ icon: radio.icon, label: radio.label, role: radio.role, previewLoaded: radio.previewLoaded })) };
  await shotRow("dock-icon-row-default");
  if (details.initial.stored !== "dark" || initial.selected !== "dark") throw new Error(`the default Dock icon is ${details.initial.stored} / ${initial.selected}, expected dark`);
  if (initial.radios.length !== 2 || !/Dark|深色/u.test(initial.radios[0].label) || !/Light|浅色/u.test(initial.radios[1].label) || initial.radios.some((radio) => !radio.previewLoaded || radio.role !== "radio")) {
    throw new Error(`the Dock icon row is wrong: ${JSON.stringify(details.initial)}`);
  }
  const eventsAtStart = dockEvents().length;

  // 2. Light is chosen: saved at once and reported as applied by the main process.
  await clickDom('[data-dock-icon="light"]');
  await until("light saved", async () => (await stored()) === "light", { timeout: 15_000 });
  const light = await readRow();
  details.afterLight = { stored: await stored(), selected: light.selected };
  await shotRow("dock-icon-row-light");
  if (light.selected !== "light") throw new Error(`the row shows ${light.selected} after light was chosen`);
  details.dockEventsAfterLight = dockEvents().slice(eventsAtStart);
  if (!details.dockEventsAfterLight.includes("dock_icon_applied") || details.dockEventsAfterLight.some((event) => event !== "dock_icon_applied")) {
    throw new Error(`the main process did not report the light icon as applied: ${JSON.stringify(details.dockEventsAfterLight)}`);
  }

  // 3. A restart keeps it, and the main process sets it again at startup.
  await closeSettings();
  details.quit = await quitApp();
  await launchApp();
  const expectedBeforeStartup = eventsAtStart + details.dockEventsAfterLight.length;
  await until("dock icon applied at startup", async () => dockEvents().length > expectedBeforeStartup, { timeout: 20_000, interval: 300 }).catch(() => undefined);
  const eventsBeforeStartup = dockEvents();
  details.storedAfterRestart = await stored();
  const restored = await openRow();
  details.afterRestart = { stored: details.storedAfterRestart, selected: restored.selected };
  await shotRow("dock-icon-row-after-restart");
  if (details.storedAfterRestart !== "light" || restored.selected !== "light") throw new Error(`the Dock icon after the restart is ${details.storedAfterRestart} / ${restored.selected}`);
  details.dockEventsAtStartup = eventsBeforeStartup.slice(expectedBeforeStartup);
  if (!details.dockEventsAtStartup.includes("dock_icon_applied")) throw new Error(`the main process did not apply the saved icon at startup: ${JSON.stringify(details.dockEventsAtStartup)}`);

  // 4. Dark again: saved at once and applied.
  const eventsBeforeDark = dockEvents().length;
  await clickDom('[data-dock-icon="dark"]');
  await until("dark saved", async () => (await stored()) === "dark", { timeout: 15_000 });
  const dark = await readRow();
  details.afterDark = { stored: await stored(), selected: dark.selected };
  await shotRow("dock-icon-row-dark-again");
  if (dark.selected !== "dark") throw new Error(`the row shows ${dark.selected} after dark was chosen`);
  details.dockEventsAfterDark = dockEvents().slice(eventsBeforeDark);
  if (!details.dockEventsAfterDark.includes("dock_icon_applied")) throw new Error(`the main process did not report the dark icon as applied: ${JSON.stringify(details.dockEventsAfterDark)}`);
  await closeSettings();
  if (dockEvents().includes("dock_icon_failed") || dockEvents().includes("dock_icon_not_applied")) throw new Error(`the Dock call failed or applied nothing: ${JSON.stringify(dockEvents())}`);
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
  const wanted = new Set(["DEEPSEEK_API_KEY", "QWEN_LOCAL_API_KEY", "GEMINI_API_KEY"]);
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
  const summary = { filesScanned: 0, bytesScanned: 0, keyValueHits: 0, boundarySkHits: 0, boundaryBearerHits: 0, boundaryGoogleKeyHits: 0, literalSkHits: 0, literalBearerHits: 0, literalSkFiles: [], boundaryFiles: [] };
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
      const boundaryGoogle = (text.match(/(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{30,}/gu) ?? []).length;
      summary.boundaryGoogleKeyHits += boundaryGoogle;
      if (boundaryGoogle > 0) summary.boundaryFiles.push(`${root.name}:${path.replace(root.path, "")}`);
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

/** The sessions the Gemini check made live in Guild's own home under the QA data dir; the whole home goes. */
function cleanGeminiHome() {
  const files = geminiChatFiles().length;
  if (!geminiHome.startsWith(`${dataDir}/`)) return { removedChatFiles: 0, skipped: "home is not under the QA data dir" };
  rmSync(geminiHome, { recursive: true, force: true });
  return { removedChatFiles: files };
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
    for (const [id, title] of [["C", "Opus -> DeepSeek -> Opus 5.5, two-way"], ["D", "Opus -> Local model"], ["E", "Browser pane"]]) {
      skip(id, title, "blocked: check B did not pass");
    }
  } else {
    await runCheck("G1", "Reduced capability: usage popover (native session)", () => checkG("G1", "native"));
    await runCheck("C", "Opus -> DeepSeek -> Opus 5.5, two-way: Restarts tags, switching status, env, recall, router proof", checkC);
    await runCheck("D", "Opus -> Local Model 27B (cross-mode, no Online reminder), no duplicated text", checkD);
    await runCheck("E", "Browser pane: navigate, agent tools, take over, resume", checkE);
  }
  await runCheck("F", "Settings: Engines and Model sources tabs", checkF);
  if (state.claudeTaskId !== undefined) await runCheck("G2", "Reduced capability: usage popover (routed session)", () => checkG("G2", "routed"));
  await runCheck("H1", "Claude: permission card clears after a UI approval", () => checkH("H1", "claude", "dom.txt"));
  await runCheck("H2", "Grok: permission card clears after a UI approval", () => checkH("H2", "grok", "dom-grok.txt"));
  if (codexAcpRoot === undefined) skip("I", "Codex", "GUILD_QA_CODEX_ACP is not set");
  else await runCheck("I", "Codex: ChatGPT group, cheapest model, tool turn behind a permission card, model line, restart and resume, sidebar marker, Settings", checkI);
  if (geminiCliRoot === undefined) skip("J", "Gemini", "GUILD_QA_GEMINI_CLI is not set");
  else if (!keyFileNames("GEMINI_API_KEY")) skip("J", "Gemini", "the key file names no GEMINI_API_KEY");
  else await runCheck("J", "Gemini: pay-as-you-go group, cheapest Flash model, tool turn behind a permission card, model line, child environment, restart and session/load, sidebar marker, Settings", checkJ);
  await runCheck("K", "Dock icon setting: light and back to dark, saved, applied by the main process and kept across a restart", checkK);

  const quit = process.env.GUILD_QA_KEEP_APP === "1" ? { stage: "kept" } : await quitApp();
  pageServer?.close();
  const secrets = scanSecrets();
  const removedTranscripts = cleanClaudeTranscripts();
  const removedCodexRollouts = cleanCodexRollouts();
  const removedGemini = cleanGeminiHome();
  const portClosed = !(await portOpen(debugPort));
  const extra = { quit, secrets, removedTranscripts, removedCodexRollouts, removedGemini, portClosed, pageHits };
  writeReport(extra);
  log("secret scan", JSON.stringify({ ...secrets, literalSkFiles: undefined, boundaryFiles: undefined }));
  log("removed claude transcripts", JSON.stringify(removedTranscripts));
  log("removed codex rollouts", JSON.stringify(removedCodexRollouts));
  log("removed gemini home", JSON.stringify(removedGemini));
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
