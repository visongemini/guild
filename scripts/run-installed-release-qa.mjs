import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const endpoint = process.env.GUILD_CDP_ENDPOINT ?? "http://127.0.0.1:9224";
const workspaceName = process.env.GUILD_QA_WORKSPACE ?? "Cowork";
const qaRoot = process.env.GUILD_QA_ROOT ?? "Guild-Release-QA-20260829";
const timeoutMs = Number.parseInt(process.env.GUILD_QA_TASK_TIMEOUT_MS ?? "600000", 10);
const quickMode = process.env.GUILD_QA_QUICK === "1";
const inspectOnly = process.env.GUILD_QA_INSPECT_ONLY === "1";
const scrollOnly = process.env.GUILD_QA_SCROLL_ONLY === "1";
const resizeOnly = process.env.GUILD_QA_RESIZE_ONLY === "1";
const accessibilityOnly = process.env.GUILD_QA_ACCESSIBILITY_ONLY === "1";
const workbenchOnly = process.env.GUILD_QA_WORKBENCH_ONLY === "1";
const preemptOnly = process.env.GUILD_QA_PREEMPT_ONLY === "1";
const concurrencyOnly = process.env.GUILD_QA_CONCURRENCY_ONLY === "1";
const focusOnly = process.env.GUILD_QA_FOCUS_ONLY === "1";
const archiveTaskIds = (process.env.GUILD_QA_ARCHIVE_TASK_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const followUpTaskId = process.env.GUILD_QA_FOLLOWUP_TASK_ID?.trim();
const followUpPrompt = process.env.GUILD_QA_FOLLOWUP_PROMPT?.trim() ||
  "请在同一会话中重新读取你刚生成的 summary.json 和 report.md，确认 sourceUrl、数字字段、许可证和 Markdown 内容一致；不要修改文件。验证成功只在结论末尾加 SITE-DATA-FOLLOWUP-OK。";

const pages = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const page = pages.find((candidate) => candidate.type === "page" && candidate.title === "Guild");
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

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? "guild_cdp_evaluation_failed");
  }
  return result.result.value;
}

function call(method, argument) {
  return evaluate(`window.guild.${method}(${JSON.stringify(argument)})`);
}

await send("Runtime.enable");
const bootstrap = await call("bootstrap", {});
const workspace = bootstrap.workspaces.find((candidate) => candidate.name === workspaceName);
if (workspace === undefined) throw new Error(`guild_workspace_missing:${workspaceName}`);

if (archiveTaskIds.length > 0) {
  for (const taskId of archiveTaskIds) {
    await call("updateTask", { taskId, action: "archive" });
  }
  console.log("guild_installed_qa_archived", JSON.stringify(archiveTaskIds));
  socket.close();
  process.exit(0);
}

