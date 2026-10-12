import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelSourceProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { messagesFor } from "./locales.js";
import { onlineReminderNeeded, vendorLabelFor } from "./online-reminder.js";
import { OnlineReminderDialog } from "./OnlineReminderDialog.js";
import { OnlineReminderSetting } from "./OnlineReminderSetting.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

const source = (label: string, ids: readonly string[]): ModelSourceProjection => Object.freeze({
  id: label.toLowerCase(),
  kind: "online",
  label,
  baseUrl: "https://api.example.com/anthropic",
  keyFile: null,
  keyVariable: "EXAMPLE_API_KEY",
  models: Object.freeze(ids.map((id) => Object.freeze({ id, label: id }))),
  enabled: true,
  confirmedHost: "api.example.com",
});

const base = { targetGroup: "online", currentGroup: "claude", alreadyHandledForTask: false, dismissedForWorkspace: false } as const;

test("the reminder is due only for the first Online model of a conversation in a workspace that has not silenced it", () => {
  assert.equal(onlineReminderNeeded(base), true);
  assert.equal(onlineReminderNeeded({ ...base, currentGroup: undefined }), true);
  assert.equal(onlineReminderNeeded({ ...base, currentGroup: "local" }), true);
  assert.equal(onlineReminderNeeded({ ...base, alreadyHandledForTask: true }), false);
  assert.equal(onlineReminderNeeded({ ...base, dismissedForWorkspace: true }), false);
  // Already on an Online model: the person was asked (or chose not to be) when they got there.
  assert.equal(onlineReminderNeeded({ ...base, currentGroup: "online" }), false);
});

test("Claude, Local and Grok models never ask", () => {
  for (const targetGroup of ["claude", "local", "grok", undefined] as const) {
    assert.equal(onlineReminderNeeded({ ...base, targetGroup }), false, String(targetGroup));
  }
});

test("the vendor named is the model source that lists the model, else the model's name, else its id", () => {
  const sources = [source("DeepSeek", ["deepseek-v4-flash", "deepseek-v4-reasoner"]), source("Other", ["other-1"])];
  assert.equal(vendorLabelFor("deepseek-v4-reasoner", sources, "Reasoner"), "DeepSeek");
  assert.equal(vendorLabelFor("other-1", sources, undefined), "Other");
  assert.equal(vendorLabelFor("unknown-1", sources, "Unknown One"), "Unknown One");
  assert.equal(vendorLabelFor("unknown-1", sources, undefined), "unknown-1");
  assert.equal(vendorLabelFor("x", [], undefined), "x");
});

const noop = () => undefined;
const dialog = (messages = EN, initialDontRemind = false) => renderToStaticMarkup(
  <OnlineReminderDialog
    messages={messages}
    vendorLabel="DeepSeek"
    onCancel={noop}
    onSwitch={noop}
    onDialogKeyDown={noop}
    initialDontRemind={initialDontRemind}
  />,
);

