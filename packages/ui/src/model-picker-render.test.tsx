import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EMPTY_CLAUDE_MODEL_CATALOG, freezeModelCatalog, type GrokModelCatalog, type SetTaskRuntimeSettingsResponse, type TaskModelSelectionProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { messagesFor } from "./locales.js";
import { CLAUDE_CATALOG, GEMINI_CATALOG, REAL_CATALOG } from "./model-catalog.fixture.js";
import { ModelPicker, type ModelPickerProps } from "./ModelPicker.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

function selection(
  modelId: string | null,
  reasoningEffort: string | null,
  source: TaskModelSelectionProjection["source"] = "task",
  canChange = true,
): TaskModelSelectionProjection {
  return Object.freeze({ modelId, reasoningEffort, source, canChange });
}

const grokOnly = (grok: GrokModelCatalog) => Object.freeze({ grok, claude: EMPTY_CLAUDE_MODEL_CATALOG });

function render(props: Partial<ModelPickerProps> = {}): string {
  return renderToStaticMarkup(
    <ModelPicker
      messages={EN}
      catalogs={grokOnly(REAL_CATALOG)}
      selection={selection("grok-4.7-build-fast", "high")}
      taskEngine="grok"
      engineFixed
      onApply={async (): Promise<SetTaskRuntimeSettingsResponse | undefined> => { throw new Error("not called"); }}
      {...props}
    />,
  );
}

test("the closed trigger shows the official name and effort with scope in its label", () => {
  const markup = render();
  assert.match(markup, /class="guild-model-picker"/u);
  assert.match(markup, /class="guild-model-picker-trigger"/u);
  assert.match(markup, /<span>Grok 4\.7 Fast \u00b7 High<\/span>/u);
  assert.match(markup, /aria-haspopup="dialog"/u);
  assert.match(markup, /aria-expanded="false"/u);
  assert.match(markup, /title="Set for this conversation"/u);
  assert.match(markup, /aria-label="Model and reasoning effort: Grok 4\.7 Fast \u00b7 High\. Set for this conversation\."/u);
  assert.doesNotMatch(markup, /guild-model-popover/u);
  assert.doesNotMatch(markup, /disabled/u);
});

test("the trigger stays readable and is disabled with a reason while a turn runs", () => {
  const markup = render({ selection: selection("grok-4.7", "xhigh", "task", false) });
  assert.match(markup, /<button[^>]*disabled=""/u);
  assert.match(markup, /aria-disabled="true"/u);
  assert.match(markup, /<span>Grok 4\.7 \u00b7 Extra high<\/span>/u);
  assert.match(markup, /title="Set for this conversation \u00b7 The model can be changed after the current turn finishes"/u);
  // Even asked to open, a locked picker renders no popover.
  assert.doesNotMatch(render({ selection: selection("grok-4.7", "xhigh", "task", false), initialOpen: true }), /guild-model-popover/u);
});

test("without an open task the trigger is disabled and reads the default label", () => {
  const markup = render({ selection: undefined, messages: ZH });
  assert.match(markup, /<button[^>]*disabled=""/u);
  assert.match(markup, /<span>\u9ed8\u8ba4\u6a21\u578b<\/span>/u);
  assert.match(markup, /\u6253\u5f00\u4e00\u4e2a\u5bf9\u8bdd\u540e\u624d\u80fd\u9009\u62e9\u6a21\u578b/u);
});

