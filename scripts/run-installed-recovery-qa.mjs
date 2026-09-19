import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const endpoint = process.env.GUILD_CDP_ENDPOINT ?? "http://127.0.0.1:9224";
const appPath = "/Applications/Guild.app";
const executable = `${appPath}/Contents/MacOS/Guild`;
const workspaceName = process.env.GUILD_QA_WORKSPACE ?? "Cowork";

let taskId;
let connection;
try {
  connection = await connectGuild();
  const bootstrap = await connection.call("bootstrap", {});
  const workspace = bootstrap.workspaces.find((candidate) => candidate.name === workspaceName);
  if (workspace === undefined) throw new Error(`guild_workspace_missing:${workspaceName}`);
  await connection.call("setRuntimeSettings", {
    model: "grok-4.6",
    reasoningEffort: "xhigh",
    permissionMode: "bypassPermissions",
    startup: bootstrap.runtimeSettings.startup,
  });

  const created = await connection.call("createTask", { workspaceId: workspace.workspaceId });
  taskId = created.task.taskId;
  const active = await connection.call("sendMessage", {
    taskId,
    text: "这是 Guild 异常恢复验收。必须使用终端工具执行 `sleep 90`；命令结束后只回复 RECOVERY-QA-SHOULD-NOT-COMPLETE。",
  });
  if (active.status !== "started") throw new Error(`guild_recovery_active_not_started:${JSON.stringify(active)}`);
  await waitForTask(connection, taskId, "active-tool", (view) =>
    view.task.activeRunState === "running" &&
    view.timeline.some((item) => item.kind === "tool" && item.runId === active.runId),
    120_000,
  );

  const appPid = await guildPid();
  const oldRuntimePids = await childPids(appPid);
  console.log("guild_installed_qa_recovery_kill", JSON.stringify({ taskId, activeRunId: active.runId, appPid, oldRuntimePids }));
  connection.close();
  connection = undefined;
  process.kill(appPid, "SIGKILL");
  await waitFor(() => processMissing(appPid), 15_000, "guild_process_survived_sigkill");
  await waitFor(() => endpointUnavailable(), 15_000, "guild_cdp_survived_sigkill");

  const childExitDeadline = Date.now() + 15_000;
  while (Date.now() < childExitDeadline && oldRuntimePids.some((pid) => processExists(pid))) {
    await delay(100);
  }
  const leakedRuntimePids = oldRuntimePids.filter((pid) => processExists(pid));
  if (leakedRuntimePids.length > 0) {
    throw new Error(`guild_recovery_orphaned_runtime:${JSON.stringify(leakedRuntimePids)}`);
  }

  await launchGuildInBackground();
  await waitFor(() => endpointAvailable(), 30_000, "guild_recovery_cdp_missing");
  connection = await connectGuild();
  const recovered = await waitForTask(connection, taskId, "interrupted", (view) =>
    view.task.activeRunState === "interrupted" && view.canSend,
    30_000,
  );
  const interruptedEvidence = recovered.timeline.some(
    (item) => item.runId === active.runId && item.status === "interrupted",
  );
  if (!interruptedEvidence) throw new Error("guild_recovery_interrupted_evidence_missing");

  const continued = await connection.call("sendMessage", {
    taskId,
    text: "不要使用工具，只回复 RECOVERY-QA-OK。",
  });
  if (continued.status !== "started") throw new Error(`guild_recovery_continue_not_started:${JSON.stringify(continued)}`);
  const completed = await waitForTask(connection, taskId, "continued", (view) =>
    view.task.activeRunState === "completed" &&
    view.timeline.some((item) => item.kind === "assistant" && item.text.includes("RECOVERY-QA-OK")),
    120_000,
  );
  const leakedCompletion = completed.timeline.some(
    (item) => item.kind === "assistant" && item.text.includes("RECOVERY-QA-SHOULD-NOT-COMPLETE"),
  );
  if (leakedCompletion) throw new Error("guild_recovery_cancelled_run_completed");
  console.log("guild_installed_qa_recovery_complete", JSON.stringify({
    taskId,
    activeRunId: active.runId,
    continuedRunId: continued.runId,
    interruptedEvidence,
    leakedRuntimePids,
  }));
} finally {
  if (connection === undefined) {
    if (!(await endpointAvailable())) {
      await launchGuildInBackground().catch(() => undefined);
      await waitFor(() => endpointAvailable(), 30_000, "guild_cleanup_cdp_missing").catch(() => undefined);
    }
    connection = await connectGuild().catch(() => undefined);
  }
  if (connection !== undefined && taskId !== undefined) {
    await stopTaskIfRunning(connection, taskId).catch((error) => {
      console.warn("guild_installed_qa_recovery_cleanup_stop_failed", String(error));
    });
    await connection.call("updateTask", { taskId, action: "archive" }).catch((error) => {
      console.warn("guild_installed_qa_recovery_cleanup_archive_failed", String(error));
    });
  }
  connection?.close();
}

