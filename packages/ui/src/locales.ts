import type { AcpToolKind, GuildGrokManagementAction, GuildGrokPermissionMode, GuildGrokReasoningEffort, GuildLocale, GuildTaskActivity } from "@guild/contracts";

import { WORKSHOP_ZH, WORKSHOP_EN, type WorkshopMessages } from "./workshop-messages.js";

export type GuildMessages = WorkshopMessages & {
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
  readonly reasoningEffortName: (effort: GuildGrokReasoningEffort) => string;
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

const ZH_CN: GuildMessages = Object.freeze({
  ...WORKSHOP_ZH,
  appName: "GUILD",
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
  preemptQueued: "立即插队",
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
  aboutRole: "Guild 是调用官方 Grok 工具的本地单用户客户端。",
  closeDialog: "关闭",
  language: "语言",
  model: "模型",
  reasoningEffort: "推理强度",
  permissionMode: "工具授权",
  reasoningEffortName: (effort) => ({
    xhigh: "超高",
    high: "高",
    medium: "中",
    low: "低",
  })[effort],
  runtimeSettingsBusy: "任务运行或排队时不能切换模型、推理强度或工具授权。",
  runtimeSettingsHelp: "仅显示官方 Grok 设置；切换会安全重连空闲会话。",
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
  independentNotice: "Guild 是独立客户端，与 xAI 无隶属关系。",
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
  appName: "GUILD",
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
  aboutRole: "Guild is a local single-user client that calls the official Grok tools.",
  closeDialog: "Close",
  language: "Language",
  model: "Model",
  reasoningEffort: "Reasoning effort",
  permissionMode: "Tool permissions",
  reasoningEffortName: (effort) => ({
    xhigh: "Extra high",
    high: "High",
    medium: "Medium",
    low: "Low",
  })[effort],
  runtimeSettingsBusy: "Model, reasoning, and tool permissions cannot change while a task is running or queued.",
  runtimeSettingsHelp: "Only official Grok settings are shown; idle sessions reconnect safely.",
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
  independentNotice: "Guild is an independent client and is not affiliated with xAI.",
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

export function messagesFor(locale: GuildLocale): GuildMessages {
  return LOCALES[locale];
}
