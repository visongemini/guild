import type {
  ApplyWorktreeResponse,
  ChooseAvatarResponse,
  ChoosePromptFilesResponse,
  ConvertQueuedTurnToSteerResponse,
  DesktopBootstrapProjection,
  DiscardWorktreeResponse,
  ExecuteRewindRequest,
  ExecuteRewindResponse,
  ExportTaskResponse,
  GuildClaudePermissionMode,
  GuildEngine,
  GuildGrokModel,
  GuildGrokPermissionMode,
  GuildGrokReasoningEffort,
  GuildGrokStartupSettings,
  GuildLocale,
  GuildNewTaskWorkspaceMode,
  GuildTaskIsolation,
  LoadRunFileDiffRequest,
  LoadRunFileDiffResponse,
  PreviewRewindResponse,
  PreviewWorktreeApplyResponse,
  RunId,
  RunGrokManagementRequest,
  RunGrokManagementResponse,
  SaveProfileAvatar,
  PromptAttachment,
  SendMessageResponse,
  SearchConversationsResponse,
  SteerMessageResponse,
  SetTaskRuntimeSettingsRequest,
  SetTaskRuntimeSettingsResponse,
  StreamDeltaEvent,
  TaskId,
  TaskViewProjection,
  UpdateTaskRequest,
  WorkspaceId,
} from "@guild/contracts";

