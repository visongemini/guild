import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release chrome exposes truthful runtime state and no dead navigation controls", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /messages\.permissionModeName\(projection\.runtimeSettings\.permissionMode\)/);
  assert.match(source, /messages\.toolKindLabel\(item\.toolKind\)/);
  assert.match(source, /className="guild-inline-error" role="alert"/);
  assert.doesNotMatch(source, /<SidebarNav[^>]+messages\.(?:extensions|automation|library)/);
  const utilities = source.slice(source.indexOf('className="guild-sidebar-utilities"'), source.indexOf('className="guild-profile-bar"'));
  assert.match(utilities, /onClick=\{openGrokControlCenter\}/);
  assert.match(utilities, /onClick=\{\(\) => openSettings\(\)\}/);
});

test("new task creation preserves workspace selection behavior", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("async function createTask");
  const end = source.indexOf("async function openTask", start);
  assert.ok(start >= 0 && end > start);
  const createTask = source.slice(start, end);

  assert.match(createTask, /const selected = await chooseWorkspace\(\)/);
  assert.match(createTask, /selected\?\.generalSettings\.lastWorkspaceId/);
  assert.match(createTask, /api\.createTask/);
});

test("modal dialogs support escape, initial focus, and tab containment", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /onKeyDown=\{\(event\) => handleDialogKeyDown/);
  assert.match(source, /if \(event\.key === "Escape"\)/);
  assert.match(source, /if \(event\.key !== "Tab"\) return/);
  assert.match(source, /<button autoFocus type="button" className="guild-soft-button"/);
  assert.match(source, /autoFocus\s+className="guild-nickname-field"/);
});

test("usage and live thinking labels remain period-neutral and informative", async () => {
  const locales = await readFile(new URL("../src/locales.ts", import.meta.url), "utf8");

  assert.match(locales, /usage: "官方用量"/);
  assert.match(locales, /usage: "Official usage"/);
  assert.match(locales, /thinkingFor: \(seconds\) => `思考中 · \$\{seconds\} 秒`/);
  assert.match(locales, /thinkingFor: \(seconds\) => `Thinking · \$\{seconds\}s`/);
});

test("command center is keyboard-owned and inserts official commands without bypassing the composer", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(source, /event\.key\.toLocaleLowerCase\(\) !== "k"/);
  assert.match(source, /className="guild-command-palette"/);
  assert.match(source, /setDraft\(slashCommandText\(command\)\)/);
  const commandItemStart = source.indexOf("id: `command-${command.name}`");
  const commandItemsEnd = source.indexOf("] satisfies readonly CommandPaletteItem[]", commandItemStart);
  assert.ok(commandItemStart >= 0 && commandItemsEnd > commandItemStart);
  assert.doesNotMatch(source.slice(commandItemStart, commandItemsEnd), /sendComposerText|api\.sendMessage/);
});

test("message actions copy, branch at an exact sequence, and only return failed text to the draft", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.match(source, /navigator\.clipboard\.writeText\(item\.text\)/);
  assert.match(source, /api\.forkTask\(\{ taskId, throughSequence: item\.sequence \}\)/);
  assert.match(source, /function retryMessageToDraft/);
  assert.match(source, /setDraft\(item\.text\)/);
  const retryStart = source.indexOf("function retryMessageToDraft");
  const retryEnd = source.indexOf("function openGrokControlCenter", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  assert.doesNotMatch(source.slice(retryStart, retryEnd), /sendMessage|sendComposerText/);
});

test("queued follow-ups can explicitly interrupt the active Run and take over next", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const locales = await readFile(new URL("../src/locales.ts", import.meta.url), "utf8");

  assert.match(source, /activeTask\.task\.activeRunState === "cancel_requested"/);
  assert.match(source, /messages\.queuedFirst/);
  assert.match(source, /api\.preemptQueuedTurn\(\{ taskId, queueId \}\)/);
  assert.match(source, /messages\.preemptQueued/);
  assert.match(source, /messages\.preemptingQueued/);
  assert.match(source, /messages\.cancelQueued/);
  assert.match(locales, /preemptQueued: "立即插队"/);
  assert.match(locales, /preemptingQueued: "正在停止当前任务…"/);
});

test("continuous tasks expose an explicit opt-in and durable foreground controls", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const locales = await readFile(new URL("../src/locales.ts", import.meta.url), "utf8");

  assert.match(source, /mode: "continuous" as const/u);
  assert.match(source, /api\.setContinuousTask/u);
  const card = await readFile(new URL("../src/ContinuousTask.tsx", import.meta.url), "utf8");
  assert.match(source, /<ContinuousTaskCard/u);
  assert.match(source, /task=\{activeTask\.continuousTask\}/u);
  assert.match(source, /onAction=\{\(action\) => void setContinuousTask\(action\)\}/u);
  for (const action of ["pause", "resume", "stop"]) {
    assert.ok(card.includes('onAction("' + action + '")'), action + " remains wired to the service");
  }
  assert.match(locales, /continuousMode: "持续任务"/u);
  assert.match(locales, /continuousAuditPhase: "验收中"/u);
});

test("runtime recovery separates an interrupted run from a restored session", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const locales = await readFile(new URL("../src/locales.ts", import.meta.url), "utf8");

  assert.match(source, /item\.noticeType === "session_restored"/u);
  assert.match(source, /className="guild-runtime-recovery-card" role="alert"/u);
  assert.match(source, /messages\.recoveryRetryAction/u);
  assert.match(source, /onOpenRuntimeDiagnostics/u);
  assert.match(source, /messages\.interruptedResultUnconfirmed/u);
  assert.match(source, /activeTask\.recentResult\.state === "interrupted"/u);
  assert.match(source, /!restoredNoticeCoversLatestResult/u);
  assert.match(locales, /interruptedResult: "本轮已中断"/u);
  assert.match(locales, /recoveryNoticeTitle: "本轮已中断，会话已恢复"/u);
  assert.match(locales, /latestResultNoChanges: "Grok 未报告文件或差异证据"/u);
  assert.doesNotMatch(locales, /本轮没有收到文件或差异证据/u);
});
