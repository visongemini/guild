import type {
  ChooseAvatarResponse,
  ChoosePromptFilesResponse,
  DesktopBootstrapProjection,
  ExportTaskResponse,
  GuildGrokModel,
  GuildGrokPermissionMode,
  GuildGrokReasoningEffort,
  GuildGrokStartupSettings,
  GuildLocale,
  GuildNewTaskWorkspaceMode,
  RunId,
  RunGrokManagementRequest,
  RunGrokManagementResponse,
  SaveProfileAvatar,
  PromptAttachment,
  SendMessageResponse,
  SearchConversationsResponse,
  TaskId,
  TaskViewProjection,
  UpdateTaskRequest,
  WorkspaceId,
} from "@guild/contracts";

export interface DesktopApplicationService {
  bootstrap(): Promise<DesktopBootstrapProjection>;
  chooseWorkspace(): Promise<DesktopBootstrapProjection>;
  choosePromptFiles(taskId: TaskId): Promise<ChoosePromptFilesResponse>;
  createTask(workspaceId: WorkspaceId): Promise<TaskViewProjection>;
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
    model: GuildGrokModel,
    reasoningEffort: GuildGrokReasoningEffort,
    permissionMode: GuildGrokPermissionMode,
    startup: GuildGrokStartupSettings,
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
  close(): Promise<void>;
}
