import type { AcpToolKind, GuildClaudePermissionMode, GuildEngine, GuildGrokManagementAction, GuildGrokPermissionMode, GuildLocale, GuildModelSwitchRefusalReason, GuildTaskActivity, ModelGroup } from "@guild/contracts";

import { WORKSHOP_ZH, WORKSHOP_EN, type WorkshopMessages } from "./workshop-messages.js";
import { createChangeMessages, type ChangeMessages } from "./change-messages.js";
import { ZH_TOOL_ACTION, classifyToolName } from "./tool-names.js";

export type GuildMessages = WorkshopMessages & ChangeMessages & {
  readonly appName: string;
  readonly loading: string;
  readonly newTask: string;
  readonly projects: string;
  readonly extensions: string;
  readonly automation: string;
  readonly library: string;
  readonly projectAndChats: string;
  readonly noWorkspaceTitle: string;
  readonly noWorkspaceBody: string;
  readonly chooseWorkspace: string;
  readonly welcomeTitle: string;
  readonly welcomeBody: string;
  readonly composerPlaceholder: string;
  readonly connectingRuntime: string;
  readonly queuePlaceholder: string;
  readonly queueReady: string;
  readonly queuedNext: string;
  readonly queuedFirst: string;
  readonly preemptQueued: string;
  readonly preemptingQueued: string;
  readonly cancelQueued: string;
  readonly selectWorkspaceFirst: string;
  readonly send: string;
  readonly stop: string;
  readonly continuousMode: string;
  readonly continuousModeHelp: string;
  readonly continuousCycle: (cycle: number) => string;
  readonly continuousWorkPhase: string;
  readonly continuousAuditPhase: string;
  readonly continuousPause: string;
  readonly continuousResume: string;
  readonly continuousStop: string;
  readonly continuousPaused: string;
  readonly continuousBlocked: string;
  readonly continuousCompleted: string;
  readonly continuousRemaining: string;
  readonly continuousObjective: string;
  readonly continuousSummary: string;
  readonly continuousDetails: string;
  readonly continuousNoRemaining: string;
  readonly continuousRoundRecord: string;
  readonly continuousReportedVerdict: string;
  readonly continuousVerdict: (verdict: "CONTINUE" | "COMPLETE" | "BLOCKED") => string;
  readonly continuousStopReasonLabel: string;
  readonly continuousStopReason: (reason: string) => string;
  readonly thinking: string;
  readonly thinkingFor: (seconds: number) => string;
  readonly activeActivity: (activity: GuildTaskActivity) => string;
  readonly activeActivityFor: (activity: GuildTaskActivity, seconds: number) => string;
  readonly runQueued: string;
  readonly runPreparing: string;
  readonly runWaitingForGrok: string;
  readonly runElapsed: (seconds: number) => string;
  readonly conversation: string;
  readonly cancelledActivity: string;
  readonly interruptedActivity: string;
  readonly failedActivity: string;
  readonly thoughtFor: (seconds: number) => string;
  readonly usedTools: (count: number) => string;
  readonly toolDetails: string;
  readonly viewImage: string;
  readonly closeImage: string;
  readonly imagePreview: string;
  readonly fileChange: string;
  readonly beforeChange: string;
  readonly afterChange: string;
  readonly terminalOutputUnavailable: string;
  readonly unsupportedToolContent: (contentType: string) => string;
  readonly permissionNeeded: string;
  readonly cancel: string;
  readonly archive: string;
  readonly archived: string;
  readonly restore: string;
  readonly restoreNamed: (name: string) => string;
  readonly restoreTaskNamed: (task: string, workspace: string) => string;
  readonly pin: string;
  readonly unpin: string;
  readonly pinned: string;
  readonly rename: string;
  readonly renameTask: string;
  readonly taskTitle: string;
  readonly taskTitleInvalid: string;
  readonly delete: string;
  readonly confirmDelete: string;
  readonly confirmDeleteTask: (title: string) => string;
  readonly confirmDeleteWorkspace: (name: string, taskCount: number) => string;
  readonly stopTaskBeforeManage: string;
  readonly openMenu: string;
  readonly settings: string;
  readonly settingsGeneral: string;
  readonly settingsGrok: string;
  readonly settingsPrivacy: string;
  readonly settingsAbout: string;
  readonly editProfile: string;
  readonly localProfile: string;
  readonly nickname: string;
  readonly nicknameHelp: string;
  readonly changeAvatar: string;
  readonly resetAvatar: string;
  readonly save: string;
  readonly discardChanges: string;
  readonly discardChangesBody: string;
  readonly keepEditing: string;
  readonly discard: string;
  readonly nicknameInvalid: string;
  readonly avatarTooLarge: string;
  readonly avatarInvalid: string;
  readonly avatarUnsupported: string;
  readonly restoreLastTask: string;
  readonly restoreLastTaskHelp: string;
  readonly newTaskWorkspace: string;
  readonly newTaskWorkspaceAsk: string;
  readonly newTaskWorkspaceLast: string;
  readonly taskNotifications: string;
  readonly taskNotificationsHelp: string;
  readonly taskStatusRunning: string;
  readonly taskStatusQueued: (count: number) => string;
  readonly taskStatusPermission: string;
  readonly taskStatusFailed: string;
  readonly taskStatusInterrupted: string;
  readonly taskStatusCancelled: string;
  readonly privacyBrowserSyncOff: string;
  readonly privacyBrowserSyncHelp: string;
  readonly openDataDirectory: string;
  readonly backupData: string;
  readonly backupSaving: string;
  readonly backupSaved: string;
  readonly backupFailed: string;
  readonly localData: string;
  readonly localDataHelp: string;
  readonly aboutCopyright: string;
  readonly aboutRole: string;
  readonly closeDialog: string;
  readonly language: string;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly permissionMode: string;
  /** Localized name for the well-known efforts, else the runtime's own label, else the raw id. */
  readonly reasoningEffortName: (effort: string, officialLabel?: string) => string;
  readonly runtimeDefaultOption: string;
  readonly reasoningFollowsRuntimeDefault: string;
  readonly modelDefaultName: string;
  readonly modelPickerTitle: string;
  readonly modelPickerAria: (summary: string, scope: string, disabled?: string) => string;
  readonly modelPickerScopeTask: string;
  readonly modelPickerScopeGlobal: string;
  readonly modelPickerScopeRuntime: string;
  readonly modelPickerDisabledNoTask: string;
  readonly modelPickerDisabledRunning: string;
  readonly modelPickerDisabledPending: string;
  readonly modelPickerContext: (sizes: string) => string;
  readonly modelPickerDefaultMark: string;
  readonly modelPickerUseDefault: string;
  readonly modelPickerEmpty: string;
  readonly modelPickerNoEfforts: string;
  readonly modelPickerSaved: string;
  readonly modelPickerRefused: (reason: GuildModelSwitchRefusalReason) => string;
  // Guild 3.0 grouped picker (PC-MODEL-001)
  readonly modelGroupName: (group: ModelGroup) => string;
  readonly modelPickerGroupEmpty: (group: "online" | "local") => string;
  readonly modelPickerOpenModelSources: string;
  readonly modelPickerClaudeUnavailable: string;
  readonly modelPickerClaudeUnavailableHelp: string;
  readonly modelPickerClaudeNotStarted: string;
  /** The Claude group's one row while Claude Code lists no model yet: the task follows Claude Code's own default. */
  readonly modelPickerClaudeDefault: string;
  readonly modelPickerEngineNote: string;
  readonly taskEngineName: (engine: GuildEngine) => string;
  readonly taskEngineMarkerTitle: (engine: GuildEngine) => string;
  // Online-model reminder (PC-PRIV-001)
  readonly onlineReminderTitle: (vendor: string) => string;
  readonly onlineReminderLead: (vendor: string) => string;
  readonly onlineReminderItemClaudeMd: string;
  readonly onlineReminderItemMemory: string;
  readonly onlineReminderItemConversation: string;
  readonly onlineReminderItemBrowser: string;
  readonly onlineReminderDontRemind: string;
  readonly onlineReminderSwitch: string;
  readonly privacyOnlineReminder: string;
  readonly privacyOnlineReminderHelp: string;
  readonly privacyOnlineReminderNoWorkspace: string;
  readonly privacyOnlineReminderFailed: string;
  // Settings: Engines and Model sources (PC-SET-002)
  readonly settingsEngines: string;
  readonly settingsModelSources: string;
  readonly settingsClaude: string;
  readonly enginesClaudeIntro: string;
  readonly claudeDefaultModelOption: string;
  readonly claudePermissionModeName: (mode: GuildClaudePermissionMode) => string;
  readonly claudePermissionModeHelp: (mode: GuildClaudePermissionMode) => string;
  readonly claudeSettingsHelp: string;
  readonly claudeSettingsFailed: string;
  readonly claudeStatusLabel: string;
  readonly claudeStatusReady: (account: string | undefined) => string;
  readonly claudeStatusNotFound: string;
  readonly claudeStatusNotLoggedIn: string;
  readonly claudeStatusUnavailable: string;
  readonly grokToolsGrokOnly: string;
  readonly sourcesIntro: string;
  readonly sourcesKeyNotice: string;
  readonly sourcesLoading: string;
  readonly sourcesLoadFailed: string;
  readonly sourcesEmpty: string;
  readonly sourcesAdd: string;
  readonly sourcesEdit: string;
  readonly sourcesEditTitle: string;
  readonly sourcesAddTitle: string;
  readonly sourcesDeleteConfirm: (label: string) => string;
  readonly sourcesDeleteFailed: string;
  readonly sourcesKindName: (kind: "online" | "local") => string;
  readonly sourcesStatusName: (status: "confirmed" | "needs_confirmation" | "disabled") => string;
  readonly sourcesModelCount: (count: number) => string;
  readonly sourcesConfirm: string;
  readonly sourcesConfirming: string;
  readonly sourcesConfirmHelp: (host: string, variable: string | null, kind: "online" | "local") => string;
  readonly sourcesConfirmedNotice: string;
  readonly sourcesConfirmCancelled: string;
  readonly sourcesConfirmFailed: string;
  readonly sourcesNeedsConfirmationNotice: (label: string) => string;
  readonly sourcesFieldKind: string;
  readonly sourcesFieldLabel: string;
  readonly sourcesFieldBaseUrl: string;
  readonly sourcesBaseUrlHint: (kind: "online" | "local") => string;
  readonly sourcesFieldKeyFile: string;
  readonly sourcesKeyFilePlaceholder: string;
  readonly sourcesKeyFileHint: string;
  readonly sourcesFieldKeyVariable: string;
  readonly sourcesKeyVariablePlaceholder: string;
  readonly sourcesKeyVariableHint: string;
  readonly sourcesModels: string;
  readonly sourcesModelId: string;
  readonly sourcesModelLabel: string;
  readonly sourcesModelContext: string;
  readonly sourcesModelImages: string;
  readonly sourcesAddModel: string;
  readonly sourcesRemoveModel: (id: string) => string;
  readonly sourcesEnabled: string;
  readonly sourcesSaving: string;
  readonly sourcesSaveFailed: string;
  readonly sourcesSaveError: (reason: "invalid" | "reserved_id" | "reserved_model" | "duplicate_model" | "limit" | "changed" | "not_found" | "rejected", maxSources: number) => string;
  readonly sourcesInvalid: (problem: "label" | "base_url" | "base_url_https" | "key_file" | "key_variable" | "key_variable_secret" | "models" | "model_id" | "model_duplicate" | "model_label" | "model_context") => string;
  // Claude usage popover (PC-ENG-001)
  readonly usageClaudeHeading: string;
  readonly usageClaudeAccountUnknown: string;
  readonly usageClaudeQuota: string;
  readonly runDuration: (seconds: number) => string;
  readonly runPhaseStartingRuntime: string;
  readonly runPhaseOpeningSession: string;
  readonly runPhaseMcp: (connected: number, total: number) => string;
  readonly runPhasePromptSent: string;
  readonly runPhasePromptSentSlow: string;
  readonly runPhaseQueued: (position?: number) => string;
  readonly runPhaseRunningHooks: (count?: number) => string;
  readonly runPhaseWaitingForModel: string;
  readonly runPhaseThinking: string;
  readonly runPhasePreparingTool: (toolName?: string) => string;
  readonly runPhaseWaitingForPermission: string;
  readonly runPhaseRunningTool: (toolName?: string) => string;
  readonly runPhaseRetrying: (attempt?: number, maxRetries?: number) => string;
  readonly runPhaseResponding: string;
  readonly runPhaseTime: (phase: string | undefined, total: string) => string;
  readonly runtimeSettingsBusy: string;
  readonly runtimeSettingsHelp: string;
  readonly webSearch: string;
  readonly webSearchHelp: string;
  readonly planMode: string;
  readonly planModeHelp: string;
  readonly subagents: string;
  readonly subagentsHelp: string;
  readonly maxTurns: string;
  readonly unlimited: string;
  readonly startupBehavior: string;
  readonly usage: string;
  readonly usageLoading: string;
  readonly usageUnavailable: string;
  readonly usageResetsAt: (date: string) => string;
  readonly viewOfficialUsage: string;
  readonly version: string;
  readonly independentNotice: string;
  readonly recovered: string;
  readonly today: string;
  readonly yesterday: string;
  readonly earlier: string;
  readonly emptyTask: string;
  readonly currentAttention: string;
  readonly latestResult: string;
  readonly latestResultNoChanges: string;
  readonly interruptedResult: string;
  readonly failedResult: string;
  readonly cancelledResult: string;
  readonly interruptedResultUnconfirmed: string;
  readonly latestResultCounts: (files: number, diffs: number) => string;
  readonly viewResult: string;
  readonly recoveryNoticeTitle: string;
  readonly recoveryNoticeBody: string;
  readonly recoveryNoticeRestored: string;
  readonly recoveryRetryAction: string;
  readonly addWorkspaceFiles: string;
  readonly attachedFiles: string;
  readonly attachmentsCannotQueue: string;
  readonly removeAttachment: (name: string) => string;
  readonly bannyDragHint: string;
  readonly bannySeated: string;
  readonly runtimeUnavailable: string;
  readonly workspaceFolderMissing: string;
  readonly messageTooLong: string;
  readonly sessionReplacementTitle: string;
  readonly sessionReplacementBody: string;
  readonly sessionReplacementAction: string;
  readonly sessionRecoveryContextRequired: string;
  readonly operationFailed: string;
  readonly startupUnavailable: string;
  readonly retry: string;
  readonly code: string;
  readonly permissionOnDemand: string;
  readonly permissionFullAccess: string;
  readonly permissionFullAccessHelp: string;
  readonly contextUsageUnavailable: string;
  readonly contextUsageUnavailableCompact: string;
  readonly loadingEarlierHistory: string;
  readonly slashCommands: string;
  readonly slashCommandsEmpty: string;
  readonly commandSending: string;
  readonly goalPreparing: string;
  readonly commandWaiting: string;
  readonly commandRunning: string;
  readonly commandRunningTool: (title: string) => string;
  readonly auxiliaryWorkers: (count: number, activity: string) => string;
  readonly commandAwaitingPermission: string;
  readonly commandCompleting: string;
  readonly commandStopping: string;
  readonly commandCompleted: string;
  readonly commandFailed: string;
  readonly commandCancelled: string;
  readonly commandInterrupted: string;
  readonly toolKindLabel: (kind: AcpToolKind) => string;
  readonly contextUsageUsedOnly: (used: string) => string;
  readonly contextUsageCompact: (used: string, size: string, percent: number) => string;
  readonly contextUsageLabel: (used: string, size: string, percent: number) => string;
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly clearSearch: string;
  readonly noSearchResults: string;
  readonly searchingConversation: string;
  readonly inConversation: string;
  readonly forkFromHere: string;
  readonly commandPalette: string;
  readonly commandPalettePlaceholder: string;
  readonly commandPaletteEmpty: string;
  readonly commandPaletteHint: string;
  readonly commandPaletteGroup: (group: "navigation" | "tasks" | "commands") => string;
  readonly messageActions: string;
  readonly copyMessage: string;
  readonly branchFromMessage: string;
  readonly branchMessageHelp: string;
  readonly retryToDraft: string;
  readonly retryToDraftHelp: string;
  readonly localSettingScope: string;
  readonly officialSettingScope: string;
  readonly exportMarkdown: string;
  readonly exportJson: string;
  readonly workbench: string;
  readonly files: string;
  readonly review: string;
  readonly filesTouched: string;
  readonly noFilesYet: string;
  readonly noChangesYet: string;
  readonly openTerminal: string;
  readonly openTerminalHelp: string;
  readonly emptyFile: string;
  readonly browserPaneWorkbenchTab: string;
  readonly browserPaneTitle: string;
  readonly browserPaneTabs: string;
  readonly browserPaneNewTab: string;
  readonly browserPaneCloseTab: string;
  readonly browserPaneTabLimit: string;
  readonly browserPaneUntitledTab: string;
  readonly browserPaneBack: string;
  readonly browserPaneForward: string;
  readonly browserPaneReload: string;
  readonly browserPaneStop: string;
  readonly browserPaneAddress: string;
  readonly browserPaneAddressPlaceholder: string;
  readonly browserPaneInvalidAddress: string;
  readonly browserPaneAgentIdle: string;
  readonly browserPaneAgentOperating: string;
  readonly browserPaneAgentPaused: string;
  readonly browserPaneTakeOver: string;
  readonly browserPaneResume: string;
  readonly browserPaneEmpty: string;
  readonly permissionModeName: (mode: GuildGrokPermissionMode) => string;
  readonly officialSessionCapabilities: string;
  readonly startTaskForCapabilities: string;
  readonly sessionModes: string;
  readonly officialCommands: string;
  readonly commandsAppearAfterConnect: string;
  readonly enabled: string;
  readonly disabled: string;
  readonly resizeSidebar: string;
  readonly workspaceFallback: string;
  readonly browserSync: string;
  readonly manageGrokBuild: string;
  readonly grokManagementIntro: string;
  readonly grokManagementSearch: string;
  readonly grokManagementOpenSettings: string;
  readonly runtimeDiagnostics: string;
  readonly runtimeDiagnosticsHelp: string;
  readonly openRuntimeDiagnostics: string;
  readonly noRuntimeIncidents: string;
  readonly runtimeRecoveryState: (state: "restoring" | "restored" | "failed") => string;
  readonly runtimeLogHasStderr: string;
  readonly grokManagementSelect: string;
  readonly grokManagementCommandInput: string;
  readonly grokManagementRun: string;
  readonly grokManagementConfirm: string;
  readonly grokManagementCancelConfirm: string;
  readonly grokManagementResult: string;
  readonly grokManagementNoTask: string;
  readonly grokManagementBusy: string;
  readonly grokManagementCompleted: string;
  readonly grokManagementFailed: string;
  readonly grokManagementBoundary: string;
  readonly grokManagementSection: (section: string) => string;
  readonly grokManagementSectionHelp: (section: string) => string;
  readonly grokManagementAction: (action: GuildGrokManagementAction) => string;
  readonly grokManagementField: (field: string) => string;
  readonly grokManagementRequired: (field: string) => string;
};