if (accessibilityOnly) {
  await evaluate(`(() => {
    const profile = document.querySelector('.guild-profile');
    if (!(profile instanceof HTMLButtonElement)) return false;
    profile.click();
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const accountOpen = await evaluate(`(() => ({
    popover: document.querySelector('.guild-account-popover') !== null,
    activeInside: document.activeElement?.closest('.guild-account-popover') !== null,
    activeText: document.activeElement?.textContent?.trim() ?? '',
  }))()`);
  if (!accountOpen.popover || !accountOpen.activeInside) {
    throw new Error(`guild_account_focus_missing:${JSON.stringify(accountOpen)}`);
  }
  await evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const accountClosed = await evaluate(`(() => ({
    popover: document.querySelector('.guild-account-popover') !== null,
    profileFocused: document.activeElement?.classList.contains('guild-profile') ?? false,
  }))()`);
  if (accountClosed.popover || !accountClosed.profileFocused) {
    throw new Error(`guild_account_escape_failed:${JSON.stringify(accountClosed)}`);
  }
  await evaluate(`document.querySelector('.guild-profile-settings')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await evaluate(`(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (!(tab instanceof HTMLButtonElement)) return false;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const settingsTabs = await evaluate(`(() => {
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    return {
      selectedText: selected?.textContent?.trim() ?? '',
      selectedFocused: document.activeElement === selected,
      tabStops: [...document.querySelectorAll('[role="tab"]')].filter((tab) => tab.tabIndex === 0).length,
      panelCount: panels.length,
      panelLabelledBy: panels[0]?.getAttribute('aria-labelledby') ?? '',
      selectedId: selected?.id ?? '',
    };
  })()`);
  if (
    settingsTabs.selectedText !== "Grok" ||
    !settingsTabs.selectedFocused ||
    settingsTabs.tabStops !== 1 ||
    settingsTabs.panelCount !== 1 ||
    settingsTabs.panelLabelledBy !== settingsTabs.selectedId
  ) {
    throw new Error(`guild_settings_tab_keyboard_failed:${JSON.stringify(settingsTabs)}`);
  }
  await evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  console.log("guild_installed_qa_accessibility", JSON.stringify({ accountOpen, accountClosed, settingsTabs }));
  socket.close();
  process.exit(0);
}

if (workbenchOnly) {
  const opened = await evaluate(`(async () => {
    const toggle = document.querySelector('.guild-top-actions .guild-icon-button');
    if (!(toggle instanceof HTMLButtonElement) || toggle.disabled) return null;
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const shell = document.querySelector('.guild-shell');
    const sidebar = document.querySelector('.guild-sidebar');
    const main = document.querySelector('.guild-main');
    const panel = document.querySelector('.guild-workbench');
    const separator = document.querySelector('.guild-workbench-resizer');
    if (!(shell instanceof HTMLElement) || !(sidebar instanceof HTMLElement) || !(main instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(separator instanceof HTMLElement)) return null;
    const sidebarRect = sidebar.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const beforeWidth = Number(separator.getAttribute('aria-valuenow'));
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterWidth = Number(separator.getAttribute('aria-valuenow'));
    return {
      openClass: shell.classList.contains('workbench-open'),
      columns: getComputedStyle(shell).gridTemplateColumns,
      panelPosition: getComputedStyle(panel).position,
      sidebarMainGap: Math.abs(sidebarRect.right - mainRect.left),
      mainPanelGap: Math.abs(mainRect.right - panelRect.left),
      beforeWidth,
      afterWidth,
      storedWidth: window.localStorage.getItem('guild:v1:workbench-width'),
    };
  })()`);
  if (
    opened === null ||
    !opened.openClass ||
    opened.panelPosition === "absolute" ||
    opened.sidebarMainGap > 1 ||
    opened.mainPanelGap > 1 ||
    !(opened.afterWidth > opened.beforeWidth) ||
    opened.storedWidth !== String(opened.afterWidth)
  ) {
    throw new Error(`guild_installed_workbench_failed:${JSON.stringify(opened)}`);
  }
  const restored = await evaluate(`(async () => {
    const separator = document.querySelector('.guild-workbench-resizer');
    if (!(separator instanceof HTMLElement)) return null;
    separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      width: Number(separator.getAttribute('aria-valuenow')),
      storedWidth: window.localStorage.getItem('guild:v1:workbench-width'),
    };
  })()`);
  if (restored === null || restored.width !== opened.beforeWidth || restored.storedWidth !== String(opened.beforeWidth)) {
    throw new Error(`guild_installed_workbench_restore_failed:${JSON.stringify({ opened, restored })}`);
  }
  const closed = await evaluate(`(async () => {
    const toggle = document.querySelector('.guild-top-actions .guild-icon-button');
    if (!(toggle instanceof HTMLButtonElement)) return null;
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const shell = document.querySelector('.guild-shell');
    return shell instanceof HTMLElement ? {
      openClass: shell.classList.contains('workbench-open'),
      panelPresent: document.querySelector('.guild-workbench') !== null,
      columns: getComputedStyle(shell).gridTemplateColumns,
    } : null;
  })()`);
  if (closed === null || closed.openClass || closed.panelPresent || closed.columns.trim().split(/\s+/u).length !== 2) {
    throw new Error(`guild_installed_workbench_close_failed:${JSON.stringify(closed)}`);
  }
  console.log("guild_installed_qa_workbench", JSON.stringify({ opened, restored, closed }));
  socket.close();
  process.exit(0);
}

if (scrollOnly) {
  let before;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    before = await evaluate(`(() => {
      const pane = document.querySelector('.guild-conversation');
      if (!(pane instanceof HTMLElement)) return null;
      if (pane.scrollHeight <= pane.clientHeight + 120) return null;
      pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight - 120);
      pane.dispatchEvent(new Event('scroll'));
      return { scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight, clientHeight: pane.clientHeight };
    })()`);
    if (before !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (before === null || before === undefined) throw new Error("guild_conversation_not_scrollable");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = await evaluate(`(() => {
    const pane = document.querySelector('.guild-conversation');
    return pane instanceof HTMLElement ? { scrollTop: pane.scrollTop, scrollHeight: pane.scrollHeight } : null;
  })()`);
  if (after === null || Math.abs(after.scrollTop - before.scrollTop) > 1) {
    throw new Error(`guild_streaming_scroll_jump:${JSON.stringify({ before, after })}`);
  }
  console.log("guild_installed_qa_scroll", JSON.stringify({ before, after }));
  socket.close();
  process.exit(0);
}

if (resizeOnly) {
  const before = await evaluate(`(() => {
    const separator = document.querySelector('.guild-sidebar-resizer');
    const sidebar = document.querySelector('.guild-sidebar');
    if (!(separator instanceof HTMLElement) || !(sidebar instanceof HTMLElement)) return null;
    const rect = separator.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: sidebar.getBoundingClientRect().width };
  })()`);
  if (before === null) throw new Error("guild_sidebar_resizer_missing");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x, y: before.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.x, y: before.y, button: "left", buttons: 1, clickCount: 1 });
  for (let offset = 8; offset <= 48; offset += 8) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x + offset, y: before.y, button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.x + 48, y: before.y, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = await evaluate(`(() => {
    const separator = document.querySelector('.guild-sidebar-resizer');
    const sidebar = document.querySelector('.guild-sidebar');
    return separator instanceof HTMLElement && sidebar instanceof HTMLElement
      ? { width: sidebar.getBoundingClientRect().width, ariaValue: separator.getAttribute('aria-valuenow') }
      : null;
  })()`);
  if (after === null || after.width < before.width + 40) {
    throw new Error(`guild_sidebar_resize_failed:${JSON.stringify({ before, after })}`);
  }
  const restoreRect = await evaluate(`(() => {
    const separator = document.querySelector('.guild-sidebar-resizer');
    if (!(separator instanceof HTMLElement)) return null;
    const rect = separator.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (restoreRect === null) throw new Error("guild_sidebar_restore_resizer_missing");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: restoreRect.x, y: restoreRect.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: restoreRect.x, y: restoreRect.y, button: "left", buttons: 1, clickCount: 1 });
  for (let offset = 8; offset <= 48; offset += 8) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: restoreRect.x - offset, y: restoreRect.y, button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: restoreRect.x - 48, y: restoreRect.y, button: "left", buttons: 0, clickCount: 1 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const restored = await evaluate(`(() => {
    const sidebar = document.querySelector('.guild-sidebar');
    return sidebar instanceof HTMLElement ? { width: sidebar.getBoundingClientRect().width } : null;
  })()`);
  if (restored === null || Math.abs(restored.width - before.width) > 2) {
    throw new Error(`guild_sidebar_resize_restore_failed:${JSON.stringify({ before, after, restored })}`);
  }
  console.log("guild_installed_qa_resize", JSON.stringify({ before, after, restored }));
  socket.close();
  process.exit(0);
}

