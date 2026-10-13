import assert from "node:assert/strict";
import test from "node:test";
import { GUILD_ADDON_PERMISSION_MODES } from "@guild/contracts";
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
  assert.equal(messagesFor("en-US").reasoningEffortName("turbo", "Turbo mode"), "Turbo mode");
  assert.equal(messagesFor("zh-CN").reasoningEffortName("turbo"), "turbo");
  // Claude's two extra efforts: its own "Default" and the top "Max".
  assert.deepEqual(
    ["default", "low", "medium", "high", "xhigh", "max"].map((effort) => messagesFor("zh-CN").reasoningEffortName(effort, "Official")),
    ["默认", "低", "中", "高", "超高", "最高"],
  );
  assert.deepEqual(
    ["default", "low", "medium", "high", "xhigh", "max"].map((effort) => messagesFor("en-US").reasoningEffortName(effort, "Official")),
    ["Default", "Low", "Medium", "High", "Extra high", "Max"],
  );
});

test("Guild 3.0 strings exist, are non-empty and mention no undefined in both catalogs", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const texts: string[] = [
      messages.settingsEngines, messages.settingsModelSources, messages.settingsClaude, messages.enginesClaudeIntro,
      messages.modelPickerOpenModelSources, messages.modelPickerClaudeUnavailable, messages.modelPickerClaudeUnavailableHelp,
      messages.modelPickerClaudeNotStarted, messages.modelPickerClaudeDefault, messages.modelPickerEngineNote,
      messages.onlineReminderTitle, messages.onlineReminderLead("V"), messages.onlineReminderItemClaudeMd,
      messages.onlineReminderItemMemory, messages.onlineReminderItemConversation, messages.onlineReminderItemBrowser,
      messages.onlineReminderDontRemind, messages.onlineReminderSwitch,
      messages.privacyOnlineReminder, messages.privacyOnlineReminderHelp, messages.privacyOnlineReminderNoWorkspace, messages.privacyOnlineReminderFailed,
      messages.claudeDefaultModelOption, messages.claudeSettingsHelp, messages.claudeSettingsFailed, messages.claudeStatusLabel,
      messages.claudeStatusReady(undefined), messages.claudeStatusReady("Claude Max"), messages.claudeStatusNotFound,
      messages.claudeStatusNotLoggedIn, messages.claudeStatusUnavailable, messages.claudeStatusIntegrityChanged, messages.grokToolsGrokOnly,
      messages.usageClaudeHeading, messages.usageClaudeAccountUnknown, messages.usageClaudeQuota,
      messages.sourcesIntro, messages.sourcesLoading, messages.sourcesLoadFailed, messages.sourcesEmpty,
      messages.sourcesAdd, messages.sourcesEdit, messages.sourcesEditTitle, messages.sourcesAddTitle,
      messages.sourcesDeleteConfirm("L"), messages.sourcesDeleteFailed, messages.sourcesConfirm, messages.sourcesConfirming,
      messages.sourcesConfirmHelp("h", "V", "online"), messages.sourcesConfirmHelp("h", "V", "local"), messages.sourcesConfirmHelp("h", null, "local"), messages.sourcesConfirmedNotice,
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
    for (const reason of ["invalid", "reserved_id", "reserved_model", "duplicate_model", "limit", "changed", "not_found", "rejected"] as const) {
      texts.push(messages.sourcesSaveError(reason, 32));
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
  assert.deepEqual((["grok", "claude", "codex", "online", "local"] as const).map(en.modelGroupName), ["Grok", "Claude", "ChatGPT", "Online", "Local"]);
  assert.deepEqual((["grok", "claude", "codex", "online", "local"] as const).map(zh.modelGroupName), ["Grok", "Claude\uff08\u8ba2\u9605\uff09", "ChatGPT\uff08\u8ba2\u9605\uff09", "\u5728\u7ebf", "\u672c\u5730"]);
  assert.equal(en.modelPickerGroupEmpty("online"), "No online models \u2014 add one in Settings \u203a Model sources");
  assert.equal(en.modelPickerClaudeUnavailable, "Claude Code not found or not logged in");
  assert.equal(en.onlineReminderTitle, "Confirm before sending to an online model");
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

test("the Claude start-timeout wording is retryable and names Claude in both languages (PC-ENG-002)", () => {
  assert.equal(
    messagesFor("en-US", "claude").claudeStartTimeout,
    "Claude is still starting (plugins and connectors can take a while). Try again in a moment.",
  );
  assert.match(messagesFor("zh-CN", "claude").claudeStartTimeout, /Claude 仍在启动.*稍后再试/u);
});

test("Guild 3.1 add-on engine strings exist, are non-empty and mention no undefined in both catalogs (PC-ENG-003, PC-I18N-001)", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    const texts: string[] = [];
    for (const engine of ["codex"] as const) {
      texts.push(
        messages.settingsAddonHeading(engine), messages.enginesAddonIntro(engine), messages.addonSettingsHelp(engine),
        messages.addonSettingsFailed(engine), messages.addonDefaultModelOption(engine), messages.addonStartTimeout(engine),
        messages.addonStopCaveat(engine), messages.addonInstallCommand(engine), messages.addonLoginCommand(engine),
        messages.modelPickerAddonUnavailable(engine), messages.modelPickerAddonUnavailableHelp(engine),
        messages.modelPickerAddonNotStarted(engine), messages.modelPickerAddonDefault(engine),
        messages.addonStatusReady(engine, undefined), messages.addonStatusReady(engine, "ChatGPT Plus"),
        messages.addonStatusNotFound(engine), messages.addonStatusNotLoggedIn(engine), messages.addonStatusUnavailable(engine),
        messages.addonStatusIntegrityChanged(engine), messages.usageAddonHeading(engine),
        messages.usageAddonAccountManaged(engine), messages.usageAddonQuota(engine),
        messages.taskEngineName(engine), messages.taskEngineMarkerTitle(engine),
      );
      for (const mode of GUILD_ADDON_PERMISSION_MODES[engine]) {
        texts.push(messages.addonPermissionModeName(engine, mode), messages.addonPermissionModeHelp(engine, mode));
        // The mode ids are never shown raw: every mode has product wording.
        assert.notEqual(messages.addonPermissionModeName(engine, mode), mode, `${locale}: ${mode}`);
      }
    }
    for (const text of texts) {
      assert.equal(text.trim().length > 0, true, `${locale}: empty string`);
      assert.equal(text.includes("undefined"), false, `${locale}: ${text}`);
    }
  }
});

test("the Codex permission modes use the product's own Chinese words and the same four modes in English (3.0.2 labels)", () => {
  const zh = messagesFor("zh-CN");
  const en = messagesFor("en-US");
  const modes = GUILD_ADDON_PERMISSION_MODES.codex;
  assert.deepEqual(modes, ["read-only", "workspace-write", "agent", "agent-full-access"]);
  assert.deepEqual(modes.map((mode) => zh.addonPermissionModeName("codex", mode)), ["\u53ea\u8bfb\uff0c\u9700\u786e\u8ba4", "\u5de5\u4f5c\u533a\u8bbf\u95ee", "\u81ea\u52a8\u5ba1\u67e5", "\u5b8c\u5168\u8bbf\u95ee"]);
  assert.deepEqual(modes.map((mode) => en.addonPermissionModeName("codex", mode)), ["Read-only, ask first", "Workspace access", "Auto review", "Full access"]);
  // An id the engine does not offer falls back to the id itself rather than to another engine's wording.
  assert.equal(en.addonPermissionModeName("codex", "plan"), "plan");
  assert.equal(en.addonPermissionModeHelp("codex", "plan"), "");
});

test("the Codex task and marker names are the engine's own in both languages", () => {
  assert.deepEqual((["grok", "claude", "codex"] as const).map(messagesFor("en-US").taskEngineName), ["Grok", "Claude", "Codex"]);
  assert.equal(messagesFor("en-US").taskEngineMarkerTitle("codex"), "Codex conversation");
  assert.equal(messagesFor("zh-CN").taskEngineMarkerTitle("codex"), "Codex \u5bf9\u8bdd");
});

test("the Dock icon strings exist, are non-empty and mention no undefined in both catalogs (PC-SET-002)", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const messages = messagesFor(locale);
    for (const text of [messages.dockIcon, messages.dockIconHelp, messages.dockIconName("dark"), messages.dockIconName("light")]) {
      assert.equal(text.trim().length > 0, true, `${locale}: empty string`);
      assert.equal(text.includes("undefined"), false, `${locale}: ${text}`);
    }
  }
  assert.deepEqual([messagesFor("en-US").dockIcon, messagesFor("en-US").dockIconName("dark"), messagesFor("en-US").dockIconName("light")], ["Dock icon", "Dark", "Light"]);
  assert.deepEqual([messagesFor("zh-CN").dockIcon, messagesFor("zh-CN").dockIconName("dark"), messagesFor("zh-CN").dockIconName("light")], ["Dock 图标", "深色", "浅色"]);
});
