import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelSourceProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { messagesFor } from "./locales.js";
import {
  agreedSourcesOf,
  createOnlineConsentLedger,
  onlineReminderNeeded,
  onlineSourceKey,
  vendorLabelFor,
} from "./online-reminder.js";
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

const base = {
  targetGroup: "online",
  targetSource: "source:deepseek",
  agreedSources: new Set<string>(),
  dismissedForWorkspace: false,
} as const;

test("the reminder is due for an Online vendor the task has not agreed to, unless the workspace silenced it", () => {
  assert.equal(onlineReminderNeeded(base), true);
  assert.equal(onlineReminderNeeded({ ...base, agreedSources: new Set(["source:other"]) }), true);
  assert.equal(onlineReminderNeeded({ ...base, agreedSources: new Set(["source:deepseek"]) }), false);
  assert.equal(onlineReminderNeeded({ ...base, dismissedForWorkspace: true }), false);
});

test("Claude, Local and Grok models never ask", () => {
  for (const targetGroup of ["claude", "local", "grok", undefined] as const) {
    assert.equal(onlineReminderNeeded({ ...base, targetGroup }), false, String(targetGroup));
  }
});

test("a model belongs to the source that lists it, else it is its own key", () => {
  const sources = [source("DeepSeek", ["deepseek-v4-flash", "deepseek-v4-reasoner"]), source("Other", ["other-1"])];
  assert.equal(onlineSourceKey("deepseek-v4-reasoner", sources), "source:deepseek");
  assert.equal(onlineSourceKey("other-1", sources), "source:other");
  assert.equal(onlineSourceKey("ghost", sources), "model:ghost");
  assert.equal(onlineSourceKey("ghost", []), "model:ghost");
});