function taskActivityLabel(locale: GuildLocale, activity: GuildTaskActivity): string {
  const labels = locale === "zh-CN" ? {
    working: "处理中", thinking: "思考中", planning: "规划中", reading: "读取中",
    editing: "编辑中", deleting: "删除中", moving: "移动中", searching: "搜索中",
    executing: "执行中", fetching: "联网中", switching_mode: "切换中", responding: "回复中",
  } : {
    working: "Working", thinking: "Thinking", planning: "Planning", reading: "Reading",
    editing: "Editing", deleting: "Deleting", moving: "Moving", searching: "Searching",
    executing: "Executing", fetching: "Fetching", switching_mode: "Switching", responding: "Responding",
  };
  return labels[activity];
}

const ZH_GROK_ACTIONS = Object.freeze({
  version: "查看 Grok 版本", models: "查看官方模型", inspect: "检查当前目录配置", doctor: "运行环境诊断",
  doctor_fixes: "查看可自动修复项", doctor_fix: "应用自动修复", disk_usage: "查看 Grok 磁盘占用",
  update_check: "检查更新", update_stable: "切换并安装稳定版", update_alpha: "切换并安装 Alpha 版",
  update_version: "安装指定版本", update_reinstall: "重新安装当前版本", setup_preview: "预览托管配置",
  setup_apply: "安装托管配置", login_oauth: "使用 OAuth 登录", login_device: "使用设备码登录", logout: "退出 Grok 登录",
  plugin_list: "查看已安装插件", plugin_available: "查看市场可用插件", plugin_details: "查看插件组件",
  plugin_validate: "验证插件清单", plugin_install: "安装并信任插件", plugin_uninstall: "卸载插件",
  plugin_update: "更新插件", plugin_enable: "启用插件", plugin_disable: "停用插件",
  plugin_tag_preview: "预览插件版本标签", plugin_tag: "创建插件版本标签", marketplace_list: "查看插件市场源",
  marketplace_add: "添加插件市场源", marketplace_remove: "移除插件市场源", marketplace_update: "刷新插件市场源",
  mcp_list: "查看 MCP 服务器", mcp_doctor: "诊断 MCP 连接", mcp_add: "添加或更新 MCP 服务器",
  mcp_remove: "移除 MCP 服务器", mcp_enable: "启用 MCP 服务器", mcp_disable: "停用 MCP 服务器",
  memory_clear: "清理跨会话记忆", sessions_list: "查看官方会话", sessions_search: "搜索官方会话",
  session_delete: "永久删除官方会话", session_export: "导出官方会话 Markdown", session_trace_local: "本地导出会话 Trace",
  session_trace_upload: "上传会话 Trace", worktree_list: "查看工作树", worktree_show: "查看工作树详情",
  worktree_remove: "移除工作树", worktree_gc_preview: "预览工作树清理", worktree_gc: "清理过期工作树",
  worktree_detach: "转成普通 Git 工作树", worktree_salvage: "抢救工作树文件",
  worktree_clean_preview: "预览清理工作树外遗留文件", worktree_clean: "清理工作树外遗留文件",
  worktree_db_stats: "查看工作树数据库统计", worktree_db_path: "查看工作树数据库路径",
  worktree_db_rebuild: "重建工作树数据库", leader_list: "查看 Leader 进程", leader_info: "查看 Leader 详情",
  leader_kill: "停止全部 Leader 进程", clone: "按需克隆 Git 仓库",
} satisfies Record<GuildGrokManagementAction, string>);

const EN_GROK_ACTIONS = Object.freeze({
  version: "Show Grok version", models: "List official models", inspect: "Inspect directory configuration", doctor: "Run environment diagnostics",
  doctor_fixes: "List automatic fixes", doctor_fix: "Apply automatic fix", disk_usage: "Show Grok disk usage",
  update_check: "Check for updates", update_stable: "Switch to and install stable", update_alpha: "Switch to and install alpha",
  update_version: "Install a specific version", update_reinstall: "Reinstall current version", setup_preview: "Preview managed configuration",
  setup_apply: "Install managed configuration", login_oauth: "Sign in with OAuth", login_device: "Sign in with device code", logout: "Sign out of Grok",
  plugin_list: "List installed plugins", plugin_available: "List marketplace plugins", plugin_details: "Show plugin components",
  plugin_validate: "Validate plugin manifest", plugin_install: "Install and trust plugin", plugin_uninstall: "Uninstall plugin",
  plugin_update: "Update plugin", plugin_enable: "Enable plugin", plugin_disable: "Disable plugin",
  plugin_tag_preview: "Preview plugin release tag", plugin_tag: "Create plugin release tag", marketplace_list: "List marketplace sources",
  marketplace_add: "Add marketplace source", marketplace_remove: "Remove marketplace source", marketplace_update: "Refresh marketplace source",
  mcp_list: "List MCP servers", mcp_doctor: "Diagnose MCP connection", mcp_add: "Add or update MCP server",
  mcp_remove: "Remove MCP server", mcp_enable: "Enable MCP server", mcp_disable: "Disable MCP server",
  memory_clear: "Clear cross-session memory", sessions_list: "List official sessions", sessions_search: "Search official sessions",
  session_delete: "Permanently delete official session", session_export: "Export official session as Markdown", session_trace_local: "Export session trace locally",
  session_trace_upload: "Upload session trace", worktree_list: "List worktrees", worktree_show: "Show worktree details",
  worktree_remove: "Remove worktree", worktree_gc_preview: "Preview worktree cleanup", worktree_gc: "Clean expired worktrees",
  worktree_detach: "Convert to plain Git worktree", worktree_salvage: "Salvage worktree files",
  worktree_clean_preview: "Preview escape-artifact cleanup", worktree_clean: "Clean escape artifacts",
  worktree_db_stats: "Show worktree database stats", worktree_db_path: "Show worktree database path",
  worktree_db_rebuild: "Rebuild worktree database", leader_list: "List leader processes", leader_info: "Show leader details",
  leader_kill: "Stop all leader processes", clone: "Lazy-clone Git repository",
} satisfies Record<GuildGrokManagementAction, string>);

