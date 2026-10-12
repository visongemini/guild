import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline } from "./App.js";
import { messagesFor } from "./locales.js";
import { newTaskWorkspace, noTaskWorkspaceChip } from "./welcome.js";

/*
 * Guild 3.0.3 fixes: one test file for the behaviours added after testing the installed 3.0.2. Pure view logic is
 * tested directly; what only a stylesheet can say is checked on the stylesheet's rules.
 */

const noop = () => undefined;
const source = (name: string) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");

/** The `{selector, body}` of every top-level rule of a stylesheet (no nested at-rules needed here). */
function cssRules(css: string): Array<{ selector: string; body: string }> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  return [...stripped.matchAll(/([^{}@]+)\{([^{}]*)\}/gu)].map((match) => ({ selector: match[1]!.trim(), body: match[2]! }));
}

const answered = (runId: string, createdAtMs: number, updatedAtMs: number): TimelineItemProjection => ({
  entryId: `a-${runId}`, taskId: "t", runId, sequence: 2, createdAtMs, updatedAtMs, status: "completed", kind: "assistant", text: "ok",
}) as unknown as TimelineItemProjection;
const asked = (runId: string, at: number): TimelineItemProjection => ({
  entryId: `u-${runId}`, taskId: "t", runId, sequence: 1, createdAtMs: at, updatedAtMs: at, status: "completed", kind: "user", text: "hi",
}) as unknown as TimelineItemProjection;

// ---- the model and the time stay visible under every finished answer

