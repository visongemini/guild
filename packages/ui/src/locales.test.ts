import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, messagesFor } from "./locales.js";

test("Chinese and English catalogs expose the same keys", () => {
  assert.deepEqual(Object.keys(LOCALES["zh-CN"]).sort(), Object.keys(LOCALES["en-US"]).sort());
});

test("settings and profile strings are present in both catalogs", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    assert.equal(messages.settingsGeneral.length > 0, true);
    assert.equal(messages.settingsGrok.length > 0, true);
    assert.equal(messages.settingsPrivacy.length > 0, true);
    assert.equal(messages.settingsAbout.length > 0, true);
    assert.equal(messages.editProfile.length > 0, true);
    assert.equal(messages.localProfile.length > 0, true);
    assert.equal(messages.restoreLastTask.length > 0, true);
    assert.equal(messages.newTaskWorkspaceAsk.length > 0, true);
    assert.equal(messages.privacyBrowserSyncOff.length > 0, true);
    assert.equal(messages.openDataDirectory.length > 0, true);
    assert.equal(messages.workspaceFolderMissing.length > 0, true);
    assert.equal(messages.messageTooLong.length > 0, true);
    assert.equal(messages.closeDialog.length > 0, true);
    assert.equal(messages.commandWaiting.length > 0, true);
    assert.equal(messages.commandCompleted.length > 0, true);
    assert.equal(messages.toolKindLabel("search").length > 0, true);
  }
});

test("model picker and run phase strings exist and are non-empty in both catalogs", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    for (const text of [
      messages.runtimeDefaultOption, messages.reasoningFollowsRuntimeDefault, messages.modelDefaultName,
      messages.modelPickerTitle, messages.modelPickerAria("a", "b"), messages.modelPickerAria("a", "b", "c"),
      messages.modelPickerScopeTask, messages.modelPickerScopeGlobal, messages.modelPickerScopeRuntime,
      messages.modelPickerDisabledNoTask, messages.modelPickerDisabledRunning, messages.modelPickerDisabledPending,
      messages.modelPickerContext("256K"), messages.modelPickerDefaultMark, messages.modelPickerUseDefault,
      messages.modelPickerEmpty, messages.modelPickerNoEfforts, messages.modelPickerSaved,
      messages.modelPickerRefused("incompatible_agent"), messages.modelPickerRefused("unsupported_value"),
      messages.modelPickerRefused("unavailable"), messages.runDuration(65),
      messages.runPhaseStartingRuntime, messages.runPhaseOpeningSession, messages.runPhaseMcp(3, 7),
      messages.runPhasePromptSent, messages.runPhasePromptSentSlow, messages.runPhaseQueued(2),
      messages.runPhaseRunningHooks(2), messages.runPhaseWaitingForModel, messages.runPhaseThinking,
      messages.runPhasePreparingTool("Bash"), messages.runPhaseWaitingForPermission,
      messages.runPhaseRunningTool("Bash"), messages.runPhaseRetrying(2, 5), messages.runPhaseResponding,
      messages.runPhaseTime("23s", "35s"), messages.runPhaseTime(undefined, "35s"),
    ]) {
      assert.equal(text.length > 0, true, `${locale}: empty string`);
      assert.equal(text.includes("undefined"), false, `${locale}: ${text}`);
    }
  }
});

test("effort names are localized for the well-known ids and fall back to the runtime label, then the id", () => {
  assert.equal(messagesFor("en-US").reasoningEffortName("xhigh"), "Extra high");
  assert.equal(messagesFor("zh-CN").reasoningEffortName("xhigh"), "\u8d85\u9ad8");
  assert.equal(messagesFor("en-US").reasoningEffortName("max", "Maximum"), "Maximum");
  assert.equal(messagesFor("zh-CN").reasoningEffortName("max"), "max");
});