const ZH_GROK_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  id: "编号或路径", version: "版本号", name: "名称", path: "本地路径", source: "来源 URL、仓库简写或本地路径",
  keepData: "保留插件数据", push: "推送标签到远程", force: "强制执行", transport: "传输方式", scope: "配置范围",
  endpoint: "命令或服务器 URL", env: "环境变量（每行 KEY=value）", headers: "HTTP Header（每行 NAME: VALUE）",
  args: "命令参数（每行一个）", query: "搜索关键词", limit: "结果数量", sessionId: "官方会话 ID", output: "输出文件或目录",
  ids: "工作树 ID（每行一个）", repo: "仓库路径", type: "工作树类型", all: "包括全部记录", maxAge: "最大闲置时间（如 7d）",
  allowCopy: "跨磁盘时允许复制", pid: "进程 PID", url: "Git 仓库 URL", directory: "目标目录", branch: "分支或 Ref",
  cones: "稀疏检出目录（每行一个）", fullHistory: "获取完整历史",
});
const EN_GROK_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  id: "ID or path", version: "Version", name: "Name", path: "Local path", source: "Source URL, repository shorthand, or local path",
  keepData: "Keep plugin data", push: "Push tag to remote", force: "Force operation", transport: "Transport", scope: "Configuration scope",
  endpoint: "Command or server URL", env: "Environment (one KEY=value per line)", headers: "HTTP headers (one NAME: VALUE per line)",
  args: "Command arguments (one per line)", query: "Search query", limit: "Result limit", sessionId: "Official session ID", output: "Output file or directory",
  ids: "Worktree IDs (one per line)", repo: "Repository path", type: "Worktree type", all: "Include all records", maxAge: "Maximum idle age (for example 7d)",
  allowCopy: "Allow copy across disks", pid: "Process PID", url: "Git repository URL", directory: "Destination directory", branch: "Branch or ref",
  cones: "Sparse checkout cones (one per line)", fullHistory: "Fetch full history",
});

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