test("the dialog asks to send the conversation to the vendor and lists what goes", () => {
  const markup = dialog();
  assert.match(markup, /role="alertdialog" aria-modal="true"/u);
  assert.match(markup, /<strong id="[^"]+">Send this conversation to DeepSeek\?<\/strong>/u);
  assert.match(markup, /DeepSeek is an online model\. If you switch, these are sent to its vendor:/u);
  for (const item of ["CLAUDE.md", "Memory", "This conversation", "Text and screenshots of web pages in this conversation"]) {
    assert.match(markup, new RegExp(`<li>${item}</li>`, "u"));
  }
  assert.match(markup, /<input type="checkbox"\/>/u);
  assert.match(markup, /Don&#x27;t remind me again in this workspace/u);
  assert.doesNotMatch(markup, /type="checkbox"[^>]*checked/u);
  assert.match(markup, /class="primary">Switch<\/button>/u);
  // Cancel is the default action: it holds the initial focus.
  assert.match(markup, /<button autofocus="" type="button">Cancel<\/button>/u);
});

test("the checkbox starts unticked, the dialog is localized, and the key handling is the app's", async () => {
  assert.match(dialog(EN, true), /type="checkbox"[^>]*checked/u);
  const zh = dialog(ZH);
  assert.match(zh, /要把这段对话发给「DeepSeek」吗？/u);
  assert.match(zh, /在此工作区不再提醒/u);
  const component = await readFile(new URL("../src/OnlineReminderDialog.tsx", import.meta.url), "utf8");
  assert.match(component, /onKeyDown=\{\(event\) => onDialogKeyDown\(event, onCancel\)\}/u);
  assert.match(component, /<button autoFocus type="button" onClick=\{onCancel\}>/u);
  assert.match(component, /onClick=\{\(\) => onSwitch\(dontRemind\)\}/u);
});

test("the Privacy switch shows the reminder on until the workspace silences it, and waits for a workspace", () => {
  const api = {
    getWorkspacePrefs: async () => { throw new Error("not called"); },
    setWorkspacePrefs: async () => { throw new Error("not called"); },
  };
  const wid = "workspace-1" as never;
  const on = renderToStaticMarkup(<OnlineReminderSetting messages={EN} api={api} workspaceId={wid} initialPrefs={{ workspaceId: wid, onlineReminderDismissed: false }} />);
  assert.match(on, /class="guild-switch on"[^>]*aria-pressed="true"/u);
  assert.match(on, /Remind me before sending to an online model/u);
  const off = renderToStaticMarkup(<OnlineReminderSetting messages={EN} api={api} workspaceId={wid} initialPrefs={{ workspaceId: wid, onlineReminderDismissed: true }} />);
  assert.match(off, /class="guild-switch "[^>]*aria-pressed="false"/u);
  const none = renderToStaticMarkup(<OnlineReminderSetting messages={EN} api={api} workspaceId={undefined} />);
  assert.match(none, /disabled=""/u);
  assert.match(none, /Open a conversation to change this for its workspace\./u);
});

test("the reminder flow in the app follows PC-PRIV-001", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("async function applyTaskRuntimeSettings");
  const end = app.indexOf("async function setSessionConfigOption", start);
  const flow = app.slice(start, end);
  // The reminder gates only Online models and comes before anything is changed.
  assert.match(flow, /change\.group === "online" && !\(await confirmOnlineSwitch\(task, change\.model\)\)\) return undefined/u);
  assert.ok(flow.indexOf("confirmOnlineSwitch(task") < flow.indexOf("api.setTaskEngine("));
  assert.ok(flow.indexOf("confirmOnlineSwitch(task") < flow.indexOf("api.setTaskRuntimeSettings("));
  // The preference is read whenever the task has not been asked and is not already on an Online model, even when the
  // current model is not in the catalog (a fresh Claude task may name none).
  assert.match(app, /const currentGroup = currentModel === undefined \? undefined : modelGroupOf\(currentModel\);/u);
  assert.match(app, /if \(!handledBefore && currentGroup !== "online"\) \{\s*\n\s*try \{\s*\n\s*dismissed = \(await api\.getWorkspacePrefs/u);
  // The silenced state comes from the workspace preference; the checkbox writes it back; asked tasks are remembered per task id.
  assert.match(flow, /api\.getWorkspacePrefs\(\{ workspaceId: task\.task\.workspaceId \}\)/u);
  assert.match(flow, /api\.setWorkspacePrefs\(\{ workspaceId: task\.task\.workspaceId, onlineReminderDismissed: true \}\)/u);
  assert.match(flow, /onlineRemindedTaskIds\.current\.add\(taskId\)/u);
  // The vendor is the model source's label.
  assert.match(flow, /vendorLabelFor\(modelId \?\? "", \(await api\.listModelSources\(\)\)\.sources/u);
  // Cancel resolves without switching and never marks the task as asked.
  assert.match(flow, /if \(!answer\.confirmed\) return false;\s*\n\s*onlineRemindedTaskIds\.current\.add\(taskId\);/u);
  assert.match(app, /<OnlineReminderDialog\s*\n\s*messages=\{baseMessages\}/u);
});