test("consent is per task and per vendor: Online A -> Claude -> Online B asks again for B, not for A", () => {
  const sources = [source("DeepSeek", ["ds-flash", "ds-reasoner"]), source("Other", ["other-1"])];
  const ledger = createOnlineConsentLedger();
  /** Whether switching `taskId` from `current` to `target` must ask, and (when answered yes) records the agreement. */
  const asks = (taskId: string, target: string, current: [string, "claude" | "online"], dismissed = false): boolean => {
    const targetSource = onlineSourceKey(target, sources);
    const due = onlineReminderNeeded({
      targetGroup: "online",
      targetSource,
      agreedSources: agreedSourcesOf({ ledger, taskId, currentModelId: current[0], currentGroup: current[1], sources }),
      dismissedForWorkspace: dismissed,
    });
    if (due) ledger.agree(taskId, targetSource);
    return due;
  };
  assert.equal(asks("t1", "ds-flash", ["opus", "claude"]), true, "the first Online vendor of the task");
  // Another model of the same vendor, with or without leaving to Claude and back, is the same agreement.
  assert.equal(asks("t1", "ds-reasoner", ["ds-flash", "online"]), false);
  assert.equal(asks("t1", "ds-flash", ["opus", "claude"]), false);
  // A different vendor is a different agreement, straight from Online A or by way of Claude.
  assert.equal(asks("t1", "other-1", ["ds-flash", "online"]), true, "Online A -> Online B");
  const viaClaude = createOnlineConsentLedger();
  viaClaude.agree("t2", onlineSourceKey("ds-flash", sources));
  const b = { ledger: viaClaude, taskId: "t2", currentModelId: "opus", currentGroup: "claude", sources } as const;
  assert.equal(onlineReminderNeeded({ ...base, targetSource: onlineSourceKey("other-1", sources), agreedSources: agreedSourcesOf(b) }), true, "Online A -> Claude -> Online B");
  assert.equal(onlineReminderNeeded({ ...base, targetSource: onlineSourceKey("ds-flash", sources), agreedSources: agreedSourcesOf(b) }), false, "and back to A");
  // Both vendors are known to t1 now; another task starts from nothing.
  assert.equal(asks("t1", "other-1", ["opus", "claude"]), false);
  assert.equal(asks("t3", "ds-flash", ["opus", "claude"]), true);
  // The vendor a task already runs on counts as agreed even with no entry (a default the person set), and the
  // workspace opt-out silences every vendor.
  assert.equal(asks("t4", "ds-reasoner", ["ds-flash", "online"]), false);
  assert.equal(asks("t5", "other-1", ["opus", "claude"], true), false);
  assert.equal(asks("t5", "ds-flash", ["opus", "claude"], true), false);
  // A model no source lists is its own vendor key: asked once, not on every switch.
  assert.equal(asks("t6", "ghost", ["opus", "claude"]), true);
  assert.equal(asks("t6", "ghost", ["opus", "claude"]), false);
  // The ledger hands out a copy: reading it never records anything.
  agreedSourcesOf({ ledger, taskId: "t7", currentModelId: "ds-flash", currentGroup: "online", sources });
  assert.equal(ledger.agreedSources("t7").size, 0);
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

test("the app asks once per switch, only for an Online vendor not agreed yet, and never about leaving the subscription [D-062]", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("async function confirmModelSwitch");
  const flow = app.slice(start, app.indexOf("async function setSessionConfigOption", start));
  assert.equal(flow.match(/new Promise<OnlineReminderAnswer>/gu)?.length, 1, "a single dialog per switch");
  assert.match(flow, /if \(!reminderNeeded\) \{\s*\n\s*if \(change\.group === "online"\) onlineConsent\.current\.agree\(taskId, targetSource\);\s*\n\s*return true;/u);
  assert.match(flow, /setOnlineReminder\(Object\.freeze\(\{ vendorLabel \}\)\);/u);
  assert.match(flow, /if \(reminderNeeded && answer\.dontRemindAgain\) \{/u);
  const gate = app.slice(app.indexOf("async function applyTaskRuntimeSettings"), start);
  assert.match(gate, /\(change\.group === "online" \|\| change\.group === "local"\) && !\(await confirmModelSwitch\(task, change\)\)/u);
  assert.doesNotMatch(app, /routedModelName|taskHasNativeClaudeSession|routedNotice/u);
  const component = await readFile(new URL("../src/OnlineReminderDialog.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /routed/iu);
  // The reminder is per vendor and per task: Online A, Claude, Online A again does not ask a second time for A, B asks.
  const ledger = createOnlineConsentLedger();
  ledger.agree("t", "source:a");
  const afterClaude = agreedSourcesOf({ ledger, taskId: "t", currentModelId: "opus", currentGroup: "claude", sources: [] });
  assert.equal(onlineReminderNeeded({ targetGroup: "online", targetSource: "source:a", agreedSources: afterClaude, dismissedForWorkspace: false }), false);
  assert.equal(onlineReminderNeeded({ targetGroup: "online", targetSource: "source:b", agreedSources: afterClaude, dismissedForWorkspace: false }), true);
  assert.equal(onlineReminderNeeded({ targetGroup: "claude", targetSource: "", agreedSources: new Set(), dismissedForWorkspace: false }), false);
  assert.equal(onlineReminderNeeded({ targetGroup: "local", targetSource: "model:x", agreedSources: new Set(), dismissedForWorkspace: false }), false);
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
  assert.match(flow, /\(change\.group === "online" \|\| change\.group === "local"\) && !\(await confirmModelSwitch\(task, change\)\)\) return undefined/u);
  assert.ok(flow.indexOf("confirmModelSwitch(task") < flow.indexOf("applyModelSelectionChange("));
  // Agreement is kept per task and per vendor, in the ledger; the vendor is the source that lists the model.
  assert.match(app, /const onlineConsent = useRef\(createOnlineConsentLedger\(\)\);/u);
  assert.match(flow, /const targetSource = onlineSourceKey\(modelId \?\? "", sources\);/u);
  assert.match(flow, /agreedSourcesOf\(\{\s*\n\s*ledger: onlineConsent\.current,\s*\n\s*taskId,\s*\n\s*currentModelId: task\.modelSelection\.modelId,/u);
  // The workspace preference is read only when this vendor is not agreed yet; the checkbox writes it back.
  assert.match(flow, /if \(change\.group === "online" && !agreedSources\.has\(targetSource\)\) \{\s*\n\s*try \{\s*\n\s*dismissed = \(await api\.getWorkspacePrefs\(\{ workspaceId: task\.task\.workspaceId \}\)\)\.onlineReminderDismissed;/u);
  assert.match(flow, /api\.setWorkspacePrefs\(\{ workspaceId: task\.task\.workspaceId, onlineReminderDismissed: true \}\)/u);
  assert.match(flow, /onlineReminderNeeded\(\{ targetGroup: change\.group, targetSource, agreedSources, dismissedForWorkspace: dismissed \}\)/u);
  assert.match(flow, /onlineConsent\.current\.agree\(taskId, targetSource\)/u);
  // The vendor named is the model source's label.
  assert.match(flow, /vendorLabelFor\(modelId \?\? "", sources, target\?\.name\)/u);
  // Cancel resolves without switching and never records an agreement.
  assert.match(flow, /if \(!answer\.confirmed\) return false;\s*\n\s*if \(change\.group === "online"\) onlineConsent\.current\.agree\(taskId, targetSource\);/u);
  assert.doesNotMatch(app, /onlineRemindedTaskIds/u);
  assert.match(app, /<OnlineReminderDialog\s*\n\s*messages=\{baseMessages\}/u);
});
