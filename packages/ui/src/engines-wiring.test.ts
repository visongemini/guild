import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Guild 3.0 wiring (PC-ENG-001, PC-MODEL-001, PC-SET-002, PC-PRIV-001). These read the sources the way
 * f2-f4-wiring.test.ts does: the view-model and render tests cover behavior, these pin that App.tsx
 * connects them to the right preload calls and keeps Grok-only surfaces Grok-only.
 */

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match?.[1], `missing ${selector} block`);
  return match[1];
}

function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `${from} .. ${to}`);
  return source.slice(start, end);
}

test("choosing a model of the other engine moves the task first, then applies the model", () => {
  const apply = between(app, "async function applyTaskRuntimeSettings", "async function confirmOnlineSwitch");
  assert.match(apply, /change\.engine !== undefined && change\.engine !== taskEngineOf\(task\.task\)/u);
  const move = apply.indexOf("api.setTaskEngine({ taskId, engine: change.engine })");
  const settings = apply.indexOf("api.setTaskRuntimeSettings({");
  assert.ok(move > 0 && settings > move, "setTaskEngine comes before setTaskRuntimeSettings");
  // The moved task replaces the open one and its sidebar summary follows without waiting for a push.
  assert.match(apply, /withTaskSummary\(\{ \.\.\.current, activeTask: moved \}, moved\.task\)/u);
});

test("the picker gets the engine catalogs, the task's engine, whether it is fixed, Claude's state and the way to Model sources", () => {
  const picker = between(app, "<ModelPicker", "/>\n              {steerButton.visible");
  assert.match(picker, /catalogs=\{modelCatalogs\}/u);
  assert.match(picker, /taskEngine=\{activeEngine\}/u);
  assert.match(picker, /engineFixed=\{engineFixed\}/u);
  assert.match(picker, /claudeState: claudeStatus\.state/u);
  assert.match(picker, /onOpenModelSources=\{\(\) => openSettings\("sources"\)\}/u);
  assert.match(app, /const engineFixed = taskEngineFixed\(activeTask, activeTask !== undefined && pendingSends\.has\(activeTask\.task\.taskId\)\);/u);
  assert.match(app, /const modelCatalogs = modelCatalogsOf\(projection\.runtimeSettings\);/u);
});