test("the open popover lists the catalog's models, descriptions and context windows", () => {
  const markup = render({ initialOpen: true });
  assert.match(markup, /role="dialog"/u);
  assert.match(markup, /aria-expanded="true"/u);
  assert.match(markup, /role="listbox"/u);
  assert.equal(markup.match(/role="option"/gu)?.length, 4);
  for (const name of ["Grok 4.7", "Grok 4.7 Fast", "Grok 4.6", "Grok 4.5"]) {
    assert.match(markup, new RegExp(`<strong>${name.replace(".", "\\.")}</strong>`, "u"));
  }
  assert.match(markup, /SpaceXAI&#x27;s latest frontier model/u);
  assert.match(markup, /Fast variant\. 2x the price\./u);
  assert.match(markup, /256K \/ 500K context/u);
  // Exactly the selected row is marked, and it alone is the roving tab stop.
  assert.equal(markup.match(/aria-selected="true"/gu)?.length, 1);
  const selectedRow = markup.match(/<button[^>]*aria-selected="true"[^>]*>/u)?.[0] ?? "";
  assert.match(selectedRow, /tabindex="0"/u);
  assert.match(selectedRow, /guild-model-row selected/u);
  assert.equal(markup.match(/role="option"[^>]*tabindex="-1"/gu)?.length, 3);
  assert.match(markup, /<svg/u);
});

test("the effort buttons come from the selected model, with the default marked and described", () => {
  const markup = render({ initialOpen: true });
  assert.match(markup, /role="radiogroup"/u);
  assert.equal(markup.match(/role="radio"/gu)?.length, 4);
  assert.equal(markup.match(/aria-checked="true"/gu)?.length, 1);
  assert.match(markup, /aria-checked="true"[^>]*>High/u);
  assert.match(markup, /title="Maximum reasoning for the hardest tasks\."/u);
  assert.match(markup, /title="Thorough reasoning and quality\. Recommended\."/u);
  assert.equal(markup.match(/guild-model-default-dot/gu)?.length, 1);
  assert.match(markup, /class="guild-sr-only"> \(default\)<\/span>/u);
  const grok45 = render({ initialOpen: true, selection: selection("grok-4.5", "high") });
  assert.equal(grok45.match(/role="radio"/gu)?.length, 3);
  assert.doesNotMatch(grok45, /Extra high/u);
});

test("Use default exists only while the task carries its own override", () => {
  assert.match(render({ initialOpen: true }), /class="guild-model-use-default"[^>]*>Use default<\/button>/u);
  assert.doesNotMatch(render({ initialOpen: true, selection: selection("grok-4.7", "high", "global") }), /guild-model-use-default/u);
  assert.doesNotMatch(render({ initialOpen: true, selection: selection("grok-4.7", "high", "runtime") }), /guild-model-use-default/u);
});

test("an empty catalog opens to a single hint and no choices", () => {
  const markup = render({
    initialOpen: true,
    catalogs: grokOnly({ models: [] }),
    selection: selection(null, null, "runtime"),
  });
  assert.match(markup, /Model choices appear once Grok has started\./u);
  assert.doesNotMatch(markup, /role="option"/u);
  assert.doesNotMatch(markup, /role="radio"/u);
  assert.match(markup, /<span>Default model<\/span>/u);
});

test("refusals, a saved selection and failures show inline inside the popover", () => {
  const refused = render({ initialOpen: true, initialNotice: { kind: "refused", reason: "unsupported_value" } });
  assert.match(
    refused,
    /<p class="guild-model-notice refused" role="alert">Grok does not offer that option for this task right now\. Your previous selection was kept\.<\/p>/u,
  );
  assert.match(
    render({ initialOpen: true, initialNotice: { kind: "refused", reason: "incompatible_agent" } }),
    /This model cannot be used in this conversation after it has started\. Your previous selection was kept\./u,
  );
  assert.match(
    render({ initialOpen: true, initialNotice: { kind: "refused", reason: "unavailable" } }),
    /Grok could not switch right now\. Your previous selection was kept\./u,
  );
  assert.match(
    render({ initialOpen: true, initialNotice: { kind: "saved" } }),
    /<p class="guild-model-notice saved" role="status">Applies when the session opens\.<\/p>/u,
  );
  assert.match(
    render({ initialOpen: true, initialNotice: { kind: "failed" } }),
    /<p class="guild-model-notice failed" role="alert">That action could not be completed\. Try again\.<\/p>/u,
  );
  // The notice sits next to the previous selection, which stays marked.
  assert.match(refused, /aria-selected="true"/u);
  // Nothing is shown outside the popover.
  assert.doesNotMatch(render({ initialNotice: { kind: "failed" } }), /guild-model-notice/u);
  const zh = render({ messages: ZH, initialOpen: true, initialNotice: { kind: "refused", reason: "unavailable" } });
  assert.match(zh, /Grok \u6682\u65f6\u65e0\u6cd5\u5207\u6362/u);
});

test("the popover keys, focus return and pointer handling are wired in the component", async () => {
  const source = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(source, /event\.key !== "Escape"/u);
  assert.match(source, /document\.addEventListener\("pointerdown", onPointerDown, true\)/u);
  assert.match(source, /document\.removeEventListener\("pointerdown", onPointerDown, true\)/u);
  assert.match(source, /triggerRef\.current\?\.focus\(\)/u);
  assert.match(source, /moveFocus\(event, '\[role="option"\]', "vertical"\)/u);
  assert.match(source, /moveFocus\(event, '\[role="radio"\]', "both"\)/u);
  // The picker never goes through the app-wide busy wrapper or the global error banner.
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const applied = app.slice(app.indexOf("async function applyTaskRuntimeSettings"), app.indexOf("async function setSessionConfigOption"));
  assert.match(applied, /applyModelSelectionChange\(api, \{/u);
  assert.doesNotMatch(applied, /run\(|setError|setBusy/u);
  assert.match(applied, /current\.activeTask\?\.task\.taskId !== response\.task\.task\.taskId/u);
  // A new task gets a new picker, so a pending request or notice never leaks across tasks.
  assert.match(app, /<ModelPicker\s+key=\{activeTask\?\.task\.taskId/u);
});

// ---- Guild 3.0 grouped picker (PC-MODEL-001)

const claudeCatalogs = Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG });
const renderClaude = (props: Partial<ModelPickerProps> = {}) => render({
  catalogs: claudeCatalogs,
  selection: selection("opus", "high"),
  taskEngine: "claude",
  engineFixed: true,
  initialOpen: true,
  onOpenModelSources: () => undefined,
  ...props,
});

test("a Claude task's open picker is one listbox of labelled groups: Claude, Online, Local", () => {
  const markup = renderClaude();
  assert.equal(markup.match(/role="listbox"/gu)?.length, 1);
  assert.equal(markup.match(/role="group"/gu)?.length, 3);
  for (const label of ["Claude", "Online", "Local"]) {
    assert.match(markup, new RegExp(`<div id="[^"]+-group-${label.toLowerCase()}" class="guild-model-heading guild-model-group-heading">${label}</div>`, "u"));
  }
  // Each group is named by its own heading.
  for (const group of ["claude", "online", "local"]) {
    const labelledBy = markup.match(new RegExp(`role="group" aria-labelledby="([^"]+-group-${group})"`, "u"))?.[1];
    assert.ok(labelledBy !== undefined, `${group} group is labelled`);
    assert.ok(markup.includes(`id="${labelledBy}"`), `${group} heading exists`);
  }
  assert.doesNotMatch(markup, /<strong>Grok 4\.7<\/strong>/u);
  assert.equal(markup.match(/role="option"/gu)?.length, 6);
  assert.match(markup, /<strong>DeepSeek V4 Flash<\/strong>/u);
  assert.match(markup, /<strong>Local 27B<\/strong>/u);
  // The one selected row is the one tab stop, in the Claude group.
  assert.equal(markup.match(/aria-selected="true"/gu)?.length, 1);
  assert.match(markup.match(/<button[^>]*aria-selected="true"[^>]*>/u)?.[0] ?? "", /tabindex="0"/u);
  // The "Model" heading would only repeat the group headings.
  assert.doesNotMatch(markup, /class="guild-model-heading">Model</u);
  // A Claude task has fixed its engine, so there is no note about choosing it.
  assert.doesNotMatch(markup, /guild-model-engine-note/u);
});

test("a new task's picker offers the Grok group next to the others and explains that the first message fixes the engine", () => {
  const markup = renderClaude({
    selection: selection("grok-4.7", "high", "runtime"),
    taskEngine: "grok",
    engineFixed: false,
  });
  assert.equal(markup.match(/role="group"/gu)?.length, 6);
  assert.match(markup, />Grok<\/div>/u);
  assert.match(markup, />ChatGPT<\/div>/u);
  assert.match(markup, />Gemini \(API, pay-as-you-go\)<\/div>/u);
  assert.match(markup, /<strong>Grok 4\.7 Fast<\/strong>/u);
  assert.match(markup, /<strong>Opus<\/strong>/u);
  assert.match(markup, /class="guild-model-footnote guild-model-engine-note">The model you pick for the first message decides whether this conversation runs on Grok, Claude, ChatGPT or Gemini\./u);
  const zh = renderClaude({ messages: ZH, selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false });
  assert.match(zh, />Claude（订阅）<\/div>/u);
  assert.match(zh, />ChatGPT（订阅）<\/div>/u);
  assert.match(zh, />Gemini（API 按量）<\/div>/u);
  assert.match(zh, />在线<\/div>/u);
  assert.match(zh, />本地<\/div>/u);
});

test("a Grok task that already ran renders exactly as before: no visible heading, the old list", () => {
  const markup = render({ initialOpen: true });
  assert.match(markup, /<div class="guild-model-heading">Model<\/div>/u);
  assert.match(markup, /role="group" aria-labelledby="[^"]+-group-grok"><div id="[^"]+-group-grok" class="guild-sr-only">Grok<\/div>/u);
  assert.equal(markup.match(/guild-model-group-heading/gu), null);
  assert.equal(markup.match(/role="option"/gu)?.length, 4);
});

test("an empty Online group shows the hint and a button that opens Model sources", () => {
  const onlyClaude = freezeModelCatalog("claude", {
    models: [{ id: "opus", name: "Opus", group: "claude", reasoningEfforts: [], contextWindows: [] }],
  });
  const markup = renderClaude({ catalogs: { grok: REAL_CATALOG, claude: onlyClaude }, claudeState: "ready" });
  // The hints are disabled options of the listbox, so a screen reader reaches and announces them (PC-MODEL-001).
  assert.match(markup, /<div class="guild-model-hint" role="option" aria-disabled="true" aria-selected="false" tabindex="-1"><p>No online models — add one in Settings › Model sources<\/p><\/div>/u);
  assert.match(markup, /<div class="guild-model-hint" role="option" aria-disabled="true" aria-selected="false" tabindex="-1"><p>No local models — add one in Settings › Model sources<\/p><\/div>/u);
  assert.equal(markup.match(/class="guild-model-action"/gu)?.length, 2);
  assert.match(markup, /<button type="button" role="option" aria-selected="false" tabindex="-1" class="guild-model-action">Open Model sources<\/button>/u);
  // Without a way to open settings the hint stays and the button goes.
  assert.doesNotMatch(renderClaude({ catalogs: { grok: REAL_CATALOG, claude: onlyClaude }, onOpenModelSources: undefined as never }), /guild-model-action/u);
});

test("empty-group hints are disabled options inside the listbox, so a screen reader announces them; a lone hint is plain text", () => {
  const onlyClaude = freezeModelCatalog("claude", {
    models: [{ id: "opus", name: "Opus", group: "claude", reasoningEfforts: [], contextWindows: [] }],
  });
  const markup = renderClaude({ catalogs: { grok: REAL_CATALOG, claude: onlyClaude }, claudeState: "ready" });
  const listbox = markup.match(/<div class="guild-model-list" role="listbox"[^>]*>(.*)<\/div><div class="guild-model-heading">/su)?.[1] ?? markup;
  const hints = listbox.match(/<div class="guild-model-hint"[^>]*>/gu) ?? [];
  assert.equal(hints.length, 2);
  for (const hint of hints) assert.equal(hint, '<div class="guild-model-hint" role="option" aria-disabled="true" aria-selected="false" tabindex="-1">');
  // Nothing in the listbox is a bare paragraph a screen reader would skip.
  assert.doesNotMatch(listbox, /<div class="guild-model-hint"><p>/u);
  // Disabled options are never the roving tab stop and never take a click.
  assert.doesNotMatch(listbox, /<div class="guild-model-hint"[^>]*tabindex="0"/u);
  // The help line of the Claude hint rides inside the same option.
  const claude = renderClaude({ catalogs: { grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG }, selection: selection(null, null, "runtime"), claudeState: "not_found" });
  assert.match(claude, /role="option" aria-disabled="true" aria-selected="false" tabindex="-1"><p>Claude Code not found or not logged in<\/p><small>Install Claude Code/u);
  // A picker with a single empty group has no listbox: its hint is plain text in the popover.
  const lone = render({ initialOpen: true, catalogs: grokOnly({ models: [] }), selection: selection(null, null, "runtime") });
  assert.match(lone, /<div class="guild-model-hint"><p>Model choices appear once Grok has started\.<\/p><\/div>/u);
  assert.doesNotMatch(lone, /role="listbox"/u);
});

test("the Claude group says Claude Code is not found or not logged in, with what to do", () => {
  const markup = renderClaude({
    catalogs: { grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG },
    selection: selection(null, null, "runtime"),
  });
  assert.match(markup, /<p>Claude Code not found or not logged in<\/p><small>Install Claude Code, then run `claude` once in Terminal and log in\.<\/small>/u);
  assert.match(markup, /No online models/u);
});

test("an Online model without efforts has no effort control; one with efforts keeps it", () => {
  const flash = renderClaude({ selection: selection("deepseek-v4-flash", null) });
  assert.doesNotMatch(flash, /role="radiogroup"/u);
  assert.doesNotMatch(flash, />Reasoning effort</u);
  assert.match(flash, /class="guild-model-footnote"/u);
  const reasoner = renderClaude({ selection: selection("deepseek-v4-reasoner", null) });
  assert.match(reasoner, /role="radiogroup"/u);
  assert.equal(reasoner.match(/role="radio"/gu)?.length, 2);
  const opus = renderClaude();
  assert.equal(opus.match(/role="radio"/gu)?.length, 6);
});

test("a locked picker still renders no popover for a Claude task", () => {
  const markup = renderClaude({ selection: selection("opus", "high", "task", false) });
  assert.doesNotMatch(markup, /guild-model-popover/u);
  assert.match(markup, /<span>Opus · High<\/span>/u);
});

test("the grouped picker keeps arrow-key navigation over every option and opens Model sources from its action", async () => {
  const source = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(source, /moveFocus\(event, '\[role="option"\]', "vertical"\)/u);
  assert.match(source, /role="group" aria-labelledby=\{headingId\}/u);
  assert.match(source, /setOpen\(false\);\s*onOpenModelSources\(\);/u);
  assert.match(source, /selectionForRow\(catalogs, row, view\.selectedEffortId, taskEngine\)/u);
  // The popover opens on the selected row, else the first row (a hint is also an option, but not what a person came to pick).
  assert.match(source, /querySelector<HTMLElement>\('\[role="option"\]\[aria-selected="true"\]'\) \?\?\s*\n\s*popover\.querySelector<HTMLElement>\('button\[role="option"\]:not\(\[aria-disabled="true"\]\)'\)/u);
  assert.match(source, /role="option" aria-disabled="true" aria-selected="false" tabIndex=\{-1\}/u);
});

// ---- Guild 3.1 part 2: the Gemini group (PC-ENG-004, PC-MODEL-001)

test("a Gemini task's picker shows the billing line under the group, its models and no effort control at all", () => {
  const catalogs = Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG, gemini: GEMINI_CATALOG });
  const markup = render({
    catalogs, selection: selection("gemini-3.8-flash", "high"), taskEngine: "gemini", geminiState: "ready", initialOpen: true,
  });
  // The trigger names the model alone: no effort, even a stored one.
  assert.match(markup, /<span>Gemini 3\.8 Flash<\/span>/u);
  assert.doesNotMatch(markup, /Gemini 3\.8 Flash \u00b7/u);
  // The one group, described by its billing line, which is not a heading and not an option.
  const group = /<div class="guild-model-group" role="group" aria-labelledby="([^"]+)" aria-describedby="([^"]+)">/u.exec(markup);
  assert.ok(group !== null);
  assert.equal(group[2], `${group[1]}-hint`);
  assert.match(markup, new RegExp(`<small id="${group[2]!.replace(/[:]/gu, "\\:")}" class="guild-model-group-hint">Billed per use on your Google AI Studio account</small>`, "u"));
  assert.doesNotMatch(markup, /guild-model-hint"[^>]*>Billed per use/u);
  assert.match(markup, /<strong>Gemini 3\.5 Flash-Lite<\/strong>/u);
  // No effort heading, no effort radios, no "no efforts" hint.
  assert.doesNotMatch(markup, /guild-model-efforts|role="radiogroup"/u);
  assert.doesNotMatch(markup, new RegExp(`class="guild-model-heading">${EN.reasoningEffort}<`, "u"));
  assert.doesNotMatch(markup, new RegExp(EN.modelPickerNoEfforts, "u"));
  // Chinese.
  const zh = render({ messages: ZH, catalogs, selection: selection("gemini-3.8-flash", null), taskEngine: "gemini", initialOpen: true });
  assert.match(zh, /class="guild-model-group-hint">按 Google AI Studio 账户的用量计费<\/small>/u);
});

test("a new task's picker lists the Gemini default row with what it starts on, under the Gemini heading and its billing line", () => {
  const markup = render({
    catalogs: Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG }),
    selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false, initialOpen: true,
  });
  const gemini = markup.match(/aria-labelledby="[^"]+-group-gemini"[^>]*>(.*?)<div class="guild-model-group" role="group" aria-labelledby="[^"]+-group-online"/su)?.[1] ?? "";
  assert.match(gemini, /class="guild-model-heading guild-model-group-heading">Gemini \(API, pay-as-you-go\)<\/div><small[^>]*class="guild-model-group-hint">Billed per use on your Google AI Studio account<\/small>/u);
  assert.match(gemini, /<strong>Gemini \(default model\)<\/strong>.*<small class="guild-model-row-description">Starts on the cheapest Flash model the session offers\.<\/small>/su);
  // With no usable key there is no row, only the way to fix it.
  const noKey = render({
    catalogs: Object.freeze({ grok: REAL_CATALOG, claude: CLAUDE_CATALOG }), geminiState: "not_logged_in",
    selection: selection("grok-4.7", "high", "runtime"), taskEngine: "grok", engineFixed: false, initialOpen: true,
  });
  assert.doesNotMatch(noKey, /Gemini \(default model\)/u);
  assert.match(noKey, /<p>Gemini not found or no API key<\/p><small>Install the Gemini CLI/u);
});