const ZH_CN: GuildMessages = Object.freeze({
  ...WORKSHOP_ZH,
  ...createChangeMessages("zh-CN"),
  appName: "Guild",
  loading: "正在载入 Guild",
  newTask: "新建任务",
  projects: "项目",
  extensions: "扩展",
  automation: "自动化",
  library: "资料库",
  projectAndChats: "项目与对话",
  noWorkspaceTitle: "先选择工作区",
  noWorkspaceBody: "任务必须归属于一个本地文件夹，Guild 不会在未选择工作区时发送。",
  chooseWorkspace: "选择项目文件夹",
  welcomeTitle: "准备好做点什么？",
  welcomeBody: "选择一个工作区，然后把任务交给 Guild。",
  composerPlaceholder: "问 Guild…",
  connectingRuntime: "正在连接 Grok…",
  queuePlaceholder: "继续输入，回车后排队发送…",
  queueReady: "按回车排到下一条",
  queuedNext: "接下来",
  queuedFirst: "下一条",
  preemptQueued: "打断并先做",
  preemptingQueued: "正在停止当前任务…",
  cancelQueued: "取消这条排队消息",
  selectWorkspaceFirst: "选择工作区后才能发送",
  send: "发送",
  stop: "停止",
  continuousMode: "持续任务",
  continuousModeHelp: "Guild 会交替执行与审计，直到目标完成、遇到阻塞或你手动停止",
  continuousCycle: (cycle) => `第 ${cycle} 轮`,
  continuousWorkPhase: "执行中",
  continuousAuditPhase: "验收中",
  continuousPause: "暂停续跑",
  continuousResume: "继续续跑",
  continuousStop: "结束任务",
  continuousPaused: "已暂停",
  continuousBlocked: "需要处理阻塞",
  continuousCompleted: "目标已验收完成",
  continuousRemaining: "剩余",
  continuousObjective: "原始目标",
  continuousSummary: "最新进展",
  continuousDetails: "查看进度详情",
  continuousNoRemaining: "未报告剩余问题",
  continuousRoundRecord: "本轮记录",
  continuousReportedVerdict: "模型判断",
  continuousVerdict: (verdict) => ({ CONTINUE: "继续推进", COMPLETE: "已完成", BLOCKED: "遇到阻塞" })[verdict],
  continuousStopReasonLabel: "当前状态",
  continuousStopReason: (reason) => ({
    runtime_unavailable: "Grok 运行时当前不可用；检查登录或连接后可继续。",
    desktop_restarted: "Guild 重启后已安全暂停；不会自动重发上一轮，确认状态后可继续。",
    work_blocked: "执行阶段报告了阻塞；请查看剩余项后处理或继续。",
    audit_protocol_invalid: "验收回复缺少有效的结束标记；可重试本轮，这不代表目标已完成。",
    audit_blocked: "验收阶段发现阻塞；请查看剩余项后处理。",
    empty_runtime_response: "Grok 没有返回可用内容；请检查连接后重试。",
    transport_interrupted: "与 Grok 的连接中断；任务已安全暂停，没有自动重发。",
    paused_by_user: "任务已由你暂停。",
    stopped_by_user: "任务已由你结束。",
    current_round_cancelled_by_user: "当前一轮已由你取消。",
    objective_verified_complete: "目标已通过独立验收。",
  } as Record<string, string>)[reason] ?? (reason.startsWith("run_")
    ? "本轮没有正常完成；检查本轮结果后可继续。"
    : "任务已暂停；请查看最新进展与剩余项。"),
  thinking: "思考中",
  thinkingFor: (seconds) => `思考中 · ${seconds} 秒`,
  activeActivity: (activity) => taskActivityLabel("zh-CN", activity),
  activeActivityFor: (activity, seconds) => `${taskActivityLabel("zh-CN", activity)} · ${seconds} 秒`,
  runQueued: "已加入任务队列",
  runPreparing: "正在准备 Grok",
  runWaitingForGrok: "Grok 已接收，等待响应",
  runElapsed: (seconds) => `${seconds} 秒`,
  conversation: "对话",
  cancelledActivity: "已取消",
  interruptedActivity: "已中断",
  failedActivity: "执行失败",
  thoughtFor: (seconds) => `思考了 ${seconds} 秒`,
  usedTools: (count) => `使用了 ${count} 个工具`,
  toolDetails: "工具详情",
  viewImage: "查看图片",
  closeImage: "关闭图片",
  imagePreview: "图片预览",
  fileChange: "文件变更",
  beforeChange: "修改前",
  afterChange: "修改后",
  terminalOutputUnavailable: "当前 Grok 会话没有提供可显示的终端正文。",
  unsupportedToolContent: (contentType) => `此工具内容暂不支持显示：${contentType}`,
  permissionNeeded: "需要你的确认",
  cancel: "取消",
  archive: "归档",
  archived: "已归档",
  restore: "恢复",
  restoreNamed: (name) => `恢复 ${name}`,
  restoreTaskNamed: (task, workspace) => `${workspace} · ${task}`,
  pin: "置顶",
  unpin: "取消置顶",
  pinned: "已置顶",
  rename: "重命名",
  renameTask: "重命名对话",
  taskTitle: "对话名称",
  taskTitleInvalid: "名称需要 1 到 512 个字符，且不能包含换行。",
  delete: "删除",
  confirmDelete: "确认删除",
  confirmDeleteTask: (title) => `将删除对话“${title}”，之后无法在 Guild 中恢复。`,
  confirmDeleteWorkspace: (name, taskCount) => `将移除项目与任务“${name}”及其中 ${taskCount} 个对话，之后无法在 Guild 中恢复。`,
  stopTaskBeforeManage: "请先停止正在运行的任务，再归档或删除。",
  openMenu: "打开菜单",
  settings: "设置",
  settingsGeneral: "通用",
  settingsGrok: "Grok",
  settingsPrivacy: "隐私与数据",
  settingsAbout: "关于",
  editProfile: "编辑资料",
  localProfile: "本地资料",
  nickname: "昵称",
  nicknameHelp: "1 到 32 个字符，保存后会同步到侧栏。",
  changeAvatar: "选择图片",
  resetAvatar: "恢复默认头像",
  save: "保存",
  discardChanges: "放弃未保存的修改？",
  discardChangesBody: "关闭后，这次对昵称和头像的修改不会写入。",
  keepEditing: "继续编辑",
  discard: "放弃",
  nicknameInvalid: "昵称需要 1 到 32 个字符，且不能包含换行或空白。",
  avatarTooLarge: "图片不能超过 5 MB。",
  avatarInvalid: "无法解码这张图片。",
  avatarUnsupported: "只支持 PNG、JPEG 和 WebP。",
  restoreLastTask: "启动时恢复上次打开的任务",
  restoreLastTaskHelp: "关闭后，冷启动不会自动打开上一次的对话。",
  newTaskWorkspace: "新建任务的工作区",
  newTaskWorkspaceAsk: "每次选择工作区",
  newTaskWorkspaceLast: "使用上次工作区",
  taskNotifications: "后台任务通知",
  taskNotificationsHelp: "Guild 不在前台时，在任务完成、失败、中断或等待授权时发送系统通知；通知不会主动切换窗口。",
  taskStatusRunning: "运行中",
  taskStatusQueued: (count) => `${count} 条排队`,
  taskStatusPermission: "等待授权",
  taskStatusFailed: "任务失败",
  taskStatusInterrupted: "任务已中断",
  taskStatusCancelled: "任务已取消",
  privacyBrowserSyncOff: "浏览器登录状态同步默认关闭，且当前不可用。",
  privacyBrowserSyncHelp: "Guild 不会在冷启动时访问浏览器数据或钥匙串。官方用量仍只通过官方 Grok 进程读取。",
  openDataDirectory: "打开 Guild 数据目录",
  backupData: "创建完整本地备份",
  backupSaving: "正在创建备份…",
  backupSaved: "备份已创建，包含会话数据库、头像与媒体以及脱敏诊断。",
  backupFailed: "备份未完成；原始数据没有被修改。",
  localData: "本地数据与诊断",
  localDataHelp: "对话、设置和诊断都只保存在这台 Mac。诊断不记录正常提示词与回复，错误输出会先脱敏凭据。",
  aboutCopyright: "Copyright © 2026 BDV",
  aboutRole: "Guild 是调用官方 Grok 工具和 Claude Code 的本地单用户客户端。",
  closeDialog: "关闭",
  language: "语言",
  model: "模型",
  reasoningEffort: "推理强度",
  permissionMode: "工具授权",
  reasoningEffortName: (effort, officialLabel) => (({
    xhigh: "超高",
    high: "高",
    medium: "中",
    low: "低",
  }) as Readonly<Record<string, string>>)[effort] ?? officialLabel ?? effort,
  runtimeDefaultOption: "运行时默认（推荐）",
  reasoningFollowsRuntimeDefault: "跟随运行时默认",
  modelDefaultName: "默认模型",
  modelPickerTitle: "模型与推理强度",
  modelPickerAria: (summary, scope, disabled) =>
    `模型与推理强度：${summary}。${scope}。${disabled === undefined ? "" : `${disabled}。`}`,
  modelPickerScopeTask: "仅用于当前对话",
  modelPickerScopeGlobal: "使用你的默认设置",
  modelPickerScopeRuntime: "使用 Grok 的默认设置",
  modelPickerDisabledNoTask: "打开一个对话后才能选择模型",
  modelPickerDisabledRunning: "当前轮次结束后才能更换模型",
  modelPickerDisabledPending: "正在应用更改",
  modelPickerContext: (sizes) => `${sizes} 上下文`,
  modelPickerDefaultMark: "默认",
  modelPickerUseDefault: "使用默认设置",
  modelPickerEmpty: "Grok 启动后才会显示可选的模型。",
  modelPickerNoEfforts: "这个模型没有推理强度设置。",
  modelPickerSaved: "会话打开时生效。",
  modelPickerRefused: (reason) => ({
    incompatible_agent: "对话开始后不能改用这个模型，已保留你之前的选择。",
    unsupported_value: "Grok 目前没有为这个任务提供该选项，已保留你之前的选择。",
    unavailable: "Grok 暂时无法切换，已保留你之前的选择。",
  })[reason],
  modelGroupName: (group) => ({ grok: "Grok", claude: "Claude（订阅）", online: "在线", local: "本地" })[group],
  modelPickerGroupEmpty: (group) => group === "online"
    ? "没有在线模型，请在「设置 › 模型源」中添加"
    : "没有本地模型，请在「设置 › 模型源」中添加",
  modelPickerOpenModelSources: "打开模型源设置",
  modelPickerClaudeUnavailable: "未找到 Claude Code，或尚未登录",
  modelPickerClaudeUnavailableHelp: "请先安装 Claude Code，并在终端运行一次 claude 完成登录。",
  modelPickerClaudeNotStarted: "Claude 启动后才会显示可选的模型。",
  modelPickerClaudeDefault: "Claude Code（默认模型）",
  modelPickerEngineNote: "第一条消息选的模型，决定这个对话用 Grok 还是 Claude，之后不能更换。",
  taskEngineName: (engine) => ({ grok: "Grok", claude: "Claude" })[engine],
  taskEngineMarkerTitle: (engine) => ({ grok: "Grok 对话", claude: "Claude Code 对话" })[engine],
  onlineReminderTitle: (vendor) => `要把这段对话发给「${vendor}」吗？`,
  onlineReminderLead: (vendor) => `「${vendor}」是在线模型。切换后，下面这些内容会发送给它的服务商：`,
  onlineReminderItemClaudeMd: "CLAUDE.md",
  onlineReminderItemMemory: "记忆",
  onlineReminderItemConversation: "本次对话",
  onlineReminderItemBrowser: "对话中出现的网页文字和截图",
  onlineReminderDontRemind: "在此工作区不再提醒",
  onlineReminderSwitch: "切换",
  privacyOnlineReminder: "发给在线模型前先提醒我",
  privacyOnlineReminderHelp: "在此工作区的每个对话里，第一次使用某个在线服务商的模型时，先确认一次；换到另一个服务商会再确认。本地模型和 Claude 订阅模型不会提醒。",
  privacyOnlineReminderNoWorkspace: "打开一个对话后，才能修改它所在工作区的这项设置。",
  privacyOnlineReminderFailed: "这项设置没有保存，请重试。",
  settingsEngines: "引擎",
  settingsModelSources: "模型源",
  settingsClaude: "Claude",
  enginesClaudeIntro: "Claude Code 通过这台 Mac 上已安装的适配器和 claude 程序运行，使用你自己的 Claude 登录。Guild 不会读取这个登录。",
  claudeDefaultModelOption: "Claude Code 默认（推荐）",
  claudePermissionModeName: (mode) => ({
    default: "按需询问",
    acceptEdits: "自动接受编辑",
    plan: "仅规划",
    auto: "自动",
    bypassPermissions: "完全授权",
  })[mode],
  claudePermissionModeHelp: (mode) => ({
    default: "每次编辑文件或运行命令前都先询问你。",
    acceptEdits: "文件编辑自动通过，运行命令仍会询问。",
    plan: "只读和规划，不修改文件，也不运行命令。",
    auto: "由 Claude Code 判断哪些操作需要你确认。",
    bypassPermissions: "不再逐次询问，工具会直接在此设备上运行；只在你信任的工作区使用。",
  })[mode],
  claudeSettingsHelp: "新的 Claude 对话从这里的设置开始，正在运行的一轮不会被改动。",
  claudeSettingsFailed: "Claude 设置没有保存，请重试。",
  claudeStatusLabel: "状态",
  claudeStatusReady: (account) => account === undefined ? "已就绪" : `已就绪 · ${account}`,
  claudeStatusNotFound: "没有找到 Claude Code。请先安装，并确认适配器和 claude 程序都在这台 Mac 上。",
  claudeStatusNotLoggedIn: "尚未登录。请在终端运行一次 claude 完成登录。",
  claudeStatusUnavailable: "暂时无法使用，稍后再试。",
  grokToolsGrokOnly: "Grok 工具只用于 Grok 对话",
  sourcesIntro: "在线和本地模型会出现在 Claude 对话的模型选择里。Guild 只把请求发到你设置的地址；API 密钥留在你指定的文件里，Guild 不会显示、保存或记录它。",
  sourcesKeyNotice: "这里只填密钥变量的名字，不要粘贴密钥本身。",
  sourcesLoading: "正在读取模型源…",
  sourcesLoadFailed: "无法读取模型源，请重试。",
  sourcesEmpty: "还没有模型源。",
  sourcesAdd: "添加模型源",
  sourcesEdit: "编辑",
  sourcesEditTitle: "编辑模型源",
  sourcesAddTitle: "添加模型源",
  sourcesDeleteConfirm: (label) => `删除「${label}」？它的模型会从选择列表中消失，密钥文件不会被改动。`,
  sourcesDeleteFailed: "没有删除成功，请重试。",
  sourcesKindName: (kind) => ({ online: "在线", local: "本地" })[kind],
  sourcesStatusName: (status) => ({ confirmed: "已确认", needs_confirmation: "待确认", disabled: "已停用" })[status],
  sourcesModelCount: (count) => `${count} 个模型`,
  sourcesConfirm: "确认",
  sourcesConfirming: "等待你在系统窗口中确认…",
  sourcesConfirmHelp: (host, variable, kind) => variable === null
    ? `Guild 会弹出系统窗口，请你确认可以向 ${host} 发送请求。`
    : kind === "online"
      ? `Guild 会弹出系统窗口，请你确认变量 ${variable} 里的密钥和 Claude 任务的对话可以发送到 ${host}。`
      : `Guild 会弹出系统窗口，请你确认变量 ${variable} 里的密钥可以发送到 ${host}。`,
  sourcesConfirmedNotice: "已确认。",
  sourcesConfirmCancelled: "没有确认，这个模型源暂时不能使用。",
  sourcesConfirmFailed: "确认没有完成，请重试。",
  sourcesNeedsConfirmationNotice: (label) => `「${label}」已保存，确认地址和密钥变量之后才能使用。`,
  sourcesFieldKind: "类型",
  sourcesFieldLabel: "名称",
  sourcesFieldBaseUrl: "接口地址",
  sourcesBaseUrlHint: (kind) => kind === "online"
    ? "在线模型源必须使用 https。"
    : "本地模型源可以用 http 或 https，地址必须在这台 Mac 或你的 Tailscale 网络内。",
  sourcesFieldKeyFile: "密钥文件",
  sourcesKeyFilePlaceholder: "~/.config/guild/keys.env",
  sourcesKeyFileHint: "存放密钥的 env 文件的绝对路径。留空则使用默认文件。",
  sourcesFieldKeyVariable: "密钥变量名",
  sourcesKeyVariablePlaceholder: "例如 DEEPSEEK_API_KEY",
  sourcesKeyVariableHint: "只填变量名。Guild 在后台从密钥文件读取它的值，不会显示或保存。",
  sourcesModels: "模型",
  sourcesModelId: "模型 ID",
  sourcesModelLabel: "显示名称",
  sourcesModelContext: "上下文窗口",
  sourcesModelImages: "支持图片",
  sourcesAddModel: "添加模型",
  sourcesRemoveModel: (id) => id.length === 0 ? "删除这一行" : `删除模型 ${id}`,
  sourcesEnabled: "启用",
  sourcesSaving: "正在保存…",
  sourcesSaveFailed: "没有保存成功，请检查各项内容后重试。",
  sourcesSaveError: (reason, maxSources) => ({
    invalid: "有些内容没有被接受。请检查各项，看是否含有隐藏字符，或看起来像密钥的文字。",
    reserved_id: "这个名称是 Claude 自带模型保留的，请换一个名称。",
    reserved_model: "有模型 ID 被 Claude Code 保留了（以 claude- 开头，或是 default、opus、sonnet、haiku 等名称）。请改用你的接口实际需要的 ID。",
    duplicate_model: "别的模型源已经提供了这个模型 ID。同一个 ID 只能属于一个模型源。",
    limit: `模型源最多 ${maxSources} 个。请先删除一个再添加。`,
    changed: "编辑期间，这个模型源在别处被修改了。列表已刷新，请关闭此表单后重新编辑。",
    not_found: "这个模型源已经不存在。列表已刷新，请关闭此表单。",
    rejected: "Guild 没能保存这个模型源。请检查各项内容后重试。",
  })[reason],
  sourcesInvalid: (problem) => ({
    label: "请填写名称。",
    base_url: "请填写完整的接口地址，例如 https://api.example.com/anthropic。",
    base_url_https: "在线模型源必须使用 https。",
    key_file: "密钥文件需要绝对路径（以 / 开头），或者留空。",
    key_variable: "请填写密钥变量名，只能用大写字母、数字和下划线。",
    key_variable_secret: "这里要填变量的名字，不是密钥本身。",
    models: "至少添加一个模型。",
    model_id: "模型 ID 只能包含字母、数字和 . _ : [ ] -，且以字母或数字开头。",
    model_duplicate: "模型 ID 不能重复。",
    model_label: "请给每个模型填写显示名称。",
    model_context: "上下文窗口需要是正整数，或者留空。",
  })[problem],
  usageClaudeHeading: "Claude 订阅",
  usageClaudeAccountUnknown: "账户信息暂不可用",
  usageClaudeQuota: "额度：由 Claude Code 管理",
  runDuration: (seconds) => seconds < 60
    ? `${seconds} 秒`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)} 分 ${pad2(seconds % 60)} 秒`
      : `${Math.floor(seconds / 3_600)} 小时 ${pad2(Math.floor(seconds % 3_600 / 60))} 分 ${pad2(seconds % 60)} 秒`,
  runPhaseStartingRuntime: "正在启动 Grok",
  runPhaseOpeningSession: "正在打开会话",
  runPhaseMcp: (connected, total) => `MCP ${connected}/${total}`,
  runPhasePromptSent: "已发送",
  runPhasePromptSentSlow: "已发送 · Grok 尚未接手",
  runPhaseQueued: (position) => position === undefined ? "排队中" : `排队中 #${position}`,
  runPhaseRunningHooks: (count) => count === undefined ? "正在运行钩子" : `正在运行钩子（${count}）`,
  runPhaseWaitingForModel: "等待模型响应",
  runPhaseThinking: "思考中",
  // A tool the runtime names in its own words is shown as what it does; an unknown one stays a generic "tool" (the raw name rides in the tooltip).
  runPhasePreparingTool: (toolName) => {
    const action = classifyToolName(toolName);
    return action === undefined ? "正在准备工具" : `准备${ZH_TOOL_ACTION[action]}`;
  },
  runPhaseWaitingForPermission: "等待你的授权",
  runPhaseRunningTool: (toolName) => {
    const action = classifyToolName(toolName);
    return action === undefined ? "正在运行工具" : `正在${ZH_TOOL_ACTION[action]}`;
  },
  runPhaseRetrying: (attempt, maxRetries) => attempt === undefined || maxRetries === undefined
    ? "正在重试"
    : `正在重试 ${attempt}/${maxRetries}`,
  runPhaseResponding: "正在回答",
  runPhaseTime: (phase, total) => phase === undefined ? `共 ${total}` : `${phase} · 共 ${total}`,
  runtimeSettingsBusy: "任务运行或排队时不能切换工具授权或启动选项。",
  runtimeSettingsHelp: "仅显示官方 Grok 设置；模型与推理强度在下一轮生效，工具授权和启动选项会安全重连空闲会话。",
  webSearch: "联网搜索",
  webSearchHelp: "允许官方 Grok 使用 Web Search 与 Web Fetch。",
  planMode: "计划模式",
  planModeHelp: "允许 Grok 在复杂任务中建立并更新计划。",
  subagents: "子代理",
  subagentsHelp: "允许 Grok 为适合并行的工作启动子代理。",
  maxTurns: "最大代理轮数",
  unlimited: "不限制",
  startupBehavior: "新会话启动选项",
  usage: "官方用量",
  usageLoading: "正在通过官方 Grok 读取用量…",
  usageUnavailable: "官方 Grok 当前未提供可读取的用量与重置时间。Guild 不会估算。",
  usageResetsAt: (date) => `${date} 重置`,
  viewOfficialUsage: "在 Grok 查看官方用量",
  version: "版本",
  independentNotice: "Guild 是独立客户端，与 xAI、Anthropic 均无隶属关系。",
  recovered: "上次未正常退出，状态已恢复",
  today: "今天",
  yesterday: "昨天",
  earlier: "更早",
  emptyTask: "从下面开始这项任务。",
  currentAttention: "正在进行",
  latestResult: "本轮结果",
  latestResultNoChanges: "Grok 未报告文件或差异证据",
  interruptedResult: "本轮已中断",
  failedResult: "本轮失败",
  cancelledResult: "本轮已停止",
  interruptedResultUnconfirmed: "结果未确认；请先检查工作区，再决定是否重试",
  latestResultCounts: (files, diffs) => `${files} 个文件 · ${diffs} 项差异`,
  viewResult: "查看",
  recoveryNoticeTitle: "本轮已中断，会话已恢复",
  recoveryNoticeBody: "上一条指令没有自动重试，可能已经执行过部分操作。请先检查结果，再决定是否重试。",
  recoveryNoticeRestored: "现在可以继续使用这个 Grok 会话",
  recoveryRetryAction: "编辑并重试",
  addWorkspaceFiles: "添加工作区文件",
  attachedFiles: "已添加的工作区文件",
  attachmentsCannotQueue: "带文件的消息需要等当前任务结束后发送",
  removeAttachment: (name) => `移除 ${name}`,
  bannyDragHint: "把蕉仔拖到对话上让它坐下；拖到窗口中间让它回到主页，也可以放在窗口其他位置。",
  bannySeated: "蕉仔坐在这里",
  runtimeUnavailable: "Grok 运行时暂时不可用",
  workspaceFolderMissing: "工作区文件夹已不存在。请重新选择该文件夹，或换一个仍在磁盘上的工作区。",
  messageTooLong: "这条消息太长，请删短后再发送。",
  sessionReplacementTitle: "原 Grok 会话无法继续",
  sessionReplacementBody: "开始新会话会保留本地记录；首次发送时，Guild 会附带本任务的恢复摘要。中断的指令不会自动重发。",
  sessionReplacementAction: "确认开始新会话",
  sessionRecoveryContextRequired: "这个替换会话没有可恢复的任务内容。请写明要继续做什么，不要只发送“继续”。",
  operationFailed: "操作未完成，请重试",
  startupUnavailable: "Guild 无法打开本地数据或运行时。请重试；若仍失败，请重新启动应用。",
  retry: "重试",
  code: "代码",
  permissionOnDemand: "按需授权",
  permissionFullAccess: "完全授权",
  permissionFullAccessHelp: "完全授权会让官方 Grok 在此设备上无需逐次询问即可执行工具；只在你信任的工作区使用。",
  contextUsageUnavailable: "尚未收到 Grok 的精确用量；首次回传通常在首轮回复后出现",
  contextUsageUnavailableCompact: "等待 Grok 首次回传用量",
  loadingEarlierHistory: "正在载入更早记录",
  slashCommands: "Grok 命令",
  slashCommandsEmpty: "没有匹配的命令；回车仍会原样发送。",
  commandSending: "正在发送给 Grok",
  goalPreparing: "已发送，正在建立自主目标",
  commandWaiting: "Grok 已接收，正在等待状态回传",
  commandRunning: "Grok 正在处理",
  commandRunningTool: (title) => `运行中 · ${title}`,
  auxiliaryWorkers: (count, activity) => `${count} 个子任务 · ${activity}`,
  commandAwaitingPermission: "等待你的确认",
  commandCompleting: "正在整理结果",
  commandStopping: "正在停止",
  commandCompleted: "命令已完成",
  commandFailed: "命令执行失败",
  commandCancelled: "命令已取消",
  commandInterrupted: "命令执行中断",
  toolKindLabel: (kind) => ({
    read: "读取",
    edit: "编辑",
    delete: "删除",
    move: "移动",
    search: "搜索",
    execute: "执行",
    think: "思考",
    fetch: "联网获取",
    switch_mode: "切换模式",
    other: "其他工具",
  })[kind],
  contextUsageUsedOnly: (used) => `已用 ${used} Token`,
  contextUsageCompact: (used, size, percent) => `已用 ${used} / ${size} · ${percent}%`,
  contextUsageLabel: (used, size, percent) => `上下文已使用 ${percent}%（${used} / ${size}）`,
  search: "搜索",
  searchPlaceholder: "搜索对话",
  clearSearch: "清除搜索",
  noSearchResults: "没有匹配的对话",
  searchingConversation: "正在搜索对话正文…",
  inConversation: "对话正文",
  forkFromHere: "从这里新开分支",
  commandPalette: "Guild 命令中心",
  commandPalettePlaceholder: "搜索任务、设置和当前会话命令",
  commandPaletteEmpty: "没有匹配的操作",
  commandPaletteHint: "↑↓ 选择 · 回车打开 · Esc 关闭",
  commandPaletteGroup: (group) => ({ navigation: "导航与设置", tasks: "任务", commands: "当前 Grok 会话命令" })[group],
  messageActions: "消息操作",
  copyMessage: "复制消息",
  branchFromMessage: "从这条消息新建任务",
  branchMessageHelp: "复制截至此处的本地对话快照，并启动新的官方 Grok 会话",
  retryToDraft: "放回输入框",
  retryToDraftHelp: "将失败或中断的指令放回输入框编辑，不会自动重发",
  localSettingScope: "由 Guild 保存在这台 Mac，立即生效。",
  officialSettingScope: "由官方 Grok 会话接受；运行中的会话不会被暗中替换。",
  exportMarkdown: "导出 Markdown",
  exportJson: "导出 JSON",
  workbench: "文件与审阅",
  files: "文件",
  review: "审阅",
  filesTouched: "本任务涉及的文件",
  noFilesYet: "Grok 尚未报告文件位置。",
  noChangesYet: "Grok 尚未报告可审阅的变更。",
  openTerminal: "在工作区打开终端",
  openTerminalHelp: "只在你明确点击时打开当前工作区。",
  emptyFile: "（空文件）",
  browserPaneWorkbenchTab: "浏览器",
  browserPaneTitle: "浏览器",
  browserPaneTabs: "浏览器标签页",
  browserPaneNewTab: "新建标签页",
  browserPaneCloseTab: "关闭标签页",
  browserPaneTabLimit: "最多同时打开 5 个标签页",
  browserPaneUntitledTab: "新标签页",
  browserPaneBack: "后退",
  browserPaneForward: "前进",
  browserPaneReload: "刷新",
  browserPaneStop: "停止加载",
  browserPaneAddress: "地址",
  browserPaneAddressPlaceholder: "输入网址，例如 example.com",
  browserPaneInvalidAddress: "请输入网址，例如 example.com",
  browserPaneAgentIdle: "智能体空闲",
  browserPaneAgentOperating: "智能体正在操作",
  browserPaneAgentPaused: "智能体已暂停，由你操作",
  browserPaneTakeOver: "接管",
  browserPaneResume: "恢复智能体",
  browserPaneEmpty: "输入网址即可打开页面，智能体也可以在这里浏览网页。",
  permissionModeName: (mode) => ({
    default: "按需询问",
    acceptEdits: "自动接受编辑",
    auto: "自动",
    dontAsk: "不询问",
    bypassPermissions: "完全授权",
    plan: "仅规划",
  })[mode],
  officialSessionCapabilities: "官方会话能力",
  startTaskForCapabilities: "打开一个任务后，Guild 会显示官方 ACP 实际报告的配置。",
  sessionModes: "会话模式",
  officialCommands: "斜杠命令",
  commandsAppearAfterConnect: "连接官方 Grok 会话后显示。",
  enabled: "已开启",
  disabled: "已关闭",
  resizeSidebar: "调整侧栏宽度",
  workspaceFallback: "工作区",
  browserSync: "浏览器同步",
  manageGrokBuild: "工具与连接",
  grokManagementIntro: "官方 Grok Build 的会话命令、扩展、MCP、会话记录、工作树和运行时管理都集中在这里。所有操作仍由官方 grok 进程执行。",
  grokManagementSearch: "搜索功能",
  grokManagementOpenSettings: "打开 Grok 会话设置",
  runtimeDiagnostics: "Guild 运行诊断",
  runtimeDiagnosticsHelp: "仅在本机记录进程退出、会话恢复和子任务阶段；不会主动记录提示词或正常回复，进程错误输出会先脱敏凭据。",
  openRuntimeDiagnostics: "打开本地诊断目录",
  noRuntimeIncidents: "最近没有运行中断",
  runtimeRecoveryState: (state) => ({ restoring: "正在恢复原会话", restored: "原会话已恢复", failed: "原会话恢复失败" })[state],
  runtimeLogHasStderr: "含脱敏 stderr",
  grokManagementSelect: "从左侧选择一个功能。",
  grokManagementCommandInput: "填写命令参数",
  grokManagementRun: "执行",
  grokManagementConfirm: "确认执行",
  grokManagementCancelConfirm: "先不执行",
  grokManagementResult: "执行结果",
  grokManagementNoTask: "打开一个任务并选择工作区后才能使用此功能。",
  grokManagementBusy: "任务或另一项 Grok 操作正在进行；结束后再执行管理功能。",
  grokManagementCompleted: "已完成",
  grokManagementFailed: "未完成",
  grokManagementBoundary: "不包含 TUI 画面、Headless 序列化、网关/代理基址、调试文件和 Shell 补全参数。它们属于承载或开发接口，不是 Guild 用户功能。",
  grokManagementSection: (section) => ({
    commands: "会话命令", runtime: "运行时与账户", extensions: "插件与 MCP",
    sessions: "会话与记忆", worktrees: "工作树与克隆", diagnostics: "诊断与配置",
  })[section] ?? section,
  grokManagementSectionHelp: (section) => ({
    commands: "不用输入斜杠：选择官方命令、填写需要的参数后直接运行。",
    runtime: "登录、版本、模型、更新和官方进程状态。",
    extensions: "管理插件、市场源与 MCP 服务器；敏感 Header 和环境变量不会回显。",
    sessions: "搜索、导出、清理官方会话和跨会话记忆。",
    worktrees: "查看、清理、抢救工作树，并按需克隆仓库。",
    diagnostics: "检查当前项目配置、终端环境、磁盘占用和托管配置。",
  })[section] ?? "",
  grokManagementAction: (action) => ZH_GROK_ACTIONS[action],
  grokManagementField: (field) => ZH_GROK_FIELDS[field] ?? field,
  grokManagementRequired: (field) => `${ZH_GROK_FIELDS[field] ?? field}为必填项。`,
});

