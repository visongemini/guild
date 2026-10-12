import assert from "node:assert/strict";
import test from "node:test";
import { messagesFor } from "./locales.js";
import { CLAUDE_ADAPTER_CATALOG } from "./model-catalog.fixture.js";
import {
  currentProcessMode,
  groupOfModel,
  modelSwitchLine,
  modelSwitchRunning,
  processModeOfGroup,
  switchRestartsEngine,
  switchTargetName,
  type ModelSwitchState,
} from "./model-switch.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

test("Claude rows run natively, Online and Local rows through the router, and Grok has no mode [D-062]", () => {
  assert.equal(processModeOfGroup("claude"), "native");
  assert.equal(processModeOfGroup("online"), "routed");
  assert.equal(processModeOfGroup("local"), "routed");
  assert.equal(processModeOfGroup("grok"), undefined);
  assert.equal(processModeOfGroup(undefined), undefined);
  // A task whose model is unknown, or that follows Claude's default, is native.
  assert.equal(currentProcessMode(undefined), "native");
  assert.equal(currentProcessMode("claude"), "native");
  assert.equal(currentProcessMode("local"), "routed");
});

test("a switch restarts the engine exactly when it crosses the boundary in a Claude task that has run", () => {
  const base = { taskEngine: "claude" as const, engineFixed: true };
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "claude", targetGroup: "online" }), true);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "claude", targetGroup: "local" }), true);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "online", targetGroup: "claude" }), true);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "local", targetGroup: "claude" }), true);
  // Inside one mode nothing restarts: Opus to Sonnet, and Online to Local, Online to Online.
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "claude", targetGroup: "claude" }), false);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "online", targetGroup: "local" }), false);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "online", targetGroup: "online" }), false);
  // Clearing the choice falls back to Claude's default: native.
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "online", targetGroup: undefined }), true);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: "claude", targetGroup: undefined }), false);
  assert.equal(switchRestartsEngine({ ...base, currentGroup: undefined, targetGroup: "online" }), true, "a task on Claude's default");
  // No session yet, a Grok task: no restart to announce.
  assert.equal(switchRestartsEngine({ ...base, engineFixed: false, currentGroup: "claude", targetGroup: "online" }), false);
  assert.equal(switchRestartsEngine({ taskEngine: "grok", engineFixed: true, currentGroup: "grok", targetGroup: "online" }), false);
});

test("the group of a selected model is read from the Claude catalog", () => {
  assert.equal(groupOfModel(CLAUDE_ADAPTER_CATALOG, "opus"), "claude");
  assert.equal(groupOfModel(CLAUDE_ADAPTER_CATALOG, "deepseek-v4-flash"), "online");
  assert.equal(groupOfModel(CLAUDE_ADAPTER_CATALOG, "local-27b-model"), "local");
  assert.equal(groupOfModel(CLAUDE_ADAPTER_CATALOG, "gone"), undefined);
  assert.equal(groupOfModel(CLAUDE_ADAPTER_CATALOG, null), undefined);
});

test("the composer names the model it is switching to, the Default row by the model it stands for", () => {
  assert.equal(switchTargetName(ZH, CLAUDE_ADAPTER_CATALOG, "deepseek-v4-flash"), "DeepSeek V4 Flash");
  assert.equal(switchTargetName(ZH, CLAUDE_ADAPTER_CATALOG, "opus"), "Opus 5.5");
  assert.equal(switchTargetName(ZH, CLAUDE_ADAPTER_CATALOG, "default"), "默认（Opus 5.5）");
  assert.equal(switchTargetName(EN, CLAUDE_ADAPTER_CATALOG, "default"), "Default (Opus 5.5)");
  assert.equal(switchTargetName(EN, CLAUDE_ADAPTER_CATALOG, null), "Claude Code (default model)");
  assert.equal(switchTargetName(EN, CLAUDE_ADAPTER_CATALOG, "unlisted-1"), "unlisted-1");
});

test("the switching status is a one-line view model for the task that switches, and nothing for any other", () => {
  const switching: ModelSwitchState = { kind: "switching", taskId: "t1", modelName: "Opus 5.5" };
  const line = modelSwitchLine(switching, "t1", ZH);
  assert.deepEqual(line, { kind: "switching", text: "正在切换到「Opus 5.5」，需要重启引擎，通常 30–90 秒。消息会在切换完成后发出。" });
  assert.match(modelSwitchLine(switching, "t1", EN)?.text ?? "", /^Switching to .Opus 5\.5.\. The engine needs a restart, usually 30.90 seconds\./u);
  assert.equal(modelSwitchLine(switching, "t2", ZH), undefined, "another task's switch is not this task's line");
  assert.equal(modelSwitchLine(switching, undefined, ZH), undefined);
  assert.equal(modelSwitchLine(undefined, "t1", ZH), undefined, "gone on success");
  // A failure shows the existing selection-failure message, as given.
  const failed: ModelSwitchState = { kind: "failed", taskId: "t1", message: ZH.modelPickerRefused("unavailable") };
  assert.deepEqual(modelSwitchLine(failed, "t1", ZH), { kind: "failed", text: "Grok 暂时无法切换，已保留你之前的选择。" });
  // The trigger spins only while the switch runs.
  assert.equal(modelSwitchRunning(switching, "t1"), true);
  assert.equal(modelSwitchRunning(switching, "t2"), false);
  assert.equal(modelSwitchRunning(failed, "t1"), false);
  assert.equal(modelSwitchRunning(undefined, "t1"), false);
});