test("every finished answer carries its model and time in the DOM, the older ones too", () => {
  const items = [asked("r1", 0), answered("r1", 1_000, 9_000), asked("r2", 20_000), answered("r2", 21_000, 71_000), asked("r3", 80_000), answered("r3", 81_000, 83_000)];
  const markup = renderToStaticMarkup(
    <Timeline items={items} locale="zh-CN" running={false}
      runModels={[{ runId: "r1" as never, label: "Opus 5.5" }, { runId: "r2" as never, label: "DeepSeek V4 Flash" }, { runId: "r3" as never, label: "Haiku 5.5" }]}
      onOpenExternal={noop} onPermissionDecision={async () => undefined} onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
  assert.deepEqual([...markup.matchAll(/class="guild-turn-model" title="([^"]+)"/gu)].map((match) => match[1]), ["Opus 5.5", "DeepSeek V4 Flash", "Haiku 5.5"]);
  assert.equal(markup.match(/class="guild-turn-took"/gu)?.length, 3);
  assert.equal(markup.match(/class="guild-turn-footer last"/gu)?.length, 1, "one newest answer");
  assert.match(markup, /Opus 5\.5<\/span><span class="guild-turn-took"> · 用时 9 秒/u, "the oldest answer says what it ran on and for how long");
});

test("only the Copy and Branch buttons hide until hover or focus on an older answer; the meta never does", async () => {
  const rules = cssRules(await source("styles.css"));
  const hidden = rules.filter((rule) => /\.guild-turn-(?:actions|meta|model|took)\b/u.test(rule.selector) && /(?:^|;)\s*opacity:\s*0\s*(?:;|$)/u.test(rule.body));
  assert.deepEqual(hidden.map((rule) => rule.selector), [".guild-turn-actions .guild-ghost-button"], "nothing but the buttons is hidden");
  const buttonRule = hidden[0]!;
  assert.match(buttonRule.body, /transition: opacity /u, "revealed with the same fade as before");
  // The buttons keep their box when hidden (opacity, not display or visibility), so nothing moves on hover.
  assert.doesNotMatch(buttonRule.body, /display:\s*none|visibility:\s*hidden/u);
  const revealing = rules.find((rule) => /(?:^|,)\s*\.guild-turn-footer\.last \.guild-turn-actions \.guild-ghost-button/u.test(rule.selector));
  assert.ok(revealing, "a rule reveals the buttons");
  assert.match(revealing.body, /opacity:\s*1/u);
  for (const trigger of [".guild-turn-footer.last .guild-turn-actions .guild-ghost-button", ".guild-message-assistant:hover .guild-turn-actions .guild-ghost-button", ".guild-message-assistant:focus-within .guild-turn-actions .guild-ghost-button"]) {
    assert.ok(revealing.selector.split(",").map((part) => part.trim()).includes(trigger), trigger);
  }
  // The row itself and the meta carry no opacity of their own that a reveal could miss.
  const row = rules.find((rule) => rule.selector === ".guild-turn-actions");
  assert.doesNotMatch(row!.body, /opacity/u);
  assert.match(row!.body, /min-height:\s*28px/u, "the row keeps its height");
  const meta = rules.find((rule) => rule.selector === ".guild-turn-meta");
  assert.match(meta!.body, /margin-left:\s*auto/u, "the meta stays on the right whatever the buttons do");
});

test("the reduced-motion rule still removes the buttons' fade", async () => {
  const css = await source("styles.css");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /transition-duration: 0\.001ms !important/u);
});

// ---- the composer's workspace chip with no task open

const WORKSPACES = [{ workspaceId: "w-a", name: "Alpha" }, { workspaceId: "w-b", name: "Beta" }];

test("New task uses the remembered workspace under 'use last', the only workspace otherwise, and asks when the choice is open", () => {
  // The remembered workspace wins while it still exists, whatever the number of workspaces.
  assert.deepEqual(newTaskWorkspace("last", "w-b", WORKSPACES), { kind: "workspace", workspaceId: "w-b" });
  assert.deepEqual(newTaskWorkspace("last", "w-a", WORKSPACES.slice(0, 1)), { kind: "workspace", workspaceId: "w-a" });
  // A single workspace is the only choice there is, also when asked every time.
  assert.deepEqual(newTaskWorkspace("ask", "w-a", WORKSPACES.slice(1)), { kind: "workspace", workspaceId: "w-b" });
  assert.deepEqual(newTaskWorkspace("ask", undefined, WORKSPACES.slice(0, 1)), { kind: "workspace", workspaceId: "w-a" });
  assert.deepEqual(newTaskWorkspace("last", undefined, WORKSPACES.slice(0, 1)), { kind: "workspace", workspaceId: "w-a" });
  // A remembered workspace that is gone (archived or removed) falls back to the same rules.
  assert.deepEqual(newTaskWorkspace("last", "w-gone", WORKSPACES.slice(0, 1)), { kind: "workspace", workspaceId: "w-a" });
  assert.deepEqual(newTaskWorkspace("last", "w-gone", WORKSPACES), { kind: "ask" });
  // The choice is open: several workspaces and nothing remembered or "ask every time".
  assert.deepEqual(newTaskWorkspace("ask", "w-b", WORKSPACES), { kind: "ask" });
  assert.deepEqual(newTaskWorkspace("last", undefined, WORKSPACES), { kind: "ask" });
  assert.deepEqual(newTaskWorkspace(undefined, undefined, WORKSPACES), { kind: "ask" });
  // No workspace at all.
  assert.deepEqual(newTaskWorkspace("last", "w-a", []), { kind: "none" });
  assert.deepEqual(newTaskWorkspace("ask", undefined, []), { kind: "none" });
});

test("the chip names the decided workspace and says 'choose project folder' only while the choice is open", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    assert.equal(noTaskWorkspaceChip(messages, newTaskWorkspace("last", "w-b", WORKSPACES), WORKSPACES), "Beta");
    assert.equal(noTaskWorkspaceChip(messages, newTaskWorkspace("ask", undefined, WORKSPACES.slice(0, 1)), WORKSPACES.slice(0, 1)), "Alpha");
    assert.equal(noTaskWorkspaceChip(messages, newTaskWorkspace("ask", "w-b", WORKSPACES), WORKSPACES), messages.chooseWorkspace);
    assert.equal(noTaskWorkspaceChip(messages, newTaskWorkspace("last", undefined, []), []), messages.chooseWorkspace);
  }
  assert.equal(messagesFor("zh-CN").chooseWorkspace, "选择项目文件夹");
  // A decided id the list does not hold (it cannot happen with the one function, but a stale list must not blank the chip).
  assert.equal(noTaskWorkspaceChip(messagesFor("zh-CN"), { kind: "workspace", workspaceId: "w-gone" }, WORKSPACES), "选择项目文件夹");
});

test("the create action and the composer chip read the same decision, and the chip is not a control", async () => {
  const app = await source("App.tsx");
  assert.match(app, /const decidedNewTaskWorkspace = newTaskWorkspace\(\s*projection\?\.generalSettings\.newTaskWorkspaceMode,\s*projection\?\.generalSettings\.lastWorkspaceId,\s*activeWorkspaces,\s*\);/u);
  assert.match(app, /if \(decidedNewTaskWorkspace\.kind === "ask"\) \{\s*setWorkspacePickerOpen\(true\);\s*return;\s*\}/u);
  assert.match(app, /<span className="guild-pill guild-workspace-pill">\s*<FolderSimple size=\{14\} aria-hidden="true" \/>\s*<span>\{activeTask === undefined \? noTaskWorkspaceChip\(messages, decidedNewTaskWorkspace, activeWorkspaces\) : workspaceName\(/u);
});