const EN_US: GuildMessages = Object.freeze({
  ...WORKSHOP_EN,
  ...createChangeMessages("en-US"),
  appName: "Guild",
  loading: "Loading Guild",
  newTask: "New task",
  projects: "Projects",
  extensions: "Extensions",
  automation: "Automation",
  library: "Library",
  projectAndChats: "Projects and chats",
  noWorkspaceTitle: "Choose a workspace first",
  noWorkspaceBody: "Every task belongs to a local folder. Guild will not send before one is selected.",
  chooseWorkspace: "Choose project folder",
  welcomeTitle: "What should we work on?",
  welcomeBody: "Choose a workspace, then hand the task to Guild.",
  composerPlaceholder: "Ask Guild…",
  connectingRuntime: "Connecting to Grok…",
  queuePlaceholder: "Keep typing, then press Enter to queue…",
  queueReady: "Press Enter to queue next",
  queuedNext: "Up next",
  queuedFirst: "Next",
  preemptQueued: "Interrupt & run",
  preemptingQueued: "Stopping current task…",
  cancelQueued: "Cancel queued message",
  selectWorkspaceFirst: "Choose a workspace before sending",
  send: "Send",
  stop: "Stop",
  continuousMode: "Continuous task",
  continuousModeHelp: "Guild works and audits in cycles until the objective is complete, blocked, or stopped by you",
  continuousCycle: (cycle) => `Cycle ${cycle}`,
  continuousWorkPhase: "Working",
  continuousAuditPhase: "Auditing",
  continuousPause: "Pause cycles",
  continuousResume: "Resume cycles",
  continuousStop: "End task",
  continuousPaused: "Paused",
  continuousBlocked: "Blocker needs attention",
  continuousCompleted: "Objective verified complete",
  continuousRemaining: "Remaining",
  continuousObjective: "Original objective",
  continuousSummary: "Latest progress",
  continuousDetails: "View progress details",
  continuousNoRemaining: "No remaining gaps reported",
  continuousRoundRecord: "Round notes",
  continuousReportedVerdict: "Model assessment",
  continuousVerdict: (verdict) => ({ CONTINUE: "Continue", COMPLETE: "Complete", BLOCKED: "Blocked" })[verdict],
  continuousStopReasonLabel: "Current state",
  continuousStopReason: (reason) => ({
    runtime_unavailable: "The Grok runtime is unavailable. Check sign-in or connectivity, then resume.",
    desktop_restarted: "Guild paused safely after restart. It did not resend the previous round; review state before resuming.",
    work_blocked: "The work phase reported a blocker. Review the remaining item before resuming.",
    audit_protocol_invalid: "The audit response had no valid terminal footer. Retry this round; completion was not accepted.",
    audit_blocked: "The audit found a blocker. Review the remaining item before resuming.",
    empty_runtime_response: "Grok returned no usable content. Check connectivity, then retry.",
    transport_interrupted: "The Grok connection was interrupted. The task paused safely and was not resent.",
    paused_by_user: "You paused this task.",
    stopped_by_user: "You ended this task.",
    current_round_cancelled_by_user: "You cancelled the current round.",
    objective_verified_complete: "The objective passed the independent audit.",
  } as Record<string, string>)[reason] ?? (reason.startsWith("run_")
    ? "This round did not finish normally. Review its result before resuming."
    : "The task is paused. Review the latest progress and remaining items."),
  thinking: "Thinking",
  thinkingFor: (seconds) => `Thinking · ${seconds}s`,
  activeActivity: (activity) => taskActivityLabel("en-US", activity),
  activeActivityFor: (activity, seconds) => `${taskActivityLabel("en-US", activity)} · ${seconds}s`,
  runQueued: "Queued for this task",
  runPreparing: "Preparing Grok",
  runWaitingForGrok: "Grok received it; waiting for a response",
  runElapsed: (seconds) => `${seconds}s`,
  conversation: "Conversation",
  cancelledActivity: "Cancelled",
  interruptedActivity: "Interrupted",
  failedActivity: "Failed",
  thoughtFor: (seconds) => `Thought for ${seconds}s`,
  usedTools: (count) => `Used ${count} ${count === 1 ? "tool" : "tools"}`,
  toolDetails: "Tool details",
  viewImage: "View Image",
  closeImage: "Close image",
  imagePreview: "Image preview",
  fileChange: "File change",
  beforeChange: "Before",
  afterChange: "After",
  terminalOutputUnavailable: "The current Grok session did not provide displayable terminal output.",
  unsupportedToolContent: (contentType) => `This tool content is not supported for display: ${contentType}`,
  permissionNeeded: "Needs your approval",
  cancel: "Cancel",
  archive: "Archive",
  archived: "Archived",
  restore: "Restore",
  restoreNamed: (name) => `Restore ${name}`,
  restoreTaskNamed: (task, workspace) => `${workspace} · ${task}`,
  pin: "Pin",
  unpin: "Unpin",
  pinned: "Pinned",
  rename: "Rename",
  renameTask: "Rename chat",
  taskTitle: "Chat name",
  taskTitleInvalid: "Use 1–512 characters without line breaks.",
  delete: "Delete",
  confirmDelete: "Confirm delete",
  confirmDeleteTask: (title) => `Delete the chat “${title}”? Guild cannot restore it afterward.`,
  confirmDeleteWorkspace: (name, taskCount) => `Delete “${name}” and its ${taskCount} ${taskCount === 1 ? "chat" : "chats"}? Guild cannot restore them afterward.`,
  stopTaskBeforeManage: "Stop the running task before archiving or deleting it.",
  openMenu: "Open menu",
  settings: "Settings",
  settingsGeneral: "General",
  settingsGrok: "Grok",
  settingsPrivacy: "Privacy & Data",
  settingsAbout: "About",
  editProfile: "Edit profile",
  localProfile: "Local profile",
  nickname: "Nickname",
  nicknameHelp: "1–32 characters. Saving updates the sidebar immediately.",
  changeAvatar: "Choose image",
  resetAvatar: "Restore default avatar",
  save: "Save",
  discardChanges: "Discard unsaved changes?",
  discardChangesBody: "Closing now will not keep this nickname or avatar edit.",
  keepEditing: "Keep editing",
  discard: "Discard",
  nicknameInvalid: "Nickname must be 1–32 characters without line breaks or blank text.",
  avatarTooLarge: "Images must be 5 MB or smaller.",
  avatarInvalid: "That file could not be decoded as an image.",
  avatarUnsupported: "Only PNG, JPEG, and WebP images are supported.",
  restoreLastTask: "Restore the last task on startup",
  restoreLastTaskHelp: "When this is off, a cold start does not reopen the previous chat.",
  newTaskWorkspace: "Workspace for new tasks",
  newTaskWorkspaceAsk: "Ask every time",
  newTaskWorkspaceLast: "Use last workspace",
  taskNotifications: "Background task notifications",
  taskNotificationsHelp: "When Guild is in the background, notify on completion, failure, interruption, or approval. Notifications never activate the window by themselves.",
  taskStatusRunning: "Running",
  taskStatusQueued: (count) => `${count} queued`,
  taskStatusPermission: "Waiting for approval",
  taskStatusFailed: "Task failed",
  taskStatusInterrupted: "Task interrupted",
  taskStatusCancelled: "Task cancelled",
  privacyBrowserSyncOff: "Browser login sync stays off and is not available yet.",
  privacyBrowserSyncHelp: "Guild will not read browser data or the keychain on cold start. Official usage still comes only from the official Grok process.",
  openDataDirectory: "Open Guild data folder",
  backupData: "Create complete local backup",
  backupSaving: "Creating backup…",
  backupSaved: "Backup created with the conversation database, avatars and media, and redacted diagnostics.",
  backupFailed: "Backup did not complete; the original data was not changed.",
  localData: "Local data and diagnostics",
  localDataHelp: "Chats, settings, and diagnostics stay on this Mac. Diagnostics omit normal prompts and replies, and redact credentials from error output.",
  aboutCopyright: "Copyright © 2026 BDV",
  aboutRole: "Guild is a local single-user client that calls the official Grok tools and Claude Code.",
  closeDialog: "Close",
  language: "Language",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  permissionMode: "Tool permissions",
  reasoningEffortName: (effort, officialLabel) => (({
    xhigh: "Extra high",
    high: "High",
    medium: "Medium",
    low: "Low",
  }) as Readonly<Record<string, string>>)[effort] ?? officialLabel ?? effort,
  runtimeDefaultOption: "Runtime default (recommended)",
  reasoningFollowsRuntimeDefault: "Follows the runtime default",
  modelDefaultName: "Default model",
  modelPickerTitle: "Model and reasoning effort",
  modelPickerAria: (summary, scope, disabled) =>
    `Model and reasoning effort: ${summary}. ${scope}.${disabled === undefined ? "" : ` ${disabled}.`}`,
  modelPickerScopeTask: "Set for this conversation",
  modelPickerScopeGlobal: "Using your default setting",
  modelPickerScopeRuntime: "Using Grok's default",
  modelPickerDisabledNoTask: "Open a conversation to choose a model",
  modelPickerDisabledRunning: "The model can be changed after the current turn finishes",
  modelPickerDisabledPending: "Applying the change",
  modelPickerContext: (sizes) => `${sizes} context`,
  modelPickerDefaultMark: "default",
  modelPickerUseDefault: "Use default",
  modelPickerEmpty: "Model choices appear once Grok has started.",
  modelPickerNoEfforts: "This model has no reasoning effort setting.",
  modelPickerSaved: "Applies when the session opens.",
  modelPickerRefused: (reason) => ({
    incompatible_agent: "This model cannot be used in this conversation after it has started. Your previous selection was kept.",
    unsupported_value: "Grok does not offer that option for this task right now. Your previous selection was kept.",
    unavailable: "Grok could not switch right now. Your previous selection was kept.",
  })[reason],
  modelGroupName: (group) => ({ grok: "Grok", claude: "Claude", online: "Online", local: "Local" })[group],
  modelPickerGroupEmpty: (group) => group === "online"
    ? "No online models — add one in Settings › Model sources"
    : "No local models — add one in Settings › Model sources",
  modelPickerOpenModelSources: "Open Model sources",
  modelPickerClaudeUnavailable: "Claude Code not found or not logged in",
  modelPickerClaudeUnavailableHelp: "Install Claude Code, then run `claude` once in Terminal and log in.",
  modelPickerClaudeNotStarted: "Model choices appear once Claude has started.",
  modelPickerClaudeDefault: "Claude Code (default model)",
  modelPickerEngineNote: "The model you pick for the first message decides whether this conversation runs on Grok or Claude. It cannot change afterwards.",
  taskEngineName: (engine) => ({ grok: "Grok", claude: "Claude" })[engine],
  taskEngineMarkerTitle: (engine) => ({ grok: "Grok conversation", claude: "Claude Code conversation" })[engine],
  onlineReminderTitle: (vendor) => `Send this conversation to ${vendor}?`,
  onlineReminderLead: (vendor) => `${vendor} is an online model. If you switch, these are sent to its vendor:`,
  onlineReminderItemClaudeMd: "CLAUDE.md",
  onlineReminderItemMemory: "Memory",
  onlineReminderItemConversation: "This conversation",
  onlineReminderItemBrowser: "Text and screenshots of web pages in this conversation",
  onlineReminderDontRemind: "Don't remind me again in this workspace",
  onlineReminderSwitch: "Switch",
  privacyOnlineReminder: "Remind me before sending to an online model",
  privacyOnlineReminderHelp: "Asks once per conversation for each online vendor, the first time it uses that vendor's model; switching to another vendor asks again. Local models and your Claude subscription never ask.",
  privacyOnlineReminderNoWorkspace: "Open a conversation to change this for its workspace.",
  privacyOnlineReminderFailed: "That setting was not saved. Try again.",
  settingsEngines: "Engines",
  settingsModelSources: "Model sources",
  settingsClaude: "Claude",
  enginesClaudeIntro: "Claude Code runs through the adapter and claude program installed on this Mac, using your own Claude login. Guild never reads that login.",
  claudeDefaultModelOption: "Claude Code default (recommended)",
  claudePermissionModeName: (mode) => ({
    default: "Ask as needed",
    acceptEdits: "Accept edits",
    plan: "Plan only",
    auto: "Automatic",
    bypassPermissions: "Full access",
  })[mode],
  claudePermissionModeHelp: (mode) => ({
    default: "Asks before every file edit and command.",
    acceptEdits: "File edits go through automatically; commands still ask.",
    plan: "Read and plan only. No file changes and no commands.",
    auto: "Claude Code decides which actions need your approval.",
    bypassPermissions: "Never asks. Tools run on this device right away; use it only in workspaces you trust.",
  })[mode],
  claudeSettingsHelp: "New Claude conversations start from these settings. A turn that is already running is never changed.",
  claudeSettingsFailed: "The Claude settings were not saved. Try again.",
  claudeStatusLabel: "Status",
  claudeStatusReady: (account) => account === undefined ? "Ready" : `Ready · ${account}`,
  claudeStatusNotFound: "Claude Code was not found. Install it and make sure the adapter and the claude program are on this Mac.",
  claudeStatusNotLoggedIn: "Not logged in. Run `claude` once in Terminal and log in.",
  claudeStatusUnavailable: "Not available right now. Try again in a moment.",
  grokToolsGrokOnly: "Grok tools are for Grok conversations",
  sourcesIntro: "Online and Local models appear in the picker of Claude conversations. Guild only sends requests to the address you set. API keys stay in the file you name; Guild never shows, stores or logs them.",
  sourcesKeyNotice: "Enter only the name of the key variable, never the key itself.",
  sourcesLoading: "Loading model sources…",
  sourcesLoadFailed: "Model sources could not be loaded. Try again.",
  sourcesEmpty: "No model sources yet.",
  sourcesAdd: "Add model source",
  sourcesEdit: "Edit",
  sourcesEditTitle: "Edit model source",
  sourcesAddTitle: "Add model source",
  sourcesDeleteConfirm: (label) => `Delete “${label}”? Its models leave the picker. The key file is not touched.`,
  sourcesDeleteFailed: "It could not be deleted. Try again.",
  sourcesKindName: (kind) => ({ online: "Online", local: "Local" })[kind],
  sourcesStatusName: (status) => ({ confirmed: "Confirmed", needs_confirmation: "Needs confirmation", disabled: "Disabled" })[status],
  sourcesModelCount: (count) => `${count} ${count === 1 ? "model" : "models"}`,
  sourcesConfirm: "Confirm",
  sourcesConfirming: "Waiting for your confirmation in the system window…",
  sourcesConfirmHelp: (host, variable, kind) => variable === null
    ? `Guild will open a system window asking you to confirm that requests may be sent to ${host}.`
    : kind === "online"
      ? `Guild will open a system window asking you to confirm that the key in ${variable} and Claude task conversations may be sent to ${host}.`
      : `Guild will open a system window asking you to confirm that the key in ${variable} may be sent to ${host}.`,
  sourcesConfirmedNotice: "Confirmed.",
  sourcesConfirmCancelled: "Not confirmed. The source cannot be used yet.",
  sourcesConfirmFailed: "The confirmation did not finish. Try again.",
  sourcesNeedsConfirmationNotice: (label) => `“${label}” is saved. Confirm its address and key variable before it can be used.`,
  sourcesFieldKind: "Type",
  sourcesFieldLabel: "Name",
  sourcesFieldBaseUrl: "Base URL",
  sourcesBaseUrlHint: (kind) => kind === "online"
    ? "Online sources must use https."
    : "Local sources may use http or https and must be on this Mac or your Tailscale network.",
  sourcesFieldKeyFile: "Key file",
  sourcesKeyFilePlaceholder: "~/.config/guild/keys.env",
  sourcesKeyFileHint: "Absolute path of the env file that holds the key. Leave empty to use the default file.",
  sourcesFieldKeyVariable: "Key variable",
  sourcesKeyVariablePlaceholder: "e.g. DEEPSEEK_API_KEY",
  sourcesKeyVariableHint: "Only the variable name. Guild reads its value from the key file in the background and never shows or saves it.",
  sourcesModels: "Models",
  sourcesModelId: "Model ID",
  sourcesModelLabel: "Display name",
  sourcesModelContext: "Context window",
  sourcesModelImages: "Images",
  sourcesAddModel: "Add model",
  sourcesRemoveModel: (id) => id.length === 0 ? "Remove this row" : `Remove model ${id}`,
  sourcesEnabled: "Enabled",
  sourcesSaving: "Saving…",
  sourcesSaveFailed: "It could not be saved. Check the fields and try again.",
  sourcesSaveError: (reason, maxSources) => ({
    invalid: "Some values were not accepted. Check each field for hidden characters or text that looks like a key.",
    reserved_id: "This name is reserved for Claude's own models. Choose a different name.",
    reserved_model: "A model ID here belongs to Claude Code (one that starts with claude-, or a name such as default, opus, sonnet or haiku). Use the ID your endpoint expects instead.",
    duplicate_model: "Another model source already offers this model ID. An ID can belong to one source only.",
    limit: `You can keep up to ${maxSources} model sources. Delete one to add another.`,
    changed: "This source was changed somewhere else while you were editing. The list has been refreshed. Close this form and edit it again.",
    not_found: "This source no longer exists. The list has been refreshed. Close this form.",
    rejected: "Guild could not save this source. Check each field and try again.",
  })[reason],
  sourcesInvalid: (problem) => ({
    label: "Enter a name.",
    base_url: "Enter a full base URL, for example https://api.example.com/anthropic.",
    base_url_https: "Online sources must use https.",
    key_file: "The key file needs an absolute path (starting with /), or leave it empty.",
    key_variable: "Enter the key variable name, using capital letters, digits and underscores only.",
    key_variable_secret: "Enter the name of the variable, not the key itself.",
    models: "Add at least one model.",
    model_id: "A model ID may contain letters, digits and . _ : [ ] - and starts with a letter or digit.",
    model_duplicate: "Model IDs must be unique.",
    model_label: "Give every model a display name.",
    model_context: "The context window must be a positive whole number, or empty.",
  })[problem],
  usageClaudeHeading: "Claude subscription",
  usageClaudeAccountUnknown: "Account details are not available yet",
  usageClaudeQuota: "Quota: managed by Claude Code",
  runDuration: (seconds) => seconds < 60
    ? `${seconds}s`
    : seconds < 3_600
      ? `${Math.floor(seconds / 60)}m ${pad2(seconds % 60)}s`
      : `${Math.floor(seconds / 3_600)}h ${pad2(Math.floor(seconds % 3_600 / 60))}m ${pad2(seconds % 60)}s`,
  runPhaseStartingRuntime: "Starting Grok",
  runPhaseOpeningSession: "Opening session",
  runPhaseMcp: (connected, total) => `MCP ${connected}/${total}`,
  runPhasePromptSent: "Sent",
  runPhasePromptSentSlow: "Sent · Grok has not picked it up yet",
  runPhaseQueued: (position) => position === undefined ? "Queued" : `Queued #${position}`,
  runPhaseRunningHooks: (count) => count === undefined ? "Running hooks" : `Running hooks (${count})`,
  runPhaseWaitingForModel: "Waiting for model",
  runPhaseThinking: "Thinking",
  runPhasePreparingTool: (toolName) => toolName === undefined ? "Preparing tool" : `Preparing tool ${toolName}`,
  runPhaseWaitingForPermission: "Waiting for your permission",
  runPhaseRunningTool: (toolName) => toolName === undefined ? "Running tool" : `Running ${toolName}`,
  runPhaseRetrying: (attempt, maxRetries) => attempt === undefined || maxRetries === undefined
    ? "Retrying"
    : `Retrying ${attempt}/${maxRetries}`,
  runPhaseResponding: "Responding",
  runPhaseTime: (phase, total) => phase === undefined ? `total ${total}` : `${phase} · total ${total}`,
  runtimeSettingsBusy: "Tool permissions and startup options cannot change while a task is running or queued.",
  runtimeSettingsHelp: "Only official Grok settings are shown. Model and reasoning effort apply from the next turn; tool permissions and startup options reconnect idle sessions safely.",
  webSearch: "Web search",
  webSearchHelp: "Allow the official Grok runtime to use Web Search and Web Fetch.",
  planMode: "Planning",
  planModeHelp: "Allow Grok to create and update plans for complex work.",
  subagents: "Subagents",
  subagentsHelp: "Allow Grok to start subagents for suitable parallel work.",
  maxTurns: "Maximum agent turns",
  unlimited: "Unlimited",
  startupBehavior: "New-session startup options",
  usage: "Official usage",
  usageLoading: "Reading usage from the official Grok runtime…",
  usageUnavailable: "The official Grok runtime does not currently report usage and reset time. Guild will not estimate them.",
  usageResetsAt: (date) => `Resets ${date}`,
  viewOfficialUsage: "View official usage in Grok",
  version: "Version",
  independentNotice: "Guild is an independent client and is not affiliated with xAI or Anthropic.",
  recovered: "State recovered after an unclean shutdown",
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
  emptyTask: "Start this task below.",
  currentAttention: "In progress",
  latestResult: "Latest result",
  latestResultNoChanges: "No file or diff evidence was reported for this run",
  interruptedResult: "Run interrupted",
  failedResult: "Run failed",
  cancelledResult: "Run stopped",
  interruptedResultUnconfirmed: "Result unconfirmed; inspect the workspace before deciding whether to retry",
  latestResultCounts: (files, diffs) => `${files} ${files === 1 ? "file" : "files"} · ${diffs} ${diffs === 1 ? "diff" : "diffs"}`,
  viewResult: "View",
  recoveryNoticeTitle: "Run interrupted, session restored",
  recoveryNoticeBody: "The previous instruction was not retried automatically and may have completed some operations. Inspect the result before retrying.",
  recoveryNoticeRestored: "This Grok session is ready for new messages",
  recoveryRetryAction: "Edit and retry",
  addWorkspaceFiles: "Add workspace files",
  attachedFiles: "Attached workspace files",
  attachmentsCannotQueue: "Wait for the current run to finish before sending files",
  removeAttachment: (name) => `Remove ${name}`,
  bannyDragHint: "Drop Banny on a chat to give it a seat, near the window center to send it home, or anywhere else to let it stay there.",
  bannySeated: "Banny is sitting here",
  runtimeUnavailable: "The Grok runtime is temporarily unavailable",
  workspaceFolderMissing: "The workspace folder is gone. Choose that folder again, or switch to a workspace that still exists.",
  messageTooLong: "That message is too long. Shorten it before sending.",
  sessionReplacementTitle: "The previous Grok session cannot continue",
  sessionReplacementBody: "Starting a new session keeps the local transcript. On the first send, Guild attaches a recovery summary for this task. Interrupted work is not resent automatically.",
  sessionReplacementAction: "Start a new session",
  sessionRecoveryContextRequired: "This replacement session has no recoverable task context. Describe what to continue instead of sending only “continue”.",
  operationFailed: "That action could not be completed. Try again.",
  startupUnavailable: "Guild could not open its local data or runtime. Try again; if it still fails, restart the app.",
  retry: "Retry",
  code: "Code",
  permissionOnDemand: "Ask before actions",
  permissionFullAccess: "Full access",
  permissionFullAccessHelp: "Full access lets the official Grok process run tools on this device without asking each time. Use it only in workspaces you trust.",
  contextUsageUnavailable: "Waiting for Grok's exact usage; the first report usually arrives after the first response",
  contextUsageUnavailableCompact: "Waiting for Grok's first usage report",
  loadingEarlierHistory: "Loading earlier history",
  slashCommands: "Grok commands",
  slashCommandsEmpty: "No matching command. Enter still sends it unchanged.",
  commandSending: "Sending to Grok",
  goalPreparing: "Sent; creating the autonomous goal",
  commandWaiting: "Grok received it; waiting for a status update",
  commandRunning: "Grok is working",
  commandRunningTool: (title) => `Running · ${title}`,
  auxiliaryWorkers: (count, activity) => `${count} workers · ${activity}`,
  commandAwaitingPermission: "Waiting for your approval",
  commandCompleting: "Preparing the result",
  commandStopping: "Stopping",
  commandCompleted: "Command completed",
  commandFailed: "Command failed",
  commandCancelled: "Command cancelled",
  commandInterrupted: "Command interrupted",
  toolKindLabel: (kind) => ({
    read: "Read",
    edit: "Edit",
    delete: "Delete",
    move: "Move",
    search: "Search",
    execute: "Execute",
    think: "Think",
    fetch: "Fetch",
    switch_mode: "Switch mode",
    other: "Other tool",
  })[kind],
  contextUsageUsedOnly: (used) => `${used} tokens used`,
  contextUsageCompact: (used, size, percent) => `${used} / ${size} · ${percent}%`,
  contextUsageLabel: (used, size, percent) => `Context ${percent}% used (${used} / ${size})`,
  search: "Search",
  searchPlaceholder: "Search chats",
  clearSearch: "Clear search",
  noSearchResults: "No matching chats",
  searchingConversation: "Searching conversation text…",
  inConversation: "In conversations",
  forkFromHere: "Branch from here",
  commandPalette: "Guild command center",
  commandPalettePlaceholder: "Search tasks, settings, and current session commands",
  commandPaletteEmpty: "No matching action",
  commandPaletteHint: "↑↓ select · Enter open · Esc close",
  commandPaletteGroup: (group) => ({ navigation: "Navigation and settings", tasks: "Tasks", commands: "Current Grok session commands" })[group],
  messageActions: "Message actions",
  copyMessage: "Copy message",
  branchFromMessage: "Create task from this message",
  branchMessageHelp: "Copy the local transcript snapshot through this message and start a new official Grok session",
  retryToDraft: "Move back to composer",
  retryToDraftHelp: "Put the failed or interrupted instruction back in the composer for editing; it will not resend automatically",
  localSettingScope: "Stored locally by Guild on this Mac and applied immediately.",
  officialSettingScope: "Accepted by the official Grok session; an active session is never silently replaced.",
  exportMarkdown: "Export Markdown",
  exportJson: "Export JSON",
  workbench: "Files & review",
  files: "Files",
  review: "Review",
  filesTouched: "Files involved in this task",
  noFilesYet: "Grok has not reported any file locations yet.",
  noChangesYet: "Grok has not reported any changes to review yet.",
  openTerminal: "Open terminal in workspace",
  openTerminalHelp: "Opens this workspace only when you explicitly click.",
  emptyFile: "(empty file)",
  browserPaneWorkbenchTab: "Browser",
  browserPaneTitle: "Browser",
  browserPaneTabs: "Browser tabs",
  browserPaneNewTab: "New tab",
  browserPaneCloseTab: "Close tab",
  browserPaneTabLimit: "Up to 5 tabs can be open",
  browserPaneUntitledTab: "New tab",
  browserPaneBack: "Back",
  browserPaneForward: "Forward",
  browserPaneReload: "Reload",
  browserPaneStop: "Stop loading",
  browserPaneAddress: "Address",
  browserPaneAddressPlaceholder: "Enter a web address, e.g. example.com",
  browserPaneInvalidAddress: "Enter a web address, e.g. example.com",
  browserPaneAgentIdle: "Agent idle",
  browserPaneAgentOperating: "Agent operating",
  browserPaneAgentPaused: "Agent paused, you have control",
  browserPaneTakeOver: "Take over",
  browserPaneResume: "Resume agent",
  browserPaneEmpty: "Enter an address to open a page. The agent can browse here too.",
  permissionModeName: (mode) => ({
    default: "Ask as needed",
    acceptEdits: "Accept edits",
    auto: "Auto",
    dontAsk: "Don't ask",
    bypassPermissions: "Full access",
    plan: "Plan only",
  })[mode],
  officialSessionCapabilities: "Official session capabilities",
  startTaskForCapabilities: "Open a task to see configuration reported by the official ACP session.",
  sessionModes: "Session modes",
  officialCommands: "Slash commands",
  commandsAppearAfterConnect: "Shown after the official Grok session connects.",
  enabled: "Enabled",
  disabled: "Disabled",
  resizeSidebar: "Resize sidebar",
  workspaceFallback: "Workspace",
  browserSync: "Browser sync",
  manageGrokBuild: "Tools & connections",
  grokManagementIntro: "Official Grok Build session commands, extensions, MCP, sessions, worktrees, and runtime administration in one place. Every operation still runs through the official grok process.",
  grokManagementSearch: "Search features",
  grokManagementOpenSettings: "Open Grok session settings",
  runtimeDiagnostics: "Guild runtime diagnostics",
  runtimeDiagnosticsHelp: "Stored only on this Mac: process exits, session recovery, and worker phases. Prompts and normal replies are not deliberately logged; process stderr is credential-redacted.",
  openRuntimeDiagnostics: "Open local diagnostics folder",
  noRuntimeIncidents: "No recent runtime interruptions",
  runtimeRecoveryState: (state) => ({ restoring: "Restoring the original session", restored: "Original session restored", failed: "Original session recovery failed" })[state],
  runtimeLogHasStderr: "redacted stderr available",
  grokManagementSelect: "Choose a feature from the left.",
  grokManagementCommandInput: "Enter command parameters",
  grokManagementRun: "Run",
  grokManagementConfirm: "Confirm and run",
  grokManagementCancelConfirm: "Not now",
  grokManagementResult: "Result",
  grokManagementNoTask: "Open a task with a workspace before using this feature.",
  grokManagementBusy: "A task or another Grok operation is active. Finish it before running administration.",
  grokManagementCompleted: "Completed",
  grokManagementFailed: "Failed",
  grokManagementBoundary: "TUI rendering, headless serialization, gateway/proxy-base overrides, debug files, and shell completions are intentionally excluded. They are transport or developer surfaces, not Guild user features.",
  grokManagementSection: (section) => ({
    commands: "Session commands", runtime: "Runtime and account", extensions: "Plugins and MCP",
    sessions: "Sessions and memory", worktrees: "Worktrees and clone", diagnostics: "Diagnostics and configuration",
  })[section] ?? section,
  grokManagementSectionHelp: (section) => ({
    commands: "No slash typing: choose an official command, provide its input, and run it directly.",
    runtime: "Sign-in, versions, models, updates, and official process state.",
    extensions: "Manage plugins, marketplaces, and MCP servers. Secret headers and environment values are never echoed.",
    sessions: "Search, export, and clean official sessions and cross-session memory.",
    worktrees: "Inspect, clean, salvage worktrees, and lazy-clone repositories.",
    diagnostics: "Inspect project configuration, terminal support, disk usage, and managed configuration.",
  })[section] ?? "",
  grokManagementAction: (action) => EN_GROK_ACTIONS[action],
  grokManagementField: (field) => EN_GROK_FIELDS[field] ?? field,
  grokManagementRequired: (field) => `${EN_GROK_FIELDS[field] ?? field} is required.`,
});