if (inspectOnly) {
  const buttonText = await evaluate(
    `document.querySelector('.guild-context-usage')?.textContent?.trim() ?? ''`,
  );
  let detailText = await evaluate(
    `document.querySelector('.guild-context-usage-detail')?.textContent?.trim() ?? ''`,
  );
  if (detailText.length === 0) {
    await evaluate(`(() => {
    const button = document.querySelector('.guild-context-usage');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    detailText = await evaluate(
      `document.querySelector('.guild-context-usage-detail')?.textContent?.trim() ?? ''`,
    );
  }
  const context = { buttonText, detailText };
  console.log("guild_installed_qa_context", JSON.stringify({
    ...context,
    projection: bootstrap.activeTask?.contextWindow ?? null,
    taskId: bootstrap.activeTask?.task.taskId ?? null,
  }));
  if (!context.buttonText.includes("%")) throw new Error(`guild_context_percentage_missing:${context.buttonText}`);
  if (context.detailText.length === 0) throw new Error("guild_context_detail_missing");
  socket.close();
  process.exit(0);
}

const configured = await call("setRuntimeSettings", {
  model: "grok-4.6",
  reasoningEffort: "xhigh",
  permissionMode: "bypassPermissions",
  startup: bootstrap.runtimeSettings.startup,
});
if (configured.runtimeSettings.permissionMode !== "bypassPermissions") {
  throw new Error("guild_full_access_not_applied");
}
console.log("guild_installed_qa_settings", JSON.stringify(configured.runtimeSettings));

if (focusOnly) {
  let taskId;
  const originalFrontmost = await frontmostApplication();
  if (originalFrontmost.bundleId === "" || originalFrontmost.bundleId === "app.guild.desktop.v2") {
    throw new Error(`guild_focus_neutral_app_missing:${JSON.stringify(originalFrontmost)}`);
  }
  const observedFrontmost = new Set();
  let sampleCount = 0;
  try {
    const created = await call("createTask", { workspaceId: workspace.workspaceId });
    taskId = created.task.taskId;
    const sent = await call("sendMessage", {
      taskId,
      text: "这是 Guild 后台焦点验收。必须使用终端工具执行 `sleep 20`；结束后只回复 FOCUS-QA-OK。",
    });
    if (sent.status !== "started") throw new Error(`guild_focus_not_started:${JSON.stringify(sent)}`);
    await waitForTask(taskId, "focus-tool", (view) =>
      view.task.activeRunState === "running" &&
      view.timeline.some((item) => item.kind === "tool" && item.runId === sent.runId),
      120_000,
    );

    await waitForFrontmost(originalFrontmost.bundleId, 10_000);
    const deadline = Date.now() + 120_000;
    let completed = false;
    while (Date.now() < deadline) {
      const frontmost = await frontmostApplication();
      sampleCount += 1;
      observedFrontmost.add(`${frontmost.name}:${frontmost.bundleId}`);
      if (frontmost.bundleId === "app.guild.desktop.v2") {
        throw new Error(`guild_focus_stolen:${JSON.stringify({ sampleCount, frontmost })}`);
      }
      const view = await call("openTask", { taskId });
      if (["failed", "cancelled", "interrupted"].includes(view.task.activeRunState ?? "")) {
        throw new Error(`guild_focus_task_failed:${view.task.activeRunState}`);
      }
      if (
        view.task.activeRunState === "completed" &&
        view.timeline.some((item) => item.kind === "assistant" && item.text.includes("FOCUS-QA-OK"))
      ) {
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!completed) throw new Error("guild_focus_task_timeout");

    const notificationDeadline = Date.now() + 2_500;
    while (Date.now() < notificationDeadline) {
      const frontmost = await frontmostApplication();
      sampleCount += 1;
      observedFrontmost.add(`${frontmost.name}:${frontmost.bundleId}`);
      if (frontmost.bundleId === "app.guild.desktop.v2") {
        throw new Error(`guild_focus_stolen_after_completion:${JSON.stringify({ sampleCount, frontmost })}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log("guild_installed_qa_focus_complete", JSON.stringify({
      taskId,
      sampleCount,
      originalFrontmost,
      observedFrontmost: [...observedFrontmost],
    }));
  } finally {
    if (taskId !== undefined) {
      await stopTaskIfRunning(taskId).catch((error) => {
        console.warn("guild_installed_qa_focus_cleanup_stop_failed", String(error));
      });
      await call("updateTask", { taskId, action: "archive" }).catch((error) => {
        console.warn("guild_installed_qa_focus_cleanup_archive_failed", String(error));
      });
    }
    if (originalFrontmost.bundleId !== "" && originalFrontmost.bundleId !== "app.guild.desktop.v2") {
      await activateApplication(originalFrontmost.bundleId).catch((error) => {
        console.warn("guild_installed_qa_focus_restore_failed", String(error));
      });
    }
  }
  socket.close();
  process.exit(0);
}

if (preemptOnly) {
  let taskId;
  try {
    const created = await call("createTask", { workspaceId: workspace.workspaceId });
    taskId = created.task.taskId;
    console.log("guild_installed_qa_preempt_task_created", JSON.stringify({ taskId }));

    const active = await call("sendMessage", {
      taskId,
      text: "这是 Guild 插队验收。必须使用终端工具执行 `sleep 90`；命令结束后只回复 ACTIVE-QA-SHOULD-NOT-COMPLETE。",
    });
    if (active.status !== "started") throw new Error(`guild_preempt_active_not_started:${JSON.stringify(active)}`);

    await waitForTask(taskId, "active-tool", (view) =>
      view.task.activeRunState === "running" &&
      view.timeline.some((item) => item.kind === "tool" && item.runId === active.runId),
      120_000,
    );

    const older = await call("sendMessage", {
      taskId,
      text: "不要使用工具，只回复 OLDER-QA-OK。",
    });
    const selected = await call("sendMessage", {
      taskId,
      text: "不要使用工具，只回复 PREEMPT-QA-OK。",
    });
    if (older.status !== "queued" || selected.status !== "queued") {
      throw new Error(`guild_preempt_queue_missing:${JSON.stringify({ older, selected })}`);
    }

    const queued = await call("openTask", { taskId });
    if (
      queued.queuedTurns.length !== 2 ||
      queued.queuedTurns[0]?.queueId !== older.queueId ||
      queued.queuedTurns[1]?.queueId !== selected.queueId
    ) {
      throw new Error(`guild_preempt_initial_order_wrong:${JSON.stringify(queued.queuedTurns)}`);
    }

    await call("preemptQueuedTurn", { taskId, queueId: selected.queueId });
    const completed = await waitForTask(taskId, "preempt-complete", (view) => {
      const assistant = view.timeline
        .filter((item) => item.kind === "assistant")
        .map((item) => item.text);
      return assistant.some((text) => text.includes("PREEMPT-QA-OK")) &&
        assistant.some((text) => text.includes("OLDER-QA-OK")) &&
        ["completed", "failed", "cancelled", "interrupted"].includes(view.task.activeRunState ?? "");
    }, 180_000);

    const assistant = completed.timeline.filter((item) => item.kind === "assistant");
    const selectedIndex = assistant.findIndex((item) => item.text.includes("PREEMPT-QA-OK"));
    const olderIndex = assistant.findIndex((item) => item.text.includes("OLDER-QA-OK"));
    const activeLeaked = assistant.some((item) => item.text.includes("ACTIVE-QA-SHOULD-NOT-COMPLETE"));
    const cancelledEvidence = completed.timeline.some(
      (item) => item.runId === active.runId && item.status === "cancelled",
    );
    if (selectedIndex < 0 || olderIndex < 0 || selectedIndex >= olderIndex || activeLeaked || !cancelledEvidence) {
      throw new Error(`guild_preempt_semantics_failed:${JSON.stringify({
        selectedIndex,
        olderIndex,
        activeLeaked,
        cancelledEvidence,
      })}`);
    }
    console.log("guild_installed_qa_preempt_complete", JSON.stringify({
      taskId,
      activeRunId: active.runId,
      selectedIndex,
      olderIndex,
      cancelledEvidence,
    }));
  } finally {
    if (taskId !== undefined) {
      await stopTaskIfRunning(taskId).catch((error) => {
        console.warn("guild_installed_qa_preempt_cleanup_stop_failed", String(error));
      });
      await call("updateTask", { taskId, action: "archive" }).catch((error) => {
        console.warn("guild_installed_qa_preempt_cleanup_archive_failed", String(error));
      });
    }
  }
  socket.close();
  process.exit(0);
}

if (concurrencyOnly) {
  const tasks = [];
  try {
    for (let index = 1; index <= 3; index += 1) {
      const created = await call("createTask", { workspaceId: workspace.workspaceId });
      const taskId = created.task.taskId;
      const marker = `PARALLEL-QA-${index}-OK`;
      const sent = await call("sendMessage", {
        taskId,
        text: `这是 Guild 三并发验收 ${index}。必须使用终端工具执行 \`sleep 45\`；结束后只回复 ${marker}。`,
      });
      if (sent.status !== "started") throw new Error(`guild_concurrency_not_started:${index}:${JSON.stringify(sent)}`);
      tasks.push({ taskId, marker, runId: sent.runId });
    }

    const initial = await call("bootstrap", {});
    const initialOrder = relativeTaskOrder(initial, workspace.workspaceId, tasks.map((task) => task.taskId));
    if (initialOrder.length !== 3) throw new Error(`guild_concurrency_sidebar_missing:${JSON.stringify(initialOrder)}`);

    const deadline = Date.now() + 180_000;
    let sawAllRunning = false;
    let previous = "";
    while (Date.now() < deadline) {
      const views = await Promise.all(tasks.map((task) => call("openTask", { taskId: task.taskId })));
      const current = await call("bootstrap", {});
      const currentOrder = relativeTaskOrder(current, workspace.workspaceId, tasks.map((task) => task.taskId));
      if (JSON.stringify(currentOrder) !== JSON.stringify(initialOrder)) {
        throw new Error(`guild_concurrency_sidebar_reordered:${JSON.stringify({ initialOrder, currentOrder })}`);
      }
      const states = views.map((view) => view.task.activeRunState ?? "none");
      const allRunning = states.every((state) => ["starting", "running", "cancel_requested"].includes(state));
      if (allRunning && !sawAllRunning) {
        sawAllRunning = true;
        console.log("guild_installed_qa_concurrency_all_running", JSON.stringify({
          taskIds: tasks.map((task) => task.taskId),
          states,
          initialOrder,
        }));
      }
      const summary = JSON.stringify({ states, currentOrder });
      if (summary !== previous) {
        console.log("guild_installed_qa_concurrency_progress", summary);
        previous = summary;
      }
      if (states.every((state) => ["completed", "failed", "cancelled", "interrupted"].includes(state))) {
        if (!states.every((state) => state === "completed")) {
          throw new Error(`guild_concurrency_terminal_failure:${JSON.stringify(states)}`);
        }
        for (let index = 0; index < tasks.length; index += 1) {
          const own = tasks[index];
          const assistantText = views[index].timeline
            .filter((item) => item.kind === "assistant")
            .map((item) => item.text)
            .join("\n");
          if (!assistantText.includes(own.marker)) {
            throw new Error(`guild_concurrency_marker_missing:${own.marker}`);
          }
          const foreign = tasks.filter((task) => task.taskId !== own.taskId && assistantText.includes(task.marker));
          if (foreign.length > 0) {
            throw new Error(`guild_concurrency_cross_talk:${own.taskId}:${foreign.map((task) => task.marker).join(",")}`);
          }
        }
        if (!sawAllRunning) throw new Error("guild_concurrency_never_overlapped");
        console.log("guild_installed_qa_concurrency_complete", JSON.stringify({
          taskIds: tasks.map((task) => task.taskId),
          initialOrder,
          sawAllRunning,
        }));
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!sawAllRunning) throw new Error("guild_concurrency_timeout");
  } finally {
    for (const task of tasks) {
      await stopTaskIfRunning(task.taskId).catch((error) => {
        console.warn("guild_installed_qa_concurrency_cleanup_stop_failed", task.taskId, String(error));
      });
      await call("updateTask", { taskId: task.taskId, action: "archive" }).catch((error) => {
        console.warn("guild_installed_qa_concurrency_cleanup_archive_failed", task.taskId, String(error));
      });
    }
  }
  socket.close();
  process.exit(0);
}

if (followUpTaskId !== undefined && followUpTaskId.length > 0) {
  await call("openTask", { taskId: followUpTaskId });
  await call("sendMessage", {
    taskId: followUpTaskId,
    text: followUpPrompt,
  });
  const result = await waitForTerminal(followUpTaskId, "site-data-follow-up");
  console.log("guild_installed_qa_follow_up_complete", JSON.stringify({ taskId: followUpTaskId, result }));
  socket.close();
  process.exit(0);
}

const tasks = quickMode ? [
  {
    name: "streaming-ui",
    prompt: "不要使用工具。分 30 个短段连续输出，每段编号并写一句中文，用于流式滚动性能测试。",
  },
] : [
  {
    name: "site-data",
    prompt: `只在当前 Cowork 工作区的 ${qaRoot}/site-data 目录内工作，不要改动其他任何文件。创建目录后，用 curl 从 https://api.github.com/repos/nodejs/node 获取公开仓库数据并保存 raw.json。编写 dependency-free 的 normalize.mjs，严格校验并提取 id、name、full_name、html_url、stargazers_count、open_issues_count、default_branch、license.spdx_id，生成带 sourceUrl 和 fetchedAt 的 summary.json 与 report.md。再用固定本地 fixture 编写 node:test 测试，覆盖正常输入、缺字段、错误类型和未知许可证；运行测试并实际生成产物。最后明确回复 SITE-DATA-QA-OK，并列出测试结果。`,
    followUp: "请在同一会话中重新读取刚生成的 summary.json 和 report.md，确认 sourceUrl、数字字段、许可证和 Markdown 内容一致；不要修改文件。验证成功只在结论末尾加 SITE-DATA-FOLLOWUP-OK。",
  },
  {
    name: "program",
    prompt: `只在当前 Cowork 工作区的 ${qaRoot}/program 目录内工作，不要改动其他任何文件。构建一个 dependency-free Node.js CLI：issue-summary.mjs。它读取 GitHub issues 风格的 JSON 数组，严格校验 number/title/state/labels/created_at，按状态和标签聚合，按 number 排序，并同时输出 summary.json 与 report.md。提供 package.json、README.md、fixtures 和至少 5 个 node:test 测试，覆盖空数组、非法 JSON、缺字段、标签聚合和稳定排序；运行全部测试，再用 fixture 实际生成输出。最后明确回复 PROGRAM-QA-OK，并列出测试结果。`,
  },
  {
    name: "dashboard",
    prompt: `只在当前 Cowork 工作区的 ${qaRoot}/dashboard 目录内写文件；允许只读 ${qaRoot}/site-data/summary.json。构建 dependency-free 的 build-dashboard.mjs，把仓库摘要生成一份可离线打开的 index.html 和 styles.css。HTML 必须有 main/header/section 语义结构、清晰的中英文标题、数字卡片、来源链接、生成时间，并正确转义所有数据；不得使用外链脚本、字体或图片。编写 node:test 验证转义、缺字段失败、无外部资源、关键可访问性结构和确定性输出，然后运行测试与生成命令。最后明确回复 DASHBOARD-QA-OK，并列出测试结果。`,
  },
];

const results = [];
for (const specification of tasks) {
  const created = await call("createTask", { workspaceId: workspace.workspaceId });
  const taskId = created.task.taskId;
  console.log("guild_installed_qa_task_created", JSON.stringify({ name: specification.name, taskId }));
  await call("sendMessage", { taskId, text: specification.prompt });
  const first = await waitForTerminal(taskId, specification.name);
  if (specification.followUp !== undefined) {
    await call("sendMessage", { taskId, text: specification.followUp });
    await waitForTerminal(taskId, `${specification.name}-follow-up`);
  }
  results.push({ name: specification.name, taskId, first });
}

const finalBootstrap = await call("bootstrap", {});
console.log("guild_installed_qa_complete", JSON.stringify({
  runtimeSettings: finalBootstrap.runtimeSettings,
  results,
}));
socket.close();

async function waitForTerminal(taskId, label) {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let observedRunningIndicator = false;
  while (Date.now() < deadline) {
    const view = await call("openTask", { taskId });
    const ui = await evaluate(`(() => ({
      runningIndicators: document.querySelectorAll('.guild-task-state.running').length,
      openActivityGroups: document.querySelectorAll('details.guild-activity[open]').length,
      contextText: document.querySelector('.guild-context-usage')?.textContent?.trim() ?? '',
    }))()`);
    observedRunningIndicator ||= ui.runningIndicators > 0;
    if (ui.openActivityGroups !== 0) {
      throw new Error(`guild_thought_activity_open_by_default:${label}`);
    }
    const counts = Object.fromEntries(
      [...new Set(view.timeline.map((item) => item.kind))]
        .map((kind) => [kind, view.timeline.filter((item) => item.kind === kind).length]),
    );
    const permissions = view.timeline.filter((item) => item.kind === "permission");
    if (permissions.length > 0) throw new Error(`guild_full_access_prompted:${label}`);
    const assistant = view.timeline.filter((item) => item.kind === "assistant").at(-1)?.text ?? "";
    const status = view.task.activeRunState ?? "none";
    const summary = JSON.stringify({ label, status, counts, assistantTail: assistant.slice(-160) });
    if (summary !== previous) {
      console.log("guild_installed_qa_progress", summary);
      previous = summary;
    }
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      if (status !== "completed") throw new Error(`guild_task_terminal:${label}:${status}`);
      if (!observedRunningIndicator) throw new Error(`guild_running_indicator_missing:${label}`);
      if (!ui.contextText.includes("%")) throw new Error(`guild_context_percentage_missing:${label}:${ui.contextText}`);
      let contextDetail = await evaluate(
        `document.querySelector('.guild-context-usage-detail')?.textContent?.trim() ?? ''`,
      );
      if (contextDetail.length === 0) {
        await evaluate(`(() => {
          const button = document.querySelector('.guild-context-usage');
          if (!(button instanceof HTMLButtonElement)) return false;
          button.click();
          return true;
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 50));
        contextDetail = await evaluate(
          `document.querySelector('.guild-context-usage-detail')?.textContent?.trim() ?? ''`,
        );
      }
      if (contextDetail.length === 0) throw new Error(`guild_context_detail_missing:${label}`);
      return { status, counts, assistant, ui: { ...ui, contextDetail } };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`guild_task_timeout:${label}`);
}

async function waitForTask(taskId, label, predicate, waitMs) {
  const deadline = Date.now() + waitMs;
  let previous = "";
  while (Date.now() < deadline) {
    const view = await call("openTask", { taskId });
    const summary = JSON.stringify({
      label,
      state: view.task.activeRunState ?? "none",
      queued: view.queuedTurns.map((turn) => turn.text),
      timeline: Object.fromEntries(
        [...new Set(view.timeline.map((item) => item.kind))]
          .map((kind) => [kind, view.timeline.filter((item) => item.kind === kind).length]),
      ),
    });
    if (summary !== previous) {
      console.log("guild_installed_qa_preempt_progress", summary);
      previous = summary;
    }
    if (predicate(view)) return view;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`guild_preempt_timeout:${label}`);
}

async function stopTaskIfRunning(taskId) {
  const view = await call("openTask", { taskId });
  if (["completed", "failed", "cancelled", "interrupted", undefined].includes(view.task.activeRunState)) return;
  const runId = [...view.timeline]
    .reverse()
    .find((item) => item.runId !== undefined && ["streaming", "waiting"].includes(item.status))
    ?.runId;
  if (runId === undefined) return;
  await call("cancelRun", { taskId, runId });
  await waitForTask(taskId, "cleanup-terminal", (next) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(next.task.activeRunState ?? ""),
    30_000,
  );
}

function relativeTaskOrder(projection, workspaceId, taskIds) {
  const taskIdSet = new Set(taskIds);
  return projection.workspaces
    .find((candidate) => candidate.workspaceId === workspaceId)
    ?.tasks
    .filter((task) => taskIdSet.has(task.taskId))
    .map((task) => task.taskId) ?? [];
}

async function frontmostApplication() {
  const script = `tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    return (name of frontProcess) & (ASCII character 9) & (bundle identifier of frontProcess)
  end tell`;
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script]);
  const [name = "", bundleId = ""] = stdout.trim().split("\t", 2);
  return { name, bundleId };
}

async function activateApplication(bundleId) {
  if (bundleId === "com.apple.finder") {
    await execFileAsync("/usr/bin/osascript", ["-e", 'tell application id "com.apple.finder" to activate']);
    return;
  }
  const script = `on run argv
    set targetId to item 1 of argv
    tell application "System Events"
      set frontmost of first application process whose bundle identifier is targetId to true
    end tell
  end run`;
  await execFileAsync("/usr/bin/osascript", ["-e", script, bundleId]);
}

async function waitForFrontmost(bundleId, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await frontmostApplication()).bundleId === bundleId) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`guild_focus_target_missing:${bundleId}`);
}