export interface DesktopApplicationService {
  bootstrap(): Promise<DesktopBootstrapProjection>;
  chooseWorkspace(): Promise<DesktopBootstrapProjection>;
  choosePromptFiles(taskId: TaskId): Promise<ChoosePromptFilesResponse>;
  /** `isolation: "worktree"` (F3) gives the task its own git worktree; refusals throw `worktree_<reason>`. */
  createTask(
    workspaceId: WorkspaceId,
    isolation?: GuildTaskIsolation,
    /** Engine of the new task (PC-ENG-001); absent means Grok. */
    engine?: GuildEngine,
  ): Promise<TaskViewProjection>;
  /**
   * Changes the engine of a task before its first turn. Refused with `task_engine_locked` once the
   * task has a Run, a queued turn or a started turn, or has switched to a router model (PC-TASK-001).
   */
  setTaskEngine(taskId: TaskId, engine: GuildEngine): Promise<TaskViewProjection>;
  openTask(taskId: TaskId, sequence?: number): Promise<TaskViewProjection>;
  loadEarlierTimeline(taskId: TaskId): Promise<TaskViewProjection>;
  loadSlashCommands(taskId: TaskId): Promise<TaskViewProjection>;
  forkTask(taskId: TaskId, throughSequence?: number): Promise<TaskViewProjection>;
  exportTask(taskId: TaskId, format: "markdown" | "json"): Promise<ExportTaskResponse>;
  searchConversations(query: string): Promise<SearchConversationsResponse>;
  openTaskResource(
    taskId: TaskId,
    action: "terminal" | "folder" | "file",
    path?: string,
  ): Promise<void>;
  setSessionConfigOption(
    taskId: TaskId,
    configId: string,
    value: string | boolean,
  ): Promise<TaskViewProjection>;
  /** Pins the model and reasoning effort for one task; applied between turns, never mid-turn. */
  setTaskRuntimeSettings(
    request: SetTaskRuntimeSettingsRequest,
  ): Promise<SetTaskRuntimeSettingsResponse>;
  updateWorkspace(
    workspaceId: WorkspaceId,
    action: "archive" | "restore" | "delete",
  ): Promise<DesktopBootstrapProjection>;
  updateTask(request: UpdateTaskRequest): Promise<DesktopBootstrapProjection>;
  sendMessage(
    taskId: TaskId,
    text: string,
    attachments?: readonly PromptAttachment[],
    mode?: "standard" | "continuous",
  ): Promise<SendMessageResponse>;
  setContinuousTask(
    taskId: TaskId,
    action: "pause" | "resume" | "stop",
  ): Promise<TaskViewProjection>;
  prioritizeQueuedTurn(taskId: TaskId, queueId: string): Promise<void>;
  preemptQueuedTurn(taskId: TaskId, queueId: string): Promise<void>;
  cancelQueuedTurn(taskId: TaskId, queueId: string): Promise<void>;
  cancelRun(taskId: TaskId, runId: RunId): Promise<void>;
  /** F4: injects the text into the running turn; falls back to the durable queue with a reason. */
  steerMessage(taskId: TaskId, text: string): Promise<SteerMessageResponse>;
  /** F4: sends a queued turn into the running turn instead; it stays queued when Steer is impossible. */
  convertQueuedTurnToSteer(taskId: TaskId, queueId: string): Promise<ConvertQueuedTurnToSteerResponse>;
  /** F2: what going back to before this Run started would do, and what it cannot undo. */
  previewRewind(taskId: TaskId, runId: RunId): Promise<PreviewRewindResponse>;
  /** F2: rewinds the conversation and restores the files from Guild's checkpoint. */
  executeRewind(request: ExecuteRewindRequest): Promise<ExecuteRewindResponse>;
  /** F2: the bounded unified diff of one file the Run changed. */
  loadRunFileDiff(request: LoadRunFileDiffRequest): Promise<LoadRunFileDiffResponse>;
  /** F3: what merging the task's worktree branch back would change, found without changing anything. */
  previewWorktreeApply(taskId: TaskId): Promise<PreviewWorktreeApplyResponse>;
  /** F3: commits uncommitted worktree files and merges the branch back with `git merge --no-ff`. */
  applyWorktree(taskId: TaskId): Promise<ApplyWorktreeResponse>;
  /** F3: removes the task's worktree and its Guild branch. The caller has confirmed. */
  discardWorktree(taskId: TaskId): Promise<DiscardWorktreeResponse>;
  /** F3: shows the task's worktree folder in Finder, or opens a terminal in it. */
  openWorktreeResource(taskId: TaskId, action: "folder" | "terminal"): Promise<void>;
  decidePermission(input: {
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly permissionId: string;
    readonly decision: { readonly type: "cancelled" } | {
      readonly type: "selected";
      readonly optionId: string;
    };
  }): Promise<void>;
  setDraft(taskId: TaskId, text: string): Promise<void>;
  authorizeSessionReplacement(taskId: TaskId): Promise<TaskViewProjection>;
  refreshUsage(): Promise<DesktopBootstrapProjection>;
  openExternal(url: string): Promise<void>;
  setLocale(locale: GuildLocale): Promise<DesktopBootstrapProjection>;
  setRuntimeSettings(
    model: GuildGrokModel | null,
    reasoningEffort: GuildGrokReasoningEffort | null,
    permissionMode: GuildGrokPermissionMode,
    startup: GuildGrokStartupSettings,
  ): Promise<DesktopBootstrapProjection>;
  /** Defaults a new Claude-engine task starts from (PC-SET-002); applied to sessions between turns. */
  setClaudeSettings(
    model: string | null,
    reasoningEffort: string | null,
    permissionMode: GuildClaudePermissionMode,
  ): Promise<DesktopBootstrapProjection>;
  setSidebarWidth(width: number): Promise<void>;
  chooseAvatar(): Promise<ChooseAvatarResponse>;
  saveProfile(nickname: string, avatar: SaveProfileAvatar): Promise<DesktopBootstrapProjection>;
  setGeneralSettings(
    restoreLastTask: boolean,
    newTaskWorkspaceMode: GuildNewTaskWorkspaceMode,
    browserSyncEnabled: boolean,
    taskNotificationsEnabled: boolean,
  ): Promise<DesktopBootstrapProjection>;
  openUserData(): Promise<void>;
  restoreUserData(): Promise<{ readonly status: "cancelled" | "restarting" }>;
  backupUserData(): Promise<{ readonly status: "cancelled" } | { readonly status: "saved"; readonly path: string }>;
  openRuntimeDiagnostics(): Promise<void>;
  runGrokManagement(request: RunGrokManagementRequest): Promise<RunGrokManagementResponse>;
  handleLifecycleEvent(event: "renderer_reload" | "suspend" | "resume"): Promise<void>;
  subscribe(listener: (projection: DesktopBootstrapProjection) => void): () => void;
  /** Small append-only text events for the active task; never an authority over the projection. */
  subscribeStreamDeltas(listener: (delta: StreamDeltaEvent) => void): () => void;
  close(): Promise<void>;
}
