import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { TimelineItem } from "./App.js";
import { messagesFor } from "./locales.js";
import { permissionOptionView } from "./permission-options.js";

/*
 * Guild 3.0.2 UI polish: one test file for the behaviours added by the polish pass. Pure view logic is tested
 * directly; markup and wiring are checked through the exported components and the sources they are wired in.
 */

const noop = () => undefined;
const source = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

function permissionCard(options: readonly { optionId: string; name: string; kind: string }[], locale: "zh-CN" | "en-US", engine: "grok" | "claude" = "claude") {
  const item = {
    entryId: "p", taskId: "t", runId: "r", sequence: 3, createdAtMs: 1, updatedAtMs: 1, status: "waiting", kind: "permission",
    permissionId: "p1", title: "Write notes.txt", options,
  } as unknown as TimelineItemProjection;
  return renderToStaticMarkup(
    <TimelineItem item={item} locale={locale} engine={engine} canRetry={false} onOpenExternal={noop}
      onPermissionDecision={async () => undefined} onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
}

const CLAUDE_OPTIONS = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "always", name: "Yes, allow all edits during this session", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];

test("permission buttons are labeled by their ACP kind in Chinese and keep the agent's text as the tooltip", () => {
  for (const engine of ["claude", "grok"] as const) {
    const markup = permissionCard(CLAUDE_OPTIONS, "zh-CN", engine);
    assert.match(markup, /title="Yes" class="allow primary">允许<\/button>/u);
    assert.match(markup, /title="Yes, allow all edits during this session" class="allow">本会话都允许<\/button>/u);
    assert.match(markup, /title="No" class="reject">拒绝<\/button>/u);
    assert.doesNotMatch(markup, />(?:Yes|No)</u);
  }
  const reject = permissionCard([{ optionId: "x", name: "Reject all", kind: "reject_always" }], "zh-CN");
  assert.match(reject, /title="Reject all" class="reject">都拒绝<\/button>/u);
});

test("an unknown kind and the English interface keep the agent's own text", () => {
  const unknown = permissionCard([{ optionId: "x", name: "Open the plan", kind: "something_new" }], "zh-CN");
  assert.match(unknown, />Open the plan<\/button>/u);
  assert.doesNotMatch(unknown, /title="Open the plan"/u);
  const english = permissionCard(CLAUDE_OPTIONS, "en-US");
  assert.match(english, /class="allow primary">Yes<\/button>/u);
  assert.match(english, />Yes, allow all edits during this session<\/button>/u);
  assert.match(english, />No<\/button>/u);
});

test("an always-option that does not speak of the session keeps the text that names its scope", () => {
  const zh = messagesFor("zh-CN");
  assert.deepEqual(
    permissionOptionView(zh, { name: "Yes, and allow access to notes/ and similar commands", kind: "allow_always" }),
    { label: "Yes, and allow access to notes/ and similar commands", title: undefined },
  );
  assert.deepEqual(
    permissionOptionView(zh, { name: "Always allow for this Session", kind: "allow_always" }),
    { label: "本会话都允许", title: "Always allow for this Session" },
  );
  assert.deepEqual(permissionOptionView(zh, { name: "允许", kind: "allow_once" }), { label: "允许", title: undefined });
});

test("the card's last button says it stops the turn, and it does stop the turn", async () => {
  const zh = permissionCard(CLAUDE_OPTIONS, "zh-CN");
  assert.match(zh, /class="dismiss" title="不执行这个操作，并停止本轮任务。">停止本轮<\/button>/u);
  assert.doesNotMatch(zh, />取消<\/button>/u);
  assert.match(permissionCard(CLAUDE_OPTIONS, "en-US"), /class="dismiss" title="Do not run this action, and stop the turn.">Stop this turn<\/button>/u);
  // A cancelled decision from the card goes down the stop path instead of sending ACP's cancelled outcome mid-turn.
  const app = await source("App.tsx");
  const start = app.indexOf("async function decidePermission");
  const body = app.slice(start, app.indexOf("function beginSidebarResize", start));
  assert.match(body, /decision\.type === "cancelled"[\s\S]*api\.cancelRun\(\{ taskId: item\.taskId, runId: item\.runId! \}\)/u);
  assert.match(body, /api\.decidePermission\(\{/u);
});

test("the online reminder dialog closes the model popover first and its copy is two-way", async () => {
  const picker = await source("ModelPicker.tsx");
  const app = await source("App.tsx");
  assert.match(picker, /useEffect\(\(\) => \{\s*if \(modalOpen\) setOpen\(false\);\s*\}, \[modalOpen\]\);/u);
  assert.match(app, /modalOpen=\{onlineReminder !== undefined\}/u);
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const copy = [
      messages.onlineReminderTitle, messages.onlineReminderLead("DeepSeek"), messages.onlineReminderItemClaudeMd,
      messages.onlineReminderItemMemory, messages.onlineReminderItemConversation, messages.onlineReminderItemBrowser,
      messages.onlineReminderDontRemind, messages.onlineReminderSwitch,
    ].join("\n");
    assert.doesNotMatch(copy, /不能再|无法再|不可再|切回|cannot (?:go|switch) back|can(?:'|’)t (?:go|switch) back|one-way|no longer be able/iu, locale);
  }
  assert.equal(messagesFor("zh-CN").onlineReminderTitle, "发给在线模型前确认一下");
  assert.equal(messagesFor("en-US").onlineReminderTitle, "Confirm before sending to an online model");
});
