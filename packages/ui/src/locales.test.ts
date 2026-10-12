import assert from "node:assert/strict";
import test from "node:test";
import { LOCALES, claudeOverrideKeys, messagesFor } from "./locales.js";

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

test("Guild 3.0 strings exist, are non-empty and mention no undefined in both catalogs", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const texts: string[] = [
      messages.settingsEngines, messages.settingsModelSources, messages.settingsClaude, messages.enginesClaudeIntro,
      messages.modelPickerOpenModelSources, messages.modelPickerClaudeUnavailable, messages.modelPickerClaudeUnavailableHelp,
      messages.modelPickerClaudeNotStarted, messages.modelPickerEngineNote,
      messages.onlineReminderTitle("V"), messages.onlineReminderLead("V"), messages.onlineReminderItemClaudeMd,
      messages.onlineReminderItemMemory, messages.onlineReminderItemConversation, messages.onlineReminderItemBrowser,
      messages.onlineReminderDontRemind, messages.onlineReminderSwitch,
      messages.privacyOnlineReminder, messages.privacyOnlineReminderHelp, messages.privacyOnlineReminderNoWorkspace, messages.privacyOnlineReminderFailed,
      messages.claudeDefaultModelOption, messages.claudeSettingsHelp, messages.claudeSettingsFailed, messages.claudeStatusLabel,
      messages.claudeStatusReady(undefined), messages.claudeStatusReady("Claude Max"), messages.claudeStatusNotFound,
      messages.claudeStatusNotLoggedIn, messages.claudeStatusUnavailable, messages.claudeStatusIntegrityChanged, messages.grokToolsGrokOnly,
      messages.usageClaudeHeading, messages.usageClaudeAccountUnknown, messages.usageClaudeQuota,
      messages.sourcesIntro, messages.sourcesKeyNotice, messages.sourcesLoading, messages.sourcesLoadFailed, messages.sourcesEmpty,
      messages.sourcesAdd, messages.sourcesEdit, messages.sourcesEditTitle, messages.sourcesAddTitle,
      messages.sourcesDeleteConfirm("L"), messages.sourcesDeleteFailed, messages.sourcesConfirm, messages.sourcesConfirming,
      messages.sourcesConfirmHelp("h", "V"), messages.sourcesConfirmHelp("h", null), messages.sourcesConfirmedNotice,
      messages.sourcesConfirmCancelled, messages.sourcesConfirmFailed, messages.sourcesNeedsConfirmationNotice("L"),
      messages.sourcesFieldKind, messages.sourcesFieldLabel, messages.sourcesFieldBaseUrl, messages.sourcesFieldKeyFile,
      messages.sourcesKeyFilePlaceholder, messages.sourcesKeyFileHint, messages.sourcesFieldKeyVariable,
      messages.sourcesKeyVariablePlaceholder, messages.sourcesKeyVariableHint, messages.sourcesModels, messages.sourcesModelId,
      messages.sourcesModelLabel, messages.sourcesModelContext, messages.sourcesModelImages, messages.sourcesAddModel,
      messages.sourcesRemoveModel("m"), messages.sourcesRemoveModel(""), messages.sourcesEnabled, messages.sourcesSaving,
      messages.sourcesSaveFailed, messages.sourcesModelCount(1), messages.sourcesModelCount(3),
    ];
    for (const group of ["grok", "claude", "online", "local"] as const) texts.push(messages.modelGroupName(group));
    for (const group of ["online", "local"] as const) texts.push(messages.modelPickerGroupEmpty(group), messages.sourcesKindName(group), messages.sourcesBaseUrlHint(group));
    for (const engine of ["grok", "claude"] as const) texts.push(messages.taskEngineName(engine), messages.taskEngineMarkerTitle(engine));
    for (const status of ["confirmed", "needs_confirmation", "disabled"] as const) texts.push(messages.sourcesStatusName(status));
    for (const mode of ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const) {
      texts.push(messages.claudePermissionModeName(mode), messages.claudePermissionModeHelp(mode));
    }
    for (const problem of ["label", "base_url", "base_url_https", "key_file", "key_variable", "key_variable_secret", "models", "model_id", "model_duplicate", "model_label", "model_context"] as const) {
      texts.push(messages.sourcesInvalid(problem));
    }
    for (const text of texts) {
      assert.equal(text.trim().length > 0, true, `${locale}: empty string`);
      assert.equal(text.includes("undefined"), false, `${locale}: ${text}`);
    }
  }
});