export const LOCALES: Readonly<Record<GuildLocale, GuildMessages>> = Object.freeze({
  "zh-CN": ZH_CN,
  "en-US": EN_US,
});

/*
 * Claude-engine wording (PC-ENG-001). The catalogs above name Grok wherever the product talks about "the runtime".
 * A Claude task shows these replacements for the strings of its own conversation (connecting, waiting, usage,
 * commands, files, rewind); everything else, including the Grok settings and tools, keeps the Grok text.
 * Each builder gets the base catalog so a function-valued entry can delegate for the cases that do not change.
 */
const CLAUDE_ZH = (base: GuildMessages): Partial<GuildMessages> => ({
  connectingRuntime: "正在连接 Claude…",
  runPreparing: "正在准备 Claude",
  runWaitingForGrok: "Claude 已接收，等待响应",
  terminalOutputUnavailable: "当前 Claude 会话没有提供可显示的终端正文。",
  modelPickerScopeRuntime: "使用 Claude 的默认设置",
  modelPickerRefused: (reason) => ({
    incompatible_agent: base.modelPickerRefused("incompatible_agent"),
    unsupported_value: "Claude Code 目前没有为这个任务提供该选项，已保留你之前的选择。",
    unavailable: "Claude Code 暂时无法切换，已保留你之前的选择。",
  })[reason],
  runPhaseStartingRuntime: "正在启动 Claude",
  runPhasePromptSentSlow: "已发送 · Claude 尚未接手",
  latestResultNoChanges: "Claude 未报告文件或差异证据",
  recoveryNoticeRestored: "现在可以继续使用这个 Claude 会话",
  runtimeUnavailable: "Claude 运行时暂时不可用",
  sessionReplacementTitle: "原 Claude 会话无法继续",
  permissionHelp: "权限决定 Claude 何时需要确认。提升权限前，先确认当前项目和要执行的操作。",
  evidenceHelp: "这里显示 Claude 在对话中报告的文件和改动，不代表完整的磁盘或 Git 状态。",
  noEvidenceAction: "可以打开项目文件夹检查实际文件，或让 Claude 检查改动并报告结果。",
  noFilesYet: "Claude 尚未报告文件位置。",
  noChangesYet: "Claude 尚未报告可审阅的变更。",
  contextUsageUnavailable: "尚未收到 Claude 的上下文用量；首次回传通常在首轮回复后出现",
  contextUsageUnavailableCompact: "等待 Claude 首次回传用量",
  slashCommands: "Claude 命令",
  commandSending: "正在发送给 Claude",
  commandWaiting: "Claude 已接收，正在等待状态回传",
  commandRunning: "Claude 正在处理",
  commandPaletteGroup: (group) => ({ navigation: "导航与设置", tasks: "任务", commands: "当前 Claude 会话命令" })[group],
  branchMessageHelp: "复制截至此处的本地对话快照，并启动新的 Claude 会话",
  convertToSteerHelp: "不打断当前这一轮，把这条直接告诉 Claude",
  rewindFilesOnlyBody: (reason) => reason === "unsupported"
    ? "Claude Code 目前不能退回对话，所以只能把文件还原到这一轮之前。对话记录保持不变，这一轮的提问也不会放回输入框。"
    : "Claude Code 暂时不能退回对话，现在只能把文件还原到这一轮之前。对话记录保持不变，这一轮的提问也不会放回输入框。",
  rewindDisabledReason: (reason) => reason === "runtime_unavailable"
    ? "Claude Code 暂时不可用，稍后再试"
    : base.rewindDisabledReason(reason),
  rewindRefused: (reason) => base.rewindRefused(reason).replaceAll("Grok", "Claude Code"),
  rewindRuntimeRestoreHeading: (count) => base.rewindRuntimeRestoreHeading(count).replaceAll("Grok", "Claude Code"),
  interjectionReason: (reason) => base.interjectionReason(reason).replaceAll("Grok", "Claude Code"),
  steerNotice: (kind, reason) => base.steerNotice(kind, reason).replaceAll("Grok", "Claude Code"),
  // Why a continuous task stopped (runtime_unavailable, empty_runtime_response, transport_interrupted name the runtime).
  continuousStopReason: (reason) => base.continuousStopReason(reason).replaceAll("Grok", "Claude Code"),
});