async function connectGuild() {
  const deadline = Date.now() + 30_000;
  let page;
  while (Date.now() < deadline && page?.webSocketDebuggerUrl === undefined) {
    try {
      const pages = await fetch(`${endpoint}/json/list`).then((response) => response.json());
      page = pages.find((candidate) => candidate.type === "page" && candidate.title === "Guild");
    } catch {
      // The debugging socket can open before Electron has registered its page.
    }
    if (page?.webSocketDebuggerUrl === undefined) await delay(100);
  }
  if (page?.webSocketDebuggerUrl === undefined) throw new Error("guild_cdp_page_missing");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const operation = pending.get(message.id);
    if (operation === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) operation.reject(new Error(JSON.stringify(message.error)));
    else operation.resolve(message.result);
  });
  const send = (method, params = {}) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  };
  await send("Runtime.enable");
  return {
    call: async (method, argument) => {
      const result = await send("Runtime.evaluate", {
        expression: `window.guild.${method}(${JSON.stringify(argument)})`,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.exception?.description ?? "guild_cdp_evaluation_failed");
      }
      return result.result.value;
    },
    close: () => socket.close(),
  };
}

async function waitForTask(api, taskId, label, predicate, waitMs) {
  const deadline = Date.now() + waitMs;
  let previous = "";
  while (Date.now() < deadline) {
    const view = await api.call("openTask", { taskId });
    const summary = JSON.stringify({
      label,
      state: view.task.activeRunState ?? "none",
      canSend: view.canSend,
      kinds: Object.fromEntries(
        [...new Set(view.timeline.map((item) => item.kind))]
          .map((kind) => [kind, view.timeline.filter((item) => item.kind === kind).length]),
      ),
    });
    if (summary !== previous) {
      console.log("guild_installed_qa_recovery_progress", summary);
      previous = summary;
    }
    if (predicate(view)) return view;
    await delay(250);
  }
  throw new Error(`guild_recovery_timeout:${label}`);
}

async function stopTaskIfRunning(api, taskId) {
  const view = await api.call("openTask", { taskId });
  if (["completed", "failed", "cancelled", "interrupted", undefined].includes(view.task.activeRunState)) return;
  const runId = [...view.timeline]
    .reverse()
    .find((item) => item.runId !== undefined && ["streaming", "waiting"].includes(item.status))
    ?.runId;
  if (runId === undefined) return;
  await api.call("cancelRun", { taskId, runId });
  await waitForTask(api, taskId, "cleanup-terminal", (next) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(next.task.activeRunState ?? ""),
    30_000,
  );
}

async function guildPid() {
  const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-f", `^${executable}`]);
  const pid = Number.parseInt(stdout.trim().split(/\s+/u)[0] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("guild_process_missing");
  return pid;
}

async function childPids(parentPid) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-P", String(parentPid)]);
    return stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10)).filter(Number.isSafeInteger);
  } catch {
    return [];
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processMissing(pid) {
  return !processExists(pid);
}

async function endpointAvailable() {
  try {
    const response = await fetch(`${endpoint}/json/list`);
    return response.ok;
  } catch {
    return false;
  }
}

async function endpointUnavailable() {
  return !(await endpointAvailable());
}

async function launchGuildInBackground() {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", "-na", appPath, "--args", "--remote-debugging-port=9224"], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`guild_open_failed:${code}`)));
  });
}

async function waitFor(predicate, waitMs, errorCode) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(errorCode);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
