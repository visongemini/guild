import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_CLAUDE_MODEL_CATALOG,
  type GuildEngine,
  type SetTaskRuntimeSettingsResponse,
  type TaskModelSelectionProjection,
  type TaskViewProjection,
} from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { applyModelSelectionChange, type ModelChangeApi } from "./apply-model-change.js";
import { messagesFor } from "./locales.js";
import { REAL_CATALOG } from "./model-catalog.fixture.js";
import { isSameSelection, modelPickerView, nextPickerIndex, selectionForRow, type ModelSelectionChange } from "./model-picker.js";
import { ModelPicker } from "./ModelPicker.js";

/*
 * First 3.0 run (PC-ENG-001, PC-MODEL-001): Claude Code has not started yet, so the Claude catalog is empty. The only
 * way to a Claude task used to be an Online or Local model. "Claude Code (default model)" is the way in.
 */

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");
const FRESH_CATALOGS = Object.freeze({ grok: REAL_CATALOG, claude: EMPTY_CLAUDE_MODEL_CATALOG });
const TASK = "task-1" as never;

const freshSelection = (): TaskModelSelectionProjection =>
  Object.freeze({ modelId: "grok-4.7", reasoningEffort: "high", source: "runtime", canChange: true });

function render(over: { taskEngine?: GuildEngine; engineFixed?: boolean; selection?: TaskModelSelectionProjection; claudeState?: "ready" | "not_found"; locale?: "en" | "zh" } = {}): string {
  return renderToStaticMarkup(
    <ModelPicker
      messages={over.locale === "zh" ? ZH : EN}
      catalogs={FRESH_CATALOGS}
      selection={over.selection ?? freshSelection()}
      taskEngine={over.taskEngine ?? "grok"}
      engineFixed={over.engineFixed ?? false}
      {...(over.claudeState === undefined ? {} : { claudeState: over.claudeState })}
      onOpenModelSources={() => undefined}
      onApply={async () => { throw new Error("not called"); }}
      initialOpen
    />,
  );
}

/** Every option of the listbox, in document order, as its opening tag. */
const optionTags = (markup: string): string[] => markup.match(/<(?:button|div)[^>]*role="option"[^>]*>/gu) ?? [];

test("from an empty Claude catalog the Claude group lists one selectable row, then the hint that models come later", () => {
  const markup = render({ claudeState: "ready" });
  const claudeGroup = markup.match(/role="group" aria-labelledby="[^"]+-group-claude">(.*?)<div id="[^"]+-group-online"/su)?.[1] ?? "";
  assert.match(claudeGroup, /<button type="button" role="option" aria-selected="false" tabindex="-1" class="guild-model-row"><span class="guild-model-row-name"><span class="guild-model-row-title"><strong>Claude Code \(default model\)<\/strong>/u);
  assert.match(claudeGroup, /<div class="guild-model-hint" role="option" aria-disabled="true" aria-selected="false" tabindex="-1"><p>Model choices appear once Claude has started\.<\/p><\/div>/u);
  assert.ok(claudeGroup.indexOf("Claude Code (default model)") < claudeGroup.indexOf("Model choices appear"));
  assert.match(render({ claudeState: "ready", locale: "zh" }), /<strong>Claude Code（默认模型）<\/strong>/u);
  // A missing installation offers no row (there is nothing to start), only the way to fix it.
  const missing = render({ claudeState: "not_found" });
  assert.doesNotMatch(missing, /Claude Code \(default model\)/u);
  assert.match(missing, /Claude Code not found or not logged in/u);
});

test("the row is reachable and activated by keyboard: a native button in the roving listbox, between its neighbours", () => {
  const options = optionTags(render({ claudeState: "ready" }));
  const names = options.map((tag) => tag.startsWith("<button") ? "button" : "hint");
  // 4 Grok rows, the default row, then the Claude hint, the ChatGPT default row and its hint, the two group hints with their actions.
  assert.deepEqual(names, ["button", "button", "button", "button", "button", "hint", "button", "hint", "hint", "button", "hint", "button"]);
  // Every option takes focus (a row by its tab stop, the rest at tabindex -1), so the arrow keys reach all of them.
  assert.equal(options.every((tag) => /tabindex="-?\d"/u.test(tag)), true);
  assert.equal(options.filter((tag) => /tabindex="0"/u.test(tag)).length, 1, "one roving tab stop");
  // ArrowDown from the last Grok row lands on the default row, ArrowUp from the hint lands back on it.
  assert.equal(nextPickerIndex(3, options.length, "ArrowDown", "vertical"), 4);
  assert.equal(nextPickerIndex(5, options.length, "ArrowUp", "vertical"), 4);
  // A Claude task that follows its default has the row as its selection and tab stop.
  const following = render({
    taskEngine: "claude",
    engineFixed: true,
    claudeState: "ready",
    selection: Object.freeze({ modelId: null, reasoningEffort: null, source: "runtime", canChange: true }),
  });
  const selected = following.match(/<button[^>]*aria-selected="true"[^>]*>/u)?.[0] ?? "";
  assert.match(selected, /tabindex="0"/u);
  assert.match(following, /aria-selected="true" tabindex="0" class="guild-model-row selected"><span class="guild-model-row-name"><span class="guild-model-row-title"><strong>Claude Code \(default model\)/u);
});