const CLAUDE_EN = (base: GuildMessages): Partial<GuildMessages> => ({
  connectingRuntime: "Connecting to Claude\u2026",
  runPreparing: "Preparing Claude",
  runWaitingForGrok: "Claude received it; waiting for a response",
  terminalOutputUnavailable: "This Claude session did not provide terminal output to show.",
  modelPickerScopeRuntime: "Using Claude's default",
  modelPickerRefused: (reason) => ({
    incompatible_agent: base.modelPickerRefused("incompatible_agent"),
    unsupported_value: "Claude Code does not offer that option for this task right now. Your previous selection was kept.",
    unavailable: "Claude Code could not switch right now. Your previous selection was kept.",
  })[reason],
  runPhaseStartingRuntime: "Starting Claude",
  runPhasePromptSentSlow: "Sent \u00b7 Claude has not picked it up yet",
  latestResultNoChanges: "Claude reported no file or diff evidence",
  recoveryNoticeRestored: "You can keep using this Claude session now",
  runtimeUnavailable: "The Claude runtime is unavailable right now",
  sessionReplacementTitle: "The original Claude session cannot continue",
  permissionHelp: "Permissions decide when Claude needs confirmation. Check the project and intended actions before granting more access.",
  evidenceHelp: "Files and changes reported by Claude in this conversation. This is not a complete disk or Git status.",
  noEvidenceAction: "Open the project folder to inspect files, or ask Claude to check and report the changes.",
  noFilesYet: "Claude has not reported any file locations yet.",
  noChangesYet: "Claude has not reported any changes to review yet.",
  contextUsageUnavailable: "Waiting for Claude's context usage; the first report usually arrives after the first response",
  contextUsageUnavailableCompact: "Waiting for Claude's first usage report",
  slashCommands: "Claude commands",
  commandSending: "Sending to Claude",
  commandWaiting: "Claude received it; waiting for a status update",
  commandRunning: "Claude is working",
  commandPaletteGroup: (group) => ({ navigation: "Navigation and settings", tasks: "Tasks", commands: "Current Claude session commands" })[group],
  branchMessageHelp: "Copy the local transcript snapshot through this message and start a new Claude session",
  convertToSteerHelp: "Tell Claude this now without interrupting the current turn",
  rewindFilesOnlyBody: (reason) => reason === "unsupported"
    ? "Claude Code cannot rewind the conversation, so only the files go back to before this turn. The conversation stays as it is and the prompt is not put back in the composer."
    : "Claude Code cannot rewind the conversation right now, so only the files go back to before this turn. The conversation stays as it is and the prompt is not put back in the composer.",
  rewindDisabledReason: (reason) => reason === "runtime_unavailable"
    ? "Claude Code is unavailable right now. Try again in a moment"
    : base.rewindDisabledReason(reason),
  rewindRefused: (reason) => base.rewindRefused(reason).replaceAll("Grok", "Claude Code"),
  rewindRuntimeRestoreHeading: (count) => base.rewindRuntimeRestoreHeading(count).replaceAll("Grok", "Claude Code"),
  interjectionReason: (reason) => base.interjectionReason(reason).replaceAll("Grok", "Claude Code"),
  steerNotice: (kind, reason) => base.steerNotice(kind, reason).replaceAll("Grok", "Claude Code"),
  // Why a continuous task stopped (runtime_unavailable, empty_runtime_response, transport_interrupted name the runtime).
  continuousStopReason: (reason) => base.continuousStopReason(reason).replaceAll("Grok", "Claude Code"),
});

const CLAUDE_LOCALES: Readonly<Record<GuildLocale, GuildMessages>> = Object.freeze({
  "zh-CN": Object.freeze({ ...ZH_CN, ...CLAUDE_ZH(ZH_CN) }),
  "en-US": Object.freeze({ ...EN_US, ...CLAUDE_EN(EN_US) }),
});

/** The keys a Claude task words differently from the base catalog (for tests and review). */
export function claudeOverrideKeys(locale: GuildLocale): readonly string[] {
  const overrides = locale === "zh-CN" ? CLAUDE_ZH(ZH_CN) : CLAUDE_EN(EN_US);
  return Object.freeze(Object.keys(overrides).sort());
}

/** The catalog for a locale; a Claude-engine task gets its own wording for the strings that name the runtime. */
export function messagesFor(locale: GuildLocale, engine: GuildEngine = "grok"): GuildMessages {
  return engine === "claude" ? CLAUDE_LOCALES[locale] : LOCALES[locale];
}
