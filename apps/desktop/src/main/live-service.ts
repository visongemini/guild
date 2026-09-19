import { sealBackup, stageBackup } from "./local-backup.js";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { cp, mkdir, open, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  GUILD_API_VERSION,
  GUILD_PROMPT_ATTACHMENT_LIMIT,
  GUILD_PROMPT_ATTACHMENT_MAX_BYTES,
  GUILD_GROK_MODELS,
  GUILD_GROK_PERMISSION_MODES,
  canonicalGuildExternalUrl,
  createRuntimeTurnEvent,
  nextAdapterEpoch,
  parseAdapterEpoch,
  parseBarrierRequestId,
  parseIdempotencyKey,
  parsePermissionDeliveryAttemptId,
  parsePermissionOutboxCommandId,
  parsePermissionOutboxVersion,
  parseRunId,
  parseSessionAttemptId,
  parseSessionId,
  parseTaskId,
  parseToolCallId,
  parseWindowId,
  parseWorkspaceId,
  parseGuildNickname,
  parseGuildNewTaskWorkspaceMode,
  parseContinuousFooter,
  supportsGuildGrokReasoningEffort,
  type AdapterEpoch,
  type AcpToolKind,
  type AcpToolStatus,
  type DesktopBootstrapProjection,
  type GuildLocale,
  type GuildGrokModel,
  type GuildGrokPermissionMode,
  type GuildGrokReasoningEffort,
  type GuildGrokStartupSettings,
  type GuildTaskActivity,
  type IdempotencyKey,
  type OfficialUsageProjection,
  type PermissionIdentity,
  type RunId,
  type RuntimePermissionRequestPayload,
  type RuntimeCommand,
  type RuntimeConfigOption,
  type RuntimeToolContent,
  type RuntimeToolLocation,
  type RuntimeTurnPayload,
  type SessionAttemptId,
  type SessionId,
  type TaskId,
  type TaskViewProjection,
  type TimelineToolContent,
  type TimelineItemProjection,
  type WindowId,
  type WorkspaceId,
  type ChooseAvatarResponse,
  type ChoosePromptFilesResponse,
  type GuildNewTaskWorkspaceMode,
  type SaveProfileAvatar,
  type RunGrokManagementRequest,
  type RunGrokManagementResponse,
  type RuntimeIncidentProjection,
  type PromptAttachment,
} from "@guild/contracts";
import {
  CONFLICT_FREE_VERDICT,
  type PermissionRecord,
  type RunRecord,
} from "@guild/domain";
import {
  openGuildPersistence,
  type ConversationEntryRecord,
  type ContinuousTaskRecord,
  type GuildPersistence,
} from "@guild/persistence";
import {
  ACP_V1_CODEC_LIMITS,
  AcpV1Adapter,
  AcpV1AdapterError,
  GrokProcessHost,
  type AcpV1AdapterInterruptionReason,
  type AcpV1AdapterInterruptionDiagnostic,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1DecodedUpdate,
  type AcpV1InitializeResult,
  type AcpV1OfficialBillingSnapshot,
  type AcpV1SessionState,
  type JsonRpcInboundResponseWriteReceipt,
  type JsonRpcWriteReceipt,
} from "@guild/runtime-grok";
import type { DesktopApplicationService } from "./application-service.js";
import {
  GuildAvatarError,
  inspectAvatarBytes,
  inspectDisplayImageBytes,
} from "./profile-image.js";
import {
  locateOfficialGrokRuntime,
  resolveOfficialGrokEnvironment,
} from "./runtime-locator.js";
import {
  SESSION_RECOVERY_CONTEXT_REQUIRED,
  assertWorkspaceFolderExists,
} from "./workspace-folder.js";
import {
  buildGrokManagementCommand,
  runOfficialGrokManagement,
} from "./grok-management.js";
import {
  allConversationEntries,
  buildTaskWorkbench,
  conversationMatches,
  exportConversation,
} from "./task-artifacts.js";
import {
  RuntimeDiagnosticLog,
  type RuntimeDiagnosticRecord,
} from "./runtime-diagnostics.js";

const PRIMARY_WINDOW_ID = must(parseWindowId("guild-primary-window"));
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const DEFAULT_CANCEL_GRACE_MS = 1_500;
const DEFAULT_PROMPT_SETTLE_MS = 1_500;
const CONVERSATION_PAGE_SIZE = 500;
const REPLACEMENT_RECOVERY_CAPSULE_MAX_LENGTH = 12_000;
const REPLAY_STAGING_MAX_UPDATES = 10_000;
const REPLAY_STAGING_MAX_BYTES = 32 * 1024 * 1024;
const PLAN_DISPLAY_MAX_CHARS = 64 * 1024;

export type WorkspaceChooser = () => Promise<string | undefined>;

export type RuntimeAdapterPort = {
  readonly state: string;
  start(): Promise<AcpV1InitializeResult>;
  authenticate(methodId: string): Promise<void>;
  officialBilling(): Promise<AcpV1OfficialBillingSnapshot>;
  setModel(
    session: AcpV1AdapterSession,
    model: GuildGrokModel,
  ): Promise<void>;
  setMode(
    session: AcpV1AdapterSession,
    model: GuildGrokModel,
    reasoningEffort: GuildGrokReasoningEffort,
  ): Promise<void>;
  setConfigOption(
    session: AcpV1AdapterSession,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]>;
  newSession(cwd: string): Promise<AcpV1AdapterSession>;
  resumeSession(sessionId: string, cwd: string): Promise<AcpV1AdapterSession>;
  loadSession(sessionId: string, cwd: string): Promise<AcpV1AdapterSession>;
  prompt(
    session: AcpV1AdapterSession,
    text: string,
    resources?: readonly {
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size?: number;
    }[],
  ): Promise<RuntimeTurnPayload & { readonly type: "prompt_terminal" }>;
  cancel(session: AcpV1AdapterSession): Promise<JsonRpcWriteReceipt>;
  close(): Promise<void>;
};

export type RuntimeFactory = (input: {
  readonly adapterEpoch: AdapterEpoch;
  readonly sink: AcpV1AdapterSink;
  readonly stagingRoot: string;
  readonly workingDirectory: string;
  readonly runtimeSettings: {
    readonly model: GuildGrokModel;
    readonly reasoningEffort: GuildGrokReasoningEffort;
    readonly permissionMode: GuildGrokPermissionMode;
    readonly startup: GuildGrokStartupSettings;
  };
}) => Promise<{ readonly adapter: RuntimeAdapterPort; readonly runtimeVersion?: string }>;

export type LiveDesktopServiceOptions = {
  readonly appVersion: string;
  readonly databasePath: string;
  readonly initialLocale?: GuildLocale;
  readonly stagingRoot: string;
  readonly mediaRoot?: string;
  readonly chooseWorkspace: WorkspaceChooser;
  readonly choosePromptFiles?: (input: {
    readonly workspacePath: string;
    readonly locale: GuildLocale;
  }) => Promise<readonly string[] | undefined>;
  readonly chooseAvatarFile?: () => Promise<string | undefined>;
  readonly openUserData?: () => Promise<void>;
  readonly chooseUserDataRestorePath?: () => Promise<string | undefined>;
  readonly requestRestoreRestart?: (stagedRoot: string) => void;
  readonly chooseUserDataBackupPath?: () => Promise<string | undefined>;
  readonly openRuntimeDiagnostics?: () => Promise<void>;
  readonly openExternal?: (url: string) => Promise<void>;
  readonly saveTaskExport?: (input: {
    readonly suggestedFilename: string;
    readonly format: "markdown" | "json";
    readonly contents: string;
  }) => Promise<"cancelled" | "saved">;
  readonly openWorkspaceFolder?: (path: string) => Promise<void>;
  readonly openWorkspaceTerminal?: (path: string) => Promise<void>;
  readonly openTaskFile?: (path: string) => Promise<void>;
  readonly runtimeFactory?: RuntimeFactory;
  readonly usageFetcher?: (signal: AbortSignal) => Promise<AcpV1OfficialBillingSnapshot>;
  readonly managementRunner?: (input: {
    readonly request: RunGrokManagementRequest;
    readonly workingDirectory: string;
    readonly signal: AbortSignal;
    readonly onOutput?: (output: string) => void;
  }) => Promise<RunGrokManagementResponse>;
  readonly cancelGraceMs?: number;
  readonly promptSilenceMs?: number;
  readonly promptSettleMs?: number;
  readonly diagnosticsRoot?: string;
};

type PendingPermission = {
  readonly identity: PermissionIdentity;
  readonly permissionId: string;
  readonly createdAtMs: number;
  readonly sequence: number;
  readonly request: RuntimePermissionRequestPayload;
  readonly decision: Deferred<
    | { readonly type: "cancelled" }
    | { readonly type: "selected"; readonly optionId: string }
  >;
  readonly prepared: Deferred<void>;
};

type RuntimeController = {
  adapter: RuntimeAdapterPort | undefined;
  adapterEpoch: AdapterEpoch | undefined;
  lastAllocatedAdapterEpoch: AdapterEpoch | undefined;
  activeRunId: RunId | undefined;
  promptRunId: RunId | undefined;
  promptOperation: Promise<void> | undefined;
  promptReplayProof: Readonly<{
    runId: RunId;
    sessionId: string;
    outboundPromptSha256: string;
    outboundPromptHadResources: boolean;
    recoveryCapsule: boolean;
    proofEntryId: string;
  }> | undefined;
  recoveryHandoff: Readonly<{
    runId: RunId;
    sessionId: string;
    sourceNoticeEntryId: string;
    handoffEntryId: string;
  }> | undefined;
  currentAttemptId: SessionAttemptId | undefined;
  receiveSequence: number;
  session: AcpV1AdapterSession | undefined;
  replayStaging: ReplayStaging | undefined;
  readonly replayAbortAcks: Map<string, Readonly<{
    sessionId: string;
    adapterEpoch: AdapterEpoch;
  }>>;
  startOperation: Promise<AcpV1AdapterSession> | undefined;
  cancelTimer: ReturnType<typeof setTimeout> | undefined;
  promptSilenceTimer: ReturnType<typeof setTimeout> | undefined;
  contextWindowUsage: { readonly used: number; readonly size?: number } | undefined;
  contextWindowSize: number | undefined;
  availableCommands: readonly RuntimeCommand[];
  sessionModes: AcpV1AdapterSession["modes"];
  sessionConfigOptions: readonly RuntimeConfigOption[];
  readonly pendingPermissions: Map<string, PendingPermission>;
  readonly streamingEntries: Map<"assistant" | "thought", ConversationEntryRecord>;
  replayOrderLastToken: string | undefined;
  readonly toolStates: Map<string, ToolProjectionState>;
  readonly auxiliarySessions: Map<string, AuxiliarySessionState>;
  closeInterruptionOverride: Readonly<{
    reason: AcpV1AdapterInterruptionReason;
    diagnostic: AcpV1AdapterInterruptionDiagnostic;
  }> | undefined;
};

type ReplayStaging = {
  readonly barrierId: string;
  readonly sessionId: string;
  readonly adapterEpoch: AdapterEpoch;
  readonly attemptId: SessionAttemptId;
  readonly updates: AcpV1DecodedUpdate[];
  approximateBytes: number;
};

type ReplayToolSnapshot = Readonly<{
  digest: string;
  title: string;
  kind: AcpToolKind;
  status: AcpToolStatus;
  content: readonly RuntimeToolContent[];
  locations: readonly RuntimeToolLocation[];
  replayProofUnavailable: boolean;
}>;

type ReplayTurnSnapshot = {
  user: string;
  hasUserChunk: boolean;
  userMessageId: string | null | undefined;
  assistant: string;
  thought: string;
  plan: string | undefined;
  readonly tools: Map<string, ReplayToolSnapshot>;
  readonly media: string[];
  readonly order: string[];
};

type LocalReplayTurn = ReplayTurnSnapshot & {
  readonly run: RunRecord;
  outboundPromptSha256: string | undefined;
  outboundPromptHadResources: boolean;
  outboundPromptProofVersion: number | undefined;
  outboundPromptRecoveryCapsule: boolean;
};

type PreparedRuntimePrompt = Readonly<{
  text: string;
  recoveryHandoff?: Readonly<{ sourceNoticeEntryId: string }>;
}>;

type AuxiliarySessionState = {
  activity: GuildTaskActivity;
  readonly startedAtMs: number;
  updatedAtMs: number;
  readonly tools: Map<string, { kind: AcpToolKind; status: AcpToolStatus }>;
};

type ToolProjectionState = Readonly<{
  runtimeReplayKind: "tool" | "plan";
  title: string;
  kind: AcpToolKind;
  status: AcpToolStatus;
  content: readonly RuntimeToolContent[];
  displayContent: readonly TimelineToolContent[];
  locations: readonly RuntimeToolLocation[];
  replayProofUnavailable: boolean;
}>;

function buildContinuousPrompt(
  mission: ContinuousTaskRecord,
  locale: GuildLocale,
): string {
  const prior = [
    mission.summary === undefined ? undefined : `Previous verified summary:\n${mission.summary}`,
    mission.remaining === undefined ? undefined : `Known remaining gaps:\n${mission.remaining}`,
  ].filter((value): value is string => value !== undefined).join("\n\n");
  if (mission.phase === "audit") {
    return locale === "zh-CN"
      ? `[Guild 持续任务 · 审计阶段 · 第 ${mission.cycle} 轮]\n\n原始目标（不可改写）：\n${mission.objective}\n\n${prior}\n\n请只依据当前工作区的真实状态与本轮可见证据审计目标是否已经完整达成。不要实施新修改；必要时做只读检查。最后三行必须严格使用以下字段，且每个字段只占一行：\nGUILD_CONTINUOUS_SUMMARY: 已确认完成的内容\nGUILD_CONTINUOUS_REMAINING: 仍未完成的差距；若无则写 NONE\nGUILD_CONTINUOUS_VERDICT: CONTINUE、COMPLETE 或 BLOCKED\n\n现在开始本轮审计。`
      : `[Guild continuous task · audit phase · cycle ${mission.cycle}]\n\nImmutable original objective:\n${mission.objective}\n\n${prior}\n\nAudit whether the objective is fully complete using only the current workspace and visible evidence from this cycle. Do not make new changes; use read-only checks when needed. The final three lines must use these exact fields, one per line:\nGUILD_CONTINUOUS_SUMMARY: verified completed work\nGUILD_CONTINUOUS_REMAINING: unfinished gaps, or NONE\nGUILD_CONTINUOUS_VERDICT: CONTINUE, COMPLETE, or BLOCKED\n\nBegin this audit now.`;
  }
  return locale === "zh-CN"
    ? `[Guild 持续任务 · 执行阶段 · 第 ${mission.cycle} 轮]\n\n原始目标（不可改写）：\n${mission.objective}\n\n${prior}\n\n检查当前工作区，选择尚未完成且优先级最高的一块实质工作，直接实施并按风险做验证。不要重复已经完成的修改，不要仅给方案，也不要把目标偷偷缩窄。若遇到必须由用户决定、权限缺失或外部状态阻塞，请明确说明。最后三行必须严格使用以下字段，且每个字段只占一行：\nGUILD_CONTINUOUS_SUMMARY: 本轮实际完成并验证的内容\nGUILD_CONTINUOUS_REMAINING: 对照原始目标仍未完成的差距；若判断已全部完成则写 NONE\nGUILD_CONTINUOUS_VERDICT: CONTINUE、COMPLETE 或 BLOCKED\n\n现在开始本轮工作。`
    : `[Guild continuous task · work phase · cycle ${mission.cycle}]\n\nImmutable original objective:\n${mission.objective}\n\n${prior}\n\nInspect the current workspace, select the highest-priority meaningful unfinished slice, implement it, and verify it in proportion to risk. Do not repeat completed changes, merely propose work, or silently narrow the objective. Clearly report any user decision, missing authority, or external blocker. The final three lines must use these exact fields, one per line:\nGUILD_CONTINUOUS_SUMMARY: work actually completed and verified this cycle\nGUILD_CONTINUOUS_REMAINING: gaps remaining against the original objective, or NONE\nGUILD_CONTINUOUS_VERDICT: CONTINUE, COMPLETE, or BLOCKED\n\nBegin this work phase now.`;
}