test("picking the row on a task that has not run moves it to Claude with setTaskEngine, then follows Claude's default", async () => {
  const selection = freshSelection();
  const view = modelPickerView({
    messages: EN, catalogs: FRESH_CATALOGS, selection, taskEngine: "grok", engineFixed: false, claudeState: "ready",
  });
  const row = view.models.find((candidate) => candidate.runtimeDefault === true);
  assert.ok(row !== undefined);
  const change: ModelSelectionChange = selectionForRow(FRESH_CATALOGS, row, view.selectedEffortId, "grok");
  // The picker's own guard lets it through: only the engine differs from the Grok task's "follow the runtime".
  assert.equal(isSameSelection(selection, change), false);

  const calls: string[] = [];
  const movedTask = { task: { taskId: TASK, engine: "claude" } } as unknown as TaskViewProjection;
  const api: ModelChangeApi = {
    setTaskEngine: async (request) => {
      calls.push(`engine:${JSON.stringify(request)}`);
      return movedTask;
    },
    setTaskRuntimeSettings: async (request) => {
      calls.push(`settings:${JSON.stringify(request)}`);
      return { status: "saved", task: movedTask } as unknown as SetTaskRuntimeSettingsResponse;
    },
  };
  const adopted: TaskViewProjection[] = [];
  const response = await applyModelSelectionChange(api, {
    taskId: TASK, taskEngine: "grok", change, onEngineMoved: (task) => adopted.push(task),
  });
  assert.deepEqual(calls, [
    'engine:{"taskId":"task-1","engine":"claude"}',
    'settings:{"taskId":"task-1","model":null,"reasoningEffort":null}',
  ]);
  assert.deepEqual(adopted, [movedTask], "the moved task is adopted before the settings request");
  assert.equal(response.status, "saved");

  // A task already on Claude is not moved again.
  calls.length = 0;
  await applyModelSelectionChange(api, { taskId: TASK, taskEngine: "claude", change, onEngineMoved: (task) => adopted.push(task) });
  assert.deepEqual(calls, ['settings:{"taskId":"task-1","model":null,"reasoningEffort":null}']);
});

test("a Claude task before Claude's first start shows the default label in the trigger, whichever group is the first row (PC-MODEL-001)", () => {
  const unpinned = modelPickerView({
    messages: EN,
    catalogs: FRESH_CATALOGS,
    selection: Object.freeze({ modelId: null, reasoningEffort: null, source: "runtime", canChange: true }),
    taskEngine: "claude",
    engineFixed: false,
    claudeState: "ready",
  });
  assert.equal(unpinned.triggerText, "Claude Code (default model)");
  assert.equal(
    modelPickerView({
      messages: ZH,
      catalogs: FRESH_CATALOGS,
      selection: Object.freeze({ modelId: null, reasoningEffort: null, source: "runtime", canChange: true }),
      taskEngine: "claude",
      claudeState: "ready",
    }).triggerText,
    "Claude Code（默认模型）",
  );
  // A saved native alias names itself until the adapter has reported its list; a Grok task keeps its own label.
  assert.equal(
    modelPickerView({
      messages: EN,
      catalogs: FRESH_CATALOGS,
      selection: Object.freeze({ modelId: "opus", reasoningEffort: null, source: "task", canChange: true }),
      taskEngine: "claude",
      claudeState: "ready",
    }).triggerText,
    "opus",
  );
  assert.equal(
    modelPickerView({
      messages: EN,
      catalogs: FRESH_CATALOGS,
      selection: Object.freeze({ modelId: null, reasoningEffort: null, source: "runtime", canChange: true }),
      taskEngine: "grok",
    }).triggerText,
    "Default model",
  );
});