test("the picker group names are the ones the product contract states", () => {
  const en = messagesFor("en-US");
  const zh = messagesFor("zh-CN");
  assert.deepEqual((["grok", "claude", "online", "local"] as const).map(en.modelGroupName), ["Grok", "Claude", "Online", "Local"]);
  assert.deepEqual((["grok", "claude", "online", "local"] as const).map(zh.modelGroupName), ["Grok", "Claude\uff08\u8ba2\u9605\uff09", "\u5728\u7ebf", "\u672c\u5730"]);
  assert.equal(en.modelPickerGroupEmpty("online"), "No online models \u2014 add one in Settings \u203a Model sources");
  assert.equal(en.modelPickerClaudeUnavailable, "Claude Code not found or not logged in");
  assert.equal(en.onlineReminderTitle("DeepSeek"), "Send this conversation to DeepSeek?");
  assert.equal(en.onlineReminderDontRemind, "Don't remind me again in this workspace");
  assert.equal(en.settingsEngines, "Engines");
  assert.equal(en.settingsModelSources, "Model sources");
});

test("both catalogs say Guild is independent of xAI and of Anthropic", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    for (const text of [messages.independentNotice, messages.aboutRole]) {
      assert.match(text, /Anthropic|Claude/u, `${locale}: ${text}`);
    }
    assert.match(messages.independentNotice, /xAI/u);
    assert.match(messages.independentNotice, /Anthropic/u);
    assert.match(messages.aboutRole, /Grok/u);
    assert.match(messages.aboutRole, /Claude Code/u);
  }
});

test("a Claude task words the runtime strings for Claude and leaves the Grok catalog untouched", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const grok = messagesFor(locale);
    const claude = messagesFor(locale, "claude");
    assert.equal(messagesFor(locale, "grok"), grok);
    assert.equal(messagesFor(locale), LOCALES[locale]);
    assert.notEqual(claude, grok);
    // Same keys, and only the listed ones differ.
    assert.deepEqual(Object.keys(claude).sort(), Object.keys(grok).sort());
    const overridden = claudeOverrideKeys(locale);
    assert.ok(overridden.length >= 25);
    for (const key of Object.keys(grok)) {
      const changed = (claude as Record<string, unknown>)[key] !== (grok as Record<string, unknown>)[key];
      assert.equal(changed, overridden.includes(key), `${locale}: ${key}`);
    }
    // Every plain-text override names Claude, not Grok.
    for (const key of overridden) {
      const value = (claude as Record<string, unknown>)[key];
      if (typeof value === "string") {
        assert.equal(/Grok/u.test(value), false, `${locale}: ${key} still says Grok`);
        if (key !== "terminalOutputUnavailable") assert.equal(/Claude/u.test(value), true, `${locale}: ${key} does not name Claude`);
      }
    }
  }
  assert.deepEqual(claudeOverrideKeys("zh-CN"), claudeOverrideKeys("en-US"));
});

test("the connecting and starting lines name the engine of the task", () => {
  assert.equal(messagesFor("en-US").connectingRuntime, "Connecting to Grok\u2026");
  assert.equal(messagesFor("en-US", "claude").connectingRuntime, "Connecting to Claude\u2026");
  assert.equal(messagesFor("zh-CN", "claude").connectingRuntime, "\u6b63\u5728\u8fde\u63a5 Claude\u2026");
  assert.equal(messagesFor("en-US", "claude").runPhaseStartingRuntime, "Starting Claude");
  assert.equal(messagesFor("en-US", "claude").runWaitingForGrok, "Claude received it; waiting for a response");
  assert.equal(messagesFor("en-US", "claude").slashCommands, "Claude commands");
  // Rewind under Claude is files only, and says so in Claude's name.
  assert.match(messagesFor("en-US", "claude").rewindFilesOnlyBody("unsupported"), /Claude Code cannot rewind the conversation, so only the files go back/u);
  assert.match(messagesFor("en-US", "claude").rewindRefused("runtime_unavailable"), /Claude Code/u);
  assert.equal(messagesFor("en-US", "claude").rewindDisabledReason("run_active"), messagesFor("en-US").rewindDisabledReason("run_active"));
});