export function createLiveDesktopService(
  options: LiveDesktopServiceOptions,
): DesktopApplicationService {
  const store = openGuildPersistence({
    path: options.databasePath,
    initialLocale: options.initialLocale,
  });
  const listeners = new Set<(projection: DesktopBootstrapProjection) => void>();
  const controllers = new Map<TaskId, RuntimeController>();
  const persistedContextTokens = new Map<TaskId, number | null>();
  const conversationPageDepths = new Map<TaskId, number>();
  const scheduledQueuedTasks = new Map<TaskId, Promise<void>>();
  const scheduledContinuousTasks = new Map<TaskId, Promise<void>>();
  const runtimeFactory = options.runtimeFactory ?? createProductionRuntime;
  const mediaRoot = options.mediaRoot ?? `${options.databasePath}.media`;
  const diagnosticsRoot = options.diagnosticsRoot ?? join(dirname(options.databasePath), "diagnostics");
  const diagnosticLog = new RuntimeDiagnosticLog(diagnosticsRoot);
  const runtimeIncidents = new Map<string, RuntimeIncidentProjection>();
  const usageFetcher = options.usageFetcher ?? ((signal: AbortSignal) => fetchProductionOfficialUsage({
    stagingRoot: options.stagingRoot,
    workingDirectory: dirname(options.databasePath),
    signal,
  }));
  const managementRunner = options.managementRunner ?? runOfficialGrokManagement;
  let activeTaskId: TaskId | undefined;
  let runtimeVersion: string | undefined;
  let usageSnapshot: AcpV1OfficialBillingSnapshot | undefined;
  let usageFetchedAtMs = 0;
  let usageLoading = false;
  let usageOperation: Promise<void> | undefined;
  let usageAbortController: AbortController | undefined;
  let managementOperationActive = false;
  let managementOperation: Promise<RunGrokManagementResponse> | undefined;
  let managementAbortController: AbortController | undefined;
  let managementProgress: DesktopBootstrapProjection["grokManagementProgress"];
  let messageAdmissionsActive = 0;
  let closed = false;
  let closing = false;
  let runtimeGeneration = 0;
  let commandTail: Promise<void> = Promise.resolve();
  let publishOperation: Promise<void> | undefined;
  let publishQueued = false;
  let streamPublishOperation: Promise<void> | undefined;
  let lastStreamYieldAt = performance.now();
  let activeTaskHydrated = false;
  let allowAutoSelectActiveTask = true;
  const avatarPreviews = new Map<string, string>();

  void Promise.all([
    mkdir(options.stagingRoot, { recursive: true, mode: 0o700 }),
    mkdir(mediaRoot, { recursive: true, mode: 0o700 }),
  ]);

  let maintenance = false;
  function assertOpen(): void {
    if (closed || closing || maintenance) throw new Error("desktop_service_closed");
  }

  function logRuntime(
    record: Omit<RuntimeDiagnosticRecord, "schemaVersion" | "occurredAtIso">,
  ): void {
    void diagnosticLog.append(Object.freeze({
      schemaVersion: 1,
      occurredAtIso: new Date().toISOString(),
      ...record,
    })).catch(() => undefined);
  }

  async function hydrateRuntimeIncidents(): Promise<void> {
    const records = await diagnosticLog.readRecent();
    const hydrated = new Map<string, RuntimeIncidentProjection>();
    for (const record of records) {
      if (
        record.category === "transport" &&
        record.event === "interrupted" &&
        record.incidentId !== undefined &&
        record.taskId !== undefined
      ) {
        const parsedTaskId = parseTaskId(record.taskId);
        if (!parsedTaskId.ok) continue;
        let taskTitle: string;
        try {
          taskTitle = store.loadTaskMetadata(parsedTaskId.value).title;
        } catch {
          continue;
        }
        hydrated.set(record.incidentId, Object.freeze({
          incidentId: record.incidentId,
          occurredAtIso: record.occurredAtIso,
          taskId: parsedTaskId.value,
          taskTitle,
          reason: record.reason ?? "process_fault",
          recovery: "restoring",
          ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
          ...(record.signal === undefined ? {} : { signal: record.signal }),
          hasStderr:
            (record.stderrTail?.length ?? 0) > 0 ||
            (record.stderrCapturedBytes ?? 0) > 0 ||
            (record.stderrDroppedBytes ?? 0) > 0,
        }));
        continue;
      }
      if (
        record.category !== "recovery" ||
        record.incidentId === undefined ||
        (record.event !== "restored" && record.event !== "failed")
      ) continue;
      const previous = hydrated.get(record.incidentId);
      if (previous !== undefined) {
        hydrated.set(record.incidentId, Object.freeze({
          ...previous,
          recovery: record.event,
        }));
      }
    }
    for (const incident of [...hydrated.values()]
      .sort((a, b) => b.occurredAtIso.localeCompare(a.occurredAtIso))
      .slice(0, 64)) {
      if (!runtimeIncidents.has(incident.incidentId)) {
        runtimeIncidents.set(incident.incidentId, incident);
      }
    }
  }

  function controllerFor(taskId: TaskId): RuntimeController {
    let controller = controllers.get(taskId);
    if (controller === undefined) {
      controller = {
        adapter: undefined,
        adapterEpoch: undefined,
        lastAllocatedAdapterEpoch: undefined,
        activeRunId: undefined,
        promptRunId: undefined,
        promptOperation: undefined,
        promptReplayProof: undefined,
        recoveryHandoff: undefined,
        currentAttemptId: undefined,
        receiveSequence: 0,
        session: undefined,
        replayStaging: undefined,
        replayAbortAcks: new Map(),
        startOperation: undefined,
        cancelTimer: undefined,
        promptSilenceTimer: undefined,
        contextWindowUsage: undefined,
        contextWindowSize: undefined,
        availableCommands: Object.freeze([]),
        sessionModes: null,
        sessionConfigOptions: Object.freeze([]),
        pendingPermissions: new Map(),
        streamingEntries: new Map(),
        replayOrderLastToken: undefined,
        toolStates: new Map(),
        auxiliarySessions: new Map(),
        closeInterruptionOverride: undefined,
      };
      controllers.set(taskId, controller);
    }
    return controller;
  }

  function enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
    const result = commandTail.then(operation, operation);
    commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function hydrateActiveTask(settings: ReturnType<GuildPersistence["loadAppSettings"]>): void {
    if (activeTaskHydrated) return;
    activeTaskHydrated = true;
    allowAutoSelectActiveTask = settings.restoreLastTask;
    if (!settings.restoreLastTask) {
      activeTaskId = undefined;
      return;
    }
    if (settings.lastActiveTaskId === undefined) return;
    try {
      const metadata = store.loadTaskMetadata(settings.lastActiveTaskId);
      const workspace = store.loadWorkspace(metadata.workspaceId);
      if (metadata.disposition === "active" && workspace.disposition === "active") {
        activeTaskId = settings.lastActiveTaskId;
      }
    } catch {
      // Invalid persisted selection falls back to the first active task.
    }
  }

  function persistTaskSelection(taskId: TaskId): void {
    const metadata = store.loadTaskMetadata(taskId);
    const settings = store.loadAppSettings();
    store.updateAppSettings({
      expectedRevision: settings.revision,
      lastActiveTaskId: taskId,
      lastWorkspaceId: metadata.workspaceId,
    });
  }

  function clearPersistedTaskSelection(taskId: TaskId): void {
    const settings = store.loadAppSettings();
    if (settings.lastActiveTaskId !== taskId) return;
    store.updateAppSettings({
      expectedRevision: settings.revision,
      lastActiveTaskId: null,
    });
  }

  function isUntitledNewTask(taskId: TaskId): boolean {
    const metadata = store.loadTaskMetadata(taskId);
    if (
      metadata.disposition !== "active" ||
      (metadata.title !== "新任务" && metadata.title !== "New task") ||
      store.countConversationEntries(taskId) > 0 ||
      store.listQueuedTurns(taskId).length > 0
    ) {
      return false;
    }
    return store.restoreTask(taskId).currentRun === undefined;
  }

  function isPristineNewTask(taskId: TaskId): boolean {
    return isUntitledNewTask(taskId) &&
      store.loadDraft(taskId) === undefined &&
      store.loadContinuousTask(taskId) === undefined;
  }

  function discardStoredPristineTasks(): void {
    for (const workspace of store.listWorkspaces({ includeArchived: true })) {
      for (const task of store.listTasks({ workspaceId: workspace.workspaceId })) {
        if (!isPristineNewTask(task.taskId)) continue;
        store.deleteTask({ taskId: task.taskId, expectedRevision: task.revision });
        clearPersistedTaskSelection(task.taskId);
      }
    }
  }

  async function discardPristineTask(taskId: TaskId): Promise<boolean> {
    if (!isPristineNewTask(taskId)) return false;
    const controller = controllers.get(taskId);
    if (controller !== undefined) {
      await closeController(taskId, controller);
      controllers.delete(taskId);
    }
    const task = store.loadTaskMetadata(taskId);
    store.deleteTask({ taskId, expectedRevision: task.revision });
    conversationPageDepths.delete(taskId);
    persistedContextTokens.delete(taskId);
    clearPersistedTaskSelection(taskId);
    if (activeTaskId === taskId) activeTaskId = undefined;
    return true;
  }

  function publish(): Promise<void> {
    if (closed || closing || maintenance) return Promise.resolve();
    publishQueued = true;
    if (publishOperation !== undefined) return publishOperation;
    publishOperation = new Promise<void>((resolve, reject) => {
      const flush = (): void => {
        setTimeout(() => {
          if (closed || closing || maintenance) {
            publishOperation = undefined;
            publishQueued = false;
            resolve();
            return;
          }
          try {
            publishQueued = false;
            const projection = buildBootstrap();
            for (const listener of [...listeners]) listener(projection);
            if (publishQueued) {
              flush();
            } else {
              publishOperation = undefined;
              resolve();
            }
          } catch (cause: unknown) {
            publishOperation = undefined;
            publishQueued = false;
            reject(cause);
          }
        }, 16);
      };
      flush();
    });
    return publishOperation;
  }

  function scheduleStreamPublish(): void {
    // One observed promise per batch; do not retain a handler for every chunk.
    if (streamPublishOperation !== undefined) return;
    const operation = publish();
    streamPublishOperation = operation;
    void operation.then(() => {
      if (streamPublishOperation === operation) streamPublishOperation = undefined;
    }, () => {
      if (streamPublishOperation === operation) streamPublishOperation = undefined;
      logRuntime({ category: "runtime", event: "stream_projection_failed" });
    });
  }

  function buildBootstrap(restoreHistory = false): DesktopBootstrapProjection {
    assertOpen();
    const settings = store.loadAppSettings();
    hydrateActiveTask(settings);
    const workspaces = store.listWorkspaces({ includeArchived: true }).map((workspace) => {
      const workspaceId = must(parseWorkspaceId(workspace.workspaceId));
      const tasks = store.listTasks({ workspaceId, includeArchived: true })
        .filter((task) => !isPristineNewTask(task.taskId))
        .map((task) => {
          const taskId = must(parseTaskId(task.taskId));
          return taskSummary(task, taskId === activeTaskId || controllers.has(taskId));
        });
      return Object.freeze({
        workspaceId,
        name: workspace.displayName,
        archived: workspace.disposition === "archived",
        tasks: Object.freeze(tasks),
      });
    });
    if (activeTaskId === undefined && allowAutoSelectActiveTask) {
      activeTaskId = workspaces.filter((workspace) => !workspace.archived)
        .flatMap((workspace) => workspace.tasks)
        .find((task) => !task.archived)?.taskId;
    }
    const activeTask = activeTaskId === undefined ? undefined : taskView(
      activeTaskId,
      restoreHistory ? conversationPageDepths.get(activeTaskId) ?? 1 : 1,
    );
    return Object.freeze({
      apiVersion: GUILD_API_VERSION,
      appVersion: options.appVersion,
      ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
      locale: settings.locale,
      runtimeSettings: Object.freeze({
        model: settings.grokModel,
        reasoningEffort: settings.reasoningEffort,
        permissionMode: settings.permissionMode,
        startup: settings.startup,
        availableModels: GUILD_GROK_MODELS,
        availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
        canChange: runtimeSettingsCanChange(),
      }),
      generalSettings: Object.freeze({
        restoreLastTask: settings.restoreLastTask,
        newTaskWorkspaceMode: settings.newTaskWorkspaceMode,
        taskNotificationsEnabled: settings.taskNotificationsEnabled,
        ...(settings.lastWorkspaceId === undefined
          ? {}
          : { lastWorkspaceId: must(parseWorkspaceId(settings.lastWorkspaceId)) }),
      }),
      profile: Object.freeze({
        nickname: settings.nickname,
        ...(settings.avatarFilename === undefined
          ? {}
          : { avatarGrantUrl: `guild-media://media/${settings.avatarFilename}` }),
      }),
      sidebarWidth: settings.sidebarWidth,
      browserSyncEnabled: settings.browserSyncEnabled,
      recoveredAfterUncleanShutdown: store.recoveredAfterUncleanShutdown,
      workspaces: Object.freeze(workspaces),
      ...(activeTask === undefined ? {} : { activeTask }),
      usage: projectOfficialUsage(settings.locale),
      runtimeDiagnostics: Object.freeze({
        enabled: true as const,
        logRelativePath: "diagnostics/runtime.jsonl" as const,
        recentIncidents: Object.freeze(
          [...runtimeIncidents.values()]
            .sort((a, b) => b.occurredAtIso.localeCompare(a.occurredAtIso))
            .slice(0, 8),
        ),
      }),
      ...(managementProgress === undefined ? {} : { grokManagementProgress: managementProgress }),
    });
  }

  function assertMaintenanceIdle(): void {
    if (!runtimeSettingsCanChange()) throw new Error("backup_requires_idle");
    for (const workspace of store.listWorkspaces({ includeArchived: true, includeDeleted: true })) {
      for (const task of store.listTasks({ workspaceId: workspace.workspaceId, includeArchived: true, includeDeleted: true })) {
        if (store.loadContinuousTask(task.taskId)?.status === "active") throw new Error("backup_requires_idle");
      }
    }
  }
  async function drainForMaintenance(): Promise<void> {
    await Promise.all([...controllers.values()].map(async (controller) => {
      if (controller.adapter !== undefined) await controller.adapter.close();
    }));
    await commandTail;
    assertMaintenanceIdle();
    await diagnosticLog.flush();
  }

  function runtimeSettingsCanChange(): boolean {
    if (managementOperationActive || messageAdmissionsActive > 0) return false;
    for (const controller of controllers.values()) {
      if (
        controller.startOperation !== undefined ||
        controller.promptRunId !== undefined ||
        controller.pendingPermissions.size > 0
      ) {
        return false;
      }
    }
    for (const workspace of store.listWorkspaces({ includeArchived: true })) {
      for (const task of store.listTasks({
        workspaceId: workspace.workspaceId,
        includeArchived: true,
      })) {
        if (store.listQueuedTurns(task.taskId).length > 0) return false;
        const run = store.restoreTask(task.taskId).currentRun;
        if (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) return false;
      }
    }
    return true;
  }

  function projectOfficialUsage(locale: GuildLocale): OfficialUsageProjection {
    if (usageLoading) return Object.freeze({ status: "loading" });
    const snapshot = usageSnapshot;
    if (snapshot === undefined) {
      return Object.freeze({ status: "unavailable", reason: "not_reported_by_runtime" });
    }
    let usedLabel: string | undefined;
    let limitLabel: string | undefined;
    if (snapshot.creditUsagePercent !== undefined) {
      const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
        .format(snapshot.creditUsagePercent);
      usedLabel = locale === "zh-CN" ? `已使用 ${percent}%` : `${percent}% used`;
    } else if (snapshot.usedCents !== undefined) {
      usedLabel = locale === "zh-CN"
        ? `已使用 ${formatUsd(snapshot.usedCents, locale)}`
        : `${formatUsd(snapshot.usedCents, locale)} used`;
      if (snapshot.monthlyLimitCents !== undefined) {
        limitLabel = locale === "zh-CN"
          ? `额度 ${formatUsd(snapshot.monthlyLimitCents, locale)}`
          : `${formatUsd(snapshot.monthlyLimitCents, locale)} limit`;
      }
    }
    if (usedLabel === undefined) {
      return Object.freeze({ status: "unavailable", reason: "not_reported_by_runtime" });
    }
    return Object.freeze({
      status: "available",
      usedLabel,
      ...(limitLabel === undefined ? {} : { limitLabel }),
      ...(snapshot.periodEndIso === undefined ? {} : { resetsAtIso: snapshot.periodEndIso }),
      fetchedAtIso: new Date(usageFetchedAtMs).toISOString(),
    });
  }

  function taskSummary(
    metadata: ReturnType<GuildPersistence["loadTaskMetadata"]>,
    includeRunState = false,
  ) {
    const restored = includeRunState ? store.restoreTask(metadata.taskId) : undefined;
    const activity = currentTaskActivity(controllers.get(metadata.taskId));
    return Object.freeze({
      taskId: metadata.taskId,
      workspaceId: must(parseWorkspaceId(metadata.workspaceId)),
      title: metadata.title,
      pinned: metadata.pinned,
      archived: metadata.disposition === "archived",
      updatedAtMs: metadata.lastActivityAtMs,
      queuedTurnCount: store.listQueuedTurns(metadata.taskId).length,
      ...(restored?.currentRun === undefined
        ? {}
        : { activeRunState: restored.currentRun.state }),
      ...(activity === undefined ? {} : { activeActivity: activity }),
    });
  }

  function currentTaskActivity(controller: RuntimeController | undefined): GuildTaskActivity | undefined {
    if (controller === undefined) return undefined;
    let planActive = false;
    for (const tool of [...controller.toolStates.values()].reverse()) {
      if (tool.status !== "pending" && tool.status !== "in_progress") continue;
      if (tool.runtimeReplayKind === "plan") {
        planActive = true;
        continue;
      }
      switch (tool.kind) {
        case "read": return "reading";
        case "edit": return "editing";
        case "delete": return "deleting";
        case "move": return "moving";
        case "search": return "searching";
        case "execute": return "executing";
        case "think": return "thinking";
        case "fetch": return "fetching";
        case "switch_mode": return "switching_mode";
        case "other": return "working";
      }
    }
    if (planActive) return "planning";
    if (controller.streamingEntries.has("thought")) return "thinking";
    if (controller.streamingEntries.has("assistant")) return "responding";
    const auxiliary = [...controller.auxiliarySessions.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    if (auxiliary !== undefined) return auxiliary.activity;
    if (controller.promptRunId !== undefined || controller.startOperation !== undefined) return "working";
    return undefined;
  }

  function allTaskConversationEntries(taskId: TaskId): readonly ConversationEntryRecord[] {
    return allConversationEntries((afterSequence, limit) =>
      store.listConversationEntries({ taskId, afterSequence, limit }));
  }

  function prepareRuntimePrompt(
    taskId: TaskId,
    session: AcpV1AdapterSession,
    currentText: string,
  ): PreparedRuntimePrompt {
    const recent = store.listRecentConversationEntries({
      taskId,
      limit: CONVERSATION_PAGE_SIZE,
    });
    const replacementNotice = [...recent].reverse().find((entry) => {
      if (entry.kind !== "notice") return false;
      if (
        entry.metadata["replacementRecoveryAuthorized"] === true &&
        entry.metadata["recoveryHandoffRequired"] === true
      ) return true;
      if (entry.metadata["sessionReplaced"] !== true) return false;
      const replacementSessionId = metadataString(entry, "replacementSessionId");
      return entry.metadata["recoveryHandoffRequired"] === true
        ? replacementSessionId === session.sessionId
        : replacementSessionId === undefined && entry.metadata["userAuthorized"] === true;
    });
    if (replacementNotice === undefined) {
      return Object.freeze({ text: currentText });
    }
    const handoffEstablished = recent.some((entry) =>
      entry.sequence > replacementNotice.sequence &&
      entry.kind === "notice" &&
      entry.metadata["replacementHandoffEstablished"] === true &&
      metadataString(entry, "replacementSessionId") === session.sessionId);
    if (handoffEstablished) {
      return Object.freeze({ text: currentText });
    }

    const legacyReplacementNotice = replacementNotice.metadata["recoveryHandoffRequired"] !== true;
    const beforeReplacement = recent.filter((entry) => entry.sequence < replacementNotice.sequence);
    const taskHistory = legacyReplacementNotice ? recent : beforeReplacement;
    const earliestUser = store.listConversationEntries({ taskId, limit: CONVERSATION_PAGE_SIZE })
      .find(isRecoveryUserEntry);
    const recentUsers = taskHistory.filter(isRecoveryUserEntry).slice(-6);
    const userHistory = dedupeRecoveryMessages([
      ...(earliestUser === undefined ? [] : [earliestUser.text]),
      ...recentUsers.map((entry) => entry.text),
    ]);
    if (userHistory.length === 0 && isAmbiguousContinuation(currentText)) {
      throw new Error(SESSION_RECOVERY_CONTEXT_REQUIRED);
    }

    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    // Post-replacement tool paths are model-authored and may already reflect the
    // cross-project guess this recovery guard is meant to stop. User-authored
    // corrections remain eligible above, but path evidence stays pre-replacement.
    const observedPaths = recoveryToolPaths(beforeReplacement, workspace.canonicalPath);
    const capsuleBudget = Math.min(
      REPLACEMENT_RECOVERY_CAPSULE_MAX_LENGTH,
      ACP_V1_CODEC_LIMITS.maxStringLength - currentText.length - 256,
    );
    if (capsuleBudget < 400) {
      throw new Error("message_too_long");
    }
    const capsule = replacementRecoveryCapsule({
      taskId,
      title: metadata.title,
      workspacePath: workspace.canonicalPath,
      userHistory,
      observedPaths,
      maxLength: capsuleBudget,
    });
    return Object.freeze({
      text: `${capsule}\n\n[Current user message]\n${currentText}`,
      recoveryHandoff: Object.freeze({ sourceNoticeEntryId: replacementNotice.entryId }),
    });
  }

  function taskView(taskId: TaskId, projectedPageDepth = 1): TaskViewProjection {
    const metadata = store.loadTaskMetadata(taskId);
    if (metadata.disposition === "deleted") throw new Error("task_deleted");
    const workspace = store.loadWorkspace(metadata.workspaceId);
    const summary = taskSummary(metadata, true);
    const locale = store.loadAppSettings().locale;
    const loadedPageDepth = conversationPageDepths.get(taskId) ?? 1;
    let entries = [...store.listRecentConversationEntries({
      taskId,
      limit: CONVERSATION_PAGE_SIZE,
    })];
    for (let page = 1; page < projectedPageDepth; page += 1) {
      const firstSequence = entries[0]?.sequence;
      if (firstSequence === undefined || firstSequence <= 1) break;
      const earlier = store.listConversationEntriesBefore({
        taskId,
        beforeSequence: firstSequence,
        limit: CONVERSATION_PAGE_SIZE,
      });
      entries = [...earlier, ...entries];
      if (earlier.length < CONVERSATION_PAGE_SIZE) break;
    }
    const runCache = new Map<RunId, RunRecord | undefined>();
    const latestToolEntry = new Map<string, string>();
    for (const entry of entries) {
      const toolCallId = entry.kind === "tool" ? metadataString(entry, "toolCallId") : undefined;
      if (toolCallId !== undefined) latestToolEntry.set(toolCallId, entry.entryId);
    }
    const timeline = entries
      .filter((entry) => {
        if (entry.metadata["hidden"] === true) return false;
        const toolCallId = entry.kind === "tool" ? metadataString(entry, "toolCallId") : undefined;
        return toolCallId === undefined || latestToolEntry.get(toolCallId) === entry.entryId;
      })
      .map((entry) => projectEntry(entry, runCache, locale));
    const pending = [...(controllers.get(taskId)?.pendingPermissions.values() ?? [])]
      .map((permission) => projectPermission(permission, locale));
    const queuedTurns = store.listQueuedTurns(taskId).map((queued) => Object.freeze({
      queueId: queued.queueId,
      text: queued.text,
      createdAtMs: queued.createdAtMs,
    }));
    const draft = store.loadDraft(taskId)?.text ?? "";
    const controller = controllers.get(taskId);
    const binding = store.loadSessionBinding(taskId);
    const canReuseRetainedContext = binding.state === "healthy" ||
      binding.state === "restore_pending" ||
      binding.state === "replay_reconciling";
    let contextWindowUsage = canReuseRetainedContext
      ? controller?.contextWindowUsage
      : undefined;
    if (canReuseRetainedContext && contextWindowUsage === undefined) {
      let persisted = persistedContextTokens.get(taskId);
      if (persisted === undefined) {
        persisted = store.loadLatestContextTokensUsed(taskId) ?? null;
        persistedContextTokens.set(taskId, persisted);
      }
      if (persisted !== null) contextWindowUsage = Object.freeze({ used: persisted });
    }
    const effectiveContextWindowSize = contextWindowUsage?.size ??
      controller?.contextWindowSize ??
      store.loadContextWindowSize(taskId);
    const replacementRequired = binding.state === "broken";
    const continuousTask = store.loadContinuousTask(taskId);
    const auxiliarySessions = [...(controller?.auxiliarySessions.values() ?? [])];
    const latestAuxiliary = [...auxiliarySessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0];
    const auxiliaryToolKinds = [...new Set(
      auxiliarySessions.flatMap((session) => [...session.tools.values()]
        .filter((tool) => tool.status === "pending" || tool.status === "in_progress")
        .map((tool) => tool.kind)),
    )];
    const latestRunId = [...entries].reverse().find((entry) => entry.runId !== undefined)?.runId;
    const latestRun = latestRunId === undefined ? undefined : safeLoadRun(taskId, latestRunId);
    const recentResult = latestRunId !== undefined && latestRun !== undefined && TERMINAL_RUN_STATES.has(latestRun.state)
      ? Object.freeze({
          runId: latestRunId,
          state: latestRun.state as "completed" | "failed" | "cancelled" | "interrupted",
          workbench: buildTaskWorkbench(
            workspace.canonicalPath,
            entries.filter((entry) => entry.runId === latestRunId),
          ),
        })
      : undefined;
    return Object.freeze({
      task: summary,
      timeline: Object.freeze([...timeline, ...pending]),
      hasEarlierTimeline:
        store.countConversationEntries(taskId) > loadedPageDepth * CONVERSATION_PAGE_SIZE,
      queuedTurns: Object.freeze(queuedTurns),
      draft,
      sessionRecovery: replacementRequired ? "replacement_required" : "available",
      contextWindow: contextWindowUsage === undefined
        ? Object.freeze({ status: "unavailable" as const })
        : effectiveContextWindowSize === undefined || effectiveContextWindowSize <= 0
          ? Object.freeze({
              status: "used_only" as const,
              used: contextWindowUsage.used,
            })
        : Object.freeze({
            status: "available" as const,
            used: contextWindowUsage.used,
            size: effectiveContextWindowSize,
          }),
      availableCommands: controller?.availableCommands ?? Object.freeze([]),
      sessionModes: controller?.sessionModes ?? null,
      sessionConfigOptions: controller?.sessionConfigOptions ?? Object.freeze([]),
      ...(latestAuxiliary === undefined
        ? {}
        : {
            auxiliaryActivity: Object.freeze({
              activity: latestAuxiliary.activity,
              startedAtMs: Math.min(...auxiliarySessions.map((session) => session.startedAtMs)),
              workerCount: auxiliarySessions.length,
              toolKinds: Object.freeze(auxiliaryToolKinds),
            }),
          }),
      workbench: buildTaskWorkbench(
        workspace.canonicalPath,
        entries,
      ),
      ...(recentResult === undefined ? {} : { recentResult }),
      ...(continuousTask === undefined
        ? {}
        : {
            continuousTask: Object.freeze({
              objective: continuousTask.objective,
              ...(continuousTask.lastRunId === undefined ? {} : { lastRunId: continuousTask.lastRunId }),
              status: continuousTask.status,
              phase: continuousTask.phase,
              cycle: continuousTask.cycle,
              ...(continuousTask.summary === undefined ? {} : { summary: continuousTask.summary }),
              ...(continuousTask.remaining === undefined ? {} : { remaining: continuousTask.remaining }),
              ...(continuousTask.stopReason === undefined ? {} : { stopReason: continuousTask.stopReason }),
            }),
          }),
      canSend:
        metadata.disposition === "active" &&
        workspace.disposition === "active" &&
        !replacementRequired,
    });
  }

  function projectEntry(
    entry: ConversationEntryRecord,
    runCache: Map<RunId, RunRecord | undefined>,
    locale: GuildLocale,
  ): TimelineItemProjection {
    let run: RunRecord | undefined;
    if (entry.runId !== undefined) {
      if (!runCache.has(entry.runId)) {
        runCache.set(entry.runId, safeLoadRun(entry.taskId, entry.runId));
      }
      run = runCache.get(entry.runId);
    }
    const status = run?.state === "cancelled"
      ? "cancelled"
      : run?.state === "interrupted"
        ? "interrupted"
        : run?.state === "failed" || entry.status === "failed" || entry.kind === "error"
          ? "failed"
          : run?.state === "completed"
            ? "completed"
            : entry.status === "streaming"
              ? "streaming"
              : "completed";
    const base = {
      entryId: entry.entryId,
      taskId: entry.taskId,
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      sequence: entry.sequence,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: entry.updatedAtMs,
      status,
    } as const;
    if (entry.kind === "user" && entry.metadata["continuousInternal"] === true) {
      return Object.freeze({
        ...base,
        kind: "user",
        text: metadataString(entry, "continuousDisplayText") ?? entry.text,
      });
    }
    if (entry.kind === "thought") {
      return Object.freeze({
        ...base,
        kind: "thought",
        text: entry.text,
        startedAtMs: metadataNumber(entry, "startedAtMs") ?? entry.createdAtMs,
        elapsedMs: Math.max(0, entry.updatedAtMs - entry.createdAtMs),
      });
    }
    if (entry.kind === "tool") {
      const persistedStatus = toolStatus(entry.metadata["toolStatus"]);
      const projectedToolStatus = run?.state === "cancelled"
        ? "failed"
        : run?.state === "completed" &&
          (persistedStatus === "pending" || persistedStatus === "in_progress")
        ? "completed"
        : (run?.state === "failed" || run?.state === "interrupted") &&
            (persistedStatus === "pending" || persistedStatus === "in_progress")
          ? "failed"
          : persistedStatus;
      return Object.freeze({
        ...base,
        kind: "tool",
        runtimeReplayKind: metadataString(entry, "runtimeReplayKind") === "plan" ? "plan" : "tool",
        ...(metadataString(entry, "toolCallId") === undefined
          ? {}
          : { toolCallId: metadataString(entry, "toolCallId") }),
        title: metadataString(entry, "title") ?? (entry.text || (locale === "zh-CN" ? "工具" : "Tool")),
        toolKind: toolKind(entry.metadata["toolKind"]),
        toolStatus: projectedToolStatus,
        content: metadataString(entry, "runtimeReplayKind") === "plan" &&
            timelineToolContent(entry.metadata["content"]).length === 0
          ? Object.freeze([{ type: "text" as const, text: entry.text }])
          : timelineToolContent(entry.metadata["content"]),
        locations: toolLocations(entry.metadata["locations"]),
      });
    }
    if (entry.kind === "media") {
      return Object.freeze({
        ...base,
        kind: "media",
        mediaType: mediaType(entry.metadata["mediaType"]),
        grantUrl: metadataString(entry, "grantUrl") ?? "",
        alt: metadataString(entry, "alt") ?? entry.text,
        mimeType: metadataString(entry, "mimeType") ?? "application/octet-stream",
      });
    }
    const kind = entry.kind === "permission" ? "notice" : entry.kind;
    if (kind === "notice") {
      const recovery = metadataString(entry, "recovery");
      const automaticResend = entry.metadata["automaticResend"];
      const incidentId = metadataString(entry, "incidentId");
      return Object.freeze({
        ...base,
        kind,
        text: entry.text,
        ...(recovery === "restored" && automaticResend === false
          ? {
              noticeType: "session_restored" as const,
              ...(incidentId === undefined ? {} : { incidentId }),
            }
          : {}),
      });
    }
    if (kind === "error") {
      const incidentId = metadataString(entry, "incidentId");
      return Object.freeze({
        ...base,
        kind,
        text: entry.text,
        ...(incidentId === undefined ? {} : { incidentId }),
      });
    }
    return Object.freeze({ ...base, kind, text: entry.text });
  }

  function projectPermission(
    pending: PendingPermission,
    locale: GuildLocale,
  ): TimelineItemProjection {
    return Object.freeze({
      entryId: pending.permissionId,
      taskId: pending.identity.taskId,
      runId: pending.identity.runId,
      sequence: pending.sequence,
      createdAtMs: pending.createdAtMs,
      updatedAtMs: pending.createdAtMs,
      status: "waiting",
      kind: "permission",
      permissionId: pending.permissionId,
      title: pending.request.title ?? (locale === "zh-CN" ? "需要确认" : "Permission requested"),
      options: pending.request.options,
    });
  }

  function safeLoadRun(taskId: TaskId, runId: RunId): RunRecord | undefined {
    try {
      return store.loadRun(taskId, runId);
    } catch {
      return undefined;
    }
  }

  function assertTaskInactive(taskId: TaskId): void {
    const controller = controllers.get(taskId);
    if (controller?.startOperation !== undefined || controller?.promptRunId !== undefined) {
      throw new Error("task_run_active");
    }
    const run = store.restoreTask(taskId).currentRun;
    if (
      (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) ||
      store.listQueuedTurns(taskId).length > 0
    ) {
      throw new Error("task_run_active");
    }
  }

  async function ensureSession(taskId: TaskId): Promise<AcpV1AdapterSession> {
    if (managementOperationActive) throw new Error("grok_management_operation_active");
    const controller = controllerFor(taskId);
    if (controller.session !== undefined && controller.adapter?.state === "ready") {
      return controller.session;
    }
    if (controller.startOperation !== undefined) return controller.startOperation;
    controller.startOperation = startRuntime(taskId, controller);
    try {
      return await controller.startOperation;
    } finally {
      controller.startOperation = undefined;
    }
  }

  function scheduleQueuedDispatch(taskId: TaskId): Promise<void> {
    const existing = scheduledQueuedTasks.get(taskId);
    if (existing !== undefined) return existing;
    if (closed || closing || maintenance || store.listQueuedTurns(taskId).length === 0) {
      return Promise.resolve();
    }
    const operation = dispatchNextQueued(taskId).finally(() => {
      if (scheduledQueuedTasks.get(taskId) === operation) {
        scheduledQueuedTasks.delete(taskId);
      }
    });
    scheduledQueuedTasks.set(taskId, operation);
    void operation.catch(() => undefined);
    return operation;
  }

  function scheduleContinuousDispatch(taskId: TaskId): Promise<void> {
    const existing = scheduledContinuousTasks.get(taskId);
    if (existing !== undefined) return existing;
    const mission = store.loadContinuousTask(taskId);
    if (
      closed ||
      closing ||
      maintenance ||
      mission?.status !== "active" ||
      store.listQueuedTurns(taskId).length > 0
    ) {
      return Promise.resolve();
    }
    const operation = dispatchContinuous(taskId).finally(() => {
      if (scheduledContinuousTasks.get(taskId) === operation) {
        scheduledContinuousTasks.delete(taskId);
      }
    });
    scheduledContinuousTasks.set(taskId, operation);
    void operation.catch(() => undefined);
    return operation;
  }

  async function dispatchContinuous(taskId: TaskId): Promise<void> {
    if (closed || closing) return;
    const mission = store.loadContinuousTask(taskId);
    if (mission?.status !== "active" || store.listQueuedTurns(taskId).length > 0) return;
    const current = store.restoreTask(taskId).currentRun;
    if (
      (current !== undefined && !TERMINAL_RUN_STATES.has(current.state)) ||
      controllers.get(taskId)?.promptRunId !== undefined
    ) return;
    let session: AcpV1AdapterSession;
    try {
      session = await ensureSession(taskId);
    } catch {
      await enqueueCommand(async () => {
        const latest = store.loadContinuousTask(taskId);
        if (latest?.status === "active") {
          store.updateContinuousTask({
            taskId,
            expectedRevision: latest.revision,
            status: "blocked",
            stopReason: "runtime_unavailable",
          });
          await publish();
        }
      });
      return;
    }
    await enqueueCommand(async () => dispatchContinuousWithSession(taskId, session));
  }

  async function dispatchContinuousWithSession(
    taskId: TaskId,
    session: AcpV1AdapterSession,
  ): Promise<void> {
    if (closed || closing || store.listQueuedTurns(taskId).length > 0) return;
    const mission = store.loadContinuousTask(taskId);
    if (mission?.status !== "active") return;
    const controller = controllerFor(taskId);
    const current = store.restoreTask(taskId).currentRun;
    if (
      (current !== undefined && !TERMINAL_RUN_STATES.has(current.state)) ||
      controller.promptRunId !== undefined ||
      controller.session?.sessionId !== session.sessionId ||
      controller.session.adapterEpoch !== session.adapterEpoch ||
      controller.adapter?.state !== "ready"
    ) return;
    const rawPrompt = buildContinuousPrompt(mission, store.loadAppSettings().locale);
    const prompt = prepareRuntimePrompt(taskId, session, rawPrompt);
    const runId = id(parseRunId, "run");
    const sessionId = must(parseSessionId(session.sessionId));
    const adapterEpoch = must(parseAdapterEpoch(session.adapterEpoch));
    store.createRun({ taskId, runId });
    requireRun(store.applyRun({
      taskId,
      runId,
      event: {
        type: "scheduler_dispatch",
        sessionId,
        adapterEpoch,
        idempotencyKey: key("continuous-scheduler-dispatch"),
      },
    }));
    store.createConversationEntry({
      taskId,
      runId,
      entryId: unique("continuous-user"),
      kind: "user",
      text: rawPrompt,
      metadata: {
        continuousInternal: true,
        continuousCycle: mission.cycle,
        continuousPhase: mission.phase,
        ...(mission.lastRunId === undefined && mission.phase === "work"
          ? { continuousDisplayText: mission.objective }
          : { hidden: true }),
      },
      status: "complete",
    });
    store.updateContinuousTask({
      taskId,
      expectedRevision: mission.revision,
      lastRunId: runId,
      stopReason: null,
    });
    controller.activeRunId = runId;
    logRuntime({
      category: "prompt",
      event: `continuous_${mission.phase}_started`,
      taskId,
      runId,
      sessionId: session.sessionId,
      adapterEpoch: session.adapterEpoch,
      reason: `cycle_${mission.cycle}`,
    });
    await publish();
    launchPrompt(taskId, controller, session, prompt, runId);
  }

  async function advanceContinuousAfterRun(taskId: TaskId, runId: RunId): Promise<void> {
    const mission = store.loadContinuousTask(taskId);
    if (
      mission === undefined ||
      mission.lastRunId !== runId ||
      (mission.status !== "active" && mission.status !== "paused")
    ) return;
    const run = safeLoadRun(taskId, runId);
    if (run === undefined || !TERMINAL_RUN_STATES.has(run.state)) return;
    if (run.state !== "completed") {
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        status: "paused",
        stopReason: `run_${run.state}`,
      });
      return;
    }
    const entries = store.listRecentConversationEntries({ taskId, limit: CONVERSATION_PAGE_SIZE })
      .filter((entry) => entry.runId === runId && entry.kind === "assistant");
    const response = entries.map((entry) => entry.text).join("\n").trim();
    if (response.length === 0) {
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        status: "blocked",
        stopReason: "empty_runtime_response",
      });
      return;
    }
    const footer = parseContinuousFooter(response);
    const summary = footer?.summary ?? response.slice(-12_000);
    const remaining = footer?.remaining;
    const verdict = footer?.verdict;
    if (mission.phase === "work") {
      if (verdict === "BLOCKED") {
        store.updateContinuousTask({
          taskId,
          expectedRevision: mission.revision,
          status: "blocked",
          summary,
          ...(remaining === undefined ? {} : { remaining }),
          stopReason: "work_blocked",
        });
        return;
      }
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        phase: "audit",
        summary,
        ...(remaining === undefined ? {} : { remaining }),
      });
      return;
    }
    if (verdict === undefined) {
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        status: "blocked",
        summary,
        ...(remaining === undefined ? {} : { remaining }),
        stopReason: "audit_protocol_invalid",
      });
      return;
    }
    if (verdict === "BLOCKED") {
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        status: "blocked",
        summary,
        ...(remaining === undefined ? {} : { remaining }),
        stopReason: "audit_blocked",
      });
      return;
    }
    if (verdict === "COMPLETE" && remaining?.trim().toUpperCase() === "NONE") {
      store.updateContinuousTask({
        taskId,
        expectedRevision: mission.revision,
        status: "completed",
        summary,
        remaining: "NONE",
        stopReason: "objective_verified_complete",
      });
      return;
    }
    store.updateContinuousTask({
      taskId,
      expectedRevision: mission.revision,
      status: mission.status,
      phase: "work",
      cycle: mission.cycle + 1,
      summary,
      ...(remaining === undefined ? {} : { remaining }),
      stopReason: null,
    });
  }

  async function dispatchNextQueued(taskId: TaskId): Promise<void> {
    if (closed || closing) return;
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (metadata.disposition !== "active" || workspace.disposition !== "active") return;
    const current = store.restoreTask(taskId).currentRun;
    if (
      (current !== undefined && !TERMINAL_RUN_STATES.has(current.state)) ||
      controllers.get(taskId)?.promptRunId !== undefined
    ) return;
    let queued = store.listQueuedTurns(taskId)[0];
    if (queued === undefined) return;
    let session: AcpV1AdapterSession;
    try {
      session = await ensureSession(taskId);
    } catch {
      await publish();
      return;
    }
    await enqueueCommand(async () => dispatchQueuedWithSession(taskId, session));
  }

  async function dispatchQueuedWithSession(
    taskId: TaskId,
    session: AcpV1AdapterSession,
  ): Promise<void> {
    if (closed || closing) return;
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (metadata.disposition !== "active" || workspace.disposition !== "active") return;
    const current = store.restoreTask(taskId).currentRun;
    if (
      (current !== undefined && !TERMINAL_RUN_STATES.has(current.state)) ||
      controllers.get(taskId)?.promptRunId !== undefined
    ) return;
    let queued = store.listQueuedTurns(taskId)[0];
    if (queued === undefined) return;
    const controller = controllerFor(taskId);
    if (
      controller.session?.sessionId !== session.sessionId ||
      controller.session.adapterEpoch !== session.adapterEpoch ||
      controller.adapter?.state !== "ready"
    ) {
      const retry = setTimeout(() => scheduleQueuedDispatch(taskId), 0);
      retry.unref?.();
      return;
    }
    let discarded = 0;
    while (queued !== undefined && session.sessionId !== queued.intendedSessionId) {
      store.createConversationEntry({
        taskId,
        entryId: queued.entryId,
        kind: "user",
        text: queued.text,
        metadata: { queueFailure: "session_replaced" },
        status: "failed",
      });
      store.cancelQueuedTurn({ taskId, queueId: queued.queueId });
      discarded += 1;
      queued = store.listQueuedTurns(taskId)[0];
    }
    if (discarded > 0) {
      store.createConversationEntry({
        taskId,
        entryId: unique("queue-session-replaced"),
        kind: "notice",
        text: store.loadAppSettings().locale === "zh-CN"
          ? `${discarded} 条排队消息未发送，因为 Grok 会话已经重建；内容已保留，请重新发送。`
          : `${discarded} queued message${discarded === 1 ? " was" : "s were"} not sent because the Grok session was rebuilt. The content is preserved above; please send it again.`,
        metadata: { queueFailure: "session_replaced", discarded },
        status: "complete",
      });
      await publish();
    }
    if (queued === undefined) return;
    let prompt: PreparedRuntimePrompt;
    while (true) {
      try {
        prompt = prepareRuntimePrompt(taskId, session, queued.text);
        break;
      } catch (cause: unknown) {
        const failure = errorMessageIncludes(cause, SESSION_RECOVERY_CONTEXT_REQUIRED)
          ? SESSION_RECOVERY_CONTEXT_REQUIRED
          : errorMessageIncludes(cause, "message_too_long")
            ? "message_too_long"
            : undefined;
        if (failure === undefined) throw cause;
        store.createConversationEntry({
          taskId,
          entryId: queued.entryId,
          kind: "user",
          text: queued.text,
          metadata: { queueFailure: failure },
          status: "failed",
        });
        store.cancelQueuedTurn({ taskId, queueId: queued.queueId });
        store.createConversationEntry({
          taskId,
          entryId: unique("queue-recovery-context-required"),
          kind: "notice",
          text: failure === "message_too_long"
            ? store.loadAppSettings().locale === "zh-CN"
              ? "这条排队消息没有发送：与任务恢复摘要合并后超过 Grok 的单条消息上限。内容已保留，请删短后重新发送。"
              : "This queued message was not sent because it exceeds Grok's single-message limit when combined with the task recovery summary. The content is preserved; shorten it and send again."
            : store.loadAppSettings().locale === "zh-CN"
              ? "这条排队消息没有发送：替换会话缺少可恢复的任务内容。请写明要继续做什么，不要只发送“继续”。"
              : "This queued message was not sent because the replacement session has no recoverable task context. Describe what to continue instead of sending only 'continue'.",
          metadata: { queueFailure: failure },
          status: "complete",
        });
        await publish();
        queued = store.listQueuedTurns(taskId)[0];
        if (queued === undefined) return;
      }
    }
    const dispatched = store.dispatchQueuedTurn({
      taskId,
      queueId: queued.queueId,
      sessionId: must(parseSessionId(session.sessionId)),
      adapterEpoch: must(parseAdapterEpoch(session.adapterEpoch)),
      idempotencyKey: key("queued-scheduler-dispatch"),
    });
    controller.activeRunId = dispatched.run.runId;
    await publish();
    launchPrompt(taskId, controller, session, prompt, dispatched.run.runId);
  }

  async function startRuntime(
    taskId: TaskId,
    controller: RuntimeController,
  ): Promise<AcpV1AdapterSession> {
    const startGeneration = runtimeGeneration;
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (workspace.disposition !== "active" || metadata.disposition !== "active") {
      throw new Error("task_not_writable");
    }
    await assertWorkspaceFolderExists(workspace.canonicalPath);
    const previousAdapter = controller.adapter;
    if (previousAdapter !== undefined) {
      if (previousAdapter.state !== "ready") {
        controller.closeInterruptionOverride = Object.freeze({
          reason: "process_fault",
          diagnostic: Object.freeze({
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          }),
        });
      }
      await previousAdapter.close().catch(() => undefined);
      controller.closeInterruptionOverride = undefined;
      if (controller.adapter === previousAdapter) {
        controller.adapter = undefined;
        controller.session = undefined;
        controller.adapterEpoch = undefined;
      }
    }
    reconcilePreviousRuntime(taskId);
    controller.activeRunId = undefined;
    controller.promptRunId = undefined;
    controller.promptOperation = undefined;
    controller.promptReplayProof = undefined;
    controller.recoveryHandoff = undefined;
    controller.replayStaging = undefined;
    controller.pendingPermissions.clear();
    controller.streamingEntries.clear();
    controller.toolStates.clear();
    controller.auxiliarySessions.clear();
    clearCancelTimer(controller);
    clearPromptSilenceTimer(controller);
    const binding = store.loadSessionBinding(taskId);
    if (binding.state === "broken") {
      throw new Error("session_replacement_requires_user_authorization");
    }
    const replacingSession = binding.state === "replacement_pending";
    const nextEpochResult = nextAdapterEpoch(
      controller.lastAllocatedAdapterEpoch ?? binding.adapterEpoch,
    );
    if (!nextEpochResult.ok) throw new Error("adapter_epoch_exhausted");
    const adapterEpoch = nextEpochResult.value;
    controller.lastAllocatedAdapterEpoch = adapterEpoch;
    let attemptId = binding.state === "restore_pending"
      ? binding.restoreAttemptId
      : id(parseSessionAttemptId, "session-attempt");
    if (attemptId === undefined) throw new Error("session_restore_attempt_missing");
    controller.adapterEpoch = adapterEpoch;
    controller.currentAttemptId = attemptId;
    controller.receiveSequence = 0;
    controller.contextWindowUsage = undefined;
    controller.contextWindowSize = undefined;
    logRuntime({
      category: "runtime",
      event: "start_requested",
      taskId,
      adapterEpoch,
      reason: binding.state,
    });

    if (
      binding.state !== "unbound" &&
      binding.state !== "replacement_pending" &&
      binding.state !== "restore_pending"
    ) {
      throw new Error("session_binding_not_restorable");
    }

    let created: Awaited<ReturnType<RuntimeFactory>> | undefined;
    let startStage = "runtime_factory";
    try {
      const selectedRuntimeSettings = store.loadAppSettings();
      created = await runtimeFactory({
        adapterEpoch,
        sink: createSink(taskId, controller),
        stagingRoot: options.stagingRoot,
        workingDirectory: workspace.canonicalPath,
        runtimeSettings: Object.freeze({
          model: selectedRuntimeSettings.grokModel,
          reasoningEffort: selectedRuntimeSettings.reasoningEffort,
          permissionMode: selectedRuntimeSettings.permissionMode,
          startup: selectedRuntimeSettings.startup,
        }),
      });
      logRuntime({ category: "runtime", event: "factory_ready", taskId, adapterEpoch });
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      controller.adapter = created.adapter;
      if (closed || closing) throw new Error("desktop_service_closed");
      runtimeVersion = created.runtimeVersion ?? runtimeVersion;
      startStage = "initialize";
      const initialized = await created.adapter.start();
      logRuntime({ category: "runtime", event: "initialized", taskId, adapterEpoch });
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      if (initialized.agentInfo?.version !== undefined) {
        runtimeVersion = [initialized.agentInfo.title ?? initialized.agentInfo.name, initialized.agentInfo.version]
          .filter(Boolean)
          .join(" ");
      }
      const selectedAuthMethod = initialized.authMethods.length === 1
        ? initialized.authMethods[0]!.id
        : initialized.defaultAuthMethodId;
      if (selectedAuthMethod !== undefined) {
        startStage = `authenticate_${selectedAuthMethod}`;
        await created.adapter.authenticate(selectedAuthMethod);
        if (runtimeGeneration !== startGeneration) {
          throw new Error("runtime_start_invalidated_by_resume");
        }
      } else if (initialized.authMethods.length > 1) {
        const advertised = initialized.authMethods
          .map((method) => `${method.id}:${method.name}`)
          .join(",");
        throw new Error(`multiple_auth_methods_require_selection:${advertised}`);
      }

      let currentBinding = store.loadSessionBinding(taskId);
      if (currentBinding.state === "unbound") {
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "start_session",
            attemptId,
            idempotencyKey: key("session-start"),
          },
        }));
        currentBinding = store.loadSessionBinding(taskId);
      } else if (currentBinding.state === "replacement_pending") {
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "replacement_creation_begins",
            attemptId,
            idempotencyKey: key("session-replacement-resume"),
          },
        }));
        currentBinding = store.loadSessionBinding(taskId);
      }
      let session: AcpV1AdapterSession | undefined;
      if (currentBinding.state === "creating") {
        startStage = "session_new";
        session = await created.adapter.newSession(workspace.canonicalPath);
      } else if (
        currentBinding.state === "restore_pending" &&
        currentBinding.retainedSessionId !== undefined &&
        currentBinding.sessionId !== undefined &&
        currentBinding.adapterEpoch !== undefined
      ) {
        let restoreCause: unknown = new Error("session_resume_not_advertised");
        if (initialized.agentCapabilities.resumeSession) {
          startStage = "session_resume";
          try {
            session = await created.adapter.resumeSession(
              currentBinding.retainedSessionId,
              workspace.canonicalPath,
            );
          } catch (cause: unknown) {
            if (created.adapter.state !== "ready") throw cause;
            restoreCause = cause;
          }
        }
        if (session === undefined && initialized.agentCapabilities.loadSession) {
          startStage = "session_load";
          try {
            session = await created.adapter.loadSession(
              currentBinding.retainedSessionId,
              workspace.canonicalPath,
            );
          } catch (cause: unknown) {
            restoreCause = cause;
          }
        }
        if (session === undefined) {
          const latestBinding = store.loadSessionBinding(taskId);
          if (latestBinding.state === "restore_pending") {
            requireBinding(store.applySessionBinding({
              taskId,
              event: {
                type: "restore_failed",
                sessionId: currentBinding.sessionId,
                adapterEpoch: currentBinding.adapterEpoch,
                attemptId,
                idempotencyKey: key("session-restore-failed-inline"),
              },
            }));
          }
          const restoreDetail = restoreCause instanceof Error
            ? restoreCause.message
            : "unknown_restore_error";
          logRuntime({
            category: "session",
            event: "restore_failed",
            taskId,
            sessionId: currentBinding.retainedSessionId,
            adapterEpoch,
            reason: restoreDetail.slice(0, 240),
          });
          controller.replayStaging = undefined;
          await publish();
          throw new Error("session_replacement_requires_user_authorization");
        }
      } else {
        throw new Error("runtime_cannot_resume_session");
      }
      if (session === undefined) throw new Error("runtime_session_unavailable");
      controller.contextWindowSize = session.contextWindowSize;
      controller.sessionModes = session.modes ?? null;
      controller.sessionConfigOptions = session.configOptions ?? Object.freeze([]);
      if (session.contextWindowSize !== undefined) {
        store.saveContextWindowSize({
          taskId,
          sessionId: must(parseSessionId(session.sessionId)),
          size: session.contextWindowSize,
        });
      }
      const runtimeSettings = store.loadAppSettings();
      if (
        !supportsGuildGrokReasoningEffort(
          runtimeSettings.grokModel,
          runtimeSettings.reasoningEffort,
        )
      ) {
        throw new Error("runtime_settings_invalid");
      }
      startStage = "session_set_model";
      await created.adapter.setModel(session, runtimeSettings.grokModel);
      startStage = "session_set_mode";
      await created.adapter.setMode(
        session,
        runtimeSettings.grokModel,
        runtimeSettings.reasoningEffort,
      );
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      if (replacingSession) {
        persistedContextTokens.delete(taskId);
        const replacementNoticeEntryId = unique("session-replaced");
        store.createConversationEntry({
          taskId,
          entryId: replacementNoticeEntryId,
          kind: "notice",
          text: store.loadAppSettings().locale === "zh-CN"
            ? "已按你的确认开始新的 Grok 会话。Guild 会在你下一次发送时附带本任务的本地恢复摘要；中断的指令仍不会自动重发。"
            : "A new Grok session was started with your confirmation. On your next send, Guild will attach a local recovery summary for this task; the interrupted instruction will still not be resent automatically.",
          metadata: {
            sessionReplaced: true,
            userAuthorized: true,
            recoveryHandoffRequired: true,
            replacementSessionId: session.sessionId,
            ...(binding.retainedSessionId === undefined
              ? {}
              : { replacedSessionId: binding.retainedSessionId }),
          },
          status: "complete",
        });
      }
      controller.session = session;
      logRuntime({
        category: "session",
        event: "ready",
        taskId,
        sessionId: session.sessionId,
        adapterEpoch,
        reason: session.establishedBy,
      });
      await publish();
      return session;
    } catch (cause: unknown) {
      await created?.adapter.close().catch(() => undefined);
      const failedBinding = store.loadSessionBinding(taskId);
      let bindingChanged = false;
      if (failedBinding.state === "creating" && failedBinding.createAttemptId === attemptId) {
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "creation_failed",
            attemptId,
            idempotencyKey: key("session-creation-failed"),
          },
        }));
        bindingChanged = true;
      } else if (
        startStage === "session_resume" &&
        failedBinding.state === "restore_pending" &&
        failedBinding.restoreAttemptId === attemptId &&
        failedBinding.sessionId !== undefined &&
        failedBinding.adapterEpoch !== undefined
      ) {
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "restore_failed",
            sessionId: failedBinding.sessionId,
            adapterEpoch: failedBinding.adapterEpoch,
            attemptId,
            idempotencyKey: key("session-restore-failed"),
          },
        }));
        bindingChanged = true;
      }
      controller.adapter = undefined;
      controller.adapterEpoch = undefined;
      controller.session = undefined;
      controller.replayStaging = undefined;
      if (bindingChanged) await publish().catch(() => undefined);
      const detail = cause instanceof Error ? cause.message : "unknown_error";
      logRuntime({
        category: "runtime",
        event: "start_failed",
        taskId,
        adapterEpoch,
        reason: `${startStage}:${detail}`.slice(0, 320),
      });
      throw new Error(`runtime_start_${startStage}:${detail}`);
    }
  }

  function reconcilePreviousRuntime(taskId: TaskId): void {
    const currentEpoch = store.loadCurrentAdapterEpoch(taskId);
    if (currentEpoch !== undefined && currentEpoch.status !== "exited") {
      store.commitAdapterEpoch({
        taskId,
        sessionId: currentEpoch.sessionId,
        adapterEpoch: currentEpoch.adapterEpoch,
        expectedRevision: currentEpoch.revision,
        status: "exited",
      });
    }
    const restored = store.restoreTask(taskId);
    const run = restored.currentRun;
    if (
      run !== undefined &&
      !TERMINAL_RUN_STATES.has(run.state)
    ) {
      const event = run.state === "queued"
        ? { type: "user_cancel", idempotencyKey: key("startup-cancel-queued") } as const
        : run.state === "starting"
          ? { type: "process_lost_after_prompt", idempotencyKey: key("startup-lost-starting") } as const
          : run.state === "cancel_requested"
            ? { type: "process_exit_confirms_cancellation", idempotencyKey: key("startup-cancel-confirmed") } as const
            : { type: "application_quit", idempotencyKey: key("startup-reconcile") } as const;
      requireRun(store.applyRun({ taskId, runId: run.runId, event }));
    }
    const binding = store.loadSessionBinding(taskId);
    if (
      binding.state === "healthy" &&
      binding.sessionId !== undefined &&
      binding.adapterEpoch !== undefined
    ) {
      const attemptId = id(parseSessionAttemptId, "restore-attempt");
      requireBinding(store.applySessionBinding({
        taskId,
        event: {
          type: "transport_lost",
          sessionId: binding.sessionId,
          adapterEpoch: binding.adapterEpoch,
          attemptId,
          idempotencyKey: key("startup-transport-lost"),
        },
      }));
    } else if (
      binding.state === "replay_reconciling" &&
      binding.sessionId !== undefined &&
      binding.adapterEpoch !== undefined &&
      binding.replayBarrier !== undefined &&
      binding.restoreAttemptId !== undefined
    ) {
      requireBinding(store.applySessionBinding({
        taskId,
        event: {
          type: "load_failed",
          sessionId: binding.sessionId,
          adapterEpoch: binding.adapterEpoch,
          barrierRequestId: binding.replayBarrier.requestId,
          attemptId: binding.restoreAttemptId,
          idempotencyKey: key("startup-load-abandoned"),
        },
      }));
    }
  }

  function reconcilePersistedRuntimes(): void {
    for (const workspace of store.listWorkspaces({ includeArchived: true })) {
      for (const task of store.listTasks({
        workspaceId: workspace.workspaceId,
        includeArchived: true,
      })) {
        reconcilePreviousRuntime(task.taskId);
      }
    }
  }

  function isCurrentRuntimeIdentity(
    taskId: TaskId,
    controller: RuntimeController,
    identity: Readonly<{ readonly adapterEpoch: number; readonly sessionId: string }>,
  ): boolean {
    if (controller.adapterEpoch !== identity.adapterEpoch) return false;
    if (controller.session !== undefined) {
      return controller.session.adapterEpoch === identity.adapterEpoch &&
        controller.session.sessionId === identity.sessionId;
    }
    const binding = store.loadSessionBinding(taskId);
    return binding.state === "healthy" &&
      binding.adapterEpoch === identity.adapterEpoch &&
      binding.sessionId === identity.sessionId;
  }

  function isCurrentReplayIdentity(
    taskId: TaskId,
    controller: RuntimeController,
    identity: Readonly<{ readonly adapterEpoch: number; readonly sessionId: string }>,
  ): boolean {
    const staging = controller.replayStaging;
    if (
      staging === undefined ||
      controller.adapterEpoch !== identity.adapterEpoch ||
      staging.adapterEpoch !== identity.adapterEpoch ||
      staging.sessionId !== identity.sessionId
    ) return false;
    const binding = store.loadSessionBinding(taskId);
    return binding.state === "replay_reconciling" &&
      binding.sessionId === identity.sessionId &&
      binding.adapterEpoch === identity.adapterEpoch &&
      binding.replayBarrier?.requestId === staging.barrierId;
  }

  function stageReplayUpdate(
    taskId: TaskId,
    controller: RuntimeController,
    identity: Readonly<{ readonly adapterEpoch: number; readonly sessionId: string }>,
    update: AcpV1DecodedUpdate,
  ): void {
    if (!isCurrentReplayIdentity(taskId, controller, identity)) {
      throw new Error("replay_identity_mismatch");
    }
    const staging = controller.replayStaging!;
    if (staging.updates.length >= REPLAY_STAGING_MAX_UPDATES) {
      throw new Error("replay_update_limit_exceeded");
    }
    const approximateBytes = Buffer.byteLength(JSON.stringify(update), "utf8");
    if (staging.approximateBytes + approximateBytes > REPLAY_STAGING_MAX_BYTES) {
      throw new Error("replay_byte_limit_exceeded");
    }
    staging.updates.push(update);
    staging.approximateBytes += approximateBytes;
  }

  function rememberReplayAbortAck(controller: RuntimeController, staging: ReplayStaging): void {
    controller.replayAbortAcks.set(staging.barrierId, Object.freeze({
      sessionId: staging.sessionId,
      adapterEpoch: staging.adapterEpoch,
    }));
    while (controller.replayAbortAcks.size > 8) {
      const oldest = controller.replayAbortAcks.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      controller.replayAbortAcks.delete(oldest);
    }
  }

  function reconcileReplayHistory(
    taskId: TaskId,
    loadedSessionId: string,
    updates: readonly AcpV1DecodedUpdate[],
  ): void {
    const replayTurns = replayTurnsFromUpdates(updates);
    const localTurns = localReplayTurns(taskId, loadedSessionId);
    let reachableReplayIndexes = new Set<number>([0]);
    for (const local of localTurns) {
      const required = local.run.state === "completed" || local.outboundPromptRecoveryCapsule;
      const next = new Set<number>();
      for (const replayIndex of reachableReplayIndexes) {
        if (!required) next.add(replayIndex);
        const replay = replayTurns[replayIndex];
        if (replay !== undefined && replayTurnMatches(local, replay, !required)) {
          next.add(replayIndex + 1);
        }
      }
      reachableReplayIndexes = next;
      if (reachableReplayIndexes.size === 0) throw new Error("session_load_replay_conflict");
    }
    if (!reachableReplayIndexes.has(replayTurns.length)) {
      throw new Error("session_load_replay_conflict");
    }
  }

  function localReplayTurns(taskId: TaskId, loadedSessionId: string): readonly LocalReplayTurn[] {
    const entries = allTaskConversationEntries(taskId);
    const turns = new Map<RunId, LocalReplayTurn>();
    for (const entry of entries) {
      if (
        entry.kind !== "user" ||
        entry.runId === undefined ||
        entry.status !== "complete" ||
        entry.metadata["hidden"] === true
      ) continue;
      const run = safeLoadRun(taskId, entry.runId);
      if (run === undefined || !TERMINAL_RUN_STATES.has(run.state)) {
        throw new Error("session_load_local_history_unsettled");
      }
      if (run.sessionId !== loadedSessionId) continue;
      if (turns.has(entry.runId)) throw new Error("session_load_local_user_ambiguous");
      turns.set(entry.runId, {
        ...emptyReplayTurn(),
        user: entry.text,
        run,
        outboundPromptSha256: undefined,
        outboundPromptHadResources: false,
        outboundPromptProofVersion: undefined,
        outboundPromptRecoveryCapsule: false,
      });
    }
    for (const entry of entries) {
      if (entry.runId === undefined) continue;
      const turn = turns.get(entry.runId);
      if (turn === undefined) continue;
      if (entry.kind === "notice" && entry.metadata["outboundPromptProof"] === true) {
        const digest = metadataString(entry, "outboundPromptSha256");
        if (digest === undefined || !/^[a-f0-9]{64}$/u.test(digest)) {
          throw new Error("session_load_local_prompt_digest_invalid");
        }
        if (turn.outboundPromptSha256 !== undefined) {
          throw new Error("session_load_local_prompt_digest_ambiguous");
        }
        turn.outboundPromptSha256 = digest;
        const proofVersion = entry.metadata["outboundPromptProofVersion"];
        if (proofVersion !== 2) {
          throw new Error("session_load_local_prompt_proof_version_unsupported");
        }
        turn.outboundPromptProofVersion = proofVersion;
        turn.outboundPromptHadResources =
          entry.metadata["outboundPromptHadResources"] === true;
        turn.outboundPromptRecoveryCapsule =
          entry.metadata["outboundPromptRecoveryCapsule"] === true;
      } else if (
        entry.kind === "notice" &&
        entry.metadata["runtimeReplayOrderMarker"] === true
      ) {
        const token = metadataString(entry, "runtimeReplayOrderToken");
        if (token === undefined || token.length > 512) {
          throw new Error("session_load_local_order_marker_invalid");
        }
        appendReplayOrderSegment(turn.order, token);
      } else if (entry.kind === "assistant") {
        turn.assistant += entry.text;
      } else if (entry.kind === "thought") {
        turn.thought += entry.text;
      } else if (entry.kind === "tool") {
        const toolCallId = metadataString(entry, "toolCallId");
        if (toolCallId === undefined) throw new Error("session_load_local_tool_identity_missing");
        const runtimeReplayKind = metadataString(entry, "runtimeReplayKind");
        if (runtimeReplayKind !== "tool" && runtimeReplayKind !== "plan") {
          throw new Error("session_load_local_tool_semantic_kind_missing");
        }
        if (runtimeReplayKind === "plan") {
          const planSha256 = metadataString(entry, "planSha256");
          if (planSha256 === undefined || !/^[a-f0-9]{64}$/u.test(planSha256)) {
            throw new Error("session_load_local_plan_digest_missing");
          }
          turn.plan = planSha256;
        } else {
          const toolSnapshotSha256 = metadataString(entry, "toolSnapshotSha256");
          if (toolSnapshotSha256 === undefined || !/^[a-f0-9]{64}$/u.test(toolSnapshotSha256)) {
            throw new Error("session_load_local_tool_digest_missing");
          }
          const snapshot = Object.freeze({
            digest: toolSnapshotSha256,
            title: "",
            kind: "other" as const,
            status: "pending" as const,
            content: Object.freeze([]),
            locations: Object.freeze([]),
            replayProofUnavailable: entry.metadata["replayProofUnavailable"] === true,
          });
          turn.tools.set(toolCallId, snapshot);
        }
      } else if (entry.kind === "media") {
        const localMediaType = mediaType(entry.metadata["mediaType"]);
        if (localMediaType !== "image" && localMediaType !== "audio") {
          throw new Error("session_load_local_media_not_reconcilable");
        }
        const mediaSha256 = metadataString(entry, "mediaSha256");
        if (mediaSha256 === undefined || !/^[a-f0-9]{64}$/u.test(mediaSha256)) {
          throw new Error("session_load_local_media_digest_missing");
        }
        const medium = replayMediaKey({
          discriminator: metadataString(entry, "discriminator") === "user_message_chunk"
            ? "user_message_chunk"
            : metadataString(entry, "discriminator") === "agent_message_chunk"
              ? "agent_message_chunk"
              : (() => { throw new Error("session_load_local_media_role_missing"); })(),
          mediaType: localMediaType,
          mimeType: metadataString(entry, "mimeType") ?? "application/octet-stream",
          mediaSha256,
        });
        turn.media.push(medium);
        appendReplayOrderSegment(turn.order, `media:${medium}`);
      }
    }
    return Object.freeze([...turns.values()]);
  }

  function applyReplayedSessionState(
    controller: RuntimeController,
    state: AcpV1SessionState,
    updates: readonly AcpV1DecodedUpdate[],
  ): void {
    controller.contextWindowSize = state.contextWindowSize;
    controller.sessionModes = state.modes ?? null;
    controller.sessionConfigOptions = state.configOptions ?? Object.freeze([]);
    for (const update of updates) {
      if (update.type !== "session_context") continue;
      const context = update.payload.context;
      if (context.kind === "commands") {
        controller.availableCommands = Object.freeze(
          context.commands.map((command) => Object.freeze({ ...command })),
        );
      } else if (context.kind === "mode") {
        if (controller.sessionModes !== null && controller.sessionModes !== undefined) {
          controller.sessionModes = Object.freeze({
            ...controller.sessionModes,
            currentModeId: context.currentModeId,
          });
        }
      } else if (context.kind === "config") {
        controller.sessionConfigOptions = Object.freeze(
          context.options.map((option) => Object.freeze({ ...option })),
        );
      } else if (context.kind === "usage") {
        controller.contextWindowUsage = Object.freeze({ used: context.used, size: context.size });
      }
    }
  }

  function createSink(taskId: TaskId, controller: RuntimeController): AcpV1AdapterSink {
    return Object.freeze({
      commitSessionEstablished: async (event) => {
        if (controller.adapterEpoch !== event.identity.adapterEpoch) return;
        const attemptId = controller.currentAttemptId;
        if (attemptId === undefined) throw new Error("session_attempt_missing");
        const sessionId = must(parseSessionId(event.identity.sessionId));
        const adapterEpoch = must(parseAdapterEpoch(event.identity.adapterEpoch));
        const bindingEvent = event.establishedBy === "new"
          ? {
              type: "session_new_succeeded",
              sessionId,
              adapterEpoch,
              attemptId,
              idempotencyKey: key("session-new-established"),
            } as const
          : {
              type: "resume_succeeded",
              sessionId,
              adapterEpoch,
              attemptId,
              idempotencyKey: key("session-resume-established"),
            } as const;
        requireBinding(store.applySessionBinding({ taskId, event: bindingEvent }));
        store.commitAdapterEpoch({
          taskId,
          sessionId,
          adapterEpoch,
          expectedRevision: 0,
          status: "alive",
        });
        logRuntime({
          category: "session",
          event: "established",
          taskId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
          reason: event.establishedBy,
        });
      },
      commitPromptAccepted: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        const runId = requireActiveRun(controller);
        const replayProof = controller.promptReplayProof;
        if (
          replayProof === undefined ||
          replayProof.runId !== runId ||
          replayProof.sessionId !== event.identity.sessionId
        ) throw new Error("prompt_replay_proof_missing");
        const recoveryHandoff = controller.recoveryHandoff;
        const matchingHandoff =
          recoveryHandoff?.runId === runId &&
          recoveryHandoff.sessionId === event.identity.sessionId
            ? recoveryHandoff
            : undefined;
        store.commitPromptAccepted({
          taskId,
          runId,
          sessionId: must(parseSessionId(event.identity.sessionId)),
          adapterEpoch: must(parseAdapterEpoch(event.identity.adapterEpoch)),
          promptSequence: event.identity.promptSequence,
          idempotencyKey: key("prompt-accepted"),
          durableNotices: Object.freeze([
            Object.freeze({
              entryId: replayProof.proofEntryId,
              text: "Guild outbound prompt replay proof.",
              metadata: Object.freeze({
                hidden: true,
                outboundPromptProof: true,
                outboundPromptProofVersion: 2,
                outboundPromptSha256: replayProof.outboundPromptSha256,
                outboundPromptHadResources: replayProof.outboundPromptHadResources,
                outboundPromptRecoveryCapsule: replayProof.recoveryCapsule,
              }),
            }),
            ...(matchingHandoff === undefined ? [] : [Object.freeze({
              entryId: matchingHandoff.handoffEntryId,
              text: "Guild replacement-session recovery context established.",
              metadata: Object.freeze({
                hidden: true,
                replacementHandoffEstablished: true,
                replacementSessionId: event.identity.sessionId,
                sourceNoticeEntryId: matchingHandoff.sourceNoticeEntryId,
              }),
            })]),
          ]),
        });
        if (matchingHandoff !== undefined) {
          controller.recoveryHandoff = undefined;
          logRuntime({
            category: "recovery",
            event: "replacement_handoff_established",
            taskId,
            runId,
            sessionId: event.identity.sessionId,
            adapterEpoch: event.identity.adapterEpoch,
          });
        }
        logRuntime({
          category: "prompt",
          event: "accepted",
          taskId,
          runId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
        });
        notePromptActivity(taskId, controller);
        await publish();
      },
      commitUpdate: async (event) => {
        if (event.update.type === "ignored_extension") {
          return;
        }
        if (event.ingestMode === "replay") {
          stageReplayUpdate(taskId, controller, event.identity, event.update);
          return;
        }
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        notePromptActivity(taskId, controller);
        const adapterEpoch = must(parseAdapterEpoch(event.identity.adapterEpoch));
        if (event.update.type === "session_context") {
          const binding = store.loadSessionBinding(taskId);
          if (event.update.payload.context.kind === "commands") {
            controller.availableCommands = Object.freeze(
              event.update.payload.context.commands.map((command) => Object.freeze({ ...command })),
            );
            await publish();
          } else if (event.update.payload.context.kind === "mode") {
            if (controller.sessionModes !== null && controller.sessionModes !== undefined) {
              controller.sessionModes = Object.freeze({
                ...controller.sessionModes,
                currentModeId: event.update.payload.context.currentModeId,
              });
            }
            await publish();
          } else if (event.update.payload.context.kind === "config") {
            controller.sessionConfigOptions = Object.freeze(
              event.update.payload.context.options.map((option) => Object.freeze({ ...option })),
            );
            await publish();
          } else if (event.update.payload.context.kind === "info") {
            const runtimeTitle = event.update.payload.context.title;
            if (typeof runtimeTitle === "string") {
              const metadata = store.loadTaskMetadata(taskId);
              const firstUserEntry = store.listConversationEntries({ taskId, limit: 64 })
                .find((entry) => entry.kind === "user");
              if (
                firstUserEntry !== undefined &&
                metadata.title === deriveTaskTitle(firstUserEntry.text)
              ) {
                const title = compactRuntimeTaskTitle(runtimeTitle);
                if (title.length > 0 && title !== metadata.title) {
                  store.renameTask({
                    taskId,
                    expectedRevision: metadata.revision,
                    title,
                  });
                  await publish();
                }
              }
            }
          } else if (
            event.update.payload.context.kind === "usage" &&
            binding.state === "healthy" &&
            binding.sessionId === event.identity.sessionId &&
            binding.adapterEpoch === event.identity.adapterEpoch
          ) {
            controller.contextWindowUsage = Object.freeze({
              used: event.update.payload.context.used,
              size: event.update.payload.context.size,
            });
            await publish();
          }
          return;
        }
        if (event.update.type === "media_content") {
          if (event.ingestMode !== "live") throw new Error("replay_media_not_admitted");
          await persistMediaContent(taskId, controller, event.update);
          await publish();
          return;
        }
        if (event.update.type === "unsupported_content") {
          const runId = requireActiveRun(controller);
          const locale = store.loadAppSettings().locale;
          store.createConversationEntry({
            taskId,
            runId,
            entryId: unique("unsupported"),
            kind: "notice",
            text: locale === "zh-CN"
              ? `运行时返回了暂不支持的 ${event.update.contentType} 内容。`
              : `Unsupported ${event.update.contentType} content was returned by the runtime.`,
            metadata: { discriminator: event.update.discriminator },
            status: "complete",
          });
          await publish();
          return;
        }
        await commitTurnUpdate(taskId, controller, adapterEpoch, event.update);
      },
      commitAuxiliaryUpdate: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        const payload = event.update.payload;
        const now = Date.now();
        let session = controller.auxiliarySessions.get(event.auxiliarySessionId);
        const isNewSession = session === undefined;
        if (session === undefined) {
          session = {
            activity: "working",
            startedAtMs: now,
            updatedAtMs: now,
            tools: new Map(),
          };
          controller.auxiliarySessions.set(event.auxiliarySessionId, session);
        }
        const previousActivity = session.activity;
        session.updatedAtMs = now;
        if (payload.type === "agent_thought_chunk") {
          session.activity = "thinking";
        } else if (payload.type === "agent_text_chunk") {
          session.activity = "responding";
        } else if (payload.type === "plan") {
          session.activity = "planning";
        } else if (payload.type === "tool_call_create" || payload.type === "tool_call_update") {
          const previous = session.tools.get(payload.toolCallId);
          const kind = payload.kind ?? previous?.kind ?? "other";
          const status = payload.status ?? previous?.status ?? "pending";
          session.tools.set(payload.toolCallId, { kind, status });
          session.activity = activityForToolKind(kind);
          logRuntime({
            category: "auxiliary",
            event: "tool_activity",
            taskId,
            ...(controller.activeRunId === undefined ? {} : { runId: controller.activeRunId }),
            sessionId: event.identity.sessionId,
            auxiliarySessionId: event.auxiliarySessionId,
            adapterEpoch: event.identity.adapterEpoch,
            activity: session.activity,
            toolKind: kind,
          });
        }
        if (
          (isNewSession || previousActivity !== session.activity) &&
          payload.type !== "tool_call_create" &&
          payload.type !== "tool_call_update"
        ) {
          logRuntime({
            category: "auxiliary",
            event: isNewSession ? "session_observed" : "activity_changed",
            taskId,
            ...(controller.activeRunId === undefined ? {} : { runId: controller.activeRunId }),
            sessionId: event.identity.sessionId,
            auxiliarySessionId: event.auxiliarySessionId,
            adapterEpoch: event.identity.adapterEpoch,
            activity: session.activity,
          });
        }
        notePromptActivity(taskId, controller);
        await publish();
      },
      preparePermissionResponse: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) {
          throw new Error("stale_runtime_identity");
        }
        const runId = requireActiveRun(controller);
        const owner = store.restoreTask(taskId).task.owningWindowId;
        if (owner === undefined) throw new Error("permission_owner_missing");
        const identity = Object.freeze({
          taskId,
          runId,
          sessionId: must(parseSessionId(event.identity.sessionId)),
          toolCallId: must(parseToolCallId(event.request.toolCallId)),
          adapterEpoch: must(parseAdapterEpoch(event.identity.adapterEpoch)),
          windowId: owner,
        });
        const run = store.loadRun(taskId, runId);
        if (run.state === "cancel_requested") {
          const commandId = id(parsePermissionOutboxCommandId, "safe-cancel-command");
          const deliveryAttemptId = id(parsePermissionDeliveryAttemptId, "safe-cancel-delivery");
          const registered = store.registerSafeCancelPermissionAndClaim({
            identity,
            request: event.request,
            idempotencyKey: key("safe-cancel-permission-register"),
            runIdempotencyKey: key("safe-cancel-permission-admit"),
            commandId,
            deliveryAttemptId,
          });
          if (!registered.ok || registered.writeClaim === undefined) {
            throw new Error(`safe_cancel_permission_${registered.ok ? "claim_missing" : registered.reason}`);
          }
          const outcome = registered.writeClaim.command.outcome;
          await publish();
          return Object.freeze({
            decision: outcome.outcome === "selected"
              ? Object.freeze({ type: "selected" as const, optionId: outcome.option.optionId })
              : Object.freeze({ type: "cancelled" as const }),
            delivery: Object.freeze({
              commandId: registered.writeClaim.commandId,
              version: registered.writeClaim.version,
              deliveryAttemptId: registered.writeClaim.deliveryAttemptId,
            }),
          });
        }
        const registered = store.registerPermission({
          identity,
          request: event.request,
          idempotencyKey: key("permission-register"),
          runIdempotencyKey: key("permission-admit-run"),
        });
        if (!registered.ok) throw new Error(`permission_register_${registered.reason}`);
        const permissionId = unique("permission");
        const createdAtMs = Date.now();
        const pending: PendingPermission = {
          identity,
          permissionId,
          createdAtMs,
          sequence: store.listConversationEntries({ taskId, limit: 500 }).length + 1,
          request: event.request,
          decision: deferred(),
          prepared: deferred(),
        };
        controller.pendingPermissions.set(permissionId, pending);
        clearPromptSilenceTimer(controller);
        const abort = () => pending.decision.reject(event.signal.reason);
        event.signal.addEventListener("abort", abort, { once: true });
        if (event.signal.aborted) abort();
        await publish();
        try {
          const decision = await pending.decision.promise;
          const commandId = id(parsePermissionOutboxCommandId, "permission-command");
          const deliveryAttemptId = id(parsePermissionDeliveryAttemptId, "permission-delivery");
          const outcome = decision.type === "selected"
            ? { outcome: "selected", optionId: decision.optionId } as const
            : { outcome: "cancelled" } as const;
          const claimed = store.decidePermissionAndClaim({
            identity,
            callbackRequestId: event.request.callbackRequestId,
            outcome,
            commandId,
            deliveryAttemptId,
          });
          if (!claimed.ok || claimed.writeClaim === undefined) {
            throw new Error(`permission_claim_${claimed.ok ? "missing" : claimed.reason}`);
          }
          controller.pendingPermissions.delete(permissionId);
          pending.prepared.resolve();
          await publish();
          return Object.freeze({
            decision,
            delivery: Object.freeze({
              commandId: claimed.writeClaim.commandId,
              version: claimed.writeClaim.version,
              deliveryAttemptId: claimed.writeClaim.deliveryAttemptId,
            }),
          });
        } catch (cause: unknown) {
          controller.pendingPermissions.delete(permissionId);
          let rejection = cause;
          if (event.signal.aborted) {
            const current = safeLoadRun(taskId, runId);
            if (current?.state === "cancel_requested") {
              const commandId = id(parsePermissionOutboxCommandId, "permission-cancel-command");
              const deliveryAttemptId = id(
                parsePermissionDeliveryAttemptId,
                "permission-cancel-delivery",
              );
              const settled = store.settlePermissionAutomaticallyAndMaybeClaim({
                identity,
                type: "orphan",
                cause: "run_cancel_requested",
                transportCanReceive: true,
                commandId,
                deliveryAttemptId,
                runResolutionIdempotencyKey: key("permission-abort"),
              });
              if (settled.ok && settled.writeClaim !== undefined) {
                const outcome = settled.writeClaim.command.outcome;
                pending.prepared.resolve();
                await publish();
                return Object.freeze({
                  decision: outcome.outcome === "selected"
                    ? Object.freeze({ type: "selected" as const, optionId: outcome.option.optionId })
                    : Object.freeze({ type: "cancelled" as const }),
                  delivery: Object.freeze({
                    commandId: settled.writeClaim.commandId,
                    version: settled.writeClaim.version,
                    deliveryAttemptId: settled.writeClaim.deliveryAttemptId,
                  }),
                });
              }
              rejection = new Error(
                `permission_abort_${settled.ok ? "claim_missing" : settled.reason}`,
              );
            }
          }
          pending.prepared.reject(rejection);
          await publish();
          throw rejection;
        } finally {
          event.signal.removeEventListener("abort", abort);
        }
      },
      commitPermissionResponseFlushed: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        const identity = Object.freeze({
          taskId,
          runId: requireActiveRun(controller),
          sessionId: must(parseSessionId(event.identity.sessionId)),
          toolCallId: must(parseToolCallId(event.request.toolCallId)),
          adapterEpoch: must(parseAdapterEpoch(event.identity.adapterEpoch)),
          windowId: PRIMARY_WINDOW_ID,
        });
        const correlation = {
          identity,
          commandId: must(parsePermissionOutboxCommandId(event.delivery.commandId)),
          version: must(parsePermissionOutboxVersion(event.delivery.version)),
          deliveryAttemptId: must(parsePermissionDeliveryAttemptId(event.delivery.deliveryAttemptId)),
        } as const;
        const permission = store.loadPermission(identity);
        const acknowledged = permission.registrationMode === "run_cancel_requested"
          ? store.acknowledgePermissionResponse({
              ...correlation,
              registrationMode: "run_cancel_requested",
            })
          : store.acknowledgePermissionResponse({
              ...correlation,
              registrationMode: "pending",
              runResolutionIdempotencyKey: key("permission-acknowledged"),
            });
        if (!acknowledged.ok) throw new Error(`permission_ack_${acknowledged.reason}`);
        notePromptActivity(taskId, controller);
        await publish();
      },
      commitPromptTerminal: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        if (event.terminal.contextTokensUsed !== undefined) {
          persistedContextTokens.set(taskId, event.terminal.contextTokensUsed);
          controller.contextWindowUsage = Object.freeze({
            used: event.terminal.contextTokensUsed,
            ...(controller.contextWindowUsage?.size === undefined && controller.contextWindowSize === undefined
              ? {}
              : { size: controller.contextWindowUsage?.size ?? controller.contextWindowSize }),
          });
        }
        const adapterEpoch = must(parseAdapterEpoch(event.identity.adapterEpoch));
        const runId = requireActiveRun(controller);
        await finalizeAllButLastStreaming(taskId, controller);
        const eventRecord = turnEvent(taskId, runId, controller, adapterEpoch, event.terminal);
        const streaming = [...controller.streamingEntries.values()].at(-1);
        const mutation = streaming === undefined
          ? {
              type: "create",
              entryId: unique("terminal"),
              kind: "notice",
              text: "",
              metadata: { hidden: true },
              status: "complete",
            } as const
          : {
              type: "finalize",
              entryId: streaming.entryId,
              expectedRevision: streaming.revision,
              status: "complete",
            } as const;
        const committed = store.commitLiveRuntimeEvent({
          event: eventRecord,
          mutation,
          ...(event.terminal.classification === "cancelled"
            ? {}
            : { terminalFinalizationIdempotencyKey: key("terminal-finalized") }),
        });
        if (!committed.ok) throw new Error(`terminal_commit_${committed.reason}`);
        controller.streamingEntries.clear();
        controller.toolStates.clear();
        controller.auxiliarySessions.clear();
        clearCancelTimer(controller);
        clearPromptSilenceTimer(controller);
        controller.activeRunId = undefined;
        logRuntime({
          category: "prompt",
          event: "terminal",
          taskId,
          runId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
          reason: event.terminal.classification,
        });
        await publish();
      },
      commitCancelSent: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) return;
        const runId = controller.activeRunId;
        if (runId === undefined) return;
        const run = safeLoadRun(taskId, runId);
        if (run?.state !== "cancel_requested" || !run.promptAccepted) return;
        const correlation = store.loadPromptCorrelation(taskId, runId);
        if (correlation.promptSequence !== event.identity.promptSequence) return;
        requireRun(store.applyRun({
          taskId,
          runId,
          event: {
            type: "cancel_notification_written",
            idempotencyKey: key("cancel-written"),
          },
        }));
      },
      commitTransportInterrupted: async (event) => {
        const override = controller.closeInterruptionOverride;
        controller.closeInterruptionOverride = undefined;
        await handleTransportInterrupted(
          taskId,
          controller,
          must(parseAdapterEpoch(event.identity.adapterEpoch)),
          override?.reason ?? event.reason,
          override?.diagnostic ?? event.diagnostic ?? Object.freeze({
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          }),
        );
      },
      beginReplayBarrier: async (event) => {
        if (controller.adapterEpoch !== event.identity.adapterEpoch) {
          throw new Error("replay_epoch_mismatch");
        }
        if (controller.replayStaging !== undefined) {
          throw new Error("replay_barrier_already_open");
        }
        const attemptId = controller.currentAttemptId;
        if (attemptId === undefined) throw new Error("session_attempt_missing");
        const binding = store.loadSessionBinding(taskId);
        if (
          binding.state !== "restore_pending" ||
          binding.retainedSessionId !== event.identity.sessionId ||
          binding.sessionId === undefined ||
          binding.adapterEpoch === undefined
        ) throw new Error("replay_binding_not_restorable");
        const sessionId = must(parseSessionId(event.identity.sessionId));
        const adapterEpoch = must(parseAdapterEpoch(event.identity.adapterEpoch));
        const barrierId = id(parseBarrierRequestId, "session-load-barrier");
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "load_began",
            sessionId,
            adapterEpoch,
            barrierRequestId: barrierId,
            attemptId,
            idempotencyKey: key("session-load-began"),
          },
        }));
        try {
          store.commitAdapterEpoch({
            taskId,
            sessionId,
            adapterEpoch,
            expectedRevision: 0,
            status: "spawning",
          });
        } catch (cause: unknown) {
          requireBinding(store.applySessionBinding({
            taskId,
            event: {
              type: "load_failed",
              sessionId,
              adapterEpoch,
              barrierRequestId: barrierId,
              attemptId,
              idempotencyKey: key("session-load-epoch-failed"),
            },
          }));
          throw cause;
        }
        controller.replayStaging = {
          barrierId,
          sessionId,
          adapterEpoch,
          attemptId,
          updates: [],
          approximateBytes: 0,
        };
        logRuntime({
          category: "session",
          event: "load_began",
          taskId,
          sessionId,
          adapterEpoch,
        });
        await publish().catch(() => undefined);
        return Object.freeze({ barrierId });
      },
      commitReplayBarrier: async (event) => {
        const staging = controller.replayStaging;
        if (
          staging === undefined ||
          staging.barrierId !== event.barrier.barrierId ||
          staging.sessionId !== event.identity.sessionId ||
          staging.adapterEpoch !== event.identity.adapterEpoch
        ) throw new Error("replay_barrier_mismatch");
        reconcileReplayHistory(taskId, staging.sessionId, staging.updates);
        const epoch = store.loadCurrentAdapterEpoch(taskId);
        if (
          epoch === undefined ||
          epoch.sessionId !== staging.sessionId ||
          epoch.adapterEpoch !== staging.adapterEpoch ||
          epoch.status !== "spawning"
        ) throw new Error("replay_epoch_commit_mismatch");
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "load_committed",
            sessionId: must(parseSessionId(staging.sessionId)),
            adapterEpoch: staging.adapterEpoch,
            barrierRequestId: must(parseBarrierRequestId(staging.barrierId)),
            attemptId: staging.attemptId,
            verdict: CONFLICT_FREE_VERDICT,
            idempotencyKey: key("session-load-committed"),
          },
        }));
        store.commitAdapterEpoch({
          taskId,
          sessionId: epoch.sessionId,
          adapterEpoch: epoch.adapterEpoch,
          expectedRevision: epoch.revision,
          status: "alive",
        });
        applyReplayedSessionState(controller, event.state, staging.updates);
        controller.replayStaging = undefined;
        logRuntime({
          category: "session",
          event: "load_committed",
          taskId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
          reason: `${staging.updates.length}_updates_reconciled`,
        });
        await publish().catch(() => undefined);
      },
      abortReplayBarrier: async (event) => {
        const staging = controller.replayStaging;
        if (staging === undefined) {
          const acknowledged = controller.replayAbortAcks.get(event.barrier.barrierId);
          if (
            acknowledged === undefined ||
            acknowledged.sessionId !== event.identity.sessionId ||
            acknowledged.adapterEpoch !== event.identity.adapterEpoch
          ) throw new Error("replay_barrier_mismatch");
          controller.replayAbortAcks.delete(event.barrier.barrierId);
          logRuntime({
            category: "session",
            event: "load_abort_acknowledged",
            taskId,
            sessionId: event.identity.sessionId,
            adapterEpoch: event.identity.adapterEpoch,
          });
          return;
        }
        if (
          staging.barrierId !== event.barrier.barrierId ||
          staging.sessionId !== event.identity.sessionId ||
          staging.adapterEpoch !== event.identity.adapterEpoch
        ) throw new Error("replay_barrier_mismatch");
        const binding = store.loadSessionBinding(taskId);
        if (binding.state === "replay_reconciling") {
          requireBinding(store.applySessionBinding({
            taskId,
            event: {
              type: "load_failed",
              sessionId: must(parseSessionId(staging.sessionId)),
              adapterEpoch: staging.adapterEpoch,
              barrierRequestId: must(parseBarrierRequestId(staging.barrierId)),
              attemptId: staging.attemptId,
              idempotencyKey: key("session-load-failed"),
            },
          }));
        }
        const epoch = store.loadCurrentAdapterEpoch(taskId);
        if (
          epoch !== undefined &&
          epoch.sessionId === staging.sessionId &&
          epoch.adapterEpoch === staging.adapterEpoch &&
          epoch.status !== "exited"
        ) {
          store.commitAdapterEpoch({
            taskId,
            sessionId: epoch.sessionId,
            adapterEpoch: epoch.adapterEpoch,
            expectedRevision: epoch.revision,
            status: "exited",
          });
        }
        controller.replayStaging = undefined;
        logRuntime({
          category: "session",
          event: "load_failed",
          taskId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
        });
        await publish().catch(() => undefined);
      },
    });
  }

  async function commitTurnUpdate(
    taskId: TaskId,
    controller: RuntimeController,
    adapterEpoch: AdapterEpoch,
    update: Extract<AcpV1DecodedUpdate, { readonly type: "turn" }>,
  ): Promise<void> {
    const runId = requireActiveRun(controller);
    const payload = update.payload;
    if (payload.type === "plan") {
      logRuntime({
        category: "prompt",
        event: "plan_activity",
        taskId,
        runId,
        ...(controller.session?.sessionId === undefined ? {} : { sessionId: controller.session.sessionId }),
        adapterEpoch,
        activity: "planning",
      });
    } else if (payload.type === "tool_call_create") {
      const toolKind = payload.kind ?? "other";
      logRuntime({
        category: "prompt",
        event: "tool_activity",
        taskId,
        runId,
        ...(controller.session?.sessionId === undefined ? {} : { sessionId: controller.session.sessionId }),
        adapterEpoch,
        activity: activityForToolKind(toolKind),
        toolKind,
      });
    }
    const event = turnEvent(taskId, runId, controller, adapterEpoch, payload);
    const createdToolMediaPaths: string[] = [];
    let nextToolState: { readonly toolCallId: string; readonly state: ToolProjectionState } | undefined;
    let mutation;
    if (payload.type === "agent_text_chunk" || payload.type === "agent_thought_chunk") {
      const kind = payload.type === "agent_text_chunk" ? "assistant" : "thought";
      const previous = controller.streamingEntries.get(kind);
      if (previous === undefined) {
        mutation = {
          type: "create",
          entryId: unique(kind),
          kind,
          text: payload.text,
          metadata: kind === "thought" ? { startedAtMs: Date.now() } : undefined,
          status: "streaming",
        } as const;
      } else {
        mutation = {
          type: "append_text",
          entryId: previous.entryId,
          expectedRevision: previous.revision,
          text: payload.text,
        } as const;
      }
    } else if (payload.type === "user_text_chunk") {
      mutation = {
        type: "create",
        entryId: unique("runtime-user"),
        kind: "user",
        text: payload.text,
        metadata: { hidden: true },
        status: "complete",
      } as const;
    } else if (payload.type === "tool_call_create" || payload.type === "tool_call_update") {
      const previous = controller.toolStates.get(payload.toolCallId);
      const locale = store.loadAppSettings().locale;
      const content = payload.content ?? previous?.content ?? Object.freeze([]);
      const locations = payload.locations ?? previous?.locations ?? Object.freeze([]);
      const status = payload.status ?? previous?.status ?? "pending";
      const materialized = await materializeToolDisplayContent({
        taskId,
        content,
        locations,
        includeLocationImages: status === "completed",
        previous: previous?.displayContent ?? Object.freeze([]),
        locale,
      });
      createdToolMediaPaths.push(...materialized.createdPaths);
      const toolState: ToolProjectionState = Object.freeze({
        runtimeReplayKind: "tool",
        title: payload.title ?? previous?.title ?? (locale === "zh-CN" ? "工具" : "Tool"),
        kind: payload.kind ?? previous?.kind ?? "other",
        status,
        content,
        displayContent: materialized.content,
        locations,
        replayProofUnavailable:
          payload.replayProofUnavailable === true || previous?.replayProofUnavailable === true,
      });
      nextToolState = Object.freeze({ toolCallId: payload.toolCallId, state: toolState });
      const displayTitle = boundedToolDisplayTitle(toolState.title);
      mutation = {
        type: "create",
        entryId: unique("tool"),
        kind: "tool",
        text: displayTitle,
        metadata: {
          toolCallId: persistedToolCallKey(payload.toolCallId),
          runtimeReplayKind: "tool",
          title: displayTitle,
          toolKind: toolState.kind,
          toolStatus: toolState.status,
          content: boundedTimelineToolContent(toolState.displayContent, 24 * 1024),
          locations: boundedToolDisplayCollection(toolState.locations, 8 * 1024),
          toolSnapshotSha256: replayToolSnapshotSha256(toolState),
          replayProofUnavailable: toolState.replayProofUnavailable,
        },
        status: "complete",
      } as const;
    } else if (payload.type === "plan") {
      const planText = boundedPlanDisplayText(payload.entries);
      const locale = store.loadAppSettings().locale;
      const planState: ToolProjectionState = Object.freeze({
        runtimeReplayKind: "plan",
        title: locale === "zh-CN" ? "计划" : "Plan",
        kind: "other",
        status: payload.entries.every((entry) => entry.status === "completed")
          ? "completed"
          : "in_progress",
        content: Object.freeze([{ type: "text" as const, text: planText }]),
        displayContent: Object.freeze([{ type: "text" as const, text: planText }]),
        locations: Object.freeze([]),
        replayProofUnavailable: false,
      });
      const planToolCallId = `plan:${runId}`;
      nextToolState = Object.freeze({ toolCallId: planToolCallId, state: planState });
      mutation = {
        type: "create",
        entryId: unique("plan"),
        kind: "tool",
        text: planText,
        metadata: {
          toolCallId: planToolCallId,
          runtimeReplayKind: "plan",
          title: planState.title,
          toolKind: planState.kind,
          toolStatus: planState.status,
          planSha256: sha256Text(canonicalReplayJson(payload.entries)),
        },
        status: "complete",
      } as const;
    } else {
      throw new Error("permission_and_terminal_use_dedicated_sink");
    }
    const orderToken = replayOrderToken(payload);
    const orderChanged = orderToken !== undefined && controller.replayOrderLastToken !== orderToken;
    let committed: ReturnType<GuildPersistence["commitLiveRuntimeEvent"]>;
    try {
      committed = store.commitLiveRuntimeEvent({
        event,
        mutation,
        ...(orderChanged ? {
          replayOrderMarker: Object.freeze({
            entryId: unique("runtime-replay-order"),
            token: orderToken!,
          }),
        } : {}),
      });
      if (!committed.ok) throw new Error(`runtime_update_${committed.reason}`);
    } catch (cause: unknown) {
      await Promise.all(createdToolMediaPaths.map((path) => unlink(path).catch(() => undefined)));
      throw cause;
    }
    if (nextToolState !== undefined) {
      // Map.set does not move an existing key. Reinsert updates so the sidebar
      // and the persisted timeline both resolve overlapping tools by the most
      // recently observed official event.
      controller.toolStates.delete(nextToolState.toolCallId);
      controller.toolStates.set(nextToolState.toolCallId, nextToolState.state);
    }
    if (!committed.duplicate && orderChanged) controller.replayOrderLastToken = orderToken;
    if (
      committed.record !== undefined &&
      (committed.record.kind === "assistant" || committed.record.kind === "thought")
    ) {
      controller.streamingEntries.set(committed.record.kind, committed.record);
    }
    if (payload.type === "agent_text_chunk" || payload.type === "agent_thought_chunk") {
      scheduleStreamPublish();
      // The adapter keeps commits ordered. Yield during a buffered burst so
      // publication, cancellation and process events can run between commits.
      if (performance.now() - lastStreamYieldAt >= 8) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        lastStreamYieldAt = performance.now();
      }
    } else {
      await publish();
    }
  }

  function turnEvent(
    taskId: TaskId,
    runId: RunId,
    controller: RuntimeController,
    adapterEpoch: AdapterEpoch,
    payload: RuntimeTurnPayload,
  ) {
    controller.receiveSequence += 1;
    const created = createRuntimeTurnEvent({
      taskId,
      runId,
      adapterEpoch,
      ingestMode: "live",
      receiveSequence: controller.receiveSequence,
      idempotencyKey: key("runtime-event"),
      payload,
    });
    if (!created.ok) throw new Error(`runtime_event_${created.reason}`);
    return created.value;
  }

  async function finalizeAllButLastStreaming(
    taskId: TaskId,
    controller: RuntimeController,
  ): Promise<void> {
    const entries = [...controller.streamingEntries.values()];
    for (const entry of entries.slice(0, -1)) {
      const finalized = store.finalizeConversationEntry({
        taskId,
        entryId: entry.entryId,
        expectedRevision: entry.revision,
        status: "complete",
      });
      controller.streamingEntries.set(entry.kind as "assistant" | "thought", finalized);
    }
    if (entries.length > 1) {
      const keep = entries.at(-1)!;
      controller.streamingEntries.clear();
      controller.streamingEntries.set(keep.kind as "assistant" | "thought", keep);
    }
  }

  async function handleTransportInterrupted(
    taskId: TaskId,
    controller: RuntimeController,
    interruptedAdapterEpoch: AdapterEpoch,
    reason: AcpV1AdapterInterruptionReason,
    diagnostic: AcpV1AdapterInterruptionDiagnostic,
  ): Promise<void> {
    if (controller.adapterEpoch !== interruptedAdapterEpoch) return;
    const epoch = store.loadCurrentAdapterEpoch(taskId);
    if (epoch !== undefined && epoch.adapterEpoch !== interruptedAdapterEpoch) return;
    if (epoch !== undefined && epoch.status !== "exited") {
      store.commitAdapterEpoch({
        taskId,
        sessionId: epoch.sessionId,
        adapterEpoch: epoch.adapterEpoch,
        expectedRevision: epoch.revision,
        status: "exited",
      });
    }
    const binding = store.loadSessionBinding(taskId);
    const replayStaging = controller.replayStaging;
    if (
      replayStaging !== undefined &&
      replayStaging.adapterEpoch === interruptedAdapterEpoch &&
      binding.sessionId === replayStaging.sessionId &&
      binding.adapterEpoch === replayStaging.adapterEpoch
    ) {
      rememberReplayAbortAck(controller, replayStaging);
    }
    if (
      binding.state === "healthy" &&
      binding.sessionId !== undefined &&
      binding.adapterEpoch !== undefined
    ) {
      requireBinding(store.applySessionBinding({
        taskId,
        event: {
          type: "transport_lost",
          sessionId: binding.sessionId,
          adapterEpoch: binding.adapterEpoch,
          attemptId: id(parseSessionAttemptId, "transport-attempt"),
          idempotencyKey: key("transport-lost"),
        },
      }));
    } else if (
      binding.state === "replay_reconciling" &&
      binding.replayBarrier !== undefined &&
      binding.sessionId !== undefined &&
      binding.adapterEpoch !== undefined &&
      binding.restoreAttemptId !== undefined
    ) {
      requireBinding(store.applySessionBinding({
        taskId,
        event: {
          type: "load_failed",
          sessionId: binding.sessionId,
          adapterEpoch: binding.adapterEpoch,
          barrierRequestId: binding.replayBarrier.requestId,
          attemptId: binding.restoreAttemptId,
          idempotencyKey: key("transport-lost-during-load"),
        },
      }));
    }
    const runId = controller.activeRunId;
    const incidentId = reason === "explicit_close" ? undefined : randomUUID();
    if (incidentId !== undefined) {
      const occurredAtIso = new Date().toISOString();
      const metadata = store.loadTaskMetadata(taskId);
      runtimeIncidents.set(incidentId, Object.freeze({
        incidentId,
        occurredAtIso,
        taskId,
        taskTitle: metadata.title,
        reason,
        recovery: "restoring",
        ...(diagnostic.exitCode === undefined ? {} : { exitCode: diagnostic.exitCode }),
        ...(diagnostic.signal === undefined ? {} : { signal: diagnostic.signal }),
        hasStderr:
          diagnostic.stderrTail.length > 0 ||
          diagnostic.stderrCapturedBytes > 0 ||
          diagnostic.stderrDroppedBytes > 0,
      }));
    }
    logRuntime({
      category: reason === "explicit_close" ? "runtime" : "transport",
      event: reason === "explicit_close" ? "closed" : "interrupted",
      taskId,
      ...(incidentId === undefined ? {} : { incidentId }),
      ...(runId === undefined ? {} : { runId }),
      ...(binding.sessionId === undefined ? {} : { sessionId: binding.sessionId }),
      adapterEpoch: interruptedAdapterEpoch,
      ...(diagnostic.processId === undefined ? {} : { processId: diagnostic.processId }),
      ...(diagnostic.exitCode === undefined ? {} : { exitCode: diagnostic.exitCode }),
      ...(diagnostic.signal === undefined ? {} : { signal: diagnostic.signal }),
      ...(diagnostic.faultCode === undefined ? {} : { faultCode: diagnostic.faultCode }),
      ...(diagnostic.faultPath === undefined ? {} : { faultPath: diagnostic.faultPath }),
      ...(diagnostic.faultStage === undefined ? {} : { faultStage: diagnostic.faultStage }),
      ...(diagnostic.updateKind === undefined ? {} : { updateKind: diagnostic.updateKind }),
      reason,
      stderrTail: diagnostic.stderrTail,
      stderrCapturedBytes: diagnostic.stderrCapturedBytes,
      stderrDroppedBytes: diagnostic.stderrDroppedBytes,
    });
    let interruptedInstruction = false;
    if (runId !== undefined) {
      const run = safeLoadRun(taskId, runId);
      if (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) {
        interruptedInstruction = true;
        const event = run.state === "cancel_requested"
          ? { type: "process_exit_confirms_cancellation", idempotencyKey: key("cancel-process-exit") } as const
          : run.state === "starting"
            ? { type: "process_lost_after_prompt", idempotencyKey: key("prompt-process-lost") } as const
            : { type: "ownership_lost_before_completion", idempotencyKey: key("runtime-ownership-lost") } as const;
        requireRun(store.applyRun({ taskId, runId, event }));
        if (run.state !== "cancel_requested" && incidentId !== undefined) {
          store.createConversationEntry({
            taskId,
            runId,
            entryId: unique("runtime-interrupted"),
            kind: "error",
            text: transportInterruptionMessage(
              store.loadAppSettings().locale,
              diagnostic,
            ),
            metadata: { incidentId, reason },
            status: "failed",
          });
        }
      }
      controller.activeRunId = undefined;
    }
    const continuousTask = store.loadContinuousTask(taskId);
    if (
      continuousTask?.status === "active" &&
      (runId === undefined || continuousTask.lastRunId === runId)
    ) {
      store.updateContinuousTask({
        taskId,
        expectedRevision: continuousTask.revision,
        status: "paused",
        stopReason: "transport_interrupted",
      });
    }
    controller.promptRunId = undefined;
    controller.promptOperation = undefined;
    controller.promptReplayProof = undefined;
    controller.session = undefined;
    controller.replayStaging = undefined;
    controller.adapter = undefined;
    controller.adapterEpoch = undefined;
    controller.contextWindowUsage = undefined;
    controller.contextWindowSize = undefined;
    controller.pendingPermissions.clear();
    controller.streamingEntries.clear();
    controller.toolStates.clear();
    controller.auxiliarySessions.clear();
    clearCancelTimer(controller);
    clearPromptSilenceTimer(controller);
    await publish();
    if (incidentId !== undefined) {
      scheduleSessionRecovery(taskId, incidentId, interruptedInstruction);
    }
    scheduleQueuedDispatch(taskId);
  }

  function scheduleSessionRecovery(
    taskId: TaskId,
    incidentId: string,
    interruptedInstruction: boolean,
  ): void {
    void Promise.resolve().then(async () => {
      if (closed || closing) return;
      logRuntime({ category: "recovery", event: "started", taskId, incidentId });
      try {
        const session = await ensureSession(taskId);
        const previous = runtimeIncidents.get(incidentId);
        if (previous !== undefined) {
          runtimeIncidents.set(incidentId, Object.freeze({ ...previous, recovery: "restored" }));
        }
        logRuntime({
          category: "recovery",
          event: "restored",
          taskId,
          sessionId: session.sessionId,
          adapterEpoch: session.adapterEpoch,
          incidentId,
        });
        if (interruptedInstruction) {
          store.createConversationEntry({
            taskId,
            entryId: unique("session-auto-restored"),
            kind: "notice",
            text: store.loadAppSettings().locale === "zh-CN"
              ? "原 Grok 会话已恢复。为避免重复修改，刚才中断的指令没有自动重发；需要时请手动重试。"
              : "The original Grok session was restored. The interrupted instruction was not resent automatically, avoiding duplicate changes; retry it manually if needed.",
            metadata: { incidentId, recovery: "restored", automaticResend: false },
            status: "complete",
          });
        }
      } catch (cause: unknown) {
        const previous = runtimeIncidents.get(incidentId);
        if (previous !== undefined) {
          runtimeIncidents.set(incidentId, Object.freeze({ ...previous, recovery: "failed" }));
        }
        logRuntime({
          category: "recovery",
          event: "failed",
          taskId,
          incidentId,
          reason: (cause instanceof Error ? cause.message : "unknown_error").slice(0, 360),
        });
      }
      await publish().catch(() => undefined);
    });
  }

  function launchPrompt(
    taskId: TaskId,
    controller: RuntimeController,
    session: AcpV1AdapterSession,
    prompt: PreparedRuntimePrompt,
    runId: RunId,
    resources: readonly {
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size: number;
    }[] = [],
  ): void {
    const adapter = controller.adapter;
    if (adapter === undefined || controller.promptRunId !== undefined) {
      throw new Error("runtime_prompt_overlap");
    }
    controller.recoveryHandoff = prompt.recoveryHandoff === undefined
      ? undefined
      : Object.freeze({
          runId,
          sessionId: session.sessionId,
          sourceNoticeEntryId: prompt.recoveryHandoff.sourceNoticeEntryId,
          handoffEntryId: unique("session-recovery-handoff"),
        });
    controller.promptReplayProof = Object.freeze({
      runId,
      sessionId: session.sessionId,
      outboundPromptSha256: outboundPromptSha256(prompt.text, resources),
      outboundPromptHadResources: resources.length > 0,
      recoveryCapsule: prompt.recoveryHandoff !== undefined,
      proofEntryId: unique("outbound-prompt-proof"),
    });
    controller.replayOrderLastToken = undefined;
    controller.promptRunId = runId;
    armPromptSilenceTimer(taskId, controller, adapter, runId);
    const operation = runPrompt(taskId, controller, adapter, session, prompt.text, runId, resources);
    controller.promptOperation = operation.then(() => undefined, () => undefined);
    void operation.catch(() => undefined);
  }

  async function runPrompt(
    taskId: TaskId,
    controller: RuntimeController,
    adapter: RuntimeAdapterPort,
    session: AcpV1AdapterSession,
    text: string,
    runId: RunId,
    resources: readonly {
      readonly name: string;
      readonly uri: string;
      readonly mimeType?: string;
      readonly size: number;
    }[],
  ): Promise<void> {
    try {
      await adapter.prompt(session, text, resources);
    } catch (cause: unknown) {
      if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
        console.error(
          "guild_prompt_failure",
          cause instanceof AcpV1AdapterError
            ? cause.code
            : cause instanceof Error ? cause.name : "unknown_error",
          controller.adapter?.state ?? "adapter_missing",
        );
      }
      let runTerminalized = false;
      if (controller.activeRunId === runId) {
        const run = safeLoadRun(taskId, runId);
        if (run?.state === "starting") {
          const deliveryUnconfirmed =
            cause instanceof AcpV1AdapterError && cause.code === "sink_commit_failed";
          requireRun(store.applyRun({
            taskId,
            runId,
            event: deliveryUnconfirmed
              ? { type: "process_lost_after_prompt", idempotencyKey: key("prompt-acceptance-unconfirmed") }
              : { type: "launch_failure", idempotencyKey: key("prompt-launch-failure") },
          }));
          store.createConversationEntry({
            taskId,
            runId,
            entryId: unique(deliveryUnconfirmed ? "prompt-acceptance-unconfirmed" : "prompt-launch-error"),
            kind: "error",
            text: deliveryUnconfirmed
              ? (store.loadAppSettings().locale === "zh-CN"
                  ? "指令已经写入 Grok，但 Guild 未能确认本地接收记录。为避免重复修改，不会自动重发；请先查看原任务状态。"
                  : "The instruction was written to Grok, but Guild could not confirm its local acceptance record. It will not resend automatically; check the original task state first.")
              : (store.loadAppSettings().locale === "zh-CN"
                  ? "Grok 运行时未能开始这次任务。你可以重新发送这条消息。"
                  : "The Grok runtime could not start this task. You can send the message again."),
            metadata: deliveryUnconfirmed
              ? { failureCategory: "prompt_delivery_unconfirmed" }
              : { failureCategory: "prompt_launch_failed" },
            status: "failed",
          });
          controller.activeRunId = undefined;
          runTerminalized = true;
        } else if (
          run !== undefined &&
          adapter.state === "ready" &&
          (run.state === "running" ||
            run.state === "awaiting_permission" ||
            run.state === "cancel_requested")
        ) {
          requireRun(store.applyRun({
            taskId,
            runId,
            event: { type: "protocol_terminal_error", idempotencyKey: key("prompt-protocol-error") },
          }));
          const locale = store.loadAppSettings().locale;
          store.createConversationEntry({
            taskId,
            runId,
            entryId: unique("prompt-protocol-error"),
            kind: "error",
            text: promptFailureMessage(locale),
            metadata: { failureCategory: "runtime_prompt_rejected" },
            status: "failed",
          });
          controller.activeRunId = undefined;
          runTerminalized = true;
        }
      }
      if (runTerminalized) {
        controller.streamingEntries.clear();
        controller.toolStates.clear();
        controller.auxiliarySessions.clear();
        clearCancelTimer(controller);
        clearPromptSilenceTimer(controller);
      }
      await publish();
    } finally {
      if (controller.promptRunId === runId) {
        controller.promptRunId = undefined;
        controller.promptOperation = undefined;
        controller.promptReplayProof = undefined;
      }
      await enqueueCommand(async () => {
        await advanceContinuousAfterRun(taskId, runId);
        await publish();
      }).catch(() => undefined);
      await scheduleQueuedDispatch(taskId);
      if (store.listQueuedTurns(taskId).length === 0) {
        scheduleContinuousDispatch(taskId);
      }
    }
  }

  function notePromptActivity(taskId: TaskId, controller: RuntimeController): void {
    const adapter = controller.adapter;
    const runId = controller.activeRunId;
    if (adapter === undefined || runId === undefined || controller.pendingPermissions.size > 0) return;
    const run = safeLoadRun(taskId, runId);
    if (run === undefined || (run.state !== "starting" && run.state !== "running")) return;
    armPromptSilenceTimer(taskId, controller, adapter, runId);
  }

  function armPromptSilenceTimer(
    taskId: TaskId,
    controller: RuntimeController,
    adapter: RuntimeAdapterPort,
    runId: RunId,
  ): void {
    clearPromptSilenceTimer(controller);
    // Silence is not proof of failure. Official Grok goals can legitimately
    // spend longer than ten minutes inside model inference, a test process, or
    // another tool without emitting an ACP update. Production therefore relies
    // on real transport/process failure and explicit cancellation. Tests and
    // diagnostics can still opt into a bounded watchdog.
    const silenceMs = options.promptSilenceMs;
    if (silenceMs === undefined) return;
    if (!Number.isFinite(silenceMs) || silenceMs <= 0) {
      throw new RangeError("promptSilenceMs must be a positive finite number");
    }
    controller.promptSilenceTimer = setTimeout(() => {
      controller.promptSilenceTimer = undefined;
      void enqueueCommand(async () => {
        if (
          closed ||
          closing ||
          controller.adapter !== adapter ||
          controller.activeRunId !== runId ||
          controller.pendingPermissions.size > 0
        ) return;
        const run = safeLoadRun(taskId, runId);
        if (run === undefined || (run.state !== "starting" && run.state !== "running")) return;
        const adapterEpoch = controller.adapterEpoch;
        controller.closeInterruptionOverride = Object.freeze({
          reason: "process_fault",
          diagnostic: Object.freeze({
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          }),
        });
        await adapter.close().catch(() => undefined);
        controller.closeInterruptionOverride = undefined;
        if (
          adapterEpoch !== undefined &&
          controller.adapter === adapter &&
          controller.activeRunId === runId
        ) {
          await handleTransportInterrupted(taskId, controller, adapterEpoch, "process_fault", {
            stderrTail: Object.freeze([]),
            stderrCapturedBytes: 0,
            stderrDroppedBytes: 0,
          });
        }
      });
    }, silenceMs);
    controller.promptSilenceTimer.unref?.();
  }

  async function materializeToolDisplayContent(input: Readonly<{
    taskId: TaskId;
    content: readonly RuntimeToolContent[];
    locations: readonly RuntimeToolLocation[];
    includeLocationImages: boolean;
    previous: readonly TimelineToolContent[];
    locale: GuildLocale;
  }>): Promise<Readonly<{
    content: readonly TimelineToolContent[];
    createdPaths: readonly string[];
  }>> {
    const result: TimelineToolContent[] = [];
    const createdPaths: string[] = [];
    const known = new Map(
      input.previous
        .filter((item): item is Extract<TimelineToolContent, { readonly type: "media" }> => item.type === "media")
        .map((item) => [item.mediaSha256, item]),
    );
    const addImage = async (bytes: Buffer, declaredMimeType: string | undefined, alt: string) => {
      const inspected = inspectDisplayImageBytes(bytes);
      if (declaredMimeType !== undefined && inspected.mimeType !== declaredMimeType) {
        throw new Error("tool_media_mime_mismatch");
      }
      const mediaSha256 = sha256Bytes(bytes);
      if (result.some((item) => item.type === "media" && item.mediaSha256 === mediaSha256)) return;
      const existing = known.get(mediaSha256);
      if (existing !== undefined) {
        result.push(existing);
        return;
      }
      await decodeAvatarWithElectron(bytes);
      await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
      const filename = `${randomUUID()}.${inspected.extension}`;
      const path = join(mediaRoot, filename);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      createdPaths.push(path);
      const media = Object.freeze({
        type: "media" as const,
        mediaType: "image" as const,
        mimeType: inspected.mimeType,
        grantUrl: `guild-media://media/${filename}`,
        alt,
        mediaSha256,
      });
      known.set(mediaSha256, media);
      result.push(media);
    };
    let imageIndex = 0;
    for (const item of input.content) {
      if (item.type !== "media") {
        result.push(item);
        continue;
      }
      imageIndex += 1;
      try {
        const bytes = Buffer.from(item.base64Data, "base64");
        await addImage(
          bytes,
          item.mimeType,
          toolImageAlt(item.uri, imageIndex, input.locale),
        );
      } catch {
        result.push(Object.freeze({ type: "unsupported", contentType: "image" }));
      }
    }
    if (input.includeLocationImages) {
      for (const location of input.locations.slice(0, 8)) {
        try {
          const image = await readWorkspaceToolImage(input.taskId, location.path);
          await addImage(image.bytes, undefined, image.name);
        } catch {
          // ACP locations can point to text, missing, or outside-workspace files.
          // Only proven workspace image bytes become renderer-visible grants.
        }
      }
    }
    return Object.freeze({
      content: Object.freeze(result),
      createdPaths: Object.freeze(createdPaths),
    });
  }

  async function readWorkspaceToolImage(
    taskId: TaskId,
    requestedPath: string,
  ): Promise<Readonly<{ readonly bytes: Buffer; readonly name: string }>> {
    const task = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(task.workspaceId);
    const workspacePath = await realpath(workspace.canonicalPath);
    const canonical = await realpath(requestedPath);
    const within = relative(workspacePath, canonical);
    if (
      within === "" ||
      within === ".." ||
      within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(within)
    ) {
      throw new Error("tool_media_outside_workspace");
    }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const details = await file.stat();
      if (!details.isFile() || details.size <= 0 || details.size > ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes) {
        throw new Error("tool_media_not_regular");
      }
      return Object.freeze({ bytes: await file.readFile(), name: basename(canonical) });
    } finally {
      await file?.close().catch(() => undefined);
    }
  }

  async function persistMediaContent(
    taskId: TaskId,
    controller: RuntimeController,
    media: Extract<AcpV1DecodedUpdate, { readonly type: "media_content" }>,
  ): Promise<void> {
    const runId = requireActiveRun(controller);
    const bytes = Buffer.from(media.base64Data, "base64");
    if (bytes.length === 0 || bytes.length > ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes) {
      throw new Error("media_payload_out_of_bounds");
    }
    const inspected = media.mediaType === "image" ? inspectDisplayImageBytes(bytes) : undefined;
    if (inspected !== undefined && inspected.mimeType !== media.mimeType) {
      throw new Error("media_mime_mismatch");
    }
    const extension = inspected?.extension ?? mediaExtension(media.mimeType);
    const mediaSha256 = sha256Bytes(bytes);
    const mediaOrderToken = `media:${replayMediaKey({
      discriminator: media.discriminator,
      mediaType: media.mediaType,
      mimeType: media.mimeType,
      mediaSha256,
    })}`;
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}.${extension}`;
    const path = join(mediaRoot, filename);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    try {
      const zh = store.loadAppSettings().locale === "zh-CN";
      const alt = media.mediaType === "image"
        ? (zh ? "Grok 图片" : "Grok image")
        : (zh ? "Grok 音频" : "Grok audio");
      store.createConversationEntry({
        taskId,
        runId,
        entryId: unique("media"),
        kind: "media",
        text: alt,
        metadata: {
          mediaType: media.mediaType,
          mimeType: media.mimeType,
          discriminator: media.discriminator,
          grantUrl: `guild-media://media/${filename}`,
          alt,
          mediaSha256,
          ...(media.messageId === undefined ? {} : { messageId: media.messageId }),
        },
        status: "complete",
      });
      controller.replayOrderLastToken = mediaOrderToken;
    } catch (cause: unknown) {
      await unlink(path).catch(() => undefined);
      throw cause;
    }
  }

  async function closeController(
    taskId: TaskId,
    controller: RuntimeController,
    strictAdapterClose = false,
  ): Promise<void> {
    clearCancelTimer(controller);
    clearPromptSilenceTimer(controller);
    const runId = controller.activeRunId;
    if (runId !== undefined) {
      const run = safeLoadRun(taskId, runId);
      if (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) {
        const event = run.state === "queued"
          ? { type: "user_cancel", idempotencyKey: key("quit-cancel-queued") } as const
          : run.state === "starting"
            ? { type: "process_lost_after_prompt", idempotencyKey: key("quit-starting") } as const
            : run.state === "cancel_requested"
              ? { type: "process_exit_confirms_cancellation", idempotencyKey: key("quit-cancel-confirm") } as const
              : { type: "application_quit", idempotencyKey: key("application-quit") } as const;
        requireRun(store.applyRun({ taskId, runId, event }));
      }
    }
    const adapterClose = controller.adapter?.close();
    if (strictAdapterClose) await adapterClose;
    else await adapterClose?.catch(() => undefined);
    controller.promptRunId = undefined;
    controller.promptOperation = undefined;
    controller.promptReplayProof = undefined;
    controller.contextWindowUsage = undefined;
    controller.contextWindowSize = undefined;
  }

  function promptAttachmentMimeType(path: string): string | undefined {
    const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
    return extension === "md" || extension === "markdown" ? "text/markdown"
      : extension === "txt" || extension === "log" ? "text/plain"
        : extension === "json" ? "application/json"
          : extension === "csv" ? "text/csv"
            : extension === "html" || extension === "htm" ? "text/html"
              : extension === "xml" ? "application/xml"
                : extension === "pdf" ? "application/pdf"
                  : extension === "png" ? "image/png"
                    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
                      : extension === "webp" ? "image/webp"
                        : undefined;
  }

  async function canonicalPromptAttachment(
    workspacePath: string,
    selectedPath: string,
  ): Promise<{ readonly attachment: PromptAttachment; readonly uri: string }> {
    const workspaceRoot = await realpath(workspacePath);
    const candidate = isAbsolute(selectedPath) ? selectedPath : resolve(workspaceRoot, selectedPath);
    const canonical = await realpath(candidate);
    const within = relative(workspaceRoot, canonical);
    if (
      within === "" ||
      within === ".." ||
      within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(within)
    ) {
      throw new Error("prompt_attachment_outside_workspace");
    }
    const details = await stat(canonical);
    if (!details.isFile()) throw new Error("prompt_attachment_not_regular");
    if (details.size > GUILD_PROMPT_ATTACHMENT_MAX_BYTES) {
      throw new Error("prompt_attachment_too_large");
    }
    const relativePath = within.replaceAll("\\", "/");
    const mimeType = promptAttachmentMimeType(canonical);
    return Object.freeze({
      attachment: Object.freeze({
        relativePath,
        name: basename(canonical),
        size: details.size,
        ...(mimeType === undefined ? {} : { mimeType }),
      }),
      uri: pathToFileURL(canonical).href,
    });
  }

  async function validatePromptAttachments(
    taskId: TaskId,
    attachments: readonly PromptAttachment[],
  ): Promise<readonly { readonly name: string; readonly uri: string; readonly mimeType?: string; readonly size: number }[]> {
    if (attachments.length > GUILD_PROMPT_ATTACHMENT_LIMIT) {
      throw new Error("too_many_prompt_attachments");
    }
    const task = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(task.workspaceId);
    if (task.disposition !== "active" || workspace.disposition !== "active") {
      throw new Error("prompt_attachment_task_unavailable");
    }
    const resources = [];
    const seen = new Set<string>();
    for (const requested of attachments) {
      if (seen.has(requested.relativePath)) throw new Error("duplicate_prompt_attachment");
      seen.add(requested.relativePath);
      const validated = await canonicalPromptAttachment(workspace.canonicalPath, requested.relativePath);
      resources.push(Object.freeze({
        name: validated.attachment.name,
        uri: validated.uri,
        size: validated.attachment.size,
        ...(validated.attachment.mimeType === undefined ? {} : { mimeType: validated.attachment.mimeType }),
      }));
    }
    return Object.freeze(resources);
  }

  async function signalRunCancellation(
    taskId: TaskId,
    runId: RunId,
    adapter: RuntimeAdapterPort,
    controller: RuntimeController,
    session: AcpV1AdapterSession,
  ): Promise<void> {
    await adapter.cancel(session).catch(() => undefined);
    await enqueueCommand(async () => {
      if (
        closed ||
        controller.adapter !== adapter ||
        controller.activeRunId !== runId
      ) return;
      const current = safeLoadRun(taskId, runId);
      if (current?.state !== "cancel_requested") return;
      clearCancelTimer(controller);
      const graceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
      controller.cancelTimer = setTimeout(() => {
        void enqueueCommand(async () => {
          if (closed || controller.adapter !== adapter) return;
          const latest = safeLoadRun(taskId, runId);
          if (latest?.state !== "cancel_requested") return;
          await adapter.close().catch(() => undefined);
        });
      }, graceMs);
      controller.cancelTimer.unref?.();
      await publish();
    });
  }

  reconcilePersistedRuntimes();
  for (const workspace of store.listWorkspaces({ includeArchived: true })) {
    for (const task of store.listTasks({ workspaceId: workspace.workspaceId, includeArchived: true })) {
      const mission = store.loadContinuousTask(task.taskId);
      if (mission?.status === "active") {
        store.updateContinuousTask({
          taskId: task.taskId,
          expectedRevision: mission.revision,
          status: "paused",
          stopReason: "desktop_restarted",
        });
      }
    }
  }
  discardStoredPristineTasks();
  const diagnosticsHydration = hydrateRuntimeIncidents().catch(() => undefined);

  const service: DesktopApplicationService = {
    bootstrap: async () => {
      await diagnosticsHydration;
      // PC-CONV-002: renderer reload loses its cache; restore its requested history once.
      // Normal publish() calls keep sending only the bounded live tail.
      const projection = buildBootstrap(true);
      for (const workspace of projection.workspaces.filter((candidate) => !candidate.archived)) {
        for (const task of workspace.tasks.filter((candidate) => !candidate.archived)) {
          scheduleQueuedDispatch(task.taskId);
          if (store.listQueuedTurns(task.taskId).length === 0) {
            scheduleContinuousDispatch(task.taskId);
          }
        }
      }
      return projection;
    },
    chooseWorkspace: async () => {
      assertOpen();
      const selected = await options.chooseWorkspace();
      if (selected === undefined) return buildBootstrap();
      const canonicalPath = await canonicalDirectory(selected);
      return enqueueCommand(async () => {
        assertOpen();
        const existing = store.listWorkspaces({ includeArchived: true, includeDeleted: true })
          .find((workspace) => workspace.canonicalPath === canonicalPath);
        if (existing === undefined) {
          store.createWorkspace({
            workspaceId: unique("workspace"),
            canonicalPath,
            displayName: basename(canonicalPath),
          });
        } else if (existing.disposition === "archived") {
          store.restoreWorkspace({
            workspaceId: existing.workspaceId,
            expectedRevision: existing.revision,
          });
        } else if (existing.disposition === "deleted") {
          store.reAddDeletedWorkspace({ workspaceId: existing.workspaceId, expectedRevision: existing.revision });
        }
        const selectedWorkspace = store.listWorkspaces({ includeArchived: true })
          .find((workspace) => workspace.canonicalPath === canonicalPath);
        if (selectedWorkspace !== undefined) {
          const settings = store.loadAppSettings();
          store.updateAppSettings({
            expectedRevision: settings.revision,
            lastWorkspaceId: selectedWorkspace.workspaceId,
          });
        }
        await publish();
        return buildBootstrap();
      });
    },
    choosePromptFiles: async (taskId): Promise<ChoosePromptFilesResponse> => {
      assertOpen();
      const task = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(task.workspaceId);
      if (task.disposition !== "active" || workspace.disposition !== "active") {
        throw new Error("prompt_attachment_task_unavailable");
      }
      const selected = await options.choosePromptFiles?.({
        workspacePath: workspace.canonicalPath,
        locale: store.loadAppSettings().locale,
      });
      if (selected === undefined || selected.length === 0) {
        return Object.freeze({ status: "cancelled" });
      }
      if (selected.length > GUILD_PROMPT_ATTACHMENT_LIMIT) {
        throw new Error("too_many_prompt_attachments");
      }
      const attachments = [];
      const seen = new Set<string>();
      for (const path of selected) {
        const validated = await canonicalPromptAttachment(workspace.canonicalPath, path);
        if (seen.has(validated.attachment.relativePath)) continue;
        seen.add(validated.attachment.relativePath);
        attachments.push(validated.attachment);
      }
      return Object.freeze({ status: "selected", attachments: Object.freeze(attachments) });
    },
    createTask: async (workspaceId) => enqueueCommand(async () => {
      assertOpen();
      const workspace = store.loadWorkspace(workspaceId);
      if (workspace.disposition !== "active") throw new Error("workspace_not_active");
      if (activeTaskId !== undefined) await discardPristineTask(activeTaskId);
      const taskId = id(parseTaskId, "task");
      store.createConversationTask({
        taskId,
        workspaceId,
        title: store.loadAppSettings().locale === "zh-CN" ? "新任务" : "New task",
        owningWindowId: PRIMARY_WINDOW_ID,
      });
      activeTaskId = taskId;
      conversationPageDepths.set(taskId, 1);
      persistTaskSelection(taskId);
      await publish();
      return taskView(taskId);
    }),
    openTask: async (taskId, sequence) => enqueueCommand(async () => {
      assertOpen();
      const metadata = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(metadata.workspaceId);
      if (metadata.disposition !== "active" || workspace.disposition !== "active") {
        throw new Error("task_not_active");
      }
      // D-046: restore enough history to include the exact search hit.
      if (sequence !== undefined) {
        const entries = allTaskConversationEntries(taskId);
        const index = entries.findIndex((entry) => entry.sequence === sequence);
        if (index < 0) throw new Error("search_message_unavailable");
        conversationPageDepths.set(taskId, Math.max(conversationPageDepths.get(taskId) ?? 1,
          Math.ceil((entries.length - index) / CONVERSATION_PAGE_SIZE)));
      }
      if (activeTaskId !== undefined && activeTaskId !== taskId) {
        await discardPristineTask(activeTaskId);
      }
      activeTaskId = taskId;
      if (!conversationPageDepths.has(taskId)) conversationPageDepths.set(taskId, 1);
      persistTaskSelection(taskId);
      await publish();
      scheduleQueuedDispatch(taskId);
      // The renderer may have evicted this task from its bounded cache.
      return taskView(taskId, conversationPageDepths.get(taskId) ?? 1);
    }),
    loadEarlierTimeline: async (taskId) => enqueueCommand(async () => {
      assertOpen();
      if (activeTaskId !== taskId) throw new Error("task_not_active");
      const currentDepth = conversationPageDepths.get(taskId) ?? 1;
      if (store.countConversationEntries(taskId) <= currentDepth * CONVERSATION_PAGE_SIZE) {
        return taskView(taskId, currentDepth);
      }
      const nextDepth = currentDepth + 1;
      conversationPageDepths.set(taskId, nextDepth);
      return taskView(taskId, nextDepth);
    }),
    loadSlashCommands: async (taskId) => {
      assertOpen();
      if (activeTaskId !== taskId) throw new Error("task_not_active");
      await ensureSession(taskId);
      return enqueueCommand(async () => {
        assertOpen();
        if (activeTaskId !== taskId) throw new Error("task_not_active");
        return taskView(taskId);
      });
    },
    forkTask: async (taskId, throughSequence) => enqueueCommand(async () => {
      assertOpen();
      const source = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(source.workspaceId);
      if (source.disposition !== "active" || workspace.disposition !== "active") {
        throw new Error("task_not_active");
      }
      const branchTaskId = id(parseTaskId, "task");
      const suffix = store.loadAppSettings().locale === "zh-CN" ? " · 分支" : " · Branch";
      const title = `${[...source.title].slice(0, Math.max(1, 512 - [...suffix].length)).join("")}${suffix}`;
      store.createConversationTask({
        taskId: branchTaskId,
        workspaceId: source.workspaceId,
        title,
        owningWindowId: PRIMARY_WINDOW_ID,
      });
      for (const entry of allTaskConversationEntries(taskId)) {
        if (throughSequence !== undefined && entry.sequence > throughSequence) continue;
        if (entry.status === "streaming" || entry.metadata["hidden"] === true) continue;
        if (entry.kind === "permission") continue;
        store.createConversationEntry({
          taskId: branchTaskId,
          entryId: unique(`branch-${entry.kind}`),
          kind: entry.kind,
          text: entry.text,
          metadata: entry.metadata,
          status: "complete",
        });
      }
      store.createConversationEntry({
        taskId: branchTaskId,
        entryId: unique("branch-notice"),
        kind: "notice",
        text: store.loadAppSettings().locale === "zh-CN"
          ? `已从“${source.title}”复制本地对话快照。此分支会启动新的官方 Grok 会话，不会冒充上游会话克隆。`
          : `Copied a local transcript snapshot from “${source.title}”. This branch starts a new official Grok session; it is not an upstream session clone.`,
        status: "complete",
      });
      activeTaskId = branchTaskId;
      conversationPageDepths.set(branchTaskId, 1);
      persistTaskSelection(branchTaskId);
      await publish();
      return taskView(branchTaskId);
    }),
    exportTask: async (taskId, format) => enqueueCommand(async () => {
      assertOpen();
      const task = store.loadTaskMetadata(taskId);
      if (task.disposition === "deleted") throw new Error("task_deleted");
      const workspace = store.loadWorkspace(task.workspaceId);
      if (workspace.disposition === "deleted") throw new Error("workspace_deleted");
      if (options.saveTaskExport === undefined) throw new Error("task_export_unavailable");
      const extension = format === "markdown" ? "md" : "json";
      const safeTitle = task.title.replace(/[\\/:*?"<>|\u0000-\u001F]/gu, "-").trim().slice(0, 80) || "Guild-conversation";
      const result = await options.saveTaskExport({
        suggestedFilename: `${safeTitle}.${extension}`,
        format,
        contents: exportConversation(format, {
          title: task.title,
          workspaceName: workspace.displayName,
          createdAtMs: task.createdAtMs,
          entries: allTaskConversationEntries(taskId),
        }),
      });
      return Object.freeze({ status: result });
    }),
    searchConversations: async (query) => enqueueCommand(async () => {
      assertOpen();
      const locale = store.loadAppSettings().locale;
      const results = [];
      for (const workspace of store.listWorkspaces({ includeArchived: true })) {
        if (workspace.disposition !== "active") continue;
        for (const task of store.listTasks({ workspaceId: workspace.workspaceId })) {
          for (const match of conversationMatches(allTaskConversationEntries(task.taskId), query, locale)) {
          results.push(Object.freeze({
            taskId: task.taskId,
            workspaceId: must(parseWorkspaceId(task.workspaceId)),
            taskTitle: task.title,
            workspaceName: workspace.displayName,
            ...match,
            updatedAtMs: task.lastActivityAtMs,
          }));
          if (results.length >= 50) break;
          }
          if (results.length >= 50) break;
        }
        if (results.length >= 50) break;
      }
      results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      return Object.freeze({ results: Object.freeze(results) });
    }),
    openTaskResource: async (taskId, action, requestedPath) => {
      assertOpen();
      const task = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(task.workspaceId);
      if (task.disposition === "deleted" || workspace.disposition !== "active") {
        throw new Error("task_resource_unavailable");
      }
      const workspacePath = await realpath(workspace.canonicalPath);
      if (action === "folder") {
        if (options.openWorkspaceFolder === undefined) throw new Error("workspace_folder_unavailable");
        await options.openWorkspaceFolder(workspacePath);
        return;
      }
      if (action === "terminal") {
        if (options.openWorkspaceTerminal === undefined) throw new Error("task_terminal_unavailable");
        await options.openWorkspaceTerminal(workspacePath);
        return;
      }
      if (requestedPath === undefined || options.openTaskFile === undefined) {
        throw new Error("task_file_unavailable");
      }
      const candidate = resolve(workspacePath, requestedPath);
      if (!isAbsolute(candidate)) throw new Error("task_file_outside_workspace");
      const canonical = await realpath(candidate);
      const within = relative(workspacePath, canonical);
      if (within === "" || within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
        throw new Error("task_file_outside_workspace");
      }
      const details = await stat(canonical);
      if (!details.isFile()) throw new Error("task_file_not_regular");
      await options.openTaskFile(canonical);
    },
    setSessionConfigOption: async (taskId, configId, value) => {
      assertOpen();
      const session = await ensureSession(taskId);
      return enqueueCommand(async () => {
        assertOpen();
        const controller = controllerFor(taskId);
        if (controller.session !== session || controller.adapter?.state !== "ready") {
          throw new Error("runtime_session_changed");
        }
        assertTaskInactive(taskId);
        const option = controller.sessionConfigOptions.find((candidate) => candidate.id === configId);
        if (
          option === undefined ||
          (option.type === "boolean" && typeof value !== "boolean") ||
          (option.type === "select" && typeof value !== "string")
        ) {
          throw new Error("session_config_option_unavailable");
        }
        if (option.type === "select") {
          const choices = option.choices.form === "flat"
            ? option.choices.options
            : option.choices.groups.flatMap((group) => group.options);
          if (typeof value !== "string" || !choices.some((choice) => choice.value === value)) {
            throw new Error("session_config_value_unavailable");
          }
        }
        controller.sessionConfigOptions = await controller.adapter.setConfigOption(session, configId, value);
        await publish();
        return taskView(taskId);
      });
    },
    updateWorkspace: async (workspaceId, action) => enqueueCommand(async () => {
      assertOpen();
      const workspace = store.loadWorkspace(workspaceId);
      if (action === "restore") {
        store.restoreWorkspace({ workspaceId, expectedRevision: workspace.revision });
        await publish();
        return buildBootstrap();
      }
      const tasks = store.listTasks({ workspaceId });
      for (const task of tasks) assertTaskInactive(task.taskId);
      await Promise.all(
        tasks.map(async (task) => {
          const controller = controllers.get(task.taskId);
          if (controller === undefined) return;
          await closeController(task.taskId, controller);
          controllers.delete(task.taskId);
        }),
      );
      if (action === "archive") {
        store.archiveWorkspace({ workspaceId, expectedRevision: workspace.revision });
      } else {
        store.deleteWorkspace({ workspaceId, expectedRevision: workspace.revision });
      }
      if (activeTaskId !== undefined) {
        const active = store.loadTaskMetadata(activeTaskId);
        if (active.workspaceId === workspaceId) activeTaskId = undefined;
      }
      await publish();
      return buildBootstrap();
    }),
    updateTask: async (request) => enqueueCommand(async () => {
      assertOpen();
      const { taskId, action } = request;
      const task = store.loadTaskMetadata(taskId);
      if (action === "restore") {
        const workspace = store.loadWorkspace(task.workspaceId);
        if (workspace.disposition !== "active") throw new Error("workspace_not_active");
        store.unarchiveTask({ taskId, expectedRevision: task.revision });
        await publish();
        return buildBootstrap();
      }
      if (action === "rename") {
        store.renameTask({
          taskId,
          expectedRevision: task.revision,
          title: request.title,
        });
        await publish();
        return buildBootstrap();
      }
      if (action === "pin" || action === "unpin") {
        store.setTaskPinned({
          taskId,
          expectedRevision: task.revision,
          pinned: action === "pin",
        });
        await publish();
        return buildBootstrap();
      }
      assertTaskInactive(taskId);
      const controller = controllers.get(taskId);
      if (controller !== undefined) {
        await closeController(taskId, controller);
        controllers.delete(taskId);
      }
      if (action === "archive") {
        store.archiveTask({ taskId, expectedRevision: task.revision });
      } else {
        store.deleteTask({ taskId, expectedRevision: task.revision });
      }
      if (activeTaskId === taskId) activeTaskId = undefined;
      await publish();
      return buildBootstrap();
    }),
    sendMessage: async (taskId, text, attachments = [], mode = "standard") => {
      assertOpen();
      if (managementOperationActive) throw new Error("grok_management_operation_active");
      if (mode === "continuous" && attachments.length > 0) {
        throw new Error("continuous_task_attachments_not_supported");
      }
      messageAdmissionsActive += 1;
      try {
        await enqueueCommand(async () => {
          if (!isUntitledNewTask(taskId)) return;
          const metadata = store.loadTaskMetadata(taskId);
          store.renameTask({
            taskId,
            expectedRevision: metadata.revision,
            title: deriveTaskTitle(text),
          });
          await publish();
        });
        if (mode === "continuous") {
          await enqueueCommand(async () => {
            const current = store.restoreTask(taskId).currentRun;
            if (
              (current !== undefined && !TERMINAL_RUN_STATES.has(current.state)) ||
              store.listQueuedTurns(taskId).length > 0 ||
              controllers.get(taskId)?.promptRunId !== undefined
            ) {
              throw new Error("continuous_task_requires_idle_task");
            }
            store.startContinuousTask({ taskId, objective: text });
            const draft = store.loadDraft(taskId);
            if (draft !== undefined && draft.text.trim() === text) {
              store.clearDraft({ taskId, expectedRevision: draft.revision });
            }
            await publish();
          });
          await scheduleContinuousDispatch(taskId);
          const mission = store.loadContinuousTask(taskId);
          if (mission?.lastRunId === undefined) {
            throw new Error("continuous_task_failed_to_start");
          }
          return Object.freeze({ status: "started" as const, runId: mission.lastRunId });
        }
        for (let attempt = 0; attempt < 6; attempt += 1) {
          await ensureSession(taskId);
          const result = await enqueueCommand(async () => {
          assertOpen();
          const controller = controllerFor(taskId);
          const session = controller.session;
          if (session === undefined || controller.adapter?.state !== "ready") {
            return Object.freeze({ status: "retry_session" as const });
          }
          const restored = store.restoreTask(taskId);
          if (
            restored.currentRun !== undefined &&
            !TERMINAL_RUN_STATES.has(restored.currentRun.state)
          ) {
            if (attachments.length > 0) {
              throw new Error("prompt_attachments_cannot_queue");
            }
            const queueId = unique("queue");
            store.enqueueQueuedTurn({
              taskId,
              queueId,
              intendedSessionId: must(parseSessionId(session.sessionId)),
              reservedRunId: id(parseRunId, "run"),
              entryId: unique("user"),
              text,
            });
            const queuedDraft = store.loadDraft(taskId);
            if (queuedDraft !== undefined && queuedDraft.text.trim() === text) {
              store.clearDraft({ taskId, expectedRevision: queuedDraft.revision });
            }
            await publish();
            return Object.freeze({ status: "queued" as const, queueId });
          }
          if (controller.promptRunId !== undefined) {
            if (controller.promptOperation === undefined) {
              throw new Error("runtime_prompt_settlement_missing");
            }
            return Object.freeze({
              status: "retry_prompt" as const,
              operation: controller.promptOperation,
            });
          }
          if (store.listQueuedTurns(taskId).length > 0) {
            return Object.freeze({ status: "retry_queue" as const });
          }
          const resources = await validatePromptAttachments(taskId, attachments);
          const metadata = store.loadTaskMetadata(taskId);
          const hasConversation = store.listConversationEntries({ taskId, limit: 1 }).length > 0;
          if (
            !hasConversation &&
            (metadata.title === "新任务" || metadata.title === "New task")
          ) {
            store.renameTask({
              taskId,
              expectedRevision: metadata.revision,
              title: deriveTaskTitle(text),
            });
          }
          const prompt = prepareRuntimePrompt(taskId, session, text);
          const runId = id(parseRunId, "run");
          const sessionId = must(parseSessionId(session.sessionId));
          const adapterEpoch = must(parseAdapterEpoch(session.adapterEpoch));
          store.createRun({ taskId, runId });
          requireRun(store.applyRun({
            taskId,
            runId,
            event: {
              type: "scheduler_dispatch",
              sessionId,
              adapterEpoch,
              idempotencyKey: key("scheduler-dispatch"),
            },
          }));
          store.createConversationEntry({
            taskId,
            runId,
            entryId: unique("user"),
            kind: "user",
            text,
            status: "complete",
          });
          const draft = store.loadDraft(taskId);
          if (draft !== undefined && draft.text.trim() === text) {
            store.clearDraft({ taskId, expectedRevision: draft.revision });
          }
          controller.activeRunId = runId;
          await publish();
          launchPrompt(taskId, controller, session, prompt, runId, resources);
          return Object.freeze({ status: "started" as const, runId });
          });
          if (result.status === "retry_prompt") {
          const settleMs = options.promptSettleMs ?? DEFAULT_PROMPT_SETTLE_MS;
          const settled = await Promise.race([
            result.operation.then(() => "settled" as const),
            new Promise<"timeout">((resolve) => {
              const timer = setTimeout(() => resolve("timeout"), settleMs);
              timer.unref?.();
            }),
          ]);
          if (settled === "timeout") {
            await enqueueCommand(async () => {
              const controller = controllerFor(taskId);
              if (controller.promptRunId === undefined) return;
              const run = store.restoreTask(taskId).currentRun;
              if (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) return;
              controller.promptRunId = undefined;
              controller.promptOperation = undefined;
              controller.promptReplayProof = undefined;
              await controller.adapter?.close().catch(() => undefined);
            });
          }
            continue;
          }
          if (result.status === "retry_queue") {
            await scheduleQueuedDispatch(taskId);
            continue;
          }
          if (result.status !== "retry_session") return result;
        }
        throw new Error("runtime_session_changed_during_send");
      } finally {
        messageAdmissionsActive -= 1;
      }
    },
    setContinuousTask: async (taskId, action) => {
      await enqueueCommand(async () => {
        assertOpen();
        const mission = store.loadContinuousTask(taskId);
        if (mission === undefined) throw new Error("continuous_task_not_found");
        if (action === "pause") {
          if (mission.status === "active") {
            store.updateContinuousTask({
              taskId,
              expectedRevision: mission.revision,
              status: "paused",
              stopReason: "paused_by_user",
            });
          }
        } else if (action === "stop") {
          if (mission.status !== "stopped" && mission.status !== "completed") {
            store.updateContinuousTask({
              taskId,
              expectedRevision: mission.revision,
              status: "stopped",
              stopReason: "stopped_by_user",
            });
          }
        } else {
          if (mission.status === "completed" || mission.status === "stopped") {
            throw new Error("continuous_task_cannot_resume");
          }
          if (mission.status !== "active") {
            store.updateContinuousTask({
              taskId,
              expectedRevision: mission.revision,
              status: "active",
              stopReason: null,
            });
          }
        }
        await publish();
      });
      if (action === "resume") await scheduleContinuousDispatch(taskId);
      return taskView(taskId, conversationPageDepths.get(taskId) ?? 1);
    },
    prioritizeQueuedTurn: async (taskId, queueId) => enqueueCommand(async () => {
      assertOpen();
      store.prioritizeQueuedTurn({ taskId, queueId });
      await publish();
    }),
    preemptQueuedTurn: async (taskId, queueId) => {
      const preemption = await enqueueCommand(async () => {
        assertOpen();
        store.prioritizeQueuedTurn({ taskId, queueId });
        const run = store.restoreTask(taskId).currentRun;
        if (run === undefined || TERMINAL_RUN_STATES.has(run.state)) {
          await publish();
          return Object.freeze({ status: "dispatch" as const });
        }
        if (run.state === "cancel_requested") {
          await publish();
          return Object.freeze({ status: "pending" as const });
        }
        requireRun(store.applyRun({
          taskId,
          runId: run.runId,
          event: { type: "user_cancel", idempotencyKey: key("queue-preempt-cancel") },
        }));
        const controller = controllerFor(taskId);
        clearPromptSilenceTimer(controller);
        await publish();
        if (
          controller.activeRunId !== run.runId ||
          controller.adapter === undefined ||
          controller.session === undefined
        ) {
          return Object.freeze({ status: "pending" as const });
        }
        return Object.freeze({
          status: "cancel" as const,
          runId: run.runId,
          adapter: controller.adapter,
          controller,
          session: controller.session,
        });
      });
      if (preemption.status === "dispatch") {
        await scheduleQueuedDispatch(taskId);
        return;
      }
      if (preemption.status === "pending") return;
      await signalRunCancellation(
        taskId,
        preemption.runId,
        preemption.adapter,
        preemption.controller,
        preemption.session,
      );
    },
    cancelQueuedTurn: async (taskId, queueId) => enqueueCommand(async () => {
      assertOpen();
      store.cancelQueuedTurn({ taskId, queueId });
      await publish();
    }),
    cancelRun: async (taskId, runId) => {
      const cancellation = await enqueueCommand(async () => {
        assertOpen();
        const run = store.loadRun(taskId, runId);
        if (TERMINAL_RUN_STATES.has(run.state) || run.state === "cancel_requested") return undefined;
        requireRun(store.applyRun({
          taskId,
          runId,
          event: { type: "user_cancel", idempotencyKey: key("user-cancel") },
        }));
        const mission = store.loadContinuousTask(taskId);
        if (mission?.lastRunId === runId && mission.status === "active") {
          store.updateContinuousTask({
            taskId,
            expectedRevision: mission.revision,
            status: "paused",
            stopReason: "current_round_cancelled_by_user",
          });
        }
        const controller = controllerFor(taskId);
        clearPromptSilenceTimer(controller);
        await publish();
        if (
          controller.activeRunId !== runId ||
          controller.adapter === undefined ||
          controller.session === undefined
        ) return undefined;
        return Object.freeze({
          adapter: controller.adapter,
          controller,
          session: controller.session,
        });
      });
      if (cancellation === undefined) return;
      await signalRunCancellation(
        taskId,
        runId,
        cancellation.adapter,
        cancellation.controller,
        cancellation.session,
      );
    },
    decidePermission: async (input) => enqueueCommand(async () => {
      assertOpen();
      const controller = controllerFor(input.taskId);
      const pending = controller.pendingPermissions.get(input.permissionId);
      if (
        pending === undefined ||
        pending.identity.runId !== input.runId ||
        pending.identity.taskId !== input.taskId
      ) {
        throw new Error("permission_not_pending");
      }
      pending.decision.resolve(input.decision);
      await pending.prepared.promise;
    }),
    setDraft: async (taskId, text) => enqueueCommand(async () => {
      assertOpen();
      const current = store.loadDraft(taskId);
      if (text.length === 0) {
        if (current !== undefined) {
          store.clearDraft({ taskId, expectedRevision: current.revision });
        }
        return;
      }
      store.saveDraft({
        taskId,
        expectedRevision: current?.revision ?? 0,
        text,
      });
    }),
    authorizeSessionReplacement: async (taskId) => {
      await enqueueCommand(async () => {
        assertOpen();
        const metadata = store.loadTaskMetadata(taskId);
        const workspace = store.loadWorkspace(metadata.workspaceId);
        if (metadata.disposition !== "active" || workspace.disposition !== "active") {
          throw new Error("task_not_writable");
        }
        const binding = store.loadSessionBinding(taskId);
        if (binding.state !== "broken") throw new Error("session_replacement_not_required");
        store.createConversationEntry({
          taskId,
          entryId: unique("session-replacement-authorized"),
          kind: "notice",
          text: "Guild replacement-session recovery authorized.",
          metadata: {
            hidden: true,
            replacementRecoveryAuthorized: true,
            recoveryHandoffRequired: true,
            ...(binding.retainedSessionId === undefined
              ? {}
              : { replacedSessionId: binding.retainedSessionId }),
          },
          status: "complete",
        });
        requireBinding(store.applySessionBinding({
          taskId,
          event: {
            type: "authorize_replacement",
            idempotencyKey: key("session-replacement-user-authorized"),
          },
        }));
        await publish();
      });
      const session = await ensureSession(taskId);
      return enqueueCommand(async () => {
        assertOpen();
        await dispatchQueuedWithSession(taskId, session);
        await publish();
        return taskView(taskId);
      });
    },
    refreshUsage: async () => {
      assertOpen();
      const fresh = usageSnapshot !== undefined && Date.now() - usageFetchedAtMs < 30_000;
      if (fresh) return buildBootstrap();
      if (usageOperation === undefined) {
        usageLoading = true;
        const abortController = new AbortController();
        usageAbortController = abortController;
        const operation = (async () => {
          await publish();
          let next: AcpV1OfficialBillingSnapshot | undefined;
          try {
            next = await usageFetcher(abortController.signal);
          } catch {
            next = undefined;
          }
          await enqueueCommand(async () => {
            if (closed || closing) return;
            usageSnapshot = next;
            usageFetchedAtMs = next === undefined ? 0 : Date.now();
            usageLoading = false;
            await publish();
          });
        })();
        usageOperation = operation.finally(() => {
          usageOperation = undefined;
          if (usageAbortController === abortController) usageAbortController = undefined;
          if (!closed && !closing && usageLoading) {
            usageLoading = false;
            void publish();
          }
        });
      }
      await usageOperation;
      return buildBootstrap();
    },
    openExternal: async (url) => {
      assertOpen();
      const parsed = canonicalGuildExternalUrl(url);
      if (options.openExternal === undefined) return;
      await options.openExternal(parsed);
    },
    setLocale: async (locale: GuildLocale) => enqueueCommand(async () => {
      assertOpen();
      const settings = store.loadAppSettings();
      store.updateAppSettings({ expectedRevision: settings.revision, locale });
      await publish();
      return buildBootstrap();
    }),
    setRuntimeSettings: async (
      model: GuildGrokModel,
      reasoningEffort: GuildGrokReasoningEffort,
      permissionMode: GuildGrokPermissionMode,
      startup: GuildGrokStartupSettings,
    ) => enqueueCommand(async () => {
      assertOpen();
      if (!supportsGuildGrokReasoningEffort(model, reasoningEffort)) {
        throw new Error("runtime_settings_change_unavailable");
      }
      const currentSettings = store.loadAppSettings();
      if (
        currentSettings.grokModel === model &&
        currentSettings.reasoningEffort === reasoningEffort &&
        currentSettings.permissionMode === permissionMode &&
        currentSettings.startup.webSearchEnabled === startup.webSearchEnabled &&
        currentSettings.startup.planEnabled === startup.planEnabled &&
        currentSettings.startup.subagentsEnabled === startup.subagentsEnabled &&
        currentSettings.startup.maxTurns === startup.maxTurns
      ) {
        return buildBootstrap();
      }
      if (!runtimeSettingsCanChange()) throw new Error("runtime_settings_change_unavailable");
      runtimeGeneration += 1;
      const closes = [...controllers.values()]
        .map((controller) => controller.adapter)
        .filter((adapter): adapter is RuntimeAdapterPort => adapter !== undefined)
        .map((adapter) => adapter.close());
      const closedAdapters = await Promise.allSettled(closes);
      if (closedAdapters.some((result) => result.status === "rejected")) {
        throw new Error("runtime_settings_close_failed");
      }
      const settings = store.loadAppSettings();
      store.updateAppSettings({
        expectedRevision: settings.revision,
        grokModel: model,
        reasoningEffort,
        permissionMode,
        startup,
      });
      await publish();
      return buildBootstrap();
    }),
    setSidebarWidth: async (width) => enqueueCommand(async () => {
      assertOpen();
      const settings = store.loadAppSettings();
      store.updateAppSettings({ expectedRevision: settings.revision, sidebarWidth: width });
      await publish();
    }),
    chooseAvatar: async () => {
      assertOpen();
      const selected = await options.chooseAvatarFile?.();
      if (selected === undefined) return Object.freeze({ status: "cancelled" as const });
      try {
        const imported = await importAvatarFile(selected, mediaRoot);
        const previewToken = randomUUID();
        avatarPreviews.set(previewToken, imported.filename);
        return Object.freeze({
          status: "selected" as const,
          previewToken,
          grantUrl: `guild-media://media/${imported.filename}`,
        });
      } catch (cause: unknown) {
        return Object.freeze({
          status: "rejected" as const,
          reason: cause instanceof GuildAvatarError ? cause.code : "invalid_image",
        });
      }
    },
    saveProfile: async (nickname, avatar) => enqueueCommand(async () => {
      assertOpen();
      const parsedNickname = parseGuildNickname(nickname);
      const settings = store.loadAppSettings();
      let nextAvatar = settings.avatarFilename;
      if (avatar === "reset") {
        if (settings.avatarFilename !== undefined) {
          await unlink(join(mediaRoot, settings.avatarFilename)).catch(() => undefined);
        }
        nextAvatar = undefined;
      } else if (avatar !== "keep") {
        const filename = avatarPreviews.get(avatar.previewToken);
        if (filename === undefined) throw new Error("avatar_preview_missing");
        if (settings.avatarFilename !== undefined && settings.avatarFilename !== filename) {
          await unlink(join(mediaRoot, settings.avatarFilename)).catch(() => undefined);
        }
        nextAvatar = filename;
        avatarPreviews.delete(avatar.previewToken);
      }
      store.updateAppSettings({
        expectedRevision: settings.revision,
        nickname: parsedNickname,
        avatarFilename: nextAvatar === undefined ? null : nextAvatar,
      });
      await publish();
      return buildBootstrap();
    }),
    setGeneralSettings: async (
      restoreLastTask,
      newTaskWorkspaceMode,
      browserSyncEnabled,
      taskNotificationsEnabled,
    ) => enqueueCommand(async () => {
      assertOpen();
      const mode = parseGuildNewTaskWorkspaceMode(newTaskWorkspaceMode);
      const settings = store.loadAppSettings();
      store.updateAppSettings({
        expectedRevision: settings.revision,
        restoreLastTask,
        newTaskWorkspaceMode: mode,
        browserSyncEnabled,
        taskNotificationsEnabled,
      });
      allowAutoSelectActiveTask = restoreLastTask;
      await publish();
      return buildBootstrap();
    }),
    openUserData: async () => {
      assertOpen();
      if (options.openUserData === undefined) return;
      await options.openUserData();
    },
    backupUserData: async () => {
      assertOpen();
      const destination = await options.chooseUserDataBackupPath?.();
      if (destination === undefined) return Object.freeze({ status: "cancelled" as const });
      assertOpen();
      assertMaintenanceIdle();
      maintenance = true;
      try {
        await drainForMaintenance();
        if (!isAbsolute(destination)) throw new Error("invalid_backup_path");
        await mkdir(destination, { recursive: false, mode: 0o700 });
        store.verifyIntegrity();
        store.backupTo(join(destination, "guild.sqlite3"));
        await copyDirectoryIfPresent(mediaRoot, join(destination, "media"));
        await copyDirectoryIfPresent(diagnosticsRoot, join(destination, "diagnostics"));
        await sealBackup(destination, options.appVersion);
        return Object.freeze({ status: "saved" as const, path: destination });
      } finally {
        maintenance = false;
        await publish();
      }
    },
    restoreUserData: async () => {
      assertOpen();
      if (options.requestRestoreRestart === undefined) throw new Error("restore_unavailable");
      const source = await options.chooseUserDataRestorePath?.();
      if (source === undefined) return Object.freeze({ status: "cancelled" as const });
      assertOpen();
      assertMaintenanceIdle();
      maintenance = true;
      try {
        await drainForMaintenance();
        const stagedRoot = await stageBackup(source, dirname(options.databasePath));
        options.requestRestoreRestart(stagedRoot);
        return Object.freeze({ status: "restarting" as const });
      } catch (error) {
        maintenance = false;
        await publish().catch(() => undefined);
        throw error;
      }
    },
    openRuntimeDiagnostics: async () => {
      assertOpen();
      if (options.openRuntimeDiagnostics === undefined) return;
      await options.openRuntimeDiagnostics();
    },
    runGrokManagement: async (request) => {
      assertOpen();
      const managementCommand = buildGrokManagementCommand(request);
      if (managementOperationActive) throw new Error("grok_management_operation_active");
      if (!runtimeSettingsCanChange()) throw new Error("grok_management_change_unavailable");
      const selectedTaskId = request.taskId ?? activeTaskId;
      if (selectedTaskId === undefined) throw new Error("grok_management_workspace_required");
      const workingDirectory = store.loadWorkspace(store.loadTaskMetadata(selectedTaskId).workspaceId).canonicalPath;
      managementOperationActive = true;
      const abortController = new AbortController();
      managementAbortController = abortController;
      managementProgress = Object.freeze({
        action: request.action,
        commandLabel: managementCommand.commandLabel,
        startedAtIso: new Date().toISOString(),
        output: "",
      });
      void publish().catch(() => undefined);
      const operation = (async () => {
        await assertWorkspaceFolderExists(workingDirectory);
        await Promise.all(
          [...controllers.entries()].map(async ([taskId, controller]) => {
            try {
              await closeController(taskId, controller, true);
            } finally {
              // A management command must never share an official Grok process
              // with a retained ACP controller, even when teardown fails.
              controller.adapter = undefined;
              controller.session = undefined;
              controller.adapterEpoch = undefined;
              controllers.delete(taskId);
            }
          }),
        );
        return managementRunner({
          request,
          workingDirectory,
          signal: abortController.signal,
          onOutput: (output) => {
            if (managementProgress?.output === output) return;
            managementProgress = Object.freeze({
              action: request.action,
              commandLabel: managementCommand.commandLabel,
              startedAtIso: managementProgress?.startedAtIso ?? new Date().toISOString(),
              output,
            });
            void publish().catch(() => undefined);
          },
        });
      })();
      managementOperation = operation;
      try {
        return await operation;
      } finally {
        if (managementOperation === operation) managementOperation = undefined;
        if (managementAbortController === abortController) managementAbortController = undefined;
        managementOperationActive = false;
        managementProgress = undefined;
        await publish().catch(() => undefined);
      }
    },
    handleLifecycleEvent: async (event) => {
      if (maintenance) return;
      if (event === "resume") runtimeGeneration += 1;
      return enqueueCommand(async () => {
        assertOpen();
        if (event === "suspend" || event === "resume") {
          await diagnosticLog.append(Object.freeze({
            schemaVersion: 1,
            occurredAtIso: new Date().toISOString(),
            category: "recovery",
            event: event === "suspend" ? "os_suspend" : "os_resume",
            reason: "system_power_event",
          })).catch(() => undefined);
          for (const controller of controllers.values()) clearPromptSilenceTimer(controller);
        }
        for (const workspace of store.listWorkspaces({ includeArchived: true })) {
          for (const task of store.listTasks({
            workspaceId: workspace.workspaceId,
            includeArchived: true,
          })) {
            const run = store.restoreTask(task.taskId).currentRun;
            if (run === undefined || TERMINAL_RUN_STATES.has(run.state)) continue;
            store.applyRun({
              taskId: task.taskId,
              runId: run.runId,
              event: { type: event === "suspend" ? "os_suspend" : event === "resume" ? "os_resume" : "renderer_reload" },
            });
          }
        }
        if (event === "resume") {
          await Promise.allSettled(
            [...controllers.values()].map((controller) => controller.adapter?.close()),
          );
        }
        await publish();
        if (event === "resume") {
          for (const workspace of store.listWorkspaces()) {
            for (const task of store.listTasks({ workspaceId: workspace.workspaceId })) {
              scheduleQueuedDispatch(task.taskId);
            }
          }
        }
      });
    },
    subscribe: (listener) => {
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => {
      if (closed || closing) return;
      closing = true;
      usageAbortController?.abort(new Error("desktop_service_closed"));
      managementAbortController?.abort(new Error("desktop_service_closed"));
      for (const controller of controllers.values()) clearPromptSilenceTimer(controller);
      await Promise.allSettled(managementOperation === undefined ? [] : [managementOperation]);
      const adapterClosures = await Promise.allSettled(
        [...controllers.values()]
          .map((controller) => controller.adapter)
          .filter((adapter): adapter is RuntimeAdapterPort => adapter !== undefined)
          .map((adapter) => adapter.close()),
      );
      if (maintenance && adapterClosures.some((result) => result.status === "rejected")) {
        throw new Error("restore_adapter_close_failed");
      }
      await commandTail;
      await Promise.allSettled(usageOperation === undefined ? [] : [usageOperation]);
      await Promise.allSettled(
        [...controllers.values()]
          .map((controller) => controller.startOperation)
          .filter((operation): operation is Promise<AcpV1AdapterSession> => operation !== undefined),
      );
      await commandTail;
      const controllerClosures = await Promise.allSettled(
        [...controllers.entries()].map(([taskId, controller]) => closeController(taskId, controller)),
      );
      if (maintenance && controllerClosures.some((result) => result.status === "rejected")) {
        throw new Error("restore_controller_close_failed");
      }
      await streamPublishOperation?.catch(() => undefined);
      if (maintenance) await diagnosticLog.flush();
      else await diagnosticLog.flush().catch(() => undefined);
      listeners.clear();
      store.close();
      closed = true;
      closing = false;
    },
  };

  return Object.freeze(service);
}

function emptyReplayTurn(): ReplayTurnSnapshot {
  return {
    user: "",
    hasUserChunk: false,
    userMessageId: undefined,
    assistant: "",
    thought: "",
    plan: undefined,
    tools: new Map(),
    media: [],
    order: [],
  };
}

function replayTurnsFromUpdates(
  updates: readonly AcpV1DecodedUpdate[],
): readonly ReplayTurnSnapshot[] {
  const turns: ReplayTurnSnapshot[] = [];
  let current: ReplayTurnSnapshot | undefined;
  const requireCurrent = (): ReplayTurnSnapshot => {
    if (current === undefined) throw new Error("session_load_replay_missing_user_anchor");
    return current;
  };
  for (const update of updates) {
    if (update.type === "ignored_extension" || update.type === "session_context") continue;
    if (update.type === "unsupported_content") {
      throw new Error("session_load_replay_unsupported_content");
    }
    if (update.type === "media_content") {
      const turn = requireCurrent();
      const medium = replayMediaKey({
        ...update,
        mediaSha256: sha256Bytes(Buffer.from(update.base64Data, "base64")),
      });
      turn.media.push(medium);
      appendReplayOrderSegment(turn.order, `media:${medium}`);
      continue;
    }
    const payload = update.payload;
    if (payload.type === "permission_request" || payload.type === "prompt_terminal") {
      throw new Error("session_load_replay_side_effect_event");
    }
    if (payload.type === "user_text_chunk") {
      if (current === undefined || replayTurnHasResponse(current)) {
        current = emptyReplayTurn();
        turns.push(current);
      } else if (current.hasUserChunk) {
        const currentMessageId = current.userMessageId;
        const nextMessageId = payload.messageId;
        if (
          currentMessageId === undefined || currentMessageId === null ||
          nextMessageId === undefined || nextMessageId === null
        ) {
          throw new Error("session_load_replay_user_boundary_ambiguous");
        }
        if (nextMessageId !== currentMessageId) {
          current = emptyReplayTurn();
          turns.push(current);
        }
      }
      current.user += payload.text;
      current.hasUserChunk = true;
      if (current.userMessageId === undefined) current.userMessageId = payload.messageId;
      continue;
    }
    const turn = requireCurrent();
    if (payload.type === "agent_text_chunk") {
      appendReplayOrderSegment(turn.order, "assistant");
      turn.assistant += payload.text;
    } else if (payload.type === "agent_thought_chunk") {
      appendReplayOrderSegment(turn.order, "thought");
      turn.thought += payload.text;
    } else if (payload.type === "tool_call_create" || payload.type === "tool_call_update") {
      const toolCallKey = persistedToolCallKey(payload.toolCallId);
      const previous = turn.tools.get(toolCallKey);
      if (payload.type === "tool_call_update" && previous === undefined) {
        throw new Error("session_load_replay_tool_update_without_create");
      }
      const snapshot = {
        title: payload.title ?? previous?.title ?? "Tool",
        kind: payload.kind ?? previous?.kind ?? "other",
        status: payload.status ?? previous?.status ?? "pending",
        content: payload.content ?? previous?.content ?? Object.freeze([]),
        locations: payload.locations ?? previous?.locations ?? Object.freeze([]),
        replayProofUnavailable:
          payload.replayProofUnavailable === true || previous?.replayProofUnavailable === true,
      };
      turn.tools.set(toolCallKey, Object.freeze({
        ...snapshot,
        digest: replayToolSnapshotSha256(snapshot),
      }));
      appendReplayOrderSegment(turn.order, toolReplayOrderToken(payload.toolCallId));
    } else if (payload.type === "plan") {
      turn.plan = sha256Text(canonicalReplayJson(payload.entries));
      appendReplayOrderSegment(turn.order, "plan");
    }
  }
  if (turns.some((turn) => turn.user.length === 0)) {
    throw new Error("session_load_replay_empty_user_anchor");
  }
  return Object.freeze(turns);
}

function replayTurnHasResponse(turn: ReplayTurnSnapshot): boolean {
  return turn.assistant.length > 0 ||
    turn.thought.length > 0 ||
    turn.plan !== undefined ||
    turn.tools.size > 0 ||
    turn.media.length > 0;
}

function replayTurnMatches(
  local: LocalReplayTurn,
  replay: ReplayTurnSnapshot,
  _allowUncertainTail: boolean,
): boolean {
  if (!replayUserMatches(local, replay.user)) return false;
  if (local.assistant !== replay.assistant || local.thought !== replay.thought) return false;
  if ((local.plan === undefined) !== (replay.plan === undefined)) return false;
  if (
    local.plan !== undefined &&
    replay.plan !== undefined &&
    local.plan !== replay.plan
  ) return false;
  const localTools = [...local.tools.entries()];
  const replayTools = [...replay.tools.entries()];
  if (localTools.length !== replayTools.length) return false;
  for (let index = 0; index < localTools.length; index += 1) {
    const [localToolCallId, localTool] = localTools[index]!;
    const [replayToolCallId, replayTool] = replayTools[index]!;
    if (
      localToolCallId !== replayToolCallId ||
      !replayToolSnapshotsEqual(localTool, replayTool, false)
    ) return false;
  }
  return canonicalReplayJson(local.media) === canonicalReplayJson(replay.media) &&
    canonicalReplayJson(local.order) === canonicalReplayJson(replay.order);
}

function boundedPlanDisplayText(entries: readonly Readonly<{ content: string }>[]): string {
  let text = "";
  for (const entry of entries) {
    const separator = text.length === 0 ? "" : "\n";
    const available = PLAN_DISPLAY_MAX_CHARS - text.length - separator.length;
    if (available <= 0) break;
    text += separator + entry.content.slice(0, available);
    if (entry.content.length > available) break;
  }
  return text;
}

function appendReplayOrderSegment(order: string[], token: string): void {
  if (order.at(-1) !== token) order.push(token);
}

function replayUserMatches(local: LocalReplayTurn, replay: string): boolean {
  const isRecoveryCapsule = replay.startsWith("[Guild replacement-session recovery context]\n");
  if (
    local.outboundPromptProofVersion !== 2 ||
    local.outboundPromptSha256 === undefined ||
    local.outboundPromptHadResources
  ) return false;
  if (local.outboundPromptRecoveryCapsule !== isRecoveryCapsule) return false;
  return local.outboundPromptSha256 === outboundPromptSha256(replay, Object.freeze([]));
}

function replayToolSnapshotsEqual(
  local: ReplayToolSnapshot,
  replay: ReplayToolSnapshot,
  _ignoreLocalizedTitle: boolean,
): boolean {
  return !local.replayProofUnavailable &&
    !replay.replayProofUnavailable &&
    local.digest === replay.digest;
}

function replayToolSnapshotSha256(input: Readonly<{
  title: string;
  kind: AcpToolKind;
  status: AcpToolStatus;
  content: readonly RuntimeToolContent[];
  locations: readonly RuntimeToolLocation[];
}>): string {
  return sha256Text(canonicalReplayJson({
    title: input.title,
    kind: input.kind,
    status: input.status,
    content: input.content,
    locations: input.locations,
  }));
}

function persistedToolCallKey(toolCallId: string): string {
  return toolIdentityKey(toolCallId);
}

function boundedToolDisplayTitle(title: string): string {
  return title.slice(0, 4_096);
}

function boundedToolDisplayCollection<T>(items: readonly T[], maxBytes: number): readonly T[] {
  return Buffer.byteLength(JSON.stringify(items), "utf8") <= maxBytes
    ? Object.freeze([...items])
    : Object.freeze([]);
}

function boundedTimelineToolContent(
  items: readonly TimelineToolContent[],
  maxBytes: number,
): readonly TimelineToolContent[] {
  const result: TimelineToolContent[] = [];
  let mediaCount = 0;
  for (const item of items) {
    if (item.type === "media") {
      if (mediaCount < 8) {
        result.push(item);
        mediaCount += 1;
      }
      continue;
    }
    const candidate = [...result, item];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxBytes) result.push(item);
  }
  return Object.freeze(result);
}

function canonicalReplayJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReplayJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalReplayJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function outboundPromptSha256(
  text: string,
  resources: readonly Readonly<{
    name: string;
    uri: string;
    mimeType?: string;
    size: number;
  }>[],
): string {
  return sha256Text(canonicalReplayJson({
    text,
    resources: resources.map((resource) => ({
      name: resource.name,
      uri: resource.uri,
      mimeType: resource.mimeType ?? null,
      size: resource.size,
    })),
  }));
}

function replayOrderToken(payload: RuntimeTurnPayload): string | undefined {
  if (payload.type === "agent_text_chunk") return "assistant";
  if (payload.type === "agent_thought_chunk") return "thought";
  if (payload.type === "tool_call_create" || payload.type === "tool_call_update") {
    return toolReplayOrderToken(payload.toolCallId);
  }
  if (payload.type === "plan") return "plan";
  if (payload.type === "user_text_chunk") return undefined;
  throw new Error("replay_order_side_effect_event");
}

function toolReplayOrderToken(toolCallId: string): string {
  return toolIdentityKey(toolCallId);
}

function toolIdentityKey(toolCallId: string): string {
  // Hash the canonical JSON spelling, rather than the JavaScript string bytes,
  // so distinct unpaired UTF-16 surrogates cannot both normalize to U+FFFD.
  // Every official ID enters the same private namespace; a raw ID that happens
  // to resemble one of our synthetic keys therefore cannot alias another tool.
  return `tool-id-sha256:${sha256Text(canonicalReplayJson({
    kind: "guild-tool-call-id-v1",
    value: toolCallId,
  }))}`;
}

function replayMediaKey(input: Readonly<{
  discriminator: "agent_message_chunk" | "user_message_chunk";
  mediaType: "image" | "audio";
  mimeType: string;
  mediaSha256: string;
}>): string {
  return canonicalReplayJson({
    discriminator: input.discriminator,
    mediaType: input.mediaType,
    mimeType: input.mimeType,
    mediaSha256: input.mediaSha256,
  });
}

function activityForToolKind(kind: AcpToolKind): GuildTaskActivity {
  switch (kind) {
    case "read": return "reading";
    case "edit": return "editing";
    case "delete": return "deleting";
    case "move": return "moving";
    case "search": return "searching";
    case "execute": return "executing";
    case "think": return "thinking";
    case "fetch": return "fetching";
    case "switch_mode": return "switching_mode";
    case "other": return "working";
  }
}

function transportInterruptionMessage(
  locale: GuildLocale,
  diagnostic: AcpV1AdapterInterruptionDiagnostic,
): string {
  const evidence = diagnostic.signal !== undefined && diagnostic.signal !== null
    ? (locale === "zh-CN" ? `（信号 ${diagnostic.signal}）` : ` (signal ${diagnostic.signal})`)
    : typeof diagnostic.exitCode === "number"
      ? (locale === "zh-CN" ? `（退出码 ${diagnostic.exitCode}）` : ` (exit code ${diagnostic.exitCode})`)
      : "";
  return locale === "zh-CN"
    ? `Grok 运行连接中断${evidence}。Guild 正在恢复原会话；为避免重复修改，不会自动重发这条指令。诊断详情已写入本地日志。`
    : `The Grok runtime connection was interrupted${evidence}. Guild is restoring the original session and will not resend this instruction automatically, avoiding duplicate changes. Diagnostic details were written to the local log.`;
}

async function createProductionRuntime(input: {
  readonly adapterEpoch: AdapterEpoch;
  readonly sink: AcpV1AdapterSink;
  readonly stagingRoot: string;
  readonly workingDirectory: string;
  readonly runtimeSettings: {
    readonly model: GuildGrokModel;
    readonly reasoningEffort: GuildGrokReasoningEffort;
    readonly permissionMode: GuildGrokPermissionMode;
    readonly startup: GuildGrokStartupSettings;
  };
}) {
  const [located, runtimeEnvironment] = await Promise.all([
    locateOfficialGrokRuntime(),
    resolveOfficialGrokEnvironment(),
  ]);
  const host = new GrokProcessHost({
    executablePath: located.executablePath,
    expectedSha256: located.sha256,
    workingDirectory: input.workingDirectory,
    stagingRoot: input.stagingRoot,
    baseEnvironment: runtimeEnvironment,
    runtimeSettings: input.runtimeSettings,
  });
  if (process.env["GUILD_DESKTOP_DEBUG"] === "1") {
    host.onEvent((event) => {
      if (event.type === "stderr_diagnostic") {
        console.error("guild_grok_stderr", Buffer.byteLength(event.text, "utf8"), "bytes");
      } else if (event.type === "process_exit") {
        console.error("guild_grok_exit", event.code, event.signal);
      } else if (event.type === "preflight_failure" || event.type === "spawn_failure") {
        console.error("guild_grok_start_failure", event.failure.type);
      }
    });
  }
  return Object.freeze({
    adapter: new AcpV1Adapter({
      adapterEpoch: input.adapterEpoch,
      process: host,
      sink: input.sink,
    }),
    runtimeVersion: located.version,
  });
}

async function fetchProductionOfficialUsage(input: {
  readonly stagingRoot: string;
  readonly workingDirectory: string;
  readonly signal: AbortSignal;
}): Promise<AcpV1OfficialBillingSnapshot> {
  throwIfAborted(input.signal);
  await mkdir(input.stagingRoot, { recursive: true, mode: 0o700 });
  const workingDirectory = await realpath(input.workingDirectory);
  throwIfAborted(input.signal);
  const [located, runtimeEnvironment] = await Promise.all([
    locateOfficialGrokRuntime(),
    resolveOfficialGrokEnvironment(),
  ]);
  throwIfAborted(input.signal);
  const host = new GrokProcessHost({
    executablePath: located.executablePath,
    expectedSha256: located.sha256,
    workingDirectory,
    stagingRoot: input.stagingRoot,
    baseEnvironment: runtimeEnvironment,
  });
  const adapter = new AcpV1Adapter({
    adapterEpoch: must(parseAdapterEpoch(1)),
    process: host,
    sink: createUsageOnlySink(),
  });
  const abort = () => {
    void adapter.close().catch(() => undefined);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    throwIfAborted(input.signal);
    const initialized = await adapter.start();
    const selectedAuthMethod = initialized.authMethods.length === 1
      ? initialized.authMethods[0]!.id
      : initialized.defaultAuthMethodId;
    if (selectedAuthMethod === undefined) {
      throw new Error("official_usage_auth_unavailable");
    }
    await adapter.authenticate(selectedAuthMethod);
    return await adapter.officialBilling();
  } finally {
    input.signal.removeEventListener("abort", abort);
    await adapter.close().catch(() => undefined);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("operation_aborted");
}

function promptFailureMessage(locale: GuildLocale): string {
  return locale === "zh-CN"
    ? "Grok 返回了无法处理的错误，本轮已经停止。你的消息仍保留在对话中，可以直接重试。"
    : "Grok returned an error that could not be processed. This turn has stopped, and your message remains in the conversation so you can retry it.";
}

function createUsageOnlySink(): AcpV1AdapterSink {
  const unexpected = async (): Promise<never> => {
    throw new Error("usage_probe_received_session_event");
  };
  return Object.freeze({
    commitSessionEstablished: unexpected,
    commitPromptAccepted: unexpected,
    commitUpdate: unexpected,
    commitAuxiliaryUpdate: unexpected,
    preparePermissionResponse: unexpected,
    commitPermissionResponseFlushed: unexpected,
    commitPromptTerminal: unexpected,
    commitCancelSent: unexpected,
    commitTransportInterrupted: unexpected,
    beginReplayBarrier: unexpected,
    commitReplayBarrier: unexpected,
    abortReplayBarrier: unexpected,
  });
}

function formatUsd(cents: number, locale: GuildLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error("workspace_not_directory");
  return canonical;
}

async function importAvatarFile(
  sourcePath: string,
  mediaRoot: string,
): Promise<{ readonly filename: string }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStat = await file.stat();
    if (!fileStat.isFile() || fileStat.size <= 0) {
      throw new GuildAvatarError("invalid_image");
    }
    if (fileStat.size > 5 * 1024 * 1024) {
      throw new GuildAvatarError("too_large");
    }
    const bytes = await file.readFile();
    const inspected = inspectAvatarBytes(bytes);
    await decodeAvatarWithElectron(bytes);
    await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}.${inspected.extension}`;
    await writeFile(join(mediaRoot, filename), bytes, { flag: "wx", mode: 0o600 });
    return Object.freeze({ filename });
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function decodeAvatarWithElectron(bytes: Buffer): Promise<void> {
  if (process.versions.electron === undefined) return;
  const { nativeImage } = await import("electron");
  if (nativeImage.createFromBuffer(bytes).isEmpty()) {
    throw new GuildAvatarError("invalid_image");
  }
}

function requireActiveRun(controller: RuntimeController): RunId {
  if (controller.activeRunId === undefined) throw new Error("active_run_missing");
  return controller.activeRunId;
}

function requireRun(result: ReturnType<GuildPersistence["applyRun"]>): void {
  if (!result.ok) throw new Error(`run_transition_${result.reason}`);
}

function requireBinding(result: ReturnType<GuildPersistence["applySessionBinding"]>): void {
  if (!result.ok) throw new Error(`binding_transition_${result.reason}`);
}

function clearCancelTimer(controller: RuntimeController): void {
  if (controller.cancelTimer === undefined) return;
  clearTimeout(controller.cancelTimer);
  controller.cancelTimer = undefined;
}

function clearPromptSilenceTimer(controller: RuntimeController): void {
  if (controller.promptSilenceTimer === undefined) return;
  clearTimeout(controller.promptSilenceTimer);
  controller.promptSilenceTimer = undefined;
}

function isRecoveryUserEntry(entry: ConversationEntryRecord): boolean {
  return entry.kind === "user" &&
    entry.status === "complete" &&
    entry.metadata["hidden"] !== true;
}

function dedupeRecoveryMessages(messages: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const message of messages) {
    const trimmed = message.trim();
    if (trimmed.length === 0) continue;
    const fingerprint = trimmed.replace(/\s+/gu, " ");
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    deduped.push(trimmed);
  }
  return Object.freeze(deduped);
}

function isAmbiguousContinuation(text: string): boolean {
  return /^(?:继续(?:吧|哈|做|制作)?|接着(?:吧|做)?|往下做|开始(?:吧)?|开干|做吧|go\s+on|continue|keep\s+going)[\s。.!！?？~～]*$/iu
    .test(text.trim());
}

function recoveryToolPaths(
  entries: readonly ConversationEntryRecord[],
  workspacePath: string,
): readonly string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  let resolutionAttempts = 0;
  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = realpathSync(workspacePath);
  } catch {
    return Object.freeze([]);
  }
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "tool") continue;
    const locations = entry.metadata["locations"];
    if (!Array.isArray(locations)) continue;
    for (const location of locations) {
      if (location === null || typeof location !== "object" || Array.isArray(location)) continue;
      const rawPath = (location as Readonly<Record<string, unknown>>)["path"];
      if (typeof rawPath !== "string" || rawPath.trim().length === 0) continue;
      if (/[\u0000-\u001f\u007f]/u.test(rawPath)) continue;
      const absolute = isAbsolute(rawPath) ? rawPath : resolve(workspacePath, rawPath);
      const lexicalRelative = relative(workspacePath, absolute);
      if (
        lexicalRelative === ".." ||
        lexicalRelative.startsWith("../") ||
        lexicalRelative.startsWith("..\\") ||
        isAbsolute(lexicalRelative)
      ) continue;
      if (resolutionAttempts >= 32) return Object.freeze(paths.reverse());
      resolutionAttempts += 1;
      let canonicalTarget: string;
      try {
        canonicalTarget = realpathSync(absolute);
      } catch {
        continue;
      }
      const relativePath = relative(canonicalWorkspace, canonicalTarget);
      if (
        relativePath === ".." ||
        relativePath.startsWith("../") ||
        relativePath.startsWith("..\\") ||
        isAbsolute(relativePath)
      ) continue;
      const normalized = (relativePath || ".").replaceAll("\\", "/");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      paths.push(normalized);
      if (paths.length >= 8) return Object.freeze(paths.reverse());
    }
  }
  return Object.freeze(paths.reverse());
}

function replacementRecoveryCapsule(input: {
  readonly taskId: TaskId;
  readonly title: string;
  readonly workspacePath: string;
  readonly userHistory: readonly string[];
  readonly observedPaths: readonly string[];
  readonly maxLength: number;
}): string {
  const history = input.userHistory.length === 0
    ? "No earlier user-authored message is available. Treat the current user message as the new authoritative task definition."
    : [...input.userHistory].reverse().map((message, index) =>
        `User instruction ${index + 1} (newest first):\n${truncateRecoverySection(message, 2_200)}`)
      .join("\n\n");
  const paths = input.observedPaths.length === 0
    ? "No task-specific tool path was recorded."
    : input.observedPaths.map((path) => `- ${truncateRecoverySection(path, 480)}`).join("\n");
  const capsule = [
    "[Guild replacement-session recovery context]",
    "The prior official Grok session for this exact Guild task could not be resumed. This is a replacement session, not a new or different task.",
    "Treat this task-local capsule and the current user message as authoritative. Do not infer a different project from global memory, another conversation, or a sibling folder.",
    "Before using tools, verify that the target matches this task. If the task identity or target path conflicts, stop and ask the user instead of editing.",
    `Guild task ID: ${input.taskId}`,
    `Task title: ${truncateRecoverySection(input.title, 700)}`,
    `Workspace root: ${truncateRecoverySection(input.workspacePath, 1_200)}`,
    "Task-local user instructions before replacement (newest first):",
    history,
    "Observed task-local paths before replacement:",
    paths,
    "[End Guild replacement-session recovery context]",
  ].join("\n");
  if (capsule.length <= input.maxLength) return capsule;
  const suffix = "\n[Recovery context truncated by Guild]\n[End Guild replacement-session recovery context]";
  return `${capsule.slice(0, Math.max(0, input.maxLength - suffix.length))}${suffix}`;
}

function truncateRecoverySection(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function errorMessageIncludes(cause: unknown, code: string): boolean {
  return cause instanceof Error
    ? cause.message.includes(code) || errorMessageIncludes(cause.cause, code)
    : String(cause).includes(code);
}

function deriveTaskTitle(text: string): string {
  const normalized = text
    .replace(/^[\s#>*\-\d.)]+/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const withoutRequestLead = normalized.replace(
    /^(?:(?:请|麻烦)(?:你)?(?:帮我|帮忙)?|(?:你)?帮我|给我|可以帮我|能不能帮我)\s*/u,
    "",
  );
  const firstSentence = withoutRequestLead.split(/[。！？!?；;\n]/u, 1)[0]?.trim();
  return boundedConciseTitle(firstSentence || normalized);
}

function compactRuntimeTaskTitle(text: string): string {
  const normalized = text
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(?:任务|标题|task|title)\s*[:：—–-]\s*/iu, "")
    .replace(/^[“”‘’"']+|[“”‘’"']+$/gu, "")
    .trim();
  return boundedConciseTitle(normalized);
}

function boundedConciseTitle(text: string): string {
  const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
  const wordLimited = hasCjk ? text : text.split(/\s+/u).slice(0, 6).join(" ");
  const codePoints = [...wordLimited];
  const limit = hasCjk ? 16 : 42;
  if (codePoints.length <= limit) return wordLimited;
  return `${codePoints.slice(0, limit - 1).join("").trimEnd()}…`;
}

function unique(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function key(prefix: string): IdempotencyKey {
  return must(parseIdempotencyKey(unique(prefix)));
}

function id<T>(parser: (value: unknown) => { readonly ok: true; readonly value: T } | { readonly ok: false }, prefix: string): T {
  return must(parser(unique(prefix)));
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!result.ok) throw new Error("invalid_internal_identity");
  return result.value;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

function metadataString(entry: ConversationEntryRecord, key: string): string | undefined {
  const value = entry.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataNumber(entry: ConversationEntryRecord, key: string): number | undefined {
  const value = entry.metadata[key];
  return typeof value === "number" ? value : undefined;
}

function toolKind(value: unknown): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other" {
  return value === "read" || value === "edit" || value === "delete" || value === "move" ||
      value === "search" || value === "execute" || value === "think" || value === "fetch" ||
      value === "switch_mode"
    ? value
    : "other";
}

function toolStatus(value: unknown): "pending" | "in_progress" | "completed" | "failed" {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "failed"
    ? value
    : "in_progress";
}

function timelineToolContent(value: unknown): readonly TimelineToolContent[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((item): item is TimelineToolContent => {
    if (item === null || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    if (candidate["type"] !== "media") return true;
    return candidate["mediaType"] === "image" &&
      typeof candidate["mimeType"] === "string" &&
      typeof candidate["grantUrl"] === "string" &&
      /^guild-media:\/\/media\/[0-9a-f-]+\.(?:gif|jpg|png|webp)$/u.test(candidate["grantUrl"]) &&
      typeof candidate["alt"] === "string" &&
      typeof candidate["mediaSha256"] === "string" &&
      /^[a-f0-9]{64}$/u.test(candidate["mediaSha256"]);
  }));
}

function toolLocations(value: unknown): readonly RuntimeToolLocation[] {
  return Array.isArray(value) ? value as readonly RuntimeToolLocation[] : Object.freeze([]);
}

function mediaType(value: unknown): "image" | "audio" | "video" | "document" {
  return value === "image" || value === "audio" || value === "video" ? value : "document";
}

function mediaExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/gif": return "gif";
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "audio/aac": return "aac";
    case "audio/flac": return "flac";
    case "audio/mp4": return "m4a";
    case "audio/mpeg": return "mp3";
    case "audio/ogg": return "ogg";
    case "audio/wav":
    case "audio/x-wav": return "wav";
    case "audio/webm": return "webm";
    default: throw new Error("unsupported_media_mime_type");
  }
}

function toolImageAlt(uri: string | null | undefined, index: number, locale: GuildLocale): string {
  if (uri !== undefined && uri !== null) {
    try {
      const parsed = new URL(uri);
      const name = basename(decodeURIComponent(parsed.pathname)).trim();
      if (name.length > 0) return name.slice(0, 160);
    } catch {
      const name = basename(uri).trim();
      if (name.length > 0) return name.slice(0, 160);
    }
  }
  return locale === "zh-CN" ? `工具查看的图片 ${index}` : `Image viewed by tool ${index}`;
}

async function copyDirectoryIfPresent(source: string, destination: string): Promise<void> {
  try {
    const metadata = await stat(source);
    if (!metadata.isDirectory()) throw new Error("backup_source_not_directory");
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  } catch (cause: unknown) {
    if (
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) return;
    throw cause;
  }
}