test("settings have the five tabs in order and the old Grok tab is gone", () => {
  assert.match(app, /type SettingsTab = "general" \| "engines" \| "sources" \| "privacy" \| "about";/u);
  assert.match(app, /Object\.freeze\(\["general", "engines", "sources", "privacy", "about"\]\)/u);
  const tabs = between(app, '["general", messages.settingsGeneral]', "] as const).map(([tab, label])");
  assert.deepEqual([...tabs.matchAll(/\["(\w+)", messages\.(\w+)\]/gu)].map((match) => `${match[1]}:${match[2]}`), [
    "general:settingsGeneral", "engines:settingsEngines", "sources:settingsModelSources", "privacy:settingsPrivacy", "about:settingsAbout",
  ]);
  assert.doesNotMatch(app, /openSettings\("grok"\)|settingsTab === "grok"/u);
  assert.match(app, /\{settingsTab === "sources" && \(/u);
  assert.match(app, /<ModelSourcesSettings messages=\{baseMessages\} api=\{api\} onChanged=\{\(\) => void refreshRuntimeSettings\(\)\} \/>/u);
});

test("the Engines tab keeps the Grok section first and adds Claude's defaults saved through setClaudeSettings", () => {
  const engines = between(app, '{settingsTab === "engines" && (', '{settingsTab === "sources" && (');
  assert.ok(engines.indexOf("guild-engine-heading\">{baseMessages.settingsGrok}") < engines.indexOf("guild-engine-claude"));
  // The Grok controls are still the Grok ones, wired to setRuntimeSettings.
  assert.match(engines, /void setRuntimeSettings\(null, null, projection\.runtimeSettings\.permissionMode\)/u);
  // Claude: default model, effort and all of the adapter's permission modes, none invented here.
  assert.match(engines, /claude\.availablePermissionModes\.map\(\(mode\) =>/u);
  assert.match(engines, /void setClaudeSettings\(change\.model, change\.reasoningEffort, claude\.permissionMode\)/u);
  assert.match(engines, /void setClaudeSettings\(claude\.model, claude\.reasoningEffort, mode\)/u);
  assert.match(engines, /claudeStatusText\(baseMessages, claudeStatus\)/u);
  assert.match(app, /api\.setClaudeSettings\(\{ model, reasoningEffort, permissionMode \}\)/u);
});

test("Grok-only surfaces stay Grok-only: tools, control center, usage read and the slash snapshot", () => {
  assert.match(app, /disabled=\{activeEngine !== "grok"\}\s*\n\s*onClick=\{openGrokControlCenter\}/u);
  assert.match(app, /\.\.\.\(activeEngine === "grok" \? \[\{\s*\n\s*id: "navigation-grok-center"/u);
  assert.match(app, /if \(next && activeEngine === "grok"\) \{\s*\n\s*void refreshUsage\(\);/u);
  assert.match(app, /slashCommandCatalogue\(\s*\n\s*activeTask\?\.availableCommands \?\? Object\.freeze\(\[\]\),\s*\n\s*projection\.locale,\s*\n\s*activeEngine,\s*\n\s*\)/u);
  assert.match(app, /activeEngine !== "grok" \? \(\s*\n\s*<p className="guild-setting-help">\{messages\.grokToolsGrokOnly\}/u);
});

test("the usage popover is Claude's own for a Claude task: account label, context usage, quota managed by Claude Code, no grok.com link", () => {
  const popover = between(app, 'className="guild-account-popover"', "guild-account-meta");
  const claude = between(popover, '{activeEngine === "claude" ? (', ") : (");
  assert.match(claude, /claudeStatus\?\.accountLabel === undefined/u);
  assert.match(claude, /messages\.usageClaudeAccountUnknown/u);
  assert.match(claude, /messages\.contextUsageLabel\(contextWindow\.usedLabel/u);
  assert.match(claude, /messages\.usageClaudeQuota/u);
  assert.doesNotMatch(claude, /grok\.com|openExternal|usage\.status/u);
  // The Grok card, with its link, is the other branch and is otherwise unchanged.
  assert.match(popover.slice(claude.length), /openExternal\("https:\/\/grok\.com\/\?_s=usage"\)/u);
  assert.match(app, /\{activeEngine === "grok" && projection\.usage\.status === "available" && <small>/u);
});

test("the permission pill names the mode of the engine the task runs on", () => {
  assert.match(app, /const claudeMode = claudePermissionModeOf\(activeTask\?\.sessionModes, projection\.runtimeSettings\.claude\?\.permissionMode\);/u);
  assert.match(app, /messages\.claudePermissionModeName\(claudeMode\)/u);
  assert.match(app, /label: messages\.permissionModeName\(projection\.runtimeSettings\.permissionMode\)/u);
  assert.match(app, /\{permissionPill !== undefined && \(/u);
});

test("the conversation speaks of its own engine: messages, timeline lines and status lines follow it", () => {
  assert.match(app, /const messages = messagesFor\(projection\.locale, activeEngine\);/u);
  assert.match(app, /const baseMessages = messagesFor\(projection\.locale\);/u);
  assert.match(app, /<Timeline\s*\n(?:.*\n){0,8}?\s*engine=\{activeEngine\}/u);
  assert.match(app, /<CommandStatusLine status=\{commandStatus\} locale=\{projection\.locale\} engine=\{activeEngine\} \/>/u);
  assert.match(app, /previous\.engine === next\.engine/u);
});

test("the sidebar marker shows only while both engines are in use and takes no layout of its own", () => {
  assert.match(app, /const engineMarkers = hasMixedEngines\(activeWorkspaces\);/u);
  assert.match(app, /engineMarkers=\{engineMarkers\}/u);
  const marker = between(app, "{engineMarkers && (", "{status === \"running\"");
  assert.match(marker, /className=\{`guild-task-engine \$\{taskEngineOf\(task\)\}`\}/u);
  // It lives in the trailing group, after the pin and before the time, so the title and state columns do not move.
  assert.ok(app.indexOf("guild-task-pin") < app.indexOf("guild-task-engine ${"));
  assert.ok(app.indexOf("guild-task-engine ${") < app.indexOf("<time>{shortTime(task.updatedAtMs, locale)}</time>"));
  const style = cssBlock(".guild-task-engine");
  assert.match(style, /flex:\s*0 0 auto/u);
  assert.match(style, /width:\s*14px/u);
  assert.match(style, /height:\s*14px/u);
  // The row grid the alignment rules protect is unchanged.
  assert.match(cssBlock(".guild-task-row"), /grid-template-columns:\s*14px minmax\(0,1fr\) auto/u);
});

test("the Privacy tab can take back 'Don't remind me again' for the open conversation's workspace", () => {
  assert.match(app, /<OnlineReminderSetting messages=\{baseMessages\} api=\{api\} workspaceId=\{activeTask\?\.task\.workspaceId\} \/>/u);
});

test("the settings dialog is wide enough for five tabs and the stylesheet styles every new surface", () => {
  assert.match(cssBlock(".guild-dialog-tabs"), /grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/u);
  assert.match(cssBlock(".guild-dialog-settings"), /width:\s*min\(640px, calc\(100vw - 16px\)\)/u);
  for (const name of [
    "guild-model-group", "guild-model-group-heading", "guild-model-action", "guild-model-engine-note",
    "guild-online-reminder", "guild-online-reminder-body", "guild-engine-heading", "guild-engine-claude", "guild-engine-status",
    "guild-claude-modes", "guild-claude-mode", "guild-sources", "guild-source-list", "guild-source-row", "guild-source-main",
    "guild-source-chip", "guild-source-meta", "guild-source-actions", "guild-source-delete", "guild-sources-form",
    "guild-source-models", "guild-source-model-row", "guild-source-model-entry", "guild-source-error", "guild-sources-actions",
    "guild-source-add", "guild-source-add-model", "guild-task-engine",
  ]) {
    assert.match(css, new RegExp(`\\.${name}[\\s,:{.\\[]`, "u"), `${name} is not styled`);
  }
  // No color literal slipped in: styles-tokens.test.ts enforces it for the whole file; spot-check the new surfaces use tokens.
  assert.match(cssBlock(".guild-source-chip.status.confirmed"), /color:\s*var\(--guild-ok-text\)/u);
  assert.match(cssBlock(".guild-source-chip.status.needs_confirmation"), /color:\s*var\(--guild-wait-text\)/u);
  assert.match(cssBlock(".guild-source-error"), /color:\s*var\(--guild-error-text\)/u);
});
