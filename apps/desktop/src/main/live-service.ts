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
  EMPTY_CLAUDE_MODEL_CATALOG,
  EMPTY_CODEX_MODEL_CATALOG,
  EMPTY_GROK_MODEL_CATALOG,
  emptyModelCatalogOf,
  GUILD_ADDON_DEFAULT_PERMISSION_MODE,
  GUILD_ADDON_ENGINES,
  GUILD_ADDON_PERMISSION_MODES,
  GUILD_CLAUDE_IDENTIFIER_LIMITS,
  GUILD_CLAUDE_PERMISSION_MODES,
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
  parseGuildDockIcon,
  parseGuildNewTaskWorkspaceMode,
  parseContinuousFooter,
  defaultReasoningEffortOf,
  CLAUDE_DEFAULT_MODEL_ID,
  freezeModelCatalog,
  grokModelById,
  isAddonEngine,
  isClaudeModelId,
  isOfficialGrokModelId,
  modelCatalogEngineOf,
  modelGroupOf,
  modelNameFromDescription,
  modelSupportsReasoningEffort,
  parseGuildAddonPermissionMode,
  parseGuildClaudePermissionMode,
  parseGuildClaudeReasoningEffort,
  parseGuildModelId,
  parseGuildReasoningEffort,
  resolveEffectiveSelection,
  runtimeDefaultModelOf,
  selectionOptionsOf,
  sessionSelectionOf,
  type AdapterEpoch,
  type AcpToolKind,
  type AcpToolStatus,
  type AddonEngineSettingsProjection,
  type DesktopBootstrapProjection,
  type EngineStatusProjection,
  type GrokModelCatalog,
  type GuildAddonEngine,
  type GuildDockIcon,
  type GuildEngine,
  type GuildLocale,
  type GuildGrokModel,
  type GuildGrokPermissionMode,
  type GuildGrokReasoningEffort,
  type GuildGrokStartupSettings,
  type GuildTaskActivity,
  type GuildModelSwitchRefusalReason,
  type IdempotencyKey,
  type ModelCatalog,
  type ModelDescriptor,
  type OfficialUsageProjection,
  type PermissionIdentity,
  type RunId,
  type StreamDeltaEvent,
  type RuntimePermissionRequestPayload,
  type RuntimeCommand,
  type RuntimeConfigOption,
  type RunPhaseProjection,
  type RuntimeToolContent,
  type RuntimeToolLocation,
  type RuntimeTurnPayload,
  type SetTaskRuntimeSettingsRequest,
  type SetTaskRuntimeSettingsResponse,
  type SessionAttemptId,
  type SessionId,
  type TaskId,
  type TaskModelSelectionProjection,
  type TaskViewProjection,
  type TimelineToolContent,
  type TimelineItemProjection,
  type WorkspaceProjection,
  type WindowId,
  type WorkspaceId,
  type XaiSignalEnvelope,
  type ApplyWorktreeResponse,
  type ChooseAvatarResponse,
  type ChoosePromptFilesResponse,
  type DiscardWorktreeResponse,
  type GuildNewTaskWorkspaceMode,
  type GuildTaskIsolation,
  type PreviewWorktreeApplyResponse,
  type SaveProfileAvatar,
  type RunGrokManagementRequest,
  type RunGrokManagementResponse,
  type RuntimeIncidentProjection,
  type PromptAttachment,
} from "@guild/contracts";
import {
  GUILD_RUN_FILE_LIST_LIMIT,
  GUILD_RUN_FILE_DIFF_MAX_BYTES,
  type GuildCheckpointUnavailableReason,
  type GuildRewindIrreversibleKind,
  type GuildRewindRefusalReason,
  type GuildRewindScope,
  type RewindConflictProjection,
  type ConvertQueuedTurnToSteerResponse,
  type ExecuteRewindRequest,
  type ExecuteRewindResponse,
  type GuildSteerFallbackReason,
  type LoadRunFileDiffRequest,
  type LoadRunFileDiffResponse,
  type PreviewRewindResponse,
  type RewindAvailabilityProjection,
  type RunCheckpointProjection,
  type RunModelProjection,
  type SteerAvailabilityProjection,
  type SteerMessageResponse,
  type TimelineInterjectionProjection,
} from "@guild/contracts";
import {
  CONFLICT_FREE_VERDICT,
  createRunPhaseTracker,
  type PermissionRecord,
  type RunPhaseInput,
  type RunPhaseStage,
  type RunPhaseTracker,
  type RunRecord,
} from "@guild/domain";
import {
  openGuildPersistence,
  type ConversationEntryRecord,
  type ContinuousTaskRecord,
  type GuildPersistence,
  type InterjectionRecord,
  type RunCheckpointRecord,
} from "@guild/persistence";
import {
  ACP_V1_CODEC_LIMITS,
  AcpV1Adapter,
  AcpV1AdapterError,
  GrokProcessHost,
  deriveClaudeModelCatalog,
  deriveCodexModelCatalog,
  engineProfileFor,
  type AcpV1AdapterInterruptionReason,
  type AcpV1AdapterInterruptionDiagnostic,
  type AcpV1AdapterSession,
  type AcpV1AdapterSink,
  type AcpV1DecodedUpdate,
  type AcpV1HttpMcpServer,
  type AcpV1InitializeResult,
  type AcpV1OfficialBillingSnapshot,
  type AcpV1SessionStartOptions,
  type AcpV1SessionState,
  type AcpV1SteerResult,
  type EngineFeatureFlags,
  type EngineSignal,
  type JsonRpcInboundResponseWriteReceipt,
  type JsonRpcWriteReceipt,
  type JsonValue,
  type XaiExtensionOutcome,
} from "@guild/runtime-grok";
import type { DesktopApplicationService } from "./application-service.js";
import { ClaudeEngineIntegrityError, ClaudeLocatorError, locateClaudeEngine } from "./claude-locator.js";
import { createClaudeRuntime } from "./claude-runtime.js";
import {
  addonEngineReport,
  createAddonEngineState,
  mergeAddonCatalog,
  type AddonAuth,
  type AddonEngineState,
  type AddonInstall,
} from "./addon-engines.js";
import { CodexEngineIntegrityError, CodexLocatorError, locateCodexEngine } from "./codex-locator.js";
import { createCodexRuntime } from "./codex-runtime.js";
import type { BrowserMcpPort, ModelRouterHostPort, RoutedModelInfo } from "./engine-ports.js";
import {
  GuildAvatarError,
  inspectAvatarBytes,
  inspectDisplayImageBytes,
} from "./profile-image.js";
import {
  invalidateOfficialGrokRuntimeCache,
  locateOfficialGrokRuntime,
  resolveOfficialGrokEnvironment,
} from "./runtime-locator.js";
import { CLAUDE_CAPTURE_OFF_ENVIRONMENT } from "./dev-hooks.js";
import { routedClaudeEnvironment } from "./routed-environment.js";
import { warmOfficialGrokRuntime } from "./runtime-warmup.js";
import {
  applyRuntimeSelection,
  optionOffers,
  refusalReasonOf,
  type RuntimeSelectionOutcome,
} from "./model-selection.js";
import {
  CLAUDE_DEFAULT_MUST_BE_NATIVE,
  CLAUDE_LOGIN_REQUIRED,
  CLAUDE_START_TIMEOUT,
  ENGINE_INTEGRITY_CHANGED,
  ENGINE_LOGIN_REQUIRED,
  ENGINE_START_TIMEOUT,
  MODEL_ROUTER_UNAVAILABLE,
  MODEL_SELECTION_FAILED,
  SESSION_RECOVERY_CONTEXT_REQUIRED,
  TASK_ENGINE_LOCKED,
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
import {
  checkpointRef,
  gitCheckpoints,
  type GitCheckpointPort,
  type RunRefs,
} from "./git-checkpoints.js";
import { gitWorktrees, type GitWorktreePort } from "./git-worktrees.js";
import { createTaskWorktreeManager } from "./task-worktrees.js";

const PRIMARY_WINDOW_ID = must(parseWindowId("guild-primary-window"));
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const DEFAULT_CANCEL_GRACE_MS = 1_500;
const DEFAULT_PROMPT_SETTLE_MS = 1_500;
const CONVERSATION_PAGE_SIZE = 500;
const REPLACEMENT_RECOVERY_CAPSULE_MAX_LENGTH = 12_000;
const REPLAY_STAGING_MAX_UPDATES = 10_000;
const REPLAY_STAGING_MAX_BYTES = 32 * 1024 * 1024;
const PLAN_DISPLAY_MAX_CHARS = 64 * 1024;
/** A failed prewarm is not retried for this long, so typing in a broken task cannot spawn in a loop. */
const PREWARM_RETRY_BACKOFF_MS = 15_000;
/** A healthy local process answers a liveness probe in about a millisecond. */
const RESUME_LIVENESS_PROBE_MS = 2_000;
/** Bound on borrowing a live adapter for the official usage call before spawning a dedicated one. */
const LIVE_USAGE_TIMEOUT_MS = 10_000;
/** While authored text streams, full projections are rebuilt at most this often. */
const STREAM_PUBLISH_INTERVAL_MS = 250;
/** Streaming deltas for one entry are merged for at most one animation frame. */
const STREAM_DELTA_COALESCE_MS = 16;
const STREAM_DELTA_FLUSH_CHARS = 32 * 1024;
const STREAM_LIVE_ENTRY_LIMIT = 32;
/** More changed rows than this are cheaper to reload in one query than row by row. */
const ENTRY_CACHE_BULK_RELOAD_ROWS = 48;
const TERMINAL_RUN_CACHE_LIMIT = 512;
/** `_x.ai/interject` is a local stdio round trip; it never waits on the model. */
const DEFAULT_STEER_REQUEST_TIMEOUT_MS = 5_000;
const ECHOED_INTERJECTION_LIMIT = 64;
/**
 * A Run's start checkpoint is taken before its prompt is sent. The send waits at most this long
 * for it; past the bound the prompt goes out and the late capture is discarded, because by then
 * the agent may already have changed files.
 */
const DEFAULT_CHECKPOINT_START_BOUND_MS = 3_000;
/** How long a send may wait for its start checkpoint before the prompt goes out anyway. */
const CHECKPOINT_START_WAIT_MS = 400;
const DEFAULT_CHECKPOINT_END_TIMEOUT_MS = 10_000;
/** Stays well inside the 256 KiB the store allows for one Run's file summary. */
const CHECKPOINT_FILES_JSON_BUDGET = 200_000;
const REWIND_FILE_LIST_LIMIT = 500;
const REWIND_REQUEST_TIMEOUT_MS = 10_000;
/** The Claude installation is looked at again at most this often (the locator itself is cached). */
const CLAUDE_PROBE_INTERVAL_MS = 30_000;
/** An add-on engine's installation is looked at again at most this often. */
const ADDON_PROBE_INTERVAL_MS = 30_000;

export type WorkspaceChooser = () => Promise<string | undefined>;

export type RuntimeAdapterPort = {
  readonly state: string;
  /** Engine the process belongs to (PC-ENG-001); decides which Grok-only features are offered. */
  readonly engine: GuildEngine;
  readonly features: EngineFeatureFlags;
  start(): Promise<AcpV1InitializeResult>;
  authenticate(methodId: string): Promise<void>;
  officialBilling(): Promise<AcpV1OfficialBillingSnapshot>;
  /** Used only for the context window; model and effort go through `setConfigOption`. */
  setModel(
    session: AcpV1AdapterSession,
    model: GuildGrokModel,
    options?: { readonly reasoningEffort?: GuildGrokReasoningEffort; readonly contextWindow?: number },
  ): Promise<void>;
  setConfigOption(
    session: AcpV1AdapterSession,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]>;
  newSession(cwd: string, startOptions?: AcpV1SessionStartOptions): Promise<AcpV1AdapterSession>;
  resumeSession(
    sessionId: string,
    cwd: string,
    startOptions?: AcpV1SessionStartOptions,
  ): Promise<AcpV1AdapterSession>;
  loadSession(
    sessionId: string,
    cwd: string,
    startOptions?: AcpV1SessionStartOptions,
  ): Promise<AcpV1AdapterSession>;
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
  /**
   * One `_x.ai/*` extension request (Steer, rewind). Extensions are not advertised: `unsupported`
   * means the installed runtime answered -32601. Any other failure rejects.
   */
  sendExtensionRequest(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options?: { readonly timeoutMs?: number },
  ): Promise<XaiExtensionOutcome<JsonValue>>;
  /**
   * Claude Steer (`_session/steering`). `unsupported` means no request was made, or the agent
   * answered -32601; `promptRequired` means no turn was running and nothing was sent.
   */
  steer(
    session: AcpV1AdapterSession,
    text: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<AcpV1SteerResult>;
  /** The adapter engines apply the permission mode as a config option after the session opens. */
  setPermissionMode(
    session: AcpV1AdapterSession,
    mode: string,
  ): Promise<readonly RuntimeConfigOption[]>;
  /** Local stdio round trip; `false` means the process no longer answers. Never closes the adapter. */
  probeLiveness(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
};

export type RuntimeFactory = (input: {
  /** Engine of the task the process is for (PC-ENG-001). */
  readonly engine: GuildEngine;
  readonly adapterEpoch: AdapterEpoch;
  readonly sink: AcpV1AdapterSink;
  readonly stagingRoot: string;
  readonly workingDirectory: string;
  /** Grok process-level settings only: the model and effort are applied per session after it opens. */
  readonly runtimeSettings: {
    readonly permissionMode: GuildGrokPermissionMode;
    readonly startup: GuildGrokStartupSettings;
  };
  /**
   * Claude only: the per-spawn variables of a start (docs/20 3.3, D-062). A process whose task selects an
   * Online / Local model gets the routed set; a native process gets none, except
   * `OPENVIKING_AUTO_CAPTURE=false` when the task has used a routed model or the dev-only capture switch of
   * `claudeCaptureOff` is on. The `ANTHROPIC_BASE_URL` value carries the router token and
   * `ANTHROPIC_AUTH_TOKEN` is a throwaway secret: never log either.
   */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
}) => Promise<{
  readonly adapter: RuntimeAdapterPort;
  readonly runtimeVersion?: string;
  /** Claude only: true when the process refused to run because its pinned files changed (PC-ENG-002). */
  readonly refusedForIntegrity?: () => boolean;
}>;

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
  /**
   * Looks for the Claude installation (node, ACP adapter, `claude`) and returns the `claude` version;
   * a `ClaudeLocatorError` means something is missing. Defaults to the real locator, and to nothing
   * when a `runtimeFactory` is injected (the status is then learned from the sessions it starts).
   */
  readonly claudeEngineProbe?: () => Promise<Readonly<{ version: string }>>;
  /**
   * Looks for an add-on engine's installation (node, adapter, core) and returns the engine's version; a
   * `CodexLocatorError` means something is missing. Defaults to the real locator, and to nothing when a
   * `runtimeFactory` is injected (the status is then learned from the sessions it starts).
   */
  readonly addonEngineProbes?: Readonly<Partial<Record<GuildAddonEngine, () => Promise<Readonly<{ version: string }>>>>>;
  /** Dev-only (`GUILD_DEV_CODEX_ACP`, see dev-hooks.ts): a `codex-acp` package directory the Codex locator tries first. */
  readonly codexAdapterRoot?: string;
  /** Applies the Dock icon the user chose (PC-SET-002); called at startup and whenever the setting changes. Returns false when nothing was set (not macOS, a missing or empty file). */
  readonly applyDockIcon?: (icon: GuildDockIcon) => boolean | void;
  /** Online / Local models behind the loopback router (docs/20 3.3, 3.4). Absent: Claude tasks stay native. */
  readonly modelRouterHost?: ModelRouterHostPort;
  /** Loopback browser MCP server handed to engines that advertise HTTP MCP (docs/20 3.5). */
  readonly browserMcp?: BrowserMcpPort;
  /**
   * Dev-only QA switch (`GUILD_DEV_CLAUDE_CAPTURE_OFF`, see dev-hooks.ts): every native Claude spawn also
   * gets `OPENVIKING_AUTO_CAPTURE=false`, so QA turns are not written into the owner's memory store.
   * The main process passes it only for an unpackaged app; routed spawns, and the native spawns of a task
   * that has used a routed model (D-062), carry the variable anyway.
   */
  readonly claudeCaptureOff?: boolean;
  readonly usageFetcher?: (signal: AbortSignal) => Promise<AcpV1OfficialBillingSnapshot>;
  readonly managementRunner?: (input: {
    readonly request: RunGrokManagementRequest;
    readonly workingDirectory: string;
    readonly signal: AbortSignal;
    readonly onOutput?: (output: string) => void;
  }) => Promise<RunGrokManagementResponse>;
  readonly cancelGraceMs?: number;
  /** Git operations behind run checkpoints and rewind; tests substitute a fake. */
  readonly checkpoints?: GitCheckpointPort;
  readonly checkpointStartBoundMs?: number;
  readonly checkpointEndTimeoutMs?: number;
  /** Git operations behind per-task worktrees (F3); tests substitute a fake. */
  readonly worktrees?: GitWorktreePort;
  readonly steerRequestTimeoutMs?: number;
  readonly promptSilenceMs?: number;
  readonly promptSettleMs?: number;
  /** Minimum delay before a failed background prewarm of the same task is retried. */
  readonly prewarmRetryMs?: number;
  readonly diagnosticsRoot?: string;
  /**
   * An already opened store shared with the model sources service (the database lease allows one
   * owner). When present the service uses it instead of opening its own and closes it with itself.
   */
  readonly persistence?: GuildPersistence;
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
  /** Engine of the task: fixed for the life of the task (PC-ENG-001). */
  readonly engine: GuildEngine;
  /** Online / Local model ids Guild put in the session's `modelPicker`; they are not Claude's own models. */
  pickerModelIds: ReadonlySet<string>;
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
  /** True when the current process was started through the model router (Claude); reset by every start. */
  routedProcess: boolean;
  /** True while the only reason `startOperation` runs is a background prewarm. */
  startIsPrewarm: boolean;
  /** True from a successful prewarm until the first real use; only such a process may be released. */
  prewarmOnly: boolean;
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
  /** Ephemeral first-token phase of the running turn (F1b); never persisted. */
  readonly phase: RunPhaseTracker;
  /** Sends admitted for this task that have not yet created their Run. */
  sendsInFlight: number;
  /** True while the session runs a selection other than the stored one because the runtime refused it. */
  selectionRefused: boolean;
  /** `_x.ai/interject` answered -32601 on this process: Steer is not offered again until it restarts. */
  steerUnsupported: boolean;
  /** `_x.ai/rewind/*` answered -32601 on this process. */
  rewindUnsupported: boolean;
  /** Steer ids the runtime already echoed, for an echo that beats the request's own response. */
  readonly echoedInterjections: Set<string>;
  /** Start checkpoints still being captured, by Run; the prompt waits for its own. */
  readonly checkpointStarts: Map<RunId, Promise<void>>;
  /** Runs whose prompt went out before their start checkpoint finished: that capture is discarded. */
  readonly abandonedCheckpointStarts: Set<RunId>;
  /** Runs whose start checkpoint capture has finished (captured or unavailable). */
  readonly settledCheckpointStarts: Set<RunId>;
  /** Captures of one task run strictly one after another, in the order the Runs happened. */
  checkpointTail: Promise<void>;
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

type PendingStreamDelta = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly entryId: string;
  readonly kind: "assistant" | "thought";
  readonly offset: number;
  text: string;
  revision: number;
};

type GitChangedFileRecord = RunCheckpointRecord["files"][number];

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
  const store = options.persistence ?? openGuildPersistence({
    path: options.databasePath,
    initialLocale: options.initialLocale,
  });
  const listeners = new Set<(projection: DesktopBootstrapProjection) => void>();
  const controllers = new Map<TaskId, RuntimeController>();
  const persistedContextTokens = new Map<TaskId, number | null>();
  const prewarmFailedAtMs = new Map<TaskId, number>();
  const conversationPageDepths = new Map<TaskId, number>();
  const scheduledQueuedTasks = new Map<TaskId, Promise<void>>();
  const scheduledContinuousTasks = new Map<TaskId, Promise<void>>();
  const runtimeFactory = options.runtimeFactory ??
    ((input: Parameters<RuntimeFactory>[0]) => createProductionRuntime(input, { codexAdapterRoot: options.codexAdapterRoot }));
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
  // F3: tasks created with an isolated worktree run in `<data>/worktrees/<taskId>` instead of the workspace folder.
  const worktreeManager = createTaskWorktreeManager({
    store,
    git: options.worktrees ?? gitWorktrees,
    dataRoot: dirname(options.databasePath),
    runBlock: (taskId) => worktreeRunBlock(taskId),
    onChange: () => schedulePublish(),
  });
  let activeTaskId: TaskId | undefined;
  let runtimeVersion: string | undefined;
  // Last model list the official runtime advertised. Seeded from the local cache so the picker has
  // choices before any process starts; replaced whenever a runtime advertises a different list.
  let modelCatalog: GrokModelCatalog = store.loadModelCatalogCache()?.catalog ?? EMPTY_GROK_MODEL_CATALOG;
  // Claude's own models, the same way; the router's Online and Local ones are added when projected.
  let claudeNativeCatalog: ModelCatalog = store.loadModelCatalogCache("claude")?.catalog ?? EMPTY_CLAUDE_MODEL_CATALOG;
  let claudeCatalogMemo: { readonly native: ModelCatalog; readonly key: string; readonly value: ModelCatalog } | undefined;
  let claudeRuntimeVersion: string | undefined;
  // What the Claude engine last said about its login. Account-level: one login serves every Claude task.
  let claudeAuth: Readonly<{ kind: string; label?: string }> | undefined;
  // What was found of the Claude installation; undefined until something looked.
  let claudeInstall: Readonly<{ status: "ready" | "not_found" | "unavailable" | "integrity_changed"; version?: string }> | undefined;
  let claudeProbeAtMs = 0;
  let claudeProbeOperation: Promise<void> | undefined;
  const claudeProbe = options.claudeEngineProbe ?? (options.runtimeFactory === undefined
    ? async () => ({ version: (await locateClaudeEngine()).claude.version })
    : undefined);
  // Add-on engines (Codex first): the same per-engine state as the Claude variables above, keyed by engine.
  const addonStates = new Map<GuildAddonEngine, AddonEngineState>(GUILD_ADDON_ENGINES.map((engine) => [
    engine,
    createAddonEngineState(engine, store.loadModelCatalogCache(engine)?.catalog ?? emptyModelCatalogOf(engine)),
  ]));
  const addonProbes: Readonly<Partial<Record<GuildAddonEngine, () => Promise<Readonly<{ version: string }>>>>> =
    options.addonEngineProbes ?? (options.runtimeFactory === undefined
      ? {
          codex: async () => ({
            version: (await locateCodexEngine({
              ...(options.codexAdapterRoot === undefined ? {} : { extraAdapterRoots: [options.codexAdapterRoot] }),
            })).core.version,
          }),
        }
      : {});
  const modelRouterHost = options.modelRouterHost;
  const browserMcp = options.browserMcp;
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
  // True when a pending flush was requested by a structural change. A flush that
  // only follows streamed text may reuse the cached sidebar projection.
  let publishStructural = false;
  let streamPublishOperation: Promise<void> | undefined;
  let streamPublishTimer: ReturnType<typeof setTimeout> | undefined;
  let lastFullPublishAtMs = Number.NEGATIVE_INFINITY;
  let lastProjectionBuildMs = 0;
  let lastStreamYieldAt = performance.now();
  const deltaListeners = new Set<(delta: StreamDeltaEvent) => void>();
  const liveStreamEntries = new Map<string, { length: number; revision: number }>();
  const pendingStreamDeltas = new Map<string, PendingStreamDelta>();
  let streamDeltaTimer: ReturnType<typeof setTimeout> | undefined;
  let sidebarCache: readonly WorkspaceProjection[] | undefined;
  let entryCache: { readonly taskId: TaskId; entries: Map<string, ConversationEntryRecord> } | undefined;
  const projectedEntryCache = new Map<string, { readonly key: string; readonly item: TimelineItemProjection }>();
  const terminalRunCache = new Map<RunId, RunRecord>();
  const workbenchCache = new Map<string, { readonly key: string; readonly value: TaskViewProjection["workbench"] }>();
  // Reads repeated within one synchronous projection build (the active task is summarized for the
  // sidebar and again for its own view) are fetched once. Unset outside a build.
  let buildReadMemo: Map<string, unknown> | undefined;
  function readOncePerBuild<T>(key: string, read: () => T): T {
    if (buildReadMemo === undefined) return read();
    if (buildReadMemo.has(key)) return buildReadMemo.get(key) as T;
    const value = read();
    buildReadMemo.set(key, value);
    return value;
  }
  let activeTaskHydrated = false;
  let allowAutoSelectActiveTask = true;
  const avatarPreviews = new Map<string, string>();

  void Promise.all([
    mkdir(options.stagingRoot, { recursive: true, mode: 0o700 }),
    mkdir(mediaRoot, { recursive: true, mode: 0o700 }),
  ]);
  if (options.runtimeFactory === undefined) {
    // Locate, stage and first-execute the official binary off the critical path.
    void warmOfficialGrokRuntime(options.stagingRoot).catch(() => undefined);
  }

  refreshClaudeInstall();
  refreshAddonInstalls();
  // Sources added, confirmed, edited, disabled or deleted change what the Claude picker offers.
  const unsubscribeRouterChanges = modelRouterHost?.onChange(() => schedulePublish());

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

  /** Looks for the Claude installation off the critical path; a change reaches the next projection. */
  function refreshClaudeInstall(): void {
    if (claudeProbe === undefined || closed || closing || claudeProbeOperation !== undefined) return;
    if (Date.now() - claudeProbeAtMs < CLAUDE_PROBE_INTERVAL_MS) return;
    claudeProbeAtMs = Date.now();
    claudeProbeOperation = (async () => {
      let next: NonNullable<typeof claudeInstall>;
      try {
        next = Object.freeze({ status: "ready" as const, version: (await claudeProbe()).version });
      } catch (cause: unknown) {
        next = Object.freeze({
          // Changed pinned files are not a missing install: the picker withholds the default row and Settings
          // shows the integrity text (PC-ENG-002).
          status: cause instanceof ClaudeEngineIntegrityError
            ? "integrity_changed" as const
            : cause instanceof ClaudeLocatorError ? "not_found" as const : "unavailable" as const,
        });
      }
      // A refusal to run changed files stays until a Claude session opens again; a probe that only
      // finds the pieces present must not hide it.
      if (claudeInstall?.status === "integrity_changed") return;
      noteClaudeInstall(next);
    })().finally(() => { claudeProbeOperation = undefined; });
  }

  function addonState(engine: GuildAddonEngine): AddonEngineState {
    return addonStates.get(engine)!;
  }

  /** Looks for every add-on engine's installation off the critical path; a change reaches the next projection. */
  function refreshAddonInstalls(): void {
    for (const engine of GUILD_ADDON_ENGINES) refreshAddonInstall(engine);
  }

  /** The Dock icon is the main process's to set; a failure there never reaches the settings. */
  function applyDockIcon(icon: GuildDockIcon): void {
    if (options.applyDockIcon === undefined) return;
    try {
      const applied = options.applyDockIcon(icon);
      logRuntime({ category: "runtime", event: applied === false ? "dock_icon_not_applied" : "dock_icon_applied" });
    } catch {
      logRuntime({ category: "runtime", event: "dock_icon_failed" });
    }
  }

  function refreshAddonInstall(engine: GuildAddonEngine): void {
    const state = addonState(engine);
    const probe = addonProbes[engine];
    if (probe === undefined || closed || closing || state.probeOperation !== undefined) return;
    if (Date.now() - state.probeAtMs < ADDON_PROBE_INTERVAL_MS) return;
    state.probeAtMs = Date.now();
    state.probeOperation = (async () => {
      let next: AddonInstall;
      try {
        next = Object.freeze({ status: "ready" as const, version: (await probe()).version });
      } catch (cause: unknown) {
        next = Object.freeze({
          // Changed pinned files are not a missing install: the picker withholds the default row and Settings
          // shows the integrity text (PC-ENG-003).
          status: cause instanceof CodexEngineIntegrityError
            ? "integrity_changed" as const
            : cause instanceof CodexLocatorError ? "not_found" as const : "unavailable" as const,
        });
      }
      // A refusal to run changed files stays until a session of the engine opens again; a probe that only finds
      // the pieces present must not hide it.
      if (state.install?.status === "integrity_changed") return;
      noteAddonInstall(engine, next);
    })().finally(() => { state.probeOperation = undefined; });
  }

  /** `status`, `accountLabel` and `version` plus the stored defaults of `runtimeSettings.engines[engine]` (docs/21 4.2). */
  function addonSettingsProjection(
    engine: GuildAddonEngine,
    settings: ReturnType<GuildPersistence["loadAppSettings"]>,
  ): AddonEngineSettingsProjection {
    const defaults = settings.engineDefaults[engine];
    return Object.freeze({
      ...addonEngineReport(addonState(engine)),
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      permissionMode: defaults.permissionMode,
      availablePermissionModes: GUILD_ADDON_PERMISSION_MODES[engine],
    });
  }

  function noteAddonInstall(engine: GuildAddonEngine, next: AddonInstall): void {
    const state = addonState(engine);
    if (closed || closing || (state.install?.status === next.status && state.install.version === next.version)) return;
    state.install = next;
    schedulePhasePublish();
  }

  function noteClaudeInstall(next: NonNullable<typeof claudeInstall>): void {
    if (closed || closing || (claudeInstall?.status === next.status && claudeInstall.version === next.version)) return;
    claudeInstall = next;
    schedulePhasePublish();
  }

  /** `status`, `accountLabel` and `version` of `runtimeSettings.claude` (docs/20 3.2, 3.8). */
  function claudeEngineReport(): Readonly<{
    status?: "ready" | "not_found" | "not_logged_in" | "unavailable" | "integrity_changed";
    accountLabel?: string;
    version?: string;
  }> {
    const loginRequired = claudeAuth?.kind === "none";
    const status = claudeInstall !== undefined && claudeInstall.status !== "ready"
      ? claudeInstall.status
      : loginRequired
        ? "not_logged_in" as const
        : claudeInstall?.status;
    return Object.freeze({
      ...(status === undefined ? {} : { status }),
      ...(claudeAuth?.label === undefined || loginRequired ? {} : { accountLabel: claudeAuth.label }),
      ...(claudeInstall?.version === undefined ? {} : { version: claudeInstall.version }),
    });
  }

  function noteModelCatalog(catalog: GrokModelCatalog | undefined): void {
    if (catalog === undefined || catalog.models.length === 0) return;
    // The Grok list is Grok's alone; a Claude session's list goes through noteClaudeNativeCatalog.
    if (modelCatalogEngineOf(catalog) !== "grok") return;
    if (JSON.stringify(catalog) === JSON.stringify(modelCatalog)) return;
    modelCatalog = catalog;
    try {
      store.saveModelCatalogCache({
        catalog,
        ...(runtimeVersion === undefined ? {} : { runtimeVersion: runtimeVersion.slice(0, 128) }),
      });
    } catch {
      // The cache only lets the picker show choices before a runtime starts.
    }
    schedulePhasePublish();
  }

  /**
   * An add-on engine's own models as its sessions reported them (group of the engine). A session lists every
   * model's efforts when it starts; later updates carry the selected model's only (`mergeAddonCatalog`).
   */
  function noteAddonCatalog(engine: GuildAddonEngine, derived: ModelCatalog | undefined, atStart: boolean): void {
    const state = addonState(engine);
    const next = mergeAddonCatalog(engine, state.catalog, derived, atStart);
    if (next === undefined || JSON.stringify(next) === JSON.stringify(state.catalog)) return;
    state.catalog = next;
    try {
      store.saveModelCatalogCache({
        engine,
        catalog: next,
        ...(state.runtimeVersion === undefined ? {} : { runtimeVersion: state.runtimeVersion.slice(0, 128) }),
      });
    } catch {
      // The cache only lets the picker show choices before a runtime starts.
    }
    schedulePhasePublish();
  }

  function engineOfTask(taskId: TaskId): GuildEngine {
    try {
      return store.loadTaskEngine(taskId);
    } catch {
      return "grok";
    }
  }

  /** Online and Local models that are enabled and confirmed right now; a faulty host lists none. */
  function routedModels(): readonly RoutedModelInfo[] {
    try {
      return modelRouterHost?.listRoutedModels() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Claude's own models as the adapter reported them (group `claude`). The adapter's `model` option
   * also lists whatever Guild put in the session's `modelPicker`, so those ids are dropped here: they
   * belong to the router's sources, not to the Claude subscription. Efforts are only reported for the
   * model that is selected, so the ones seen for a model earlier are kept. Only a native process
   * reaches this (see `applySessionOptions`): a routed process runs with an API token, so its list of
   * Claude's models is a degraded one (a bare Default row, no older models) and must neither replace
   * the picker's list nor the persisted cache.
   */
  function noteClaudeNativeCatalog(
    derived: ModelCatalog | undefined,
    pickerModelIds: ReadonlySet<string>,
  ): void {
    if (derived === undefined) return;
    const routedIds = new Set(routedModels().map((model) => model.id));
    const previousById = new Map(claudeNativeCatalog.models.map((model) => [model.id, model]));
    const models = derived.models
      .filter((model) => !pickerModelIds.has(model.id) && !routedIds.has(model.id))
      .map((model) => model.reasoningEfforts.length > 0
        ? model
        : Object.freeze({ ...model, reasoningEfforts: previousById.get(model.id)?.reasoningEfforts ?? model.reasoningEfforts }));
    if (models.length === 0) return;
    const ids = models.map((model) => model.id);
    // "default" is the adapter's own pick; the session's current model would move with every switch.
    const runtimeDefaultModelId = [
      ids.includes("default") ? "default" : undefined,
      claudeNativeCatalog.runtimeDefaultModelId,
      derived.runtimeDefaultModelId,
    ].find((candidate) => candidate !== undefined && ids.includes(candidate));
    let next: ModelCatalog;
    try {
      next = freezeModelCatalog("claude", {
        engine: "claude",
        models,
        ...(runtimeDefaultModelId === undefined ? {} : { runtimeDefaultModelId }),
      });
    } catch {
      return;
    }
    if (JSON.stringify(next) === JSON.stringify(claudeNativeCatalog)) return;
    claudeNativeCatalog = next;
    try {
      store.saveModelCatalogCache({
        engine: "claude",
        catalog: next,
        ...(claudeRuntimeVersion === undefined ? {} : { runtimeVersion: claudeRuntimeVersion.slice(0, 128) }),
      });
    } catch {
      // The cache only lets the picker show choices before a runtime starts.
    }
    schedulePhasePublish();
  }

  /**
   * What the Claude picker offers (PC-MODEL-001): the adapter's own models plus the router's Online
   * and Local ones, each labelled with its group. Memoized: the projection is rebuilt on every publish.
   */
  function claudeCatalogProjection(): ModelCatalog {
    const routed = routedModels();
    if (routed.length === 0) return claudeNativeCatalog;
    const key = routed.map((model) => `${model.id}\0${model.label}\0${model.group}\0${model.sourceLabel}\0${model.contextWindow ?? ""}\0${model.supportsImages === true}`).join("\n");
    if (claudeCatalogMemo?.native === claudeNativeCatalog && claudeCatalogMemo.key === key) {
      return claudeCatalogMemo.value;
    }
    const seen = new Set(claudeNativeCatalog.models.map((model) => model.id));
    const extra: ModelDescriptor[] = [];
    for (const model of routed) {
      if (seen.has(model.id) || !isClaudeModelId(model.id)) continue;
      seen.add(model.id);
      const description = model.sourceLabel.trim().slice(0, 512);
      extra.push(Object.freeze({
        id: model.id,
        name: model.label.trim().slice(0, 128) || model.id,
        ...(description.length === 0 ? {} : { description }),
        group: model.group,
        reasoningEfforts: Object.freeze([]),
        contextWindows: Object.freeze(
          model.contextWindow !== undefined && Number.isSafeInteger(model.contextWindow) &&
            model.contextWindow >= 1 && model.contextWindow <= 100_000_000
            ? [model.contextWindow]
            : [],
        ),
        ...(model.supportsImages === true ? { supportsImages: true as const } : {}),
      }));
    }
    let value = claudeNativeCatalog;
    try {
      value = freezeModelCatalog("claude", {
        engine: "claude",
        models: [...claudeNativeCatalog.models, ...extra].slice(0, GUILD_CLAUDE_IDENTIFIER_LIMITS.maxModels),
        ...(claudeNativeCatalog.runtimeDefaultModelId === undefined
          ? {}
          : { runtimeDefaultModelId: claudeNativeCatalog.runtimeDefaultModelId }),
      });
    } catch {
      // A list the contracts refuse falls back to the adapter's own models.
    }
    claudeCatalogMemo = { native: claudeNativeCatalog, key, value };
    return value;
  }

  function catalogOfEngine(engine: GuildEngine): ModelCatalog {
    return engine === "claude" ? claudeCatalogProjection() : isAddonEngine(engine) ? addonState(engine).catalog : modelCatalog;
  }

  /**
   * The one place a session's config options are stored, so a Claude model list is never missed. Only a native
   * process may set the native Claude catalog, the same rule as the account label (D-062, D-064).
   */
  function applySessionOptions(
    controller: RuntimeController,
    options: readonly RuntimeConfigOption[],
    /** The catalog a session reported when it started: it lists the efforts of every model. */
    startCatalog?: ModelCatalog,
  ): void {
    controller.sessionConfigOptions = options;
    if (controller.engine === "claude") {
      if (!controller.routedProcess) noteClaudeNativeCatalog(deriveClaudeModelCatalog(options), controller.pickerModelIds);
      syncClaudePermissionModes(controller, options);
    } else if (controller.engine === "codex") {
      noteAddonCatalog("codex", startCatalog ?? deriveCodexModelCatalog(options), startCatalog !== undefined);
      syncClaudePermissionModes(controller, options);
    }
  }

  /**
   * The permission mode of an adapter session (Claude, Codex) is its `mode` config option; the session's mode list
   * (`activeTask.sessionModes`) follows it, also when the adapter reported no list of its own.
   */
  function syncClaudePermissionModes(controller: RuntimeController, options: readonly RuntimeConfigOption[]): void {
    const option = options.find((candidate) => candidate.category === "mode");
    if (option === undefined || option.type !== "select") return;
    const choices = option.choices.form === "flat"
      ? option.choices.options
      : option.choices.groups.flatMap((group) => group.options);
    const modes = controller.sessionModes;
    if (modes === null || modes === undefined) {
      controller.sessionModes = Object.freeze({
        currentModeId: option.currentValue,
        availableModes: Object.freeze(choices.map((choice) => Object.freeze({
          id: choice.value,
          name: choice.name,
          ...(choice.description === undefined ? {} : { description: choice.description }),
        }))),
      });
    } else if (modes.currentModeId !== option.currentValue && choices.some((choice) => choice.value === option.currentValue)) {
      controller.sessionModes = Object.freeze({ ...modes, currentModeId: option.currentValue });
    }
  }

  /** Task override, then the global default, then the runtime default (a catalog fact, not a setting). */
  function desiredSelection(taskId: TaskId, settings = store.loadAppSettings()): Readonly<{
    selection: ReturnType<typeof resolveEffectiveSelection>;
    contextWindow: number | null;
  }> {
    const override = readOncePerBuild(`rts:${taskId}`, () => store.loadTaskRuntimeSettings(taskId));
    const taskEngine = readOncePerBuild(`engine:${taskId}`, () => engineOfTask(taskId));
    if (taskEngine === "claude") {
      return Object.freeze({
        selection: resolveClaudeSelection(
          override === undefined ? undefined : { modelId: override.modelId, reasoningEffort: override.reasoningEffort },
          { modelId: settings.claudeModel, reasoningEffort: settings.claudeEffort },
        ),
        contextWindow: null,
      });
    }
    if (isAddonEngine(taskEngine)) {
      // The same order as the Grok resolution, over the engine's own list: task override, the engine default of the
      // settings, then the engine's own pick (the model its session started on, a catalog fact).
      const defaults = settings.engineDefaults[taskEngine];
      return Object.freeze({
        selection: resolveEffectiveSelection({
          ...(override === undefined
            ? {}
            : { task: { modelId: override.modelId, reasoningEffort: override.reasoningEffort } }),
          global: { modelId: defaults.model, reasoningEffort: defaults.reasoningEffort },
          catalog: addonState(taskEngine).catalog,
        }),
        contextWindow: null,
      });
    }
    return Object.freeze({
      selection: resolveEffectiveSelection({
        ...(override === undefined
          ? {}
          : { task: { modelId: override.modelId, reasoningEffort: override.reasoningEffort } }),
        global: { modelId: settings.grokModel, reasoningEffort: settings.reasoningEffort },
        catalog: modelCatalog,
      }),
      contextWindow: override?.contextWindow ?? null,
    });
  }

  /** Claude's own aliases: a choice before the adapter has reported its list, validated by the Claude grammar. */
  const NATIVE_CLAUDE_ALIASES: ReadonlySet<string> = new Set(["default", "opus", "sonnet", "haiku", "fable"]);

  /** The adapter-reported Claude models (group `claude`): never a routed or a Grok model. */
  function nativeClaudeModels(): ModelCatalog["models"] {
    return claudeNativeCatalog.models.filter((model) => modelGroupOf(model) === "claude");
  }

  /** The adapter's own default among its own models, or null while nothing has been reported. */
  function nativeRuntimeDefaultId(): string | null {
    const native = nativeClaudeModels();
    if (native.length === 0) return null;
    return runtimeDefaultModelOf({ ...claudeNativeCatalog, models: native })?.id ?? null;
  }

  /** An official Grok model id that no router source claims: it can never be a Claude model. */
  function isGrokOnlyModelId(modelId: string): boolean {
    return isOfficialGrokModelId(modelId) && !routedModels().some((model) => model.id === modelId);
  }

  /** A stored Claude choice, or null for one that cannot belong to a Claude task. */
  function claudeChoiceOrNull(modelId: string | null | undefined): string | null {
    return modelId === null || modelId === undefined || isGrokOnlyModelId(modelId) ? null : modelId;
  }

  /**
   * Whether a Claude task or default may store this model. The adapter's list and the router's
   * models are the choices; before the adapter reported its list (a task that has not started),
   * its own aliases are accepted too: they are applied when the session starts, and the existing
   * `model_selection_failed` path answers if the adapter then does not offer one.
   */
  function claudeModelStorable(modelId: string): boolean {
    if (isGrokOnlyModelId(modelId)) return false;
    const offered = claudeCatalogProjection();
    if (offered.models.some((model) => model.id === modelId)) return true;
    if (nativeClaudeModels().length === 0 && NATIVE_CLAUDE_ALIASES.has(modelId)) return true;
    return offered.models.length === 0;
  }

  /**
   * Whether a task or the settings of an add-on engine may store this model: one its own sessions listed. Before
   * any session reported a list there is nothing to choose from; the picker's "default model" row then clears the
   * choice instead.
   */
  function addonModelStorable(engine: GuildAddonEngine, modelId: string): boolean {
    return addonState(engine).catalog.models.some((model) => model.id === modelId);
  }

  /**
   * Same order as the Grok resolution. The effort is not reconciled with the catalog: the adapter
   * reports efforts only for the model that is selected, and the effort list of a model a session
   * has not switched to yet is only known after the switch.
   */
  function resolveClaudeSelection(
    task: Readonly<{ modelId: string | null; reasoningEffort: string | null }> | undefined,
    global: Readonly<{ modelId: string | null; reasoningEffort: string | null }>,
  ): ReturnType<typeof resolveEffectiveSelection> {
    const taskPinned = task !== undefined && (task.modelId !== null || task.reasoningEffort !== null);
    const globalPinned = global.modelId !== null || global.reasoningEffort !== null;
    return Object.freeze({
      // The runtime default of a Claude task is Claude's own pick (the adapter's list) or nothing,
      // which reads "Claude Code default model": never a routed model, never a Grok one.
      modelId: claudeChoiceOrNull(task?.modelId) ?? claudeChoiceOrNull(global.modelId) ?? nativeRuntimeDefaultId(),
      reasoningEffort: task?.reasoningEffort ?? global.reasoningEffort ?? null,
      source: taskPinned ? "task" as const : globalPinned ? "global" as const : "runtime" as const,
    });
  }

  /** A task takes a model change only between turns: no run, queue, permission or start in flight. */
  function taskSelectionCanChange(taskId: TaskId): boolean {
    if (managementOperationActive) return false;
    const controller = controllers.get(taskId);
    if (
      controller !== undefined &&
      ((controller.startOperation !== undefined && !controller.startIsPrewarm) ||
        controller.promptRunId !== undefined ||
        controller.activeRunId !== undefined ||
        controller.sendsInFlight > 0 ||
        controller.pendingPermissions.size > 0)
    ) {
      return false;
    }
    try {
      const run = readOncePerBuild(`restore:${taskId}`, () => store.restoreTask(taskId)).currentRun;
      return (run === undefined || TERMINAL_RUN_STATES.has(run.state)) &&
        readOncePerBuild(`queue:${taskId}`, () => store.listQueuedTurns(taskId)).length === 0;
    } catch {
      return false;
    }
  }

  /**
   * What the task runs on: the stored selection, or the session's own model and effort when nothing is pinned or the
   * session refused the stored one.
   */
  function appliedSelection(
    taskId: TaskId,
    controller: RuntimeController | undefined,
  ): Omit<TaskModelSelectionProjection, "canChange"> {
    const { selection } = desiredSelection(taskId);
    const live = controller?.session === undefined
      ? undefined
      : sessionSelectionOf(controller.sessionConfigOptions);
    const showLive = live !== undefined && (selection.source === "runtime" || controller?.selectionRefused === true);
    return Object.freeze({
      modelId: (showLive ? live.modelId : undefined) ?? selection.modelId,
      reasoningEffort: (showLive ? live.reasoningEffort : undefined) ?? selection.reasoningEffort,
      source: selection.source,
    });
  }

  function modelSelectionProjection(
    taskId: TaskId,
    controller: RuntimeController | undefined,
  ): TaskModelSelectionProjection {
    return Object.freeze({
      ...appliedSelection(taskId, controller),
      canChange: taskSelectionCanChange(taskId),
    });
  }

  /**
   * The name the picker shows for the model a Run is about to start on: the catalog's display name, which for an
   * Online or Local model is the model's own label (its source's label is only the picker's description of it).
   * The Claude Default row stands for a model and takes that model's name when the adapter says it; when it does
   * not, the Run gets no label rather than a vague one.
   */
  function appliedModelLabel(taskId: TaskId, controller: RuntimeController): string | undefined {
    const modelId = appliedSelection(taskId, controller).modelId;
    if (modelId === null) return undefined;
    const model = catalogOfEngine(controller.engine).models.find((candidate) => candidate.id === modelId);
    if (model === undefined) return undefined;
    const name = model.id === CLAUDE_DEFAULT_MODEL_ID && modelGroupOf(model) === "claude"
      ? modelNameFromDescription(model.description)
      : model.name;
    const label = name?.trim();
    return label === undefined || label.length === 0 ? undefined : label.slice(0, 128);
  }

  /** Writes the Run's model label once its selection is applied and before its prompt goes out. Never blocks the turn. */
  function recordRunModel(taskId: TaskId, controller: RuntimeController, runId: RunId): void {
    try {
      const label = appliedModelLabel(taskId, controller);
      if (label !== undefined) store.recordRunModelLabel({ taskId, runId, label });
    } catch {
      logRuntime({ category: "runtime", event: "run_model_label_failed", taskId, runId });
    }
  }

  function runModelProjections(
    taskId: TaskId,
    entries: readonly ConversationEntryRecord[],
  ): readonly RunModelProjection[] {
    const runIds = [...new Set(entries.flatMap((entry) => entry.runId === undefined ? [] : [entry.runId]))];
    if (runIds.length === 0) return Object.freeze([]);
    return Object.freeze(store.listRunModelLabels(taskId, runIds).map((row) =>
      Object.freeze({ runId: row.runId, label: row.label })));
  }

  /**
   * A turn never goes out on the wrong backend (docs/20 3.3, D-062): the process mode must be the mode of the
   * selected model, a routed process for an Online / Local model and a native one for anything else. The
   * start gating (`ensureSession`, `sessionStartPending`) restarts a process whose mode is stale before a
   * prompt launches; this is the last check before the prompt is written, and a mismatch ends the turn with
   * the same named failure as any other selection that cannot be applied.
   */
  function assertProcessModeMatchesModel(taskId: TaskId, controller: RuntimeController, session: AcpV1AdapterSession): void {
    if (controller.engine !== "claude" || controller.routedProcess === selectsRoutedModel(taskId)) return;
    controller.selectionRefused = true;
    logRuntime({ category: "runtime", event: "model_switch_refused", taskId, sessionId: session.sessionId, reason: "process_mode_mismatch" });
    throw new Error(MODEL_SELECTION_FAILED);
  }

  /**
   * Brings a live idle session to the stored selection. Grok: refusals and unknown options never abort
   * a start or a prompt; the session keeps its previous selection and the projection reports it.
   * Claude and Codex (docs/20 3.3, docs/21 4.3): a turn never runs on a model other than the selected one, so a
   * model the session does not offer, or a `set_config_option` that fails, throws `model_selection_failed`.
   * The session is left as it is and the projection shows what it really runs.
   */
  async function reconcileRuntimeSelection(
    taskId: TaskId,
    controller: RuntimeController,
    adapter: RuntimeAdapterPort,
    session: AcpV1AdapterSession,
  ): Promise<RuntimeSelectionOutcome["status"] | "skipped"> {
    const { selection, contextWindow } = desiredSelection(taskId);
    // A native session resumed after routed turns comes back on the model of its last turn, an Online / Local
    // id that Claude does not offer; the runtime default is applied then, also when nothing is pinned (D-062).
    const strayRoutedModel = controller.engine === "claude" && !controller.routedProcess &&
      selection.modelId !== null && sessionModelUnoffered(controller.sessionConfigOptions);
    // Nothing pinned anywhere: the runtime default (or the session's own earlier choice) stays.
    if ((selection.source === "runtime" && !strayRoutedModel) || adapter.state !== "ready") {
      controller.selectionRefused = false;
      return "skipped";
    }
    const strict = isAdapterEngine(controller.engine);
    // A request the runtime refused or could not take is a failed application; a value the session
    // never offered is judged from its option list below.
    let requestFailed = false;
    const tracked = <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
      async (...args: Args): Promise<Result> => {
        try {
          return await call(...args);
        } catch (cause: unknown) {
          requestFailed = true;
          throw cause;
        }
      };
    const port = strict
      ? {
          setConfigOption: tracked(adapter.setConfigOption.bind(adapter)),
          setModel: tracked(adapter.setModel.bind(adapter)),
        }
      : adapter;
    const refuseSelection = (reason: string): Error => {
      controller.selectionRefused = true;
      logRuntime({ category: "runtime", event: "model_switch_refused", taskId, sessionId: session.sessionId, reason });
      return new Error(MODEL_SELECTION_FAILED);
    };
    let outcome: RuntimeSelectionOutcome;
    try {
      outcome = await applyRuntimeSelection({
        port,
        session,
        options: controller.sessionConfigOptions,
        catalog: catalogOfEngine(controller.engine),
        desired: { modelId: selection.modelId, reasoningEffort: selection.reasoningEffort, contextWindow },
        currentContextWindow: controller.contextWindowUsage?.size ?? controller.contextWindowSize,
      });
    } catch (cause: unknown) {
      if (!strict) throw cause;
      throw refuseSelection("request_failed");
    }
    applySessionOptions(controller, outcome.options);
    if (outcome.status !== "refused" && outcome.contextWindow !== undefined) {
      controller.contextWindowSize = outcome.contextWindow;
    }
    if (strict && outcome.status === "refused") {
      // An effort the model simply does not offer is no failed request: the projection reports it.
      const modelOption = selectionOptionsOf(outcome.options).model;
      const modelMissing = selection.modelId !== null &&
        (modelOption === undefined || !optionOffers(modelOption, selection.modelId));
      if (requestFailed || modelMissing) throw refuseSelection(outcome.reason);
    }
    controller.selectionRefused = outcome.status === "refused";
    if (outcome.status !== "unchanged") {
      logRuntime({
        category: "runtime",
        event: outcome.status === "refused" ? "model_switch_refused" : "model_switch_applied",
        taskId,
        sessionId: session.sessionId,
        ...(outcome.status === "refused" ? { reason: outcome.reason } : {}),
      });
    }
    return outcome.status;
  }

  /**
   * The adapter engines take their permission mode as a config option (docs/20 3.2), from the engine's settings
   * (Claude: its own; Codex: `engineDefaults.codex`). A mode the session does not offer is skipped; a refused or
   * failed change throws, because a resumed session keeps the mode it last had (Codex even forgets it: a resumed
   * session comes back in Auto review) and must never run looser than the setting says.
   */
  async function reconcileAdapterPermissionMode(
    taskId: TaskId,
    controller: RuntimeController,
    adapter: RuntimeAdapterPort,
    session: AcpV1AdapterSession,
  ): Promise<void> {
    if (!isAdapterEngine(controller.engine) || adapter.state !== "ready") return;
    const settings = store.loadAppSettings();
    const desired = isAddonEngine(controller.engine)
      ? settings.engineDefaults[controller.engine].permissionMode
      : settings.claudePermissionMode;
    const modeOption = controller.sessionConfigOptions.find((option) => option.category === "mode");
    const current = modeOption?.type === "select"
      ? modeOption.currentValue
      : controller.sessionModes?.currentModeId;
    if (current === desired) return;
    if (modeOption === undefined || !optionOffers(modeOption, desired)) {
      logRuntime({ category: "runtime", event: "permission_mode_unavailable", taskId, sessionId: session.sessionId });
      return;
    }
    applySessionOptions(controller, await adapter.setPermissionMode(session, desired));
    logRuntime({ category: "runtime", event: "permission_mode_applied", taskId, sessionId: session.sessionId });
  }

  /**
   * What a new or resumed session is started with. Grok: the effort, only when the model a new session
   * starts on offers it. Every engine: the browser MCP server when the agent advertised HTTP MCP.
   * Claude: the `modelPicker` that adds a routed task's Online / Local models to the model list.
   */
  async function sessionStartOptionsFor(
    taskId: TaskId,
    controller: RuntimeController,
    initialized: AcpV1InitializeResult,
    picker: readonly RoutedModelInfo[] | undefined,
  ): Promise<AcpV1SessionStartOptions | undefined> {
    const mcpServers = await browserMcpServersFor(taskId, initialized);
    if (controller.engine === "claude") {
      controller.pickerModelIds = new Set(picker?.map((model) => model.id));
      return mcpServers.length === 0 && picker === undefined
        ? undefined
        : Object.freeze({
            ...(mcpServers.length === 0 ? {} : { mcpServers }),
            ...(picker === undefined
              ? {}
              : {
                  claudeCodeOptions: Object.freeze({
                    settings: Object.freeze({
                      modelPicker: Object.freeze({
                        options: Object.freeze(picker.map((model) => Object.freeze({
                          model: model.id,
                          label: model.label.slice(0, 128),
                        }))),
                      }),
                    }),
                  }),
                }),
          });
    }
    // Codex takes no start options but the browser server: its effort and model are config options set afterwards.
    if (isAddonEngine(controller.engine)) {
      return mcpServers.length === 0 ? undefined : Object.freeze({ mcpServers });
    }
    const { selection } = desiredSelection(taskId);
    const startModel = grokModelById(modelCatalog, modelCatalog.runtimeDefaultModelId);
    const reasoningEffort = selection.source === "runtime" || selection.reasoningEffort === null ||
        (startModel !== undefined && !modelSupportsReasoningEffort(startModel, selection.reasoningEffort))
      ? undefined
      : selection.reasoningEffort;
    return reasoningEffort === undefined && mcpServers.length === 0
      ? undefined
      : Object.freeze({
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(mcpServers.length === 0 ? {} : { mcpServers }),
        });
  }

  /** The loopback browser server (docs/20 3.5); an engine that did not advertise HTTP MCP is never given it. */
  async function browserMcpServersFor(
    taskId: TaskId,
    initialized: AcpV1InitializeResult,
  ): Promise<readonly AcpV1HttpMcpServer[]> {
    if (browserMcp === undefined || initialized.mcpCapabilities?.http !== true) return Object.freeze([]);
    try {
      const { url } = await browserMcp.ensureStarted();
      return Object.freeze([Object.freeze({
        type: "http" as const,
        name: "guild-browser",
        url,
        headers: Object.freeze([]),
      })]);
    } catch {
      // The browser is an extra: a task still starts without it. The URL carries a token and is never logged.
      logRuntime({ category: "runtime", event: "browser_mcp_unavailable", taskId });
      return Object.freeze([]);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Guild 3.0 Claude engine: native and routed sessions, login state (docs/20 3.2, 3.3)
  // ---------------------------------------------------------------------------------------------

  /**
   * `setTaskRuntimeSettings` stored a selection whose mode (native Claude or routed Online / Local) is not
   * the live process's; the restart follows, outside the command queue (D-062).
   */
  type ModeSelectionRestart = Readonly<{
    status: "mode_restart";
    previous: ReturnType<GuildPersistence["loadTaskRuntimeSettings"]>;
  }>;

  /** The session runs on a model its own model list does not offer (the codec marks it `unlisted`). */
  function sessionModelUnoffered(options: readonly RuntimeConfigOption[]): boolean {
    const modelOption = selectionOptionsOf(options).model;
    return modelOption?.type === "select" && modelOption.unlisted === true;
  }

  /** Whether the session's own model list offers this model. */
  function optionOffersModel(options: readonly RuntimeConfigOption[], modelId: string): boolean {
    const modelOption = selectionOptionsOf(options).model;
    return modelOption !== undefined && optionOffers(modelOption, modelId);
  }

  type RoutedStart = Readonly<{
    extraEnvironment: Readonly<Record<string, string>>;
    picker: readonly RoutedModelInfo[];
  }>;

  /** The task's selected model is one of the router's Online / Local models. */
  function selectsRoutedModel(taskId: TaskId): boolean {
    const { selection } = desiredSelection(taskId);
    return selection.source !== "runtime" &&
      selection.modelId !== null &&
      routedModels().some((model) => model.id === selection.modelId);
  }

  async function ensureRouterReady(taskId: TaskId): Promise<string> {
    try {
      if (modelRouterHost === undefined) throw new Error("model_router_missing");
      // The URL carries the router token: it goes into the process environment and nowhere else.
      return (await modelRouterHost.ensureStarted()).baseUrl;
    } catch {
      logRuntime({ category: "runtime", event: "model_router_unavailable", taskId });
      throw new Error(MODEL_ROUTER_UNAVAILABLE);
    }
  }

  /**
   * Whether this process start is routed, and with what. The mode of every start (the switch, a crash
   * recovery, a Guild restart) follows the task's selected model: an Online / Local model starts a routed
   * process, anything else a native one (docs/20 3.3, D-062). The marker is committed by
   * `commitRoutedMarker`, once a routed process has taken the selection and before any turn.
   */
  async function planRoutedStart(taskId: TaskId, controller: RuntimeController): Promise<RoutedStart | undefined> {
    if (controller.engine !== "claude" || !selectsRoutedModel(taskId)) return undefined;
    const baseUrl = await ensureRouterReady(taskId);
    // Claude Code's background requests and subagents follow the routed model applied at this start (D-061).
    const selected = desiredSelection(taskId).selection.modelId;
    const modelId = selected !== null && routedModels().some((model) => model.id === selected) ? selected : undefined;
    return Object.freeze({
      extraEnvironment: routedClaudeEnvironment({ baseUrl, modelId }),
      picker: Object.freeze([...routedModels()]),
    });
  }

  /**
   * The routed marker: the task has used an Online / Local model at least once (D-062), so every process of
   * it keeps OpenViking capture off from now on. It is committed only after a routed process took the
   * selection and before the session is handed out, so a task is never marked without a routed process
   * behind it and no routed turn precedes the marker.
   */
  function commitRoutedMarker(taskId: TaskId): void {
    if (store.loadTaskMetadata(taskId).routedAtMs !== undefined) return;
    store.markTaskRouted({ taskId });
    logRuntime({ category: "runtime", event: "task_routed", taskId });
  }

  /**
   * An idle session whose process is not the one the selected model needs (docs/20 3.3, D-062): a native
   * process for an Online / Local model, a routed one for a Claude model or no choice, or a routed process
   * whose model list lacks the selected routed model. The process restarts between turns, in the mode the
   * selection needs, and resumes the same session (`startRuntime`). `ownStart` is the restart itself asking
   * again just before it closes the process. Selection changes are refused while a turn runs, so this never
   * interrupts one.
   */
  function processModeRestartNeeded(taskId: TaskId, controller: RuntimeController, ownStart = false): boolean {
    if (controller.engine !== "claude") return false;
    if (
      controller.adapter?.state !== "ready" ||
      controller.session === undefined ||
      (controller.startOperation !== undefined && !ownStart) ||
      controller.activeRunId !== undefined ||
      controller.promptRunId !== undefined ||
      controller.pendingPermissions.size > 0
    ) return false;
    const wantsRouted = selectsRoutedModel(taskId);
    if (controller.routedProcess !== wantsRouted) return true;
    if (!wantsRouted) return false;
    // A routed process started before the selected model joined its model list (a source added since).
    const modelId = desiredSelection(taskId).selection.modelId;
    const modelOption = selectionOptionsOf(controller.sessionConfigOptions).model;
    return modelId !== null && (modelOption === undefined || !optionOffers(modelOption, modelId));
  }

  /**
   * A start (a mode switch included) is in flight or due for this task, so the session in hand may be about
   * to go away: no prompt may launch on it. The caller goes through `ensureSession` instead, which joins the
   * start and hands out the session it produced (docs/20 3.3).
   */
  function sessionStartPending(taskId: TaskId, controller: RuntimeController): boolean {
    return controller.startOperation !== undefined || processModeRestartNeeded(taskId, controller);
  }

  /**
   * A Claude session that never had a prompt has no transcript, so the adapter cannot resume it,
   * and nothing in it is lost: restore_pending -> broken -> replacement_pending without a question.
   */
  function replaceRunlessSession(
    taskId: TaskId,
    binding: ReturnType<GuildPersistence["loadSessionBinding"]>,
  ): ReturnType<GuildPersistence["loadSessionBinding"]> {
    if (
      binding.sessionId === undefined ||
      binding.adapterEpoch === undefined ||
      binding.restoreAttemptId === undefined
    ) return binding;
    requireBinding(store.applySessionBinding({
      taskId,
      event: {
        type: "restore_failed",
        sessionId: binding.sessionId,
        adapterEpoch: binding.adapterEpoch,
        attemptId: binding.restoreAttemptId,
        idempotencyKey: key("session-runless-restore-skipped"),
      },
    }));
    requireBinding(store.applySessionBinding({
      taskId,
      event: { type: "authorize_replacement", idempotencyKey: key("session-runless-replacement") },
    }));
    logRuntime({ category: "session", event: "runless_session_replaced", taskId, sessionId: binding.sessionId });
    return store.loadSessionBinding(taskId);
  }

  function isAuthRequired(controller: RuntimeController, cause: unknown): boolean {
    return isAdapterEngine(controller.engine) &&
      cause instanceof AcpV1AdapterError &&
      cause.code === "auth_required";
  }

  /**
   * An adapter-engine start that got no answer in time, or lost its process before one: the session may well
   * exist, so nothing is declared lost and the next send resumes it (docs/20 3.2). Transport loss
   * counts only while a session is being resumed or loaded; during initialize or session/new it is
   * a process that cannot start, which is a plain failure.
   */
  function isStartInterruption(controller: RuntimeController, startStage: string, cause: unknown): boolean {
    if (!isAdapterEngine(controller.engine) || !(cause instanceof AcpV1AdapterError)) return false;
    if (cause.code === "request_timeout") return true;
    return cause.code === "transport_lost" && (startStage === "session_resume" || startStage === "session_load");
  }

  function noteLoginRequired(engine: GuildEngine): void {
    if (isAddonEngine(engine)) addonState(engine).auth = Object.freeze({ kind: "none" });
    else claudeAuth = Object.freeze({ kind: "none" });
    schedulePhasePublish();
  }

  /**
   * Display-only engine signals: the Claude account summary and frames dropped after a turn ended. A routed process
   * authenticates with Guild's throwaway token, so what it reports about its identity says nothing about the
   * subscription: only a native process may set or change the account summary, and the label stays what a native
   * process last reported (D-062).
   */
  function observeEngineSignal(taskId: TaskId, signal: EngineSignal): void {
    if (signal.type === "auth_status" && signal.engine !== "claude") {
      // An add-on engine has no routed mode: what it says about its account is its account.
      const engine = signal.engine;
      if (!isAddonEngine(engine)) return;
      const state = addonState(engine);
      const label = signal.status.label ?? signal.status.plan;
      if (state.auth?.kind === signal.status.kind && state.auth.label === label) return;
      state.auth = Object.freeze({ kind: signal.status.kind, ...(label === undefined ? {} : { label }) });
      schedulePhasePublish();
      return;
    }
    if (signal.type === "auth_status") {
      if (controllers.get(taskId)?.routedProcess === true) return;
      const label = signal.status.label ?? signal.status.plan;
      if (claudeAuth?.kind === signal.status.kind && claudeAuth.label === label) return;
      claudeAuth = Object.freeze({ kind: signal.status.kind, ...(label === undefined ? {} : { label }) });
      schedulePhasePublish();
      return;
    }
    logRuntime({
      category: "runtime",
      event: "late_update_dropped",
      taskId,
      sessionId: signal.sessionId,
      updateKind: signal.discriminator,
    });
  }

  function runPhaseProjection(
    controller: RuntimeController | undefined,
    activeRunState: string | undefined,
  ): RunPhaseProjection | undefined {
    if (controller === undefined || !controller.phase.active) return undefined;
    const running = activeRunState === "starting" ||
      activeRunState === "running" ||
      activeRunState === "awaiting_permission";
    const preRun = controller.sendsInFlight > 0 ||
      (controller.startOperation !== undefined && !controller.startIsPrewarm);
    if (!running && !preRun) {
      // A turn that ended (or was cancelled) must not leave a phase behind.
      controller.phase.end();
      return undefined;
    }
    return controller.phase.snapshot();
  }

  /** Feeds one input to the task's phase tracker and publishes when the visible phase changed. */
  function notePhase(controller: RuntimeController, input: RunPhaseInput, atMs = performance.now()): void {
    if (controller.phase.apply(input, atMs)) schedulePhasePublish();
  }

  function beginPhase(controller: RuntimeController, stage?: RunPhaseStage): void {
    const idle = controller.activeRunId === undefined &&
      controller.promptRunId === undefined &&
      controller.sendsInFlight <= 1 &&
      (controller.startOperation === undefined || controller.startIsPrewarm);
    // A tracker left over from a turn that never reported its end is stale.
    if (controller.phase.active && idle) controller.phase.end();
    if (!controller.phase.active) {
      controller.phase.begin(performance.now(), Date.now(), stage);
      schedulePhasePublish();
    }
  }

  function endPhase(controller: RuntimeController): void {
    if (!controller.phase.active) return;
    controller.phase.end();
    schedulePhasePublish();
  }

  /** Phase changes are display-only: a non-structural projection that never reloads the sidebar. */
  function schedulePhasePublish(): void {
    if (closed || closing || maintenance) return;
    void requestPublish().catch(() => {
      logRuntime({ category: "runtime", event: "stream_projection_failed" });
    });
  }

  function observeRuntimeSignal(
    taskId: TaskId,
    controller: RuntimeController,
    envelope: XaiSignalEnvelope,
  ): void {
    const { signal } = envelope;
    if (signal.kind === "models_update") {
      noteModelCatalog(signal.catalog);
      return;
    }
    const session = controller.session;
    // Child (worker/reviewer) sessions are multiplexed on the same connection; their signals are not this turn's.
    if (envelope.sessionId !== null && session !== undefined && envelope.sessionId !== session.sessionId) return;
    if (signal.kind === "session_interjection") {
      noteInterjectionEcho(taskId, controller, signal.interjectionId);
      return;
    }
    if (signal.kind === "sessions_changed") {
      if (session === undefined) return;
      const own = signal.sessions.filter((entry) => entry.sessionId === session.sessionId);
      if (own.length === 0) return;
      notePhase(controller, { type: "signal", signal: { kind: "sessions_changed", sessions: own } }, envelope.receivedMonotonicMs);
      return;
    }
    notePhase(controller, { type: "signal", signal }, envelope.receivedMonotonicMs);
  }

  // ---------------------------------------------------------------------------------------------
  // F2 run checkpoints, changed files, rewind
  // ---------------------------------------------------------------------------------------------

  const checkpoints = options.checkpoints ?? gitCheckpoints;
  const checkpointStartBoundMs = options.checkpointStartBoundMs ?? DEFAULT_CHECKPOINT_START_BOUND_MS;
  const checkpointEndTimeoutMs = options.checkpointEndTimeoutMs ?? DEFAULT_CHECKPOINT_END_TIMEOUT_MS;

  /** A misbehaving port can never hold the task's captures: past the deadline the capture counts as timed out. */
  async function captureWithin(
    input: Parameters<GitCheckpointPort["capture"]>[0],
    timeoutMs: number,
  ): ReturnType<GitCheckpointPort["capture"]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        checkpoints.capture({ ...input, limits: { ...input.limits, timeoutMs } }),
        new Promise<Awaited<ReturnType<GitCheckpointPort["capture"]>>>((resolve) => {
          timer = setTimeout(() => resolve({ status: "unavailable", reason: "timeout" }), timeoutMs + 1_000);
          timer.unref?.();
        }),
      ]);
    } catch {
      return { status: "unavailable", reason: "git_failed" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function enqueueCheckpointOperation(
    controller: RuntimeController,
    operation: () => Promise<void>,
  ): Promise<void> {
    const run = controller.checkpointTail.then(operation, operation);
    controller.checkpointTail = run.catch(() => undefined);
    return run;
  }

  /**
   * The folder everything about a task is scoped to: its session's working directory, attachment
   * and tool-media boundaries, the files it may open, and the checkpoints. The workspace folder,
   * or for a task with an isolated worktree (F3) that worktree.
   */
  function taskRootPath(taskId: TaskId, workspacePath: string): string {
    return worktreeManager.rootPathOf(taskId, workspacePath);
  }

  function workspacePathOf(taskId: TaskId): string {
    return taskRootPath(taskId, store.loadWorkspace(store.loadTaskMetadata(taskId).workspaceId).canonicalPath);
  }

  /** A Run, a queued turn or a send in flight keeps Apply and Discard from touching the worktree. */
  function worktreeRunBlock(taskId: TaskId): "run_active" | undefined {
    return rewindBlockedReason(taskId, controllers.get(taskId)) === undefined ? undefined : "run_active";
  }

  function completeCheckpointUnavailable(taskId: TaskId, runId: RunId, reason: string): void {
    try {
      store.completeRunCheckpoint({
        taskId, runId, status: "unavailable", detail: reason, files: [], filesTotal: 0, adds: 0, dels: 0,
      });
    } catch {
      logRuntime({ category: "runtime", event: "checkpoint_record_failed", taskId, runId });
    }
    schedulePublish();
  }

  /**
   * Captures the working tree for a Run that was just created, before its prompt is sent: the
   * row is created synchronously (so the Run has its ordinal), the capture runs after earlier
   * captures of the task, gets a short head start before `session/prompt` and otherwise runs
   * alongside it (see awaitStartCheckpointBriefly and markStartCheckpointLateIfPending).
   * Never throws; a failed capture only marks the Run's checkpoint unavailable.
   */
  function beginRunCheckpoint(taskId: TaskId, controller: RuntimeController, runId: RunId): Promise<void> {
    let ordinal: number;
    let cwd: string;
    try {
      cwd = workspacePathOf(taskId);
      const planned = checkpointRef(taskId, store.nextRunCheckpointOrdinal(taskId) * 2 - 1);
      if (planned === undefined) throw new Error("checkpoint_ref_invalid");
      ordinal = store.createRunCheckpoint({ taskId, runId, startRef: planned, status: "capturing" }).ordinal;
    } catch {
      logRuntime({ category: "runtime", event: "checkpoint_begin_failed", taskId, runId });
      return Promise.resolve();
    }
    const operation = enqueueCheckpointOperation(controller, async () => {
      if (controller.abandonedCheckpointStarts.delete(runId)) {
        completeCheckpointUnavailable(taskId, runId, "timeout");
        return;
      }
      const result = await captureWithin(
        { cwd, taskId, ordinal: ordinal * 2 - 1 },
        checkpointStartBoundMs,
      );
      if (controller.abandonedCheckpointStarts.delete(runId)) {
        // The prompt already went out, so this tree may contain the agent's first edits.
        completeCheckpointUnavailable(taskId, runId, "timeout");
        return;
      }
      if (result.status !== "captured") completeCheckpointUnavailable(taskId, runId, result.reason);
    });
    controller.checkpointStarts.set(runId, operation);
    void operation.then(
      () => controller.settledCheckpointStarts.add(runId),
      () => controller.settledCheckpointStarts.add(runId),
    );
    return operation;
  }

  /**
   * Gives the start capture a short head start (typical repositories finish in 0.1-0.3 s) without
   * ever holding a send for long; a capture still running afterwards is guarded by
   * markStartCheckpointLateIfPending instead of being dropped.
   */
  async function awaitStartCheckpointBriefly(controller: RuntimeController, runId: RunId): Promise<void> {
    const start = controller.checkpointStarts.get(runId);
    if (start === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      start.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CHECKPOINT_START_WAIT_MS);
        timer.unref?.();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  /**
   * A start capture that outlives the brief wait keeps running alongside the prompt: the model needs
   * seconds before its first tool call. If a tool call does arrive first, the tree may already
   * contain the agent's edits, so that Run's start checkpoint is discarded (marked unavailable)
   * instead of offering a wrong rewind.
   */
  function markStartCheckpointLateIfPending(controller: RuntimeController, runId: RunId): void {
    if (!controller.checkpointStarts.has(runId) || controller.settledCheckpointStarts.has(runId)) return;
    controller.abandonedCheckpointStarts.add(runId);
  }

  /** After the Run is terminal: the end checkpoint and the stored changed-file summary. */
  function finishRunCheckpoint(taskId: TaskId, controller: RuntimeController, runId: RunId): Promise<void> {
    const operation = enqueueCheckpointOperation(controller, async () => {
      try {
        controller.checkpointStarts.delete(runId);
        controller.abandonedCheckpointStarts.delete(runId);
        controller.settledCheckpointStarts.delete(runId);
        const row = store.loadRunCheckpoint(taskId, runId);
        if (row === undefined || row.status !== "capturing" || row.startRef === undefined) return;
        const cwd = workspacePathOf(taskId);
        const end = await captureWithin({ cwd, taskId, ordinal: row.ordinal * 2 }, checkpointEndTimeoutMs);
        if (end.status !== "captured") {
          completeCheckpointUnavailable(taskId, runId, end.reason);
          return;
        }
        const summary = await checkpoints.summarize({
          cwd,
          fromRef: row.startRef,
          toRef: end.ref,
          maxFiles: GUILD_RUN_FILE_LIST_LIMIT,
          timeoutMs: checkpointEndTimeoutMs,
        });
        if (summary.status !== "ok") {
          completeCheckpointUnavailable(taskId, runId, summary.reason);
          return;
        }
        const files: GitChangedFileRecord[] = [];
        let budget = CHECKPOINT_FILES_JSON_BUDGET;
        for (const file of summary.summary.files) {
          const cost = file.path.length + (file.oldPath?.length ?? 0) + 80;
          if (cost > budget) break;
          budget -= cost;
          files.push(file);
        }
        store.completeRunCheckpoint({
          taskId,
          runId,
          endRef: end.ref,
          status: "captured",
          files,
          filesTotal: summary.summary.filesTotal,
          adds: summary.summary.adds,
          dels: summary.summary.dels,
        });
        await publish();
      } catch {
        logRuntime({ category: "runtime", event: "checkpoint_finish_failed", taskId, runId });
      }
    });
    return operation;
  }

  /**
   * One place for everything that follows a Run reaching a terminal state: Steer rows nobody
   * echoed, the end checkpoint and, for a turn the runtime started itself, the next queued turn.
   */
  function afterRunEnded(
    taskId: TaskId,
    controller: RuntimeController,
    runId: RunId,
    options: { readonly dispatchQueue: boolean } = { dispatchQueue: controller.promptRunId === undefined },
  ): void {
    try {
      settleInterjectionsAfterRun(taskId, runId);
    } catch {
      logRuntime({ category: "runtime", event: "interjection_settle_failed", taskId, runId });
    }
    void finishRunCheckpoint(taskId, controller, runId);
    // F3: the chip's numbers move with the Run's edits.
    void worktreeManager.refresh(taskId, { force: true }).catch(() => undefined);
    if (options.dispatchQueue) void scheduleQueuedDispatch(taskId);
  }

  function runCheckpointProjections(
    taskId: TaskId,
    entries: readonly ConversationEntryRecord[],
  ): readonly RunCheckpointProjection[] {
    const runIds = [...new Set(entries.flatMap((entry) => entry.runId === undefined ? [] : [entry.runId]))];
    if (runIds.length === 0) return Object.freeze([]);
    return Object.freeze(store.listRunCheckpoints(taskId, runIds).map(projectRunCheckpoint));
  }

  function projectRunCheckpoint(row: RunCheckpointRecord): RunCheckpointProjection {
    const files = row.files.slice(0, GUILD_RUN_FILE_LIST_LIMIT).map((file) => Object.freeze({
      path: file.path,
      ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      status: file.status,
      adds: file.adds,
      dels: file.dels,
    }));
    return Object.freeze({
      runId: row.runId,
      ordinal: row.ordinal,
      status: row.status,
      ...(row.detail === undefined ? {} : { detail: row.detail as GuildCheckpointUnavailableReason }),
      rolledBack: row.status === "rolled_back",
      filesChanged: row.filesTotal,
      adds: row.adds,
      dels: row.dels,
      files: Object.freeze(files),
      filesTruncated: row.filesTotal > files.length,
    });
  }

  function rewindBlockedReason(
    taskId: TaskId,
    controller: RuntimeController | undefined,
  ): "run_active" | "queue_not_empty" | undefined {
    const run = readOncePerBuild(`restore:${taskId}`, () => store.restoreTask(taskId)).currentRun;
    if (
      (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) ||
      (controller !== undefined &&
        (controller.promptRunId !== undefined ||
          controller.activeRunId !== undefined ||
          controller.sendsInFlight > 0 ||
          controller.pendingPermissions.size > 0 ||
          (controller.startOperation !== undefined && !controller.startIsPrewarm)))
    ) return "run_active";
    if (readOncePerBuild(`queue:${taskId}`, () => store.listQueuedTurns(taskId)).length > 0) {
      return "queue_not_empty";
    }
    return undefined;
  }

  function rewindAvailability(
    taskId: TaskId,
    controller: RuntimeController | undefined,
  ): RewindAvailabilityProjection {
    const blocked = rewindBlockedReason(taskId, controller);
    if (blocked !== undefined) return Object.freeze({ available: false, reason: blocked });
    if (store.countRunCheckpoints(taskId) === 0) {
      return Object.freeze({ available: false, reason: "no_checkpoints" });
    }
    return Object.freeze({ available: true });
  }

  async function loadRunFileDiff(request: LoadRunFileDiffRequest): Promise<LoadRunFileDiffResponse> {
    assertOpen();
    const { taskId, runId } = request;
    const row = store.loadRunCheckpoint(taskId, runId);
    if (
      row === undefined ||
      row.startRef === undefined ||
      row.endRef === undefined ||
      (row.status !== "captured" && row.status !== "rolled_back")
    ) {
      return Object.freeze({ status: "unavailable" as const, reason: "no_checkpoint" as const });
    }
    const file = row.files.find((candidate) => candidate.path === request.path);
    // The stored list is capped; a path past the cap is still a path the checkpoints can answer for.
    if (file === undefined && row.filesTotal <= row.files.length) {
      return Object.freeze({ status: "unavailable" as const, reason: "not_in_run" as const });
    }
    const result = await checkpoints.fileDiff({
      cwd: workspacePathOf(taskId),
      fromRef: row.startRef,
      toRef: row.endRef,
      path: request.path,
      ...(file?.oldPath === undefined ? {} : { oldPath: file.oldPath }),
      maxBytes: GUILD_RUN_FILE_DIFF_MAX_BYTES,
    });
    if (result.status !== "ok") {
      return Object.freeze({
        status: "unavailable" as const,
        reason: result.reason === "invalid_path" ? "not_in_run" as const : "git_failed" as const,
      });
    }
    return Object.freeze({
      status: "ok" as const,
      path: request.path,
      diff: result.diff,
      binary: result.binary,
      truncated: result.truncated,
    });
  }

  // ---------------------------------------------------------------------------------------------
  // F3 per-task worktrees: preview, apply, discard
  // ---------------------------------------------------------------------------------------------

  async function previewWorktreeApply(taskId: TaskId): Promise<PreviewWorktreeApplyResponse> {
    assertOpen();
    // Read-only, so it does not hold the command queue; it still refuses while a Run is active.
    return worktreeManager.preview(taskId);
  }

  /** Commits and merges while holding the command queue, so no Run can start in the task meanwhile. */
  async function applyWorktree(taskId: TaskId): Promise<ApplyWorktreeResponse> {
    assertOpen();
    return enqueueCommand(async () => {
      assertOpen();
      const title = store.loadTaskMetadata(taskId).title;
      const outcome = await worktreeManager.apply(taskId, title);
      if (outcome.status !== "applied") return outcome;
      logRuntime({ category: "runtime", event: "worktree_applied", taskId });
      await publish();
      return Object.freeze({ ...outcome, task: taskView(taskId) });
    });
  }

  async function discardWorktree(taskId: TaskId): Promise<DiscardWorktreeResponse> {
    assertOpen();
    return enqueueCommand(async () => {
      assertOpen();
      const outcome = await worktreeManager.discard(taskId);
      if (outcome.status !== "discarded") return outcome;
      // The folder the session ran in is gone: stop its process so nothing keeps it open.
      const controller = controllers.get(taskId);
      if (controller !== undefined) {
        await closeController(taskId, controller);
        controllers.delete(taskId);
      }
      logRuntime({ category: "runtime", event: "worktree_discarded", taskId });
      await publish();
      return Object.freeze({ status: "discarded" as const, task: taskView(taskId) });
    });
  }

  type RewindConversation =
    | Readonly<{ available: true; mode: "conversation_only" | "all"; targetPromptIndex: number }>
    | Readonly<{ available: false; reason: "unsupported" | "runtime_unavailable" }>;

  type RewindFiles =
    | Readonly<{
        kind: "git";
        startRef: string;
        restore: readonly string[];
        remove: readonly string[];
        conflicts: readonly RewindConflictProjection[];
      }>
    | Readonly<{
        kind: "none";
        reason: GuildCheckpointUnavailableReason | "no_checkpoint_row";
        runtimeRestore: readonly string[];
        runtimeConflicts: readonly string[];
      }>;

  type RewindEvaluation =
    | Readonly<{ ok: false; reason: GuildRewindRefusalReason }>
    | Readonly<{
        ok: true;
        cwd: string;
        sessionId: string | undefined;
        adapter: RuntimeAdapterPort | undefined;
        rolledBackRuns: readonly RunId[];
        promptText: string;
        conversation: RewindConversation;
        files: RewindFiles;
      }>;

  function runPromptText(taskId: TaskId, runId: RunId): string {
    const entry = allTaskConversationEntries(taskId).find((candidate) =>
      candidate.runId === runId &&
      candidate.kind === "user" &&
      candidate.status === "complete" &&
      candidate.metadata["interjection"] !== true &&
      (candidate.metadata["hidden"] !== true || candidate.metadata["replayAnchor"] === true));
    if (entry === undefined) return "";
    if (entry.metadata["continuousInternal"] === true) {
      return metadataString(entry, "continuousDisplayText") ?? "";
    }
    return entry.text;
  }

  function usedRecoveryCapsule(taskId: TaskId, runId: RunId): boolean {
    return allTaskConversationEntries(taskId).some((entry) =>
      entry.runId === runId &&
      entry.kind === "notice" &&
      entry.metadata["outboundPromptProof"] === true &&
      entry.metadata["outboundPromptRecoveryCapsule"] === true);
  }

  /** What the runtime's own picker shows for a prompt: its first non-empty line, 57 characters at most. */
  function previewMatches(preview: unknown, text: string): boolean {
    if (typeof preview !== "string" || preview.length === 0) return true;
    const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
    return preview.endsWith("...") ? line.startsWith(preview.slice(0, -3)) : line === preview;
  }

  async function extensionRequest(
    adapter: RuntimeAdapterPort,
    controller: RuntimeController,
    method: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly status: "ok"; readonly result: Record<string, unknown> } | { readonly status: "unsupported" } | { readonly status: "failed" }> {
    try {
      const outcome = await adapter.sendExtensionRequest(method, params, { timeoutMs: REWIND_REQUEST_TIMEOUT_MS });
      if (outcome.status === "unsupported") {
        controller.rewindUnsupported = true;
        return { status: "unsupported" };
      }
      const result = outcome.result;
      return result !== null && typeof result === "object" && !Array.isArray(result)
        ? { status: "ok", result: result as Record<string, unknown> }
        : { status: "failed" };
    } catch {
      return { status: "failed" };
    }
  }

  /**
   * Everything a rewind to "before this Run" depends on, computed without changing anything:
   * the Runs it undoes, the official prompt index and whether it lines up with Guild's own turn
   * order, the official dry run, and the git file plan. Runs inside the command queue.
   */
  async function evaluateRewind(
    taskId: TaskId,
    runId: RunId,
    live: Readonly<{ adapter: RuntimeAdapterPort; session: AcpV1AdapterSession }> | undefined,
  ): Promise<RewindEvaluation> {
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (metadata.disposition !== "active" || workspace.disposition !== "active") {
      return { ok: false, reason: "runtime_unavailable" };
    }
    const controller = controllers.get(taskId);
    const blocked = rewindBlockedReason(taskId, controller);
    if (blocked !== undefined) return { ok: false, reason: blocked };
    const runs = store.listTaskRuns(taskId);
    const targetIndex = runs.findIndex((candidate) => candidate.runId === runId);
    if (targetIndex < 0) return { ok: false, reason: "run_not_found" };
    const target = runs[targetIndex]!;
    const rolledBack = new Set<string>(store.listRolledBackRunIds(taskId));
    if (rolledBack.has(runId)) return { ok: false, reason: "already_rolled_back" };
    const later = runs.slice(targetIndex + 1).filter((candidate) => !rolledBack.has(candidate.runId));
    const rolledBackRuns = Object.freeze([target.runId, ...later.map((candidate) => candidate.runId)]);
    const promptText = runPromptText(taskId, runId);
    const cwd = taskRootPath(taskId, workspace.canonicalPath);

    // Files first: they decide which official mode applies.
    const rows = new Map(store.listRunCheckpoints(taskId).map((row) => [row.runId, row]));
    const targetRow = rows.get(runId);
    const usable = (row: RunCheckpointRecord | undefined): row is RunCheckpointRecord & { startRef: string; endRef: string } =>
      row !== undefined && row.status === "captured" && row.startRef !== undefined && row.endRef !== undefined;
    let files: RewindFiles;
    if (usable(targetRow)) {
      const refs: RunRefs[] = [{ startRef: targetRow.startRef, endRef: targetRow.endRef }];
      for (const laterRun of later) {
        const row = rows.get(laterRun.runId);
        if (usable(row)) refs.push({ startRef: row.startRef, endRef: row.endRef });
      }
      const planned = await checkpoints.planRewind({ cwd, runs: refs });
      files = planned.status === "ok"
        ? {
            kind: "git",
            startRef: targetRow.startRef,
            restore: planned.plan.restore,
            remove: planned.plan.remove,
            conflicts: planned.plan.conflicts,
          }
        : { kind: "none", reason: planned.reason, runtimeRestore: [], runtimeConflicts: [] };
    } else {
      files = {
        kind: "none",
        reason: targetRow === undefined
          ? "no_checkpoint_row"
          : ((targetRow.detail as GuildCheckpointUnavailableReason | undefined) ?? "capture_skipped"),
        runtimeRestore: [],
        runtimeConflicts: [],
      };
    }

    // Files only (docs/20 3.8): the conversation of an engine without `_x.ai/rewind/*` stays as it is.
    if (!engineProfileFor(metadata.engine).features.conversationRewind) {
      return {
        ok: true, cwd, sessionId: undefined, adapter: undefined, rolledBackRuns, promptText, files,
        conversation: { available: false, reason: "unsupported" },
      };
    }
    if (live === undefined) {
      return {
        ok: true, cwd, sessionId: undefined, adapter: undefined, rolledBackRuns, promptText, files,
        conversation: { available: false, reason: "runtime_unavailable" },
      };
    }
    const { adapter, session } = live;
    if (target.sessionId !== session.sessionId) return { ok: false, reason: "session_replaced" };
    const counted = runs.filter((candidate) =>
      candidate.sessionId === session.sessionId && candidate.promptAccepted && !rolledBack.has(candidate.runId));
    const targetPromptIndex = counted.findIndex((candidate) => candidate.runId === runId);
    if (targetPromptIndex < 0) return { ok: false, reason: "prompt_index_mismatch" };
    const runtimeController = controllerFor(taskId);
    const points = await extensionRequest(adapter, runtimeController, "_x.ai/rewind/points", {
      sessionId: session.sessionId,
    });
    if (points.status === "unsupported") {
      return {
        ok: true, cwd, sessionId: session.sessionId, adapter, rolledBackRuns, promptText, files,
        conversation: { available: false, reason: "unsupported" },
      };
    }
    if (points.status === "failed") {
      return {
        ok: true, cwd, sessionId: session.sessionId, adapter, rolledBackRuns, promptText, files,
        conversation: { available: false, reason: "runtime_unavailable" },
      };
    }
    const officialPoints = points.result["rewind_points"];
    if (
      !Array.isArray(officialPoints) ||
      officialPoints.length !== counted.length ||
      officialPoints.some((point, index) =>
        point === null || typeof point !== "object" ||
        (point as { prompt_index?: unknown }).prompt_index !== index)
    ) {
      return { ok: false, reason: "prompt_index_mismatch" };
    }
    const targetPoint = officialPoints[targetPromptIndex] as { prompt_preview?: unknown };
    if (!usedRecoveryCapsule(taskId, runId) && !previewMatches(targetPoint.prompt_preview, promptText)) {
      return { ok: false, reason: "prompt_index_mismatch" };
    }
    const mode: "conversation_only" | "all" = files.kind === "git" ? "conversation_only" : "all";
    const dryRun = await extensionRequest(adapter, runtimeController, "_x.ai/rewind/execute", {
      sessionId: session.sessionId,
      targetPromptIndex,
      mode,
      force: false,
    });
    if (dryRun.status !== "ok") {
      return dryRun.status === "unsupported"
        ? {
            ok: true, cwd, sessionId: session.sessionId, adapter, rolledBackRuns, promptText, files,
            conversation: { available: false, reason: "unsupported" },
          }
        : { ok: false, reason: "runtime_refused" };
    }
    const dryError = dryRun.result["error"];
    const dryConflicts = Array.isArray(dryRun.result["conflicts"]) ? dryRun.result["conflicts"] : [];
    // A dry run reports external modifications as an `error`; they are only a warning for mode `all`.
    if (
      dryRun.result["target_prompt_index"] !== targetPromptIndex ||
      (typeof dryError === "string" && dryError.length > 0 && dryConflicts.length === 0)
    ) {
      return { ok: false, reason: "runtime_refused" };
    }
    if (files.kind === "none") {
      const strings = (value: unknown): readonly string[] =>
        Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").slice(0, REWIND_FILE_LIST_LIMIT) : [];
      files = {
        ...files,
        runtimeRestore: strings(dryRun.result["clean_files"]),
        runtimeConflicts: Object.freeze(dryConflicts.flatMap((entry) =>
          entry !== null && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
            ? [(entry as { path: string }).path]
            : []).slice(0, REWIND_FILE_LIST_LIMIT)),
      };
    }
    return {
      ok: true, cwd, sessionId: session.sessionId, adapter, rolledBackRuns, promptText, files,
      conversation: { available: true, mode, targetPromptIndex },
    };
  }

  function irreversibleEffects(
    locale: GuildLocale,
    files: RewindFiles,
  ): readonly Readonly<{ kind: GuildRewindIrreversibleKind; text: string }>[] {
    const zh = locale === "zh-CN";
    const items: { kind: GuildRewindIrreversibleKind; text: string }[] = [
      {
        kind: "network_and_mcp_effects",
        text: zh
          ? "已发出的网络请求、MCP 工具调用以及对其他服务造成的影响无法撤销。"
          : "Network requests, MCP tool calls and anything already sent to other services cannot be undone.",
      },
      {
        kind: "git_commits_and_pushes",
        text: zh
          ? "命令已经做出的 git 提交、推送、分支和 stash 变更不会被撤销。"
          : "Git commits, pushes, branch changes and stashes made by commands are not undone.",
      },
      {
        kind: "memory_writes",
        text: zh
          ? "Agent 写入记忆的内容不会被撤销。"
          : "Notes the agent wrote to memory are not undone.",
      },
    ];
    if (files.kind === "none") {
      items.push({
        kind: "shell_file_changes_without_git",
        text: zh
          ? "没有 git 检查点：命令行造成的文件改动无法还原，只有 Grok 编辑工具留下的快照可以还原。"
          : "There is no git checkpoint, so file changes made by shell commands cannot be reverted; only the runtime's own edit-tool snapshots can be restored.",
      });
    }
    return Object.freeze(items.map((item) => Object.freeze(item)));
  }

  function rewindPlanProjection(
    runId: RunId,
    evaluation: Extract<RewindEvaluation, { readonly ok: true }>,
    locale: GuildLocale,
  ): PreviewRewindResponse {
    const files = evaluation.files.kind === "git"
      ? Object.freeze({
          kind: "git" as const,
          restore: Object.freeze(evaluation.files.restore.slice(0, REWIND_FILE_LIST_LIMIT)),
          remove: Object.freeze(evaluation.files.remove.slice(0, REWIND_FILE_LIST_LIMIT)),
          conflicts: Object.freeze(evaluation.files.conflicts.slice(0, REWIND_FILE_LIST_LIMIT)),
          truncated: evaluation.files.restore.length > REWIND_FILE_LIST_LIMIT ||
            evaluation.files.remove.length > REWIND_FILE_LIST_LIMIT ||
            evaluation.files.conflicts.length > REWIND_FILE_LIST_LIMIT,
        })
      : Object.freeze({
          kind: "none" as const,
          reason: evaluation.files.reason,
          runtimeRestore: evaluation.files.runtimeRestore,
          runtimeConflicts: evaluation.files.runtimeConflicts,
        });
    const scope: GuildRewindScope = evaluation.conversation.available ? "conversation_and_files" : "files_only";
    return Object.freeze({
      status: "ready" as const,
      plan: Object.freeze({
        runId,
        scope,
        conversation: evaluation.conversation.available
          ? Object.freeze({
              available: true as const,
              mode: evaluation.conversation.mode,
              targetPromptIndex: evaluation.conversation.targetPromptIndex,
              promptText: evaluation.promptText,
            })
          : Object.freeze({ available: false as const, reason: evaluation.conversation.reason }),
        rolledBackRuns: evaluation.rolledBackRuns,
        files,
        cannotUndo: irreversibleEffects(locale, evaluation.files),
      }),
    });
  }

  /** Brings the task's official session up so `_x.ai/rewind/*` has a resident session to talk to. */
  async function liveForRewind(
    taskId: TaskId,
  ): Promise<Readonly<{ adapter: RuntimeAdapterPort; session: AcpV1AdapterSession }> | undefined> {
    // An engine without conversation rewind is not started just to be asked.
    if (!engineProfileFor(engineOfTask(taskId)).features.conversationRewind) return undefined;
    try {
      const session = await ensureSession(taskId);
      const adapter = controllerFor(taskId).adapter;
      return adapter === undefined ? undefined : Object.freeze({ adapter, session });
    } catch {
      return undefined;
    }
  }

  async function previewRewind(taskId: TaskId, runId: RunId): Promise<PreviewRewindResponse> {
    assertOpen();
    const live = await liveForRewind(taskId);
    return enqueueCommand(async () => {
      assertOpen();
      const evaluation = await evaluateRewind(taskId, runId, live);
      if (!evaluation.ok) return Object.freeze({ status: "refused" as const, reason: evaluation.reason });
      if (!evaluation.conversation.available && evaluation.files.kind !== "git") {
        // Neither half can be undone, so there is nothing to offer.
        return Object.freeze({
          status: "refused" as const,
          reason: evaluation.conversation.reason === "unsupported"
            ? "conversation_rewind_unsupported" as const
            : "runtime_unavailable" as const,
        });
      }
      return rewindPlanProjection(runId, evaluation, store.loadAppSettings().locale);
    });
  }

  async function executeRewind(request: ExecuteRewindRequest): Promise<ExecuteRewindResponse> {
    assertOpen();
    const { taskId, runId } = request;
    const scope: GuildRewindScope = request.scope ?? "conversation_and_files";
    const live = scope === "conversation_and_files" ? await liveForRewind(taskId) : undefined;
    return enqueueCommand(async () => {
      assertOpen();
      const refused = (reason: GuildRewindRefusalReason): ExecuteRewindResponse =>
        Object.freeze({ status: "refused" as const, reason });
      const evaluation = await evaluateRewind(taskId, runId, live);
      if (!evaluation.ok) return refused(evaluation.reason);
      if (scope === "conversation_and_files" && !evaluation.conversation.available) {
        return refused(evaluation.conversation.reason === "unsupported"
          ? "conversation_rewind_unsupported"
          : "runtime_unavailable");
      }
      if (scope === "files_only" && evaluation.files.kind !== "git") return refused("nothing_to_rewind");
      const gitFiles = evaluation.files.kind === "git" ? evaluation.files : undefined;
      const conflicts = gitFiles?.conflicts ?? [];
      if (
        conflicts.some((conflict) => conflict.reason === "modified_after_run") &&
        request.overwriteConflicts !== true
      ) {
        return Object.freeze({ status: "conflicts" as const, conflicts: Object.freeze([...conflicts]) });
      }
      const controller = controllerFor(taskId);
      const reverted: string[] = [];
      // 1. The conversation first: if the runtime refuses, no file has been touched.
      if (scope === "conversation_and_files" && evaluation.conversation.available) {
        const outcome = await extensionRequest(evaluation.adapter!, controller, "_x.ai/rewind/execute", {
          sessionId: evaluation.sessionId,
          targetPromptIndex: evaluation.conversation.targetPromptIndex,
          mode: evaluation.conversation.mode,
          force: true,
        });
        if (outcome.status !== "ok" || outcome.result["success"] !== true) {
          return refused(outcome.status === "unsupported" ? "conversation_rewind_unsupported" : "runtime_refused");
        }
        if (Array.isArray(outcome.result["reverted_files"])) {
          for (const entry of outcome.result["reverted_files"]) {
            if (typeof entry === "string" && reverted.length < REWIND_FILE_LIST_LIMIT) reverted.push(entry);
          }
        }
        controller.contextWindowUsage = undefined;
        persistedContextTokens.delete(taskId);
      }
      // 2. The files, from Guild's start checkpoint of the first undone Run.
      let restored: readonly string[] = reverted;
      let removed: readonly string[] = [];
      let failed: readonly Readonly<{ path: string; reason: string }>[] = [];
      if (gitFiles !== undefined) {
        try {
          const result = await checkpoints.restore({
            cwd: evaluation.cwd,
            sourceRef: gitFiles.startRef,
            restore: gitFiles.restore,
            remove: gitFiles.remove,
          });
          restored = result.restored;
          removed = result.removed;
          failed = result.failed;
        } catch {
          // The conversation is already rewound; report every file as not restored and carry on.
          restored = [];
          removed = [];
          failed = [...gitFiles.restore, ...gitFiles.remove]
            .slice(0, REWIND_FILE_LIST_LIMIT)
            .map((path) => ({ path, reason: "restore_failed" }));
        }
      }
      // 3. Guild's own record: the Runs stay for audit and are marked, the prompt returns to the draft.
      let draftRestored = false;
      if (scope === "conversation_and_files") {
        store.markRunsRolledBack({ taskId, runIds: evaluation.rolledBackRuns });
        if (evaluation.promptText.trim().length > 0) {
          const current = store.loadDraft(taskId);
          if (current === undefined) {
            store.saveDraft({ taskId, expectedRevision: 0, text: evaluation.promptText });
            draftRestored = true;
          } else if (!current.text.includes(evaluation.promptText)) {
            store.saveDraft({
              taskId,
              expectedRevision: current.revision,
              text: `${evaluation.promptText}\n\n${current.text}`,
            });
            draftRestored = true;
          } else {
            draftRestored = true;
          }
        }
      }
      const locale = store.loadAppSettings().locale;
      store.createConversationEntry({
        taskId,
        entryId: unique("rewind"),
        kind: "notice",
        text: rewindNoticeText(locale, scope, evaluation.rolledBackRuns.length, restored.length, removed.length, failed.length),
        metadata: { rewind: true, rewindScope: scope },
        status: "complete",
      });
      await publish();
      return Object.freeze({
        status: "rolled_back" as const,
        scope,
        rolledBackRuns: scope === "conversation_and_files" ? evaluation.rolledBackRuns : Object.freeze([]),
        restoredFiles: Object.freeze([...restored]),
        removedFiles: Object.freeze([...removed]),
        failedFiles: Object.freeze([...failed]),
        draftRestored,
      });
    });
  }

  function rewindNoticeText(
    locale: GuildLocale,
    scope: GuildRewindScope,
    runs: number,
    restored: number,
    removed: number,
    failed: number,
  ): string {
    const failure = failed === 0 ? "" : locale === "zh-CN" ? `，${failed} 个文件未能还原` : `; ${failed} file${failed === 1 ? "" : "s"} could not be restored`;
    if (locale === "zh-CN") {
      return scope === "files_only"
        ? `已把文件还原到该回合开始之前（还原 ${restored} 个，删除 ${removed} 个）；对话保持不变${failure}。`
        : `已回退到该回合开始之前：${runs} 个回合被撤销（还原 ${restored} 个文件，删除 ${removed} 个）${failure}。被撤销的指令已放回输入框。`;
    }
    return scope === "files_only"
      ? `Files were restored to before the Run started (${restored} restored, ${removed} removed); the conversation is unchanged${failure}.`
      : `Rewound to before the Run started: ${runs} Run${runs === 1 ? "" : "s"} undone (${restored} file${restored === 1 ? "" : "s"} restored, ${removed} removed)${failure}. The reverted instruction is back in the draft.`;
  }

  // ---------------------------------------------------------------------------------------------
  // F4 Steer
  // ---------------------------------------------------------------------------------------------

  function noteInterjectionEcho(
    taskId: TaskId,
    controller: RuntimeController,
    interjectionId: string,
  ): void {
    controller.echoedInterjections.add(interjectionId);
    while (controller.echoedInterjections.size > ECHOED_INTERJECTION_LIMIT) {
      const oldest = controller.echoedInterjections.values().next().value;
      if (oldest === undefined) break;
      controller.echoedInterjections.delete(oldest);
    }
    void enqueueCommand(async () => {
      if (closed || closing || maintenance) return;
      if (store.loadInterjection(taskId, interjectionId)?.state !== "pending") return;
      store.markInterjectionDelivered({ taskId, interjectionId });
      await publish();
    }).catch(() => {
      logRuntime({ category: "runtime", event: "interjection_echo_failed", taskId });
    });
  }

  /**
   * Steer is offered while the runtime holds an accepted, running turn of this task and the
   * installed process has not answered -32601 for `_x.ai/interject`.
   */
  function steerAvailability(
    taskId: TaskId,
    controller: RuntimeController | undefined,
  ): SteerAvailabilityProjection {
    const run = readOncePerBuild(`restore:${taskId}`, () => store.restoreTask(taskId)).currentRun;
    if (run === undefined || TERMINAL_RUN_STATES.has(run.state)) {
      return Object.freeze({ available: false, reason: "no_active_run" });
    }
    if (
      (run.state !== "running" && run.state !== "awaiting_permission") ||
      !run.promptAccepted
    ) {
      return Object.freeze({ available: false, reason: "turn_not_steerable" });
    }
    if (
      controller === undefined ||
      controller.adapter?.state !== "ready" ||
      controller.session === undefined ||
      controller.activeRunId !== run.runId
    ) {
      return Object.freeze({ available: false, reason: "runtime_unavailable" });
    }
    // Claude: Steer exists only when the adapter advertised `_meta.steering` at initialize.
    if (controller.steerUnsupported || !controller.adapter.features.steer) {
      return Object.freeze({ available: false, reason: "unsupported" });
    }
    return Object.freeze({ available: true });
  }

  function steerFallbackReason(
    availability: Extract<SteerAvailabilityProjection, { readonly available: false }>,
  ): GuildSteerFallbackReason {
    switch (availability.reason) {
      case "no_active_run": return "turn_not_running";
      case "turn_not_steerable": return "turn_not_steerable";
      case "unsupported": return "unsupported";
      case "runtime_unavailable": return "runtime_error";
    }
  }

  function steerFallbackNotice(
    reason: GuildSteerFallbackReason,
    locale: GuildLocale,
    engine: GuildEngine,
  ): string {
    const name = engineName(engine);
    if (locale === "zh-CN") {
      switch (reason) {
        case "unsupported": return `当前 ${name} 版本不支持向运行中的回合插话，这条消息已改为普通消息处理（排队或在回合结束后发送）。`;
        case "turn_not_running": return "回合已经结束，这条消息已改为普通消息发送。";
        case "turn_not_steerable": return "当前回合暂时不能插话（尚未开始或正在取消），这条消息已改为普通消息处理。";
        case "runtime_error": return `${name} 没有接受这次插话，这条消息已改为普通消息处理。`;
      }
    }
    switch (reason) {
      case "unsupported": return `This ${name} version cannot take a message into a running turn, so it was handled as an ordinary message (queued, or sent when the turn ends).`;
      case "turn_not_running": return "The turn had already ended, so the message was sent as an ordinary message.";
      case "turn_not_steerable": return "The turn cannot take a message right now (it has not started, or it is being cancelled), so the message was handled as an ordinary message.";
      case "runtime_error": return `${name} did not accept the interjection, so the message was handled as an ordinary message.`;
    }
  }

  type SteerSend =
    | Readonly<{ kind: "unavailable"; reason: GuildSteerFallbackReason; hadRun: boolean }>
    | Readonly<{
        kind: "send";
        interjectionId: string;
        adapter: RuntimeAdapterPort;
        controller: RuntimeController;
        session: AcpV1AdapterSession;
      }>;

  /** Records the intent and returns what to send, or says why Steer is not possible. Runs in the command queue. */
  function prepareSteer(taskId: TaskId, text: string): SteerSend {
    assertOpen();
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (metadata.disposition !== "active" || workspace.disposition !== "active") {
      throw new Error("task_not_writable");
    }
    const controller = controllers.get(taskId);
    const availability = steerAvailability(taskId, controller);
    const run = store.restoreTask(taskId).currentRun;
    if (!availability.available) {
      return Object.freeze({
        kind: "unavailable" as const,
        reason: steerFallbackReason(availability),
        hadRun: run !== undefined && !TERMINAL_RUN_STATES.has(run.state),
      });
    }
    const interjectionId = `interject-${randomUUID()}`;
    store.beginInterjection({ taskId, interjectionId, runId: run!.runId, text });
    return Object.freeze({
      kind: "send" as const,
      interjectionId,
      adapter: controller!.adapter!,
      controller: controller!,
      session: controller!.session!,
    });
  }

  /** `not_running`: Claude answered `promptRequired`; nothing was sent, the turn had already ended. */
  type SteerRequestOutcome = "accepted" | "unsupported" | "failed" | "not_running";

  async function sendInterjection(
    send: Extract<SteerSend, { readonly kind: "send" }>,
    text: string,
  ): Promise<SteerRequestOutcome> {
    const timeoutMs = options.steerRequestTimeoutMs ?? DEFAULT_STEER_REQUEST_TIMEOUT_MS;
    try {
      if (isAdapterEngine(send.adapter.engine)) {
        // `_session/steering`: the agent tells us whether the text went into the running turn.
        const result = await send.adapter.steer(send.session, text, { timeoutMs });
        if (result.status === "unsupported") return "unsupported";
        if (result.outcome === "injected") return "accepted";
        // Claude never starts a turn for a request that asked for `promptRequired`; the Codex adapter ignores that
        // request and does, so it reports `startedNewTurn` after cancelling that turn: the text goes out as an
        // ordinary message below, exactly once.
        return result.outcome === "promptRequired" ? "not_running" : "failed";
      }
      const outcome = await send.adapter.sendExtensionRequest(
        "_x.ai/interject",
        { sessionId: send.session.sessionId, text, interjectionId: send.interjectionId },
        { timeoutMs },
      );
      if (outcome.status === "unsupported") return "unsupported";
      const status = (outcome.result as { readonly status?: unknown } | null)?.status;
      return status === undefined || status === "queued" ? "accepted" : "failed";
    } catch {
      return "failed";
    }
  }

  function steerFallbackOf(outcome: Exclude<SteerRequestOutcome, "accepted">): GuildSteerFallbackReason {
    return outcome === "unsupported" ? "unsupported" : outcome === "not_running" ? "turn_not_running" : "runtime_error";
  }

  async function steerMessage(taskId: TaskId, rawText: string): Promise<SteerMessageResponse> {
    assertOpen();
    if (managementOperationActive) throw new Error("grok_management_operation_active");
    // The runtime trims queued text; sending the trimmed text keeps a missed Steer's later turn matchable.
    const text = rawText.trim();
    if (text.length === 0) throw new Error("steer_message_empty");
    const prepared = await enqueueCommand(async () => prepareSteer(taskId, text));
    if (prepared.kind === "unavailable") {
      // Only a turn that was running (or about to run) has anything to annotate.
      if (prepared.hadRun) await recordSteerFallback(taskId, text, prepared.reason, undefined);
      const sent = await service.sendMessage(taskId, text);
      return sent.status === "queued"
        ? Object.freeze({ status: "queued" as const, queueId: sent.queueId, reason: prepared.reason })
        : Object.freeze({ status: "started" as const, runId: sent.runId, reason: prepared.reason });
    }
    const outcome = await sendInterjection(prepared, text);
    if (outcome === "accepted") {
      // The runtime holds the message now; a failure to record it must not send it a second time.
      await enqueueCommand(async () => {
        assertOpen();
        store.commitInterjectionSent({
          taskId,
          interjectionId: prepared.interjectionId,
          entryId: unique("user"),
          delivered: prepared.controller.echoedInterjections.has(prepared.interjectionId),
        });
        await publish();
      });
      return Object.freeze({ status: "steered" as const, interjectionId: prepared.interjectionId });
    }
    const reason = steerFallbackOf(outcome);
    if (outcome === "unsupported") prepared.controller.steerUnsupported = true;
    await recordSteerFallback(taskId, text, reason, prepared.interjectionId);
    const sent = await service.sendMessage(taskId, text);
    return sent.status === "queued"
      ? Object.freeze({ status: "queued" as const, queueId: sent.queueId, reason })
      : Object.freeze({ status: "started" as const, runId: sent.runId, reason });
  }

  /** Records why a Steer became an ordinary message: the interjection row and an explanatory notice. */
  async function recordSteerFallback(
    taskId: TaskId,
    text: string,
    reason: GuildSteerFallbackReason,
    interjectionId: string | undefined,
  ): Promise<void> {
    await enqueueCommand(async () => {
      if (closed || closing) return;
      let id = interjectionId;
      if (id === undefined) {
        // The request was never sent, so no row exists yet; the Run it targeted is the one to annotate.
        const run = store.restoreTask(taskId).currentRun;
        if (run === undefined) return;
        id = `interject-${randomUUID()}`;
        store.beginInterjection({ taskId, interjectionId: id, runId: run.runId, text });
      }
      store.fallBackInterjection({
        taskId,
        interjectionId: id,
        reason,
        noticeEntryId: unique("steer-fallback"),
        noticeText: steerFallbackNotice(reason, store.loadAppSettings().locale, engineOfTask(taskId)),
      });
      await publish();
    }).catch(() => {
      logRuntime({ category: "runtime", event: "steer_fallback_record_failed", taskId });
    });
  }

  async function convertQueuedTurnToSteer(
    taskId: TaskId,
    queueId: string,
  ): Promise<ConvertQueuedTurnToSteerResponse> {
    assertOpen();
    if (managementOperationActive) throw new Error("grok_management_operation_active");
    const prepared = await enqueueCommand(async () => {
      assertOpen();
      const queued = store.listQueuedTurns(taskId).find((candidate) => candidate.queueId === queueId);
      if (queued === undefined) throw new Error("queued_turn_not_found");
      const text = queued.text.trim();
      return Object.freeze({ queued, text, send: prepareSteer(taskId, text) });
    });
    if (prepared.send.kind === "unavailable") {
      return Object.freeze({ status: "unchanged" as const, reason: prepared.send.reason });
    }
    const send = prepared.send;
    const outcome = await sendInterjection(send, prepared.text);
    return enqueueCommand(async () => {
      assertOpen();
      if (outcome === "accepted") {
        try {
          store.commitInterjectionSent({
            taskId,
            interjectionId: send.interjectionId,
            entryId: unique("user"),
            delivered: send.controller.echoedInterjections.has(send.interjectionId),
            removeQueueId: queueId,
          });
          await publish();
          return Object.freeze({ status: "steered" as const, interjectionId: send.interjectionId });
        } catch {
          // The queued turn was dispatched while the request was in flight. The runtime holds the
          // message too; nothing here can take it back, so the row is closed and the caller told.
          store.failInterjection({ taskId, interjectionId: send.interjectionId, reason: "queue_dispatched" });
          await publish();
          return Object.freeze({ status: "unchanged" as const, reason: "turn_not_running" as const });
        }
      }
      if (outcome === "unsupported") send.controller.steerUnsupported = true;
      const reason = steerFallbackOf(outcome);
      store.failInterjection({ taskId, interjectionId: send.interjectionId, reason });
      await publish();
      return Object.freeze({ status: "unchanged" as const, reason });
    });
  }

  /** The runtime acknowledged these requests but never echoed them; the Run is over, so they count as delivered. */
  function settleInterjectionsAfterRun(taskId: TaskId, runId: RunId): void {
    for (const row of store.listInterjections(taskId)) {
      if (row.runId === runId && row.state === "pending") {
        store.markInterjectionDelivered({ taskId, interjectionId: row.interjectionId });
      }
    }
  }

  function controllerFor(taskId: TaskId): RuntimeController {
    let controller = controllers.get(taskId);
    if (controller === undefined) {
      controller = {
        engine: engineOfTask(taskId),
        pickerModelIds: new Set(),
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
        routedProcess: false,
        startIsPrewarm: false,
        prewarmOnly: false,
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
        phase: createRunPhaseTracker(),
        sendsInFlight: 0,
        selectionRefused: false,
        steerUnsupported: false,
        rewindUnsupported: false,
        echoedInterjections: new Set(),
        checkpointStarts: new Map(),
        abandonedCheckpointStarts: new Set(),
        settledCheckpointStarts: new Set(),
        checkpointTail: Promise.resolve(),
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
        // A pristine task with a worktree is cleaned up by `sweepPristineWorktreeTasks` (async).
        if (worktreeManager.rowOf(task.taskId) !== undefined) continue;
        store.deleteTask({ taskId: task.taskId, expectedRevision: task.revision });
        clearPersistedTaskSelection(task.taskId);
      }
    }
  }

  /**
   * Startup: an untouched task that still has a fresh worktree (the window was closed before the
   * first message) is removed with it, except the one the window reopens on.
   */
  async function sweepPristineWorktreeTasks(): Promise<void> {
    try {
      hydrateActiveTask(store.loadAppSettings());
      for (const taskId of worktreeManager.taskIds()) {
        if (closed || closing || taskId === activeTaskId) continue;
        const status = worktreeManager.statusOf(taskId);
        if (status === undefined || status === "discarded") continue;
        await enqueueCommand(async () => {
          if (closed || closing || taskId === activeTaskId) return;
          if (await discardPristineTask(taskId)) await publish();
        });
      }
    } catch {
      logRuntime({ category: "runtime", event: "worktree_sweep_failed" });
    }
  }

  async function discardPristineTask(taskId: TaskId): Promise<boolean> {
    if (!isPristineNewTask(taskId)) return false;
    // F3: an untouched task takes its fresh worktree with it. One that holds anything (files the
    // owner added by hand, a commit) is kept, and titled with its branch so it shows in the sidebar
    // instead of staying a hidden provisional task.
    const worktreeRow = worktreeManager.rowOf(taskId);
    if (worktreeRow !== undefined && !(await worktreeManager.discardIfUntouched(taskId))) {
      const metadata = store.loadTaskMetadata(taskId);
      store.renameTask({ taskId, expectedRevision: metadata.revision, title: worktreeRow.branch });
      return false;
    }
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

  /** Structural change: new entry, tool/permission/run-state change, sidebar or settings change. */
  function publish(): Promise<void> {
    if (closed || closing || maintenance) return Promise.resolve();
    publishStructural = true;
    return requestPublish();
  }

  function requestPublish(): Promise<void> {
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
            const reuseSidebar = !publishStructural;
            publishStructural = false;
            const buildStartedAt = performance.now();
            const projection = buildBootstrap(false, reuseSidebar);
            lastProjectionBuildMs = performance.now() - buildStartedAt;
            // Deltas are delivered before the snapshot that contains their text.
            flushStreamDeltas();
            for (const listener of [...listeners]) listener(projection);
            lastFullPublishAtMs = performance.now();
            if (streamPublishTimer !== undefined) {
              // This projection already carries every chunk committed so far.
              clearTimeout(streamPublishTimer);
              streamPublishTimer = undefined;
            }
            if (publishQueued) {
              flush();
            } else {
              publishOperation = undefined;
              resolve();
            }
          } catch (cause: unknown) {
            // The failed flush may not have refreshed the sidebar; the next one must rebuild it.
            publishStructural = true;
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

  /** Non-blocking structural publish for callers that sit inside the one-at-a-time update queue. */
  let scheduledPublishObserved: Promise<void> | undefined;
  function schedulePublish(): void {
    // One observed promise per batch; do not retain a handler for every update.
    const operation = publish();
    if (scheduledPublishObserved === operation) return;
    scheduledPublishObserved = operation;
    void operation.then(() => {
      if (scheduledPublishObserved === operation) scheduledPublishObserved = undefined;
    }, () => {
      if (scheduledPublishObserved === operation) scheduledPublishObserved = undefined;
      logRuntime({ category: "runtime", event: "stream_projection_failed" });
    });
  }

  /**
   * Streamed text changes only the tail of one entry, which the delta channel already
   * carries. A full projection is rebuilt at most once per interval (longer when the
   * last build was slow) to refresh derived state and to resynchronize the renderer.
   */
  function scheduleStreamPublish(): void {
    if (streamPublishTimer !== undefined || closed || closing || maintenance) return;
    const interval = Math.max(STREAM_PUBLISH_INTERVAL_MS, lastProjectionBuildMs * 4);
    const wait = Math.max(0, lastFullPublishAtMs + interval - performance.now());
    streamPublishTimer = setTimeout(() => {
      streamPublishTimer = undefined;
      const operation = requestPublish();
      streamPublishOperation = operation;
      void operation.then(() => {
        if (streamPublishOperation === operation) streamPublishOperation = undefined;
      }, () => {
        if (streamPublishOperation === operation) streamPublishOperation = undefined;
        logRuntime({ category: "runtime", event: "stream_projection_failed" });
      });
    }, wait);
  }

  /**
   * Single hook called by the text/thought chunk handler after the chunk is committed.
   * Sends a small delta to the renderer and decides which kind of publish follows.
   */
  function publishStreamChunk(input: Readonly<{
    taskId: TaskId;
    runId: RunId;
    kind: "assistant" | "thought";
    entryId: string;
    text: string;
    created: boolean;
    duplicate: boolean;
    committedLength: number;
  }>): void {
    if (input.duplicate) return;
    emitStreamDelta(input);
    if (input.created) schedulePublish();
    else scheduleStreamPublish();
  }

  function emitStreamDelta(input: Readonly<{
    taskId: TaskId;
    runId: RunId;
    kind: "assistant" | "thought";
    entryId: string;
    text: string;
    created: boolean;
    committedLength: number;
  }>): void {
    let live = liveStreamEntries.get(input.entryId);
    if (live === undefined) {
      live = {
        length: input.created ? 0 : Math.max(0, input.committedLength - input.text.length),
        revision: 0,
      };
      liveStreamEntries.set(input.entryId, live);
      while (liveStreamEntries.size > STREAM_LIVE_ENTRY_LIMIT) {
        const oldest = liveStreamEntries.keys().next().value;
        if (oldest === undefined) break;
        liveStreamEntries.delete(oldest);
      }
    }
    const offset = live.length;
    live.length += input.text.length;
    live.revision += 1;
    if (input.text.length === 0 || deltaListeners.size === 0 || input.taskId !== activeTaskId) return;
    const pending = pendingStreamDeltas.get(input.entryId);
    if (pending === undefined) {
      pendingStreamDeltas.set(input.entryId, {
        taskId: input.taskId,
        runId: input.runId,
        entryId: input.entryId,
        kind: input.kind,
        offset,
        text: input.text,
        revision: live.revision,
      });
    } else {
      pending.text += input.text;
      pending.revision = live.revision;
    }
    if ((pendingStreamDeltas.get(input.entryId)?.text.length ?? 0) >= STREAM_DELTA_FLUSH_CHARS) {
      flushStreamDeltas();
    } else if (streamDeltaTimer === undefined) {
      streamDeltaTimer = setTimeout(flushStreamDeltas, STREAM_DELTA_COALESCE_MS);
    }
  }

  function flushStreamDeltas(): void {
    if (streamDeltaTimer !== undefined) {
      clearTimeout(streamDeltaTimer);
      streamDeltaTimer = undefined;
    }
    if (pendingStreamDeltas.size === 0) return;
    const batch = [...pendingStreamDeltas.values()];
    pendingStreamDeltas.clear();
    if (closed || closing || maintenance) return;
    for (const pending of batch) {
      if (pending.taskId !== activeTaskId) continue;
      const event: StreamDeltaEvent = Object.freeze({
        taskId: pending.taskId,
        runId: pending.runId,
        entryId: pending.entryId,
        kind: pending.kind,
        offset: pending.offset,
        appendText: pending.text,
        revision: pending.revision,
        updatedAtMs: Date.now(),
      });
      for (const listener of [...deltaListeners]) {
        try {
          listener(event);
        } catch {
          // A delivery fault must never fault task persistence; the next projection resynchronizes.
        }
      }
    }
  }

  /**
   * `reuseSidebar` is set only for projections that follow streamed text, where no task,
   * workspace, queue or draft row changed. Tasks with a live controller are still refreshed.
   */
  function buildBootstrap(restoreHistory = false, reuseSidebar = false): DesktopBootstrapProjection {
    assertOpen();
    buildReadMemo = new Map();
    try {
      return buildBootstrapUnmemoized(restoreHistory, reuseSidebar);
    } finally {
      buildReadMemo = undefined;
    }
  }

  function buildBootstrapUnmemoized(restoreHistory: boolean, reuseSidebar: boolean): DesktopBootstrapProjection {
    const settings = store.loadAppSettings();
    hydrateActiveTask(settings);
    const workspaces: readonly WorkspaceProjection[] = reuseSidebar && sidebarCache !== undefined
      ? refreshLiveSidebarTasks(sidebarCache)
      : store.listWorkspaces({ includeArchived: true }).map((workspace) => {
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
            ...(workspace.disposition === "active" && worktreeManager.isAvailableFor(workspace.canonicalPath)
              ? { worktreeAvailable: true as const }
              : {}),
            tasks: Object.freeze(tasks),
          });
        });
    sidebarCache = workspaces;
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
        modelCatalog,
        permissionMode: settings.permissionMode,
        startup: settings.startup,
        availablePermissionModes: GUILD_GROK_PERMISSION_MODES,
        canChange: runtimeSettingsCanChange(),
        claude: Object.freeze({
          ...claudeEngineReport(),
          model: settings.claudeModel,
          reasoningEffort: settings.claudeEffort,
          permissionMode: settings.claudePermissionMode,
          availablePermissionModes: GUILD_CLAUDE_PERMISSION_MODES,
        }),
        engines: Object.freeze(Object.fromEntries(GUILD_ADDON_ENGINES.map((engine) => [
          engine,
          addonSettingsProjection(engine, settings),
        ]))) as Readonly<Partial<Record<GuildAddonEngine, AddonEngineSettingsProjection>>>,
        modelCatalogs: Object.freeze({
          grok: modelCatalog,
          claude: claudeCatalogProjection(),
          codex: addonState("codex").catalog,
        }),
      }),
      generalSettings: Object.freeze({
        restoreLastTask: settings.restoreLastTask,
        newTaskWorkspaceMode: settings.newTaskWorkspaceMode,
        taskNotificationsEnabled: settings.taskNotificationsEnabled,
        dockIcon: settings.dockIcon,
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

  function refreshLiveSidebarTasks(
    cached: readonly WorkspaceProjection[],
  ): readonly WorkspaceProjection[] {
    return cached.map((workspace) => {
      if (!workspace.tasks.some((task) => task.taskId === activeTaskId || controllers.has(task.taskId))) {
        return workspace;
      }
      return Object.freeze({
        ...workspace,
        tasks: Object.freeze(workspace.tasks.map((task) => {
          if (task.taskId !== activeTaskId && !controllers.has(task.taskId)) return task;
          try {
            return taskSummary(readOncePerBuild(`meta:${task.taskId}`, () => store.loadTaskMetadata(task.taskId)), true);
          } catch {
            return task;
          }
        })),
      });
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

  /**
   * Official usage is an account-level question. A ready official process already authenticated
   * for some task can answer it, so borrow it instead of starting a whole extra process; fall
   * back to a dedicated one only if the borrowed call fails. Every request is still made by the
   * official Grok process, and Guild never reads its auth file.
   */
  async function fetchUsageSnapshot(signal: AbortSignal): Promise<AcpV1OfficialBillingSnapshot> {
    const adapter = liveUsageAdapter();
    if (adapter !== undefined) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([
          adapter.officialBilling(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("live_usage_timeout")), LIVE_USAGE_TIMEOUT_MS);
            abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("operation_aborted"));
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } catch {
        throwIfAborted(signal);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort !== undefined) signal.removeEventListener("abort", abort);
      }
    }
    return usageFetcher(signal);
  }

  function liveUsageAdapter(): RuntimeAdapterPort | undefined {
    let busy: RuntimeAdapterPort | undefined;
    for (const controller of controllers.values()) {
      const adapter = controller.adapter;
      if (adapter === undefined || adapter.state !== "ready" || controller.session === undefined) continue;
      // Official usage is Grok's account billing; the Claude engine has none (PC-FALLBACK-001).
      if (!adapter.features.billing) continue;
      if (controller.promptRunId === undefined) return adapter;
      busy ??= adapter;
    }
    return busy;
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
    const restored = includeRunState
      ? readOncePerBuild(`restore:${metadata.taskId}`, () => store.restoreTask(metadata.taskId))
      : undefined;
    const activity = currentTaskActivity(controllers.get(metadata.taskId));
    const worktreeStatus = worktreeManager.statusOf(metadata.taskId);
    return Object.freeze({
      taskId: metadata.taskId,
      workspaceId: must(parseWorkspaceId(metadata.workspaceId)),
      title: metadata.title,
      pinned: metadata.pinned,
      archived: metadata.disposition === "archived",
      updatedAtMs: metadata.lastActivityAtMs,
      engine: metadata.engine,
      queuedTurnCount: readOncePerBuild(`queue:${metadata.taskId}`, () => store.listQueuedTurns(metadata.taskId)).length,
      ...(restored?.currentRun === undefined
        ? {}
        : { activeRunState: restored.currentRun.state }),
      ...(activity === undefined ? {} : { activeActivity: activity }),
      ...(worktreeStatus === undefined ? {} : { worktreeStatus }),
    });
  }

  /** The login summary of an adapter engine (docs/20 3.8, docs/21 4.7). A Grok task has none. */
  function engineStatusProjection(
    metadata: ReturnType<GuildPersistence["loadTaskMetadata"]>,
  ): EngineStatusProjection | undefined {
    if (isAddonEngine(metadata.engine)) {
      const report = addonEngineReport(addonState(metadata.engine));
      const status: EngineStatusProjection = Object.freeze({
        ...(report.accountLabel === undefined ? {} : { accountLabel: report.accountLabel }),
        ...(report.status === "not_logged_in" ? { loginRequired: true as const } : {}),
      });
      return Object.keys(status).length === 0 ? undefined : status;
    }
    if (metadata.engine !== "claude") return undefined;
    const loginRequired = claudeAuth?.kind === "none";
    const status: EngineStatusProjection = Object.freeze({
      ...(claudeAuth?.label === undefined || loginRequired ? {} : { accountLabel: claudeAuth.label }),
      ...(loginRequired ? { loginRequired: true as const } : {}),
    });
    return Object.keys(status).length === 0 ? undefined : status;
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
    if (
      controller.promptRunId !== undefined ||
      (controller.startOperation !== undefined && !controller.startIsPrewarm)
    ) return "working";
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
    const rolledBackRuns = new Set<string>(store.listRolledBackRunIds(taskId));
    const recentUsers = taskHistory
      .filter((entry) => isRecoveryUserEntry(entry) && !(entry.runId !== undefined && rolledBackRuns.has(entry.runId)))
      .slice(-6);
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
    const taskRoot = taskRootPath(taskId, workspace.canonicalPath);
    const observedPaths = recoveryToolPaths(beforeReplacement, taskRoot);
    const capsuleBudget = Math.min(
      REPLACEMENT_RECOVERY_CAPSULE_MAX_LENGTH,
      ACP_V1_CODEC_LIMITS.maxStringLength - currentText.length - 256,
    );
    if (capsuleBudget < 400) {
      throw new Error("message_too_long");
    }
    const capsule = replacementRecoveryCapsule({
      engineName: engineName(metadata.engine),
      taskId,
      title: metadata.title,
      workspacePath: taskRoot,
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
    const metadata = readOncePerBuild(`meta:${taskId}`, () => store.loadTaskMetadata(taskId));
    if (metadata.disposition === "deleted") throw new Error("task_deleted");
    const workspace = store.loadWorkspace(metadata.workspaceId);
    const summary = taskSummary(metadata, true);
    const locale = store.loadAppSettings().locale;
    const loadedPageDepth = conversationPageDepths.get(taskId) ?? 1;
    let entries = projectedPageDepth <= 1
      ? [...recentEntriesCached(taskId)]
      : [...store.listRecentConversationEntries({
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
    const extras = projectionExtras(taskId);
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
      .map((entry) => projectEntryCached(entry, runCache, locale, extras));
    const pending = [...(controllers.get(taskId)?.pendingPermissions.values() ?? [])]
      .map((permission) => projectPermission(permission, locale));
    const queuedTurns = readOncePerBuild(`queue:${taskId}`, () => store.listQueuedTurns(taskId)).map((queued) => Object.freeze({
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
    const runPhase = runPhaseProjection(controller, summary.activeRunState);
    const engineStatus = engineStatusProjection(metadata);
    const windowCheckpoints = runCheckpointProjections(taskId, entries);
    const windowRunModels = runModelProjections(taskId, entries);
    const worktreeProjection = worktreeManager.projectionOf(taskId);
    // Opening a task with a worktree refreshes its numbers in the background (bounded, at most
    // once in a while); the projection that carries them follows.
    if (worktreeProjection !== undefined) worktreeManager.noteViewed(taskId);
    const latestRunId = [...entries].reverse().find((entry) => entry.runId !== undefined)?.runId;
    const latestRun = latestRunId === undefined
      ? undefined
      : runForProjection(taskId, latestRunId, runCache);
    const recentResult = latestRunId !== undefined && latestRun !== undefined && TERMINAL_RUN_STATES.has(latestRun.state)
      ? Object.freeze({
          runId: latestRunId,
          state: latestRun.state as "completed" | "failed" | "cancelled" | "interrupted",
          workbench: cachedWorkbench(
            `${taskId}\0run`,
            taskRootPath(taskId, workspace.canonicalPath),
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
      modelSelection: modelSelectionProjection(taskId, controller),
      ...(engineStatus === undefined ? {} : { engineStatus }),
      ...(runPhase === undefined ? {} : { runPhase }),
      steer: steerAvailability(taskId, controller),
      ...(windowCheckpoints.length === 0 ? {} : { runCheckpoints: windowCheckpoints }),
      ...(windowRunModels.length === 0 ? {} : { runModels: windowRunModels }),
      rewind: rewindAvailability(taskId, controller),
      ...(worktreeProjection === undefined ? {} : { worktree: worktreeProjection }),
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
      workbench: cachedWorkbench(`${taskId}\0all`, taskRootPath(taskId, workspace.canonicalPath), entries),
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
        worktreeProjection?.status !== "discarded" &&
        worktreeProjection?.status !== "missing" &&
        !replacementRequired,
    });
  }

  /**
   * The newest page of rows. A row whose stamp is unchanged was already decoded and
   * integrity-verified when it was cached, so only rows written since are read again.
   */
  function recentEntriesCached(taskId: TaskId): readonly ConversationEntryRecord[] {
    const stamps = store.listRecentConversationEntryStamps({
      taskId,
      limit: CONVERSATION_PAGE_SIZE,
    });
    if (entryCache === undefined || entryCache.taskId !== taskId) {
      entryCache = { taskId, entries: new Map() };
    }
    const cache = entryCache;
    let stale = 0;
    for (const stamp of stamps) {
      const hit = cache.entries.get(stamp.entryId);
      if (hit === undefined || hit.revision !== stamp.revision || hit.sequence !== stamp.sequence) {
        stale += 1;
      }
    }
    let entries: readonly ConversationEntryRecord[];
    if (stale > ENTRY_CACHE_BULK_RELOAD_ROWS) {
      entries = store.listRecentConversationEntries({ taskId, limit: CONVERSATION_PAGE_SIZE });
    } else {
      entries = stamps.map((stamp) => {
        const hit = cache.entries.get(stamp.entryId);
        return hit !== undefined && hit.revision === stamp.revision && hit.sequence === stamp.sequence
          ? hit
          : store.loadConversationEntry(taskId, stamp.entryId);
      });
    }
    cache.entries = new Map(entries.map((entry) => [entry.entryId, entry]));
    return entries;
  }

  type ProjectionExtras = Readonly<{
    interjections: ReadonlyMap<string, InterjectionRecord>;
    rolledBack: ReadonlySet<string>;
  }>;

  /** Mutable per-task state that is not in the append-only entry rows; read once per projection build. */
  function projectionExtras(taskId: TaskId): ProjectionExtras {
    return readOncePerBuild(`extras:${taskId}`, () => {
      const interjections = new Map<string, InterjectionRecord>();
      for (const row of store.listInterjections(taskId)) interjections.set(row.interjectionId, row);
      return Object.freeze({
        interjections,
        rolledBack: new Set<string>(store.listRolledBackRunIds(taskId)),
      });
    });
  }

  function interjectionProjection(
    entry: ConversationEntryRecord,
    row: InterjectionRecord | undefined,
  ): TimelineInterjectionProjection | undefined {
    if (row === undefined) return undefined;
    if (
      entry.kind === "user" &&
      entry.metadata["interjection"] === true &&
      (row.state === "pending" || row.state === "delivered")
    ) {
      return Object.freeze({ interjectionId: row.interjectionId, state: row.state });
    }
    if (
      entry.kind === "notice" &&
      entry.metadata["interjectionFallback"] === true &&
      row.state === "fallen_back"
    ) {
      return Object.freeze({
        interjectionId: row.interjectionId,
        state: "fallen_back" as const,
        ...(row.reason === undefined ? {} : { reason: row.reason as GuildSteerFallbackReason }),
      });
    }
    return undefined;
  }

  function runForProjection(
    taskId: TaskId,
    runId: RunId,
    runCache: Map<RunId, RunRecord | undefined>,
  ): RunRecord | undefined {
    if (runCache.has(runId)) return runCache.get(runId);
    // Terminal states are absorbing, so a terminal record never needs a second read.
    let run = terminalRunCache.get(runId);
    if (run === undefined) {
      run = safeLoadRun(taskId, runId);
      if (run !== undefined && TERMINAL_RUN_STATES.has(run.state)) {
        terminalRunCache.set(runId, run);
        while (terminalRunCache.size > TERMINAL_RUN_CACHE_LIMIT) {
          const oldest = terminalRunCache.keys().next().value;
          if (oldest === undefined) break;
          terminalRunCache.delete(oldest);
        }
      }
    }
    runCache.set(runId, run);
    return run;
  }

  function projectEntryCached(
    entry: ConversationEntryRecord,
    runCache: Map<RunId, RunRecord | undefined>,
    locale: GuildLocale,
    extras: ProjectionExtras,
  ): TimelineItemProjection {
    const run = entry.runId === undefined
      ? undefined
      : runForProjection(entry.taskId, entry.runId, runCache);
    const interjectionId = metadataString(entry, "interjectionId");
    const interjection = interjectionId === undefined ? undefined : extras.interjections.get(interjectionId);
    const rolledBack = entry.runId !== undefined && extras.rolledBack.has(entry.runId);
    const key = `${entry.revision}\0${run?.state ?? ""}\0${locale}\0${interjection?.state ?? ""}\0${interjection?.reason ?? ""}\0${rolledBack ? 1 : 0}`;
    const cacheKey = `${entry.taskId}\0${entry.entryId}`;
    const hit = projectedEntryCache.get(cacheKey);
    if (hit !== undefined && hit.key === key) return hit.item;
    const item = projectEntry(entry, runCache, locale, interjection, rolledBack);
    projectedEntryCache.delete(cacheKey);
    projectedEntryCache.set(cacheKey, { key, item });
    // Rows older than the live window are not projected on the hot path; bound the memory.
    while (projectedEntryCache.size > CONVERSATION_PAGE_SIZE * 2) {
      const oldest = projectedEntryCache.keys().next().value;
      if (oldest === undefined) break;
      projectedEntryCache.delete(oldest);
    }
    return item;
  }

  function cachedWorkbench(
    scope: string,
    workspacePath: string,
    entries: readonly ConversationEntryRecord[],
  ): TaskViewProjection["workbench"] {
    let key = workspacePath;
    for (const entry of entries) {
      if (entry.kind === "tool") key += `|${entry.entryId}:${entry.revision}`;
    }
    const hit = workbenchCache.get(scope);
    if (hit !== undefined && hit.key === key) return hit.value;
    const value = buildTaskWorkbench(workspacePath, entries);
    workbenchCache.delete(scope);
    workbenchCache.set(scope, { key, value });
    while (workbenchCache.size > 16) {
      const oldest = workbenchCache.keys().next().value;
      if (oldest === undefined) break;
      workbenchCache.delete(oldest);
    }
    return value;
  }

  function projectEntry(
    entry: ConversationEntryRecord,
    runCache: Map<RunId, RunRecord | undefined>,
    locale: GuildLocale,
    interjectionRow: InterjectionRecord | undefined,
    rolledBack: boolean,
  ): TimelineItemProjection {
    const run = entry.runId === undefined
      ? undefined
      : runForProjection(entry.taskId, entry.runId, runCache);
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
    const interjection = interjectionProjection(entry, interjectionRow);
    const base = {
      entryId: entry.entryId,
      taskId: entry.taskId,
      ...(entry.runId === undefined ? {} : { runId: entry.runId }),
      sequence: entry.sequence,
      createdAtMs: entry.createdAtMs,
      updatedAtMs: entry.updatedAtMs,
      status,
      ...(interjection === undefined ? {} : { interjection }),
      ...(rolledBack ? { rolledBack: true as const } : {}),
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

  /**
   * One shared start per task. A background prewarm and a user action join the same in-flight
   * promise; a prewarm never sends a prompt, and only the first real use pins the process.
   */
  async function ensureSession(taskId: TaskId, prewarm = false): Promise<AcpV1AdapterSession> {
    if (managementOperationActive) throw new Error("grok_management_operation_active");
    const controller = controllerFor(taskId);
    if (!prewarm) controller.prewarmOnly = false;
    // A start in flight, a mode switch included, is joined, never raced: while it runs the
    // old session must not be handed out for a turn.
    if (controller.startOperation !== undefined) {
      if (!prewarm) controller.startIsPrewarm = false;
      return controller.startOperation;
    }
    const live = controller.session !== undefined && controller.adapter?.state === "ready"
      ? controller.session
      : undefined;
    if (live !== undefined && (prewarm || !processModeRestartNeeded(taskId, controller))) return live;
    controller.startIsPrewarm = prewarm;
    controller.prewarmOnly = prewarm;
    // A live session here is an idle one whose process has the wrong mode for the selected model (docs/20 3.3):
    // the switch is this one start, assigned before anything is awaited.
    controller.startOperation = startRuntime(taskId, controller, live);
    try {
      return await controller.startOperation;
    } finally {
      controller.startOperation = undefined;
      controller.startIsPrewarm = false;
    }
  }

  /**
   * Starts the official process, initializes it, authenticates and resumes the task's existing
   * session in the background, without sending a prompt. Only a task whose durable binding is
   * waiting for restore is prewarmed: a brand-new task has no session to resume, and creating
   * one here would leave an empty official session behind for a task the user may discard.
   */
  function prewarmTask(taskId: TaskId): void {
    if (closed || closing || maintenance || managementOperationActive) return;
    const failedAtMs = prewarmFailedAtMs.get(taskId);
    if (failedAtMs !== undefined && Date.now() - failedAtMs < (options.prewarmRetryMs ?? PREWARM_RETRY_BACKOFF_MS)) return;
    const existing = controllers.get(taskId);
    if (
      existing !== undefined &&
      (existing.startOperation !== undefined ||
        (existing.session !== undefined && existing.adapter?.state === "ready"))
    ) return;
    try {
      const metadata = store.loadTaskMetadata(taskId);
      if (
        metadata.disposition !== "active" ||
        store.loadWorkspace(metadata.workspaceId).disposition !== "active" ||
        store.loadSessionBinding(taskId).state !== "restore_pending" ||
        // An adapter session without a prompt cannot be resumed, so there is nothing to warm up.
        (isAdapterEngine(metadata.engine) && store.listTaskRuns(taskId).length === 0)
      ) return;
    } catch {
      return;
    }
    const startedGeneration = runtimeGeneration;
    void ensureSession(taskId, true).then(
      () => {
        if (closed || closing) return;
        prewarmFailedAtMs.delete(taskId);
        // The user may have moved on while the process was starting.
        if (activeTaskId !== taskId) releaseUnusedPrewarms(activeTaskId);
      },
      () => {
        if (closed || closing) return;
        // A resume closed this start on purpose; that is not a failure of the task.
        if (runtimeGeneration !== startedGeneration) {
          if (activeTaskId === taskId) prewarmTask(taskId);
          return;
        }
        prewarmFailedAtMs.set(taskId, Date.now());
        logRuntime({ category: "runtime", event: "prewarm_failed", taskId });
      },
    );
  }

  /**
   * Browsing must not accumulate idle official processes: a prewarmed process that was never
   * used is closed when another task becomes active. It restarts from the durable binding.
   */
  function releaseUnusedPrewarms(keepTaskId: TaskId | undefined): void {
    for (const [taskId, controller] of controllers) {
      if (
        taskId === keepTaskId ||
        !controller.prewarmOnly ||
        controller.startOperation !== undefined ||
        controller.activeRunId !== undefined ||
        controller.promptRunId !== undefined ||
        controller.pendingPermissions.size > 0
      ) continue;
      controller.prewarmOnly = false;
      // Never wait for the process to exit inside a command: Grok takes about a second to stop.
      void closeController(taskId, controller).catch(() => undefined).then(() => {
        if (
          controllers.get(taskId) === controller &&
          controller.startOperation === undefined &&
          controller.adapter?.state !== "ready"
        ) controllers.delete(taskId);
      });
    }
  }

  function onActiveTaskChanged(taskId: TaskId): void {
    releaseUnusedPrewarms(taskId);
    prewarmTask(taskId);
  }

  /** Commands that stop, close or inspect every runtime wait for background starts to settle first. */
  async function settlePrewarmStarts(taskIds?: readonly TaskId[]): Promise<void> {
    const starts: Promise<unknown>[] = [];
    for (const [taskId, controller] of controllers) {
      if (
        controller.startIsPrewarm &&
        controller.startOperation !== undefined &&
        (taskIds === undefined || taskIds.includes(taskId))
      ) starts.push(controller.startOperation.catch(() => undefined));
    }
    await Promise.all(starts);
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
    if (sessionStartPending(taskId, controller)) {
      // Wait for the start (the routed switch), then dispatch again on the session it produced.
      const again = (): void => {
        const retry = setTimeout(() => void scheduleContinuousDispatch(taskId), 0);
        retry.unref?.();
      };
      if (controller.startOperation !== undefined) void controller.startOperation.then(again, again);
      else again();
      return;
    }
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
    void beginRunCheckpoint(taskId, controller, runId);
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
    if (sessionStartPending(taskId, controller)) {
      // The queued turn waits for the start (the routed switch) and then runs on the session it produced.
      const again = (): void => {
        const retry = setTimeout(() => scheduleQueuedDispatch(taskId), 0);
        retry.unref?.();
      };
      if (controller.startOperation !== undefined) void controller.startOperation.then(again, again);
      else again();
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
          ? `${discarded} 条排队消息未发送，因为 ${engineName(controller.engine)} 会话已经重建；内容已保留，请重新发送。`
          : `${discarded} queued message${discarded === 1 ? " was" : "s were"} not sent because the ${engineName(controller.engine)} session was rebuilt. The content is preserved above; please send it again.`,
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
              ? `这条排队消息没有发送：与任务恢复摘要合并后超过 ${engineName(controller.engine)} 的单条消息上限。内容已保留，请删短后重新发送。`
              : `This queued message was not sent because it exceeds ${engineName(controller.engine)}'s single-message limit when combined with the task recovery summary. The content is preserved; shorten it and send again.`
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
    void beginRunCheckpoint(taskId, controller, dispatched.run.runId);
    await publish();
    launchPrompt(taskId, controller, session, prompt, dispatched.run.runId);
  }

  /**
   * `switchFrom` is the idle session this start replaces with a process of the other mode (docs/20 3.3,
   * D-062), native to routed or routed to native. For a routed target the router comes up first; then the
   * idle conditions are checked once more and the old process is closed in the same synchronous step; a
   * session that became busy in between is returned untouched and the selection stays pending for the next
   * idle point. The new process resumes the session and takes the selection; after a routed one has, the
   * task is marked routed, and only then is the session handed out.
   */
  async function startRuntime(
    taskId: TaskId,
    controller: RuntimeController,
    switchFrom?: AcpV1AdapterSession,
  ): Promise<AcpV1AdapterSession> {
    const startGeneration = runtimeGeneration;
    const metadata = store.loadTaskMetadata(taskId);
    const workspace = store.loadWorkspace(metadata.workspaceId);
    if (workspace.disposition !== "active" || metadata.disposition !== "active") {
      throw new Error("task_not_writable");
    }
    // F3: a task with an isolated worktree runs there; a discarded one cannot run at all.
    await worktreeManager.assertUsable(taskId);
    const taskRoot = taskRootPath(taskId, workspace.canonicalPath);
    await assertWorkspaceFolderExists(taskRoot);
    // A router that cannot start leaves the working native session alone. A switch back to Claude needs none.
    if (switchFrom !== undefined && selectsRoutedModel(taskId)) await ensureRouterReady(taskId);
    const previousAdapter = controller.adapter;
    if (
      switchFrom !== undefined &&
      controller.session === switchFrom &&
      previousAdapter?.state === "ready" &&
      !processModeRestartNeeded(taskId, controller, true)
    ) {
      logRuntime({ category: "runtime", event: "mode_switch_deferred", taskId });
      return switchFrom;
    }
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
        controller.routedProcess = false;
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
    let binding = store.loadSessionBinding(taskId);
    // A Claude or Codex session that never had a prompt has no transcript to resume (the adapter answers
    // "resource not found" / "no rollout found"), and nothing in it to lose: it is replaced without asking.
    const silentReplacement = isAdapterEngine(controller.engine) &&
      (binding.state === "restore_pending" || binding.state === "replacement_pending") &&
      store.listTaskRuns(taskId).length === 0;
    if (silentReplacement && binding.state === "restore_pending") {
      binding = replaceRunlessSession(taskId, binding);
    }
    if (binding.state === "broken") {
      throw new Error("session_replacement_requires_user_authorization");
    }
    const replacingSession = binding.state === "replacement_pending" && !silentReplacement;
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
    controller.steerUnsupported = false;
    controller.rewindUnsupported = false;
    controller.echoedInterjections.clear();
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
      // The mode of every start follows the selected model, also after a Guild restart (D-062).
      startStage = "routed_plan";
      const routed = await planRoutedStart(taskId, controller);
      startStage = "runtime_factory";
      // A native process of a task that has used a routed model keeps OpenViking capture off, so third-party
      // output never enters the memory store; recall stays on.
      const captureOff = options.claudeCaptureOff === true || store.loadTaskMetadata(taskId).routedAtMs !== undefined;
      const spawnEnvironment = routed?.extraEnvironment ??
        (controller.engine === "claude" && captureOff ? CLAUDE_CAPTURE_OFF_ENVIRONMENT : undefined);
      created = await runtimeFactory({
        engine: controller.engine,
        adapterEpoch,
        sink: createSink(taskId, controller),
        stagingRoot: options.stagingRoot,
        workingDirectory: taskRoot,
        runtimeSettings: Object.freeze({
          permissionMode: selectedRuntimeSettings.permissionMode,
          startup: selectedRuntimeSettings.startup,
        }),
        ...(spawnEnvironment === undefined ? {} : { extraEnvironment: spawnEnvironment }),
      });
      logRuntime({ category: "runtime", event: "factory_ready", taskId, adapterEpoch });
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      controller.adapter = created.adapter;
      controller.routedProcess = routed !== undefined;
      if (closed || closing) throw new Error("desktop_service_closed");
      // The version label is Grok's; Claude and each add-on engine keep their own for the model list cache.
      if (controller.engine === "grok") runtimeVersion = created.runtimeVersion ?? runtimeVersion;
      else if (isAddonEngine(controller.engine)) {
        const state = addonState(controller.engine);
        state.runtimeVersion = created.runtimeVersion ?? state.runtimeVersion;
      } else claudeRuntimeVersion = created.runtimeVersion ?? claudeRuntimeVersion;
      startStage = "initialize";
      const initialized = await created.adapter.start();
      logRuntime({ category: "runtime", event: "initialized", taskId, adapterEpoch });
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      if (controller.engine === "grok" && initialized.agentInfo?.version !== undefined) {
        runtimeVersion = [initialized.agentInfo.title ?? initialized.agentInfo.name, initialized.agentInfo.version]
          .filter(Boolean)
          .join(" ");
      }
      noteModelCatalog(initialized.modelCatalog);
      // Guild never authenticates for Claude: the user's own `claude` login is used as it is, and a
      // missing login surfaces as `auth_required` from the first session call (docs/20 3.2).
      const selectedAuthMethod = initialized.authMethods.length === 1
        ? initialized.authMethods[0]!.id
        : initialized.defaultAuthMethodId;
      if (engineProfileFor(controller.engine).authPolicy === "never") {
        // Nothing to select.
      } else if (selectedAuthMethod !== undefined) {
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
      const sessionStartOptions = await sessionStartOptionsFor(taskId, controller, initialized, routed?.picker);
      notePhase(controller, { type: "opening_session" });
      if (currentBinding.state === "creating") {
        startStage = "session_new";
        session = await created.adapter.newSession(taskRoot, sessionStartOptions);
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
              taskRoot,
              sessionStartOptions,
            );
          } catch (cause: unknown) {
            if (isAdapterEngine(controller.engine)) {
              // Only the agent's own "no such session" (ACP -32002; Codex: an internal error that names the missing
              // rollout, which the adapter port maps to the same code) says the session is gone. A login
              // that lapsed, a slow start, a lost process or any other failure keeps the retained
              // session: the binding stays restore_pending and the next send resumes it again.
              if (!(cause instanceof AcpV1AdapterError && cause.code === "session_not_found")) throw cause;
            } else if (created.adapter.state !== "ready") {
              throw cause;
            }
            restoreCause = cause;
          }
        }
        // An adapter's session/load answers a missing session the same way and, started after a timed-out
        // resume, would only wait a second window: it is the fallback of an agent without resume.
        const adapterResumes = isAdapterEngine(controller.engine) && initialized.agentCapabilities.resumeSession;
        if (session === undefined && initialized.agentCapabilities.loadSession && !adapterResumes) {
          startStage = "session_load";
          try {
            // The same start options as the resume: a routed task's modelPicker and the browser server.
            session = await created.adapter.loadSession(
              currentBinding.retainedSessionId,
              taskRoot,
              sessionStartOptions,
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
      applySessionOptions(
        controller,
        session.configOptions ?? Object.freeze([]),
        // The list of efforts of every model that a Codex session reports when it starts.
        controller.engine === "codex" ? session.modelCatalog : undefined,
      );
      if (session.contextWindowSize !== undefined) {
        store.saveContextWindowSize({
          taskId,
          sessionId: must(parseSessionId(session.sessionId)),
          size: session.contextWindowSize,
        });
      }
      noteModelCatalog(session.modelCatalog);
      // Claude and Codex: the permission mode first, then the model and effort (docs/20 3.2, docs/21 4.3). A resumed
      // Codex session forgets all three, so they are applied before any prompt.
      startStage = "session_permission_mode";
      await reconcileAdapterPermissionMode(taskId, controller, created.adapter, session);
      startStage = "session_selection";
      const selectionStatus = await reconcileRuntimeSelection(taskId, controller, created.adapter, session);
      if (runtimeGeneration !== startGeneration) {
        throw new Error("runtime_start_invalidated_by_resume");
      }
      // The routed process must have taken the selection (or none is pinned); the marker itself is the
      // last step of the start, below, once nothing that can fail for this switch is left.
      if (routed !== undefined && selectionStatus === "skipped" && selectsRoutedModel(taskId)) {
        throw new Error(MODEL_SELECTION_FAILED);
      }
      if (replacingSession) {
        persistedContextTokens.delete(taskId);
        const replacementNoticeEntryId = unique("session-replaced");
        store.createConversationEntry({
          taskId,
          entryId: replacementNoticeEntryId,
          kind: "notice",
          text: store.loadAppSettings().locale === "zh-CN"
            ? `已按你的确认开始新的 ${engineName(controller.engine)} 会话。Guild 会在你下一次发送时附带本任务的本地恢复摘要；中断的指令仍不会自动重发。`
            : `A new ${engineName(controller.engine)} session was started with your confirmation. On your next send, Guild will attach a local recovery summary for this task; the interrupted instruction will still not be resent automatically.`,
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
      if (controller.engine === "claude") {
        const version = /\d+\.\d+\.\d+/u.exec(created.runtimeVersion ?? "")?.[0];
        noteClaudeInstall(Object.freeze({ status: "ready" as const, ...(version === undefined ? {} : { version }) }));
      } else if (isAddonEngine(controller.engine)) {
        const version = /\d+\.\d+\.\d+/u.exec(created.runtimeVersion ?? "")?.[0];
        noteAddonInstall(controller.engine, Object.freeze({ status: "ready" as const, ...(version === undefined ? {} : { version }) }));
      }
      logRuntime({
        category: "session",
        event: "ready",
        taskId,
        sessionId: session.sessionId,
        adapterEpoch,
        reason: session.establishedBy,
      });
      await publish();
      if (routed !== undefined) {
        // The marker is the last thing that can go wrong for this switch: a failure above leaves the
        // task unmarked (and the caller rolls the selection back); once written, the routed process is
        // valid and the session is handed out before any turn can start on it, so a failure to show
        // the marker is logged, not raised.
        if (runtimeGeneration !== startGeneration) throw new Error("runtime_start_invalidated_by_resume");
        startStage = "routed_marker";
        commitRoutedMarker(taskId);
        await publish().catch(() => {
          logRuntime({ category: "runtime", event: "routed_marker_publish_failed", taskId });
        });
      }
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
        // An adapter engine settles a missing session inline; any failure that reaches here keeps the binding.
        !isAdapterEngine(controller.engine) &&
        !isAuthRequired(controller, cause) &&
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
      // A Claude or Codex task with no prompt has no session worth a question (see silentReplacement): a
      // failed creation, for example a missing login, leaves it ready for the next try.
      if (
        bindingChanged &&
        isAdapterEngine(controller.engine) &&
        store.loadSessionBinding(taskId).state === "broken" &&
        store.listTaskRuns(taskId).length === 0
      ) {
        requireBinding(store.applySessionBinding({
          taskId,
          event: { type: "authorize_replacement", idempotencyKey: key("session-runless-replacement") },
        }));
      }
      controller.adapter = undefined;
      controller.adapterEpoch = undefined;
      controller.session = undefined;
      controller.routedProcess = false;
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
      if (isAuthRequired(controller, cause)) {
        noteLoginRequired(controller.engine);
        throw new Error(isAddonEngine(controller.engine) ? ENGINE_LOGIN_REQUIRED : CLAUDE_LOGIN_REQUIRED);
      }
      if (controller.engine === "claude" && cause instanceof ClaudeLocatorError) {
        noteClaudeInstall(Object.freeze({ status: "not_found" as const }));
      }
      if (isAddonEngine(controller.engine) && cause instanceof CodexLocatorError) {
        noteAddonInstall(controller.engine, Object.freeze({ status: "not_found" as const }));
      }
      if (controller.engine === "claude" && created?.refusedForIntegrity?.() === true) {
        noteClaudeInstall(Object.freeze({ status: "integrity_changed" as const }));
        throw new Error(ENGINE_INTEGRITY_CHANGED);
      }
      if (isAddonEngine(controller.engine) && created?.refusedForIntegrity?.() === true) {
        noteAddonInstall(controller.engine, Object.freeze({ status: "integrity_changed" as const }));
        throw new Error(ENGINE_INTEGRITY_CHANGED);
      }
      if (isStartInterruption(controller, startStage, cause)) {
        logRuntime({
          category: "runtime",
          event: controller.engine === "claude" ? "claude_start_timeout" : "engine_start_timeout",
          taskId,
          adapterEpoch,
          reason: startStage,
        });
        throw new Error(controller.engine === "claude" ? CLAUDE_START_TIMEOUT : ENGINE_START_TIMEOUT);
      }
      if (cause instanceof Error && (cause.message === MODEL_ROUTER_UNAVAILABLE || cause.message === MODEL_SELECTION_FAILED)) {
        throw cause;
      }
      throw new Error(`runtime_start_${startStage}:${detail}`);
    }
  }

  function reconcilePreviousRuntime(taskId: TaskId): void {
    // A Steer whose request was in flight when the process went away has no known outcome.
    store.failInterruptedInterjections(taskId);
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
        // No capture survives a restart, so a checkpoint still being taken will never finish.
        store.failCapturingRunCheckpoints(task.taskId);
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
    // The runtime drops a rewound branch from its replay, so a rolled-back Run is not a local turn.
    const rolledBack = new Set<string>(store.listRolledBackRunIds(taskId));
    const entries = allTaskConversationEntries(taskId)
      .filter((entry) => entry.runId === undefined || !rolledBack.has(entry.runId));
    const turns = new Map<RunId, LocalReplayTurn>();
    for (const entry of entries) {
      if (
        entry.kind !== "user" ||
        entry.runId === undefined ||
        entry.status !== "complete" ||
        // A Steer belongs to the turn it was sent into; it never opens a turn of its own.
        entry.metadata["interjection"] === true ||
        (entry.metadata["hidden"] === true && entry.metadata["replayAnchor"] !== true)
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
    applySessionOptions(controller, state.configOptions ?? Object.freeze([]));
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
        applySessionOptions(controller, Object.freeze(
          context.options.map((option) => Object.freeze({ ...option })),
        ));
      } else if (context.kind === "usage") {
        controller.contextWindowUsage = Object.freeze({ used: context.used, size: context.size });
      }
    }
  }

  function createSink(taskId: TaskId, controller: RuntimeController): AcpV1AdapterSink {
    return Object.freeze({
      observeSignal: (envelope: XaiSignalEnvelope) => observeRuntimeSignal(taskId, controller, envelope),
      observeEngineSignal: (signal: EngineSignal) => observeEngineSignal(taskId, signal),
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
            applySessionOptions(controller, Object.freeze(
              event.update.payload.context.options.map((option) => Object.freeze({ ...option })),
            ));
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
        schedulePublish();
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
        notePhase(controller, { type: "permission", open: true });
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
          notePhase(controller, { type: "permission", open: controller.pendingPermissions.size > 0 });
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
          notePhase(controller, { type: "permission", open: controller.pendingPermissions.size > 0 });
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
        endPhase(controller);
        logRuntime({
          category: "prompt",
          event: "terminal",
          taskId,
          runId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
          reason: event.terminal.classification,
        });
        afterRunEnded(taskId, controller, runId);
        await publish();
      },
      commitAgentTurnStarted: async (event) => {
        if (!isCurrentRuntimeIdentity(taskId, controller, event.identity)) {
          throw new Error("stale_runtime_identity");
        }
        // A turn the runtime started itself (for example the prompt it makes from a Steer that
        // missed its turn) gets a Run of its own, unless one of Guild's is already in flight; the
        // adapter then drops the turn rather than faulting the session.
        const current = store.restoreTask(taskId).currentRun;
        if (
          controller.activeRunId !== undefined ||
          controller.promptRunId !== undefined ||
          (current !== undefined && !TERMINAL_RUN_STATES.has(current.state))
        ) {
          logRuntime({
            category: "prompt",
            event: "agent_turn_declined",
            taskId,
            sessionId: event.identity.sessionId,
            adapterEpoch: event.identity.adapterEpoch,
          });
          throw new Error("agent_turn_overlaps_active_run");
        }
        const sessionId = must(parseSessionId(event.identity.sessionId));
        const adapterEpoch = must(parseAdapterEpoch(event.identity.adapterEpoch));
        const runId = id(parseRunId, "run");
        store.createRun({ taskId, runId });
        try {
          requireRun(store.applyRun({
            taskId,
            runId,
            event: {
              type: "scheduler_dispatch",
              sessionId,
              adapterEpoch,
              idempotencyKey: key("agent-turn-dispatch"),
            },
          }));
          const text = event.promptText?.trim();
          const hasText = text !== undefined && text.length > 0;
          // A Steer the runtime ran as its own turn is shown once, as the message the user typed.
          const steered = hasText
            ? store.listInterjections(taskId).find((row) =>
                row.startedRunId === undefined &&
                (row.state === "pending" || row.state === "delivered") &&
                row.text.trim() === text)
            : undefined;
          if (hasText) {
            store.createConversationEntry({
              taskId,
              runId,
              entryId: unique("user"),
              kind: "user",
              text,
              metadata: {
                agentStartedTurn: true,
                ...(steered === undefined
                  ? {}
                  : { hidden: true, replayAnchor: true, interjectionId: steered.interjectionId }),
              },
              status: "complete",
            });
          }
          controller.activeRunId = runId;
          controller.replayOrderLastToken = undefined;
          store.commitPromptAccepted({
            taskId,
            runId,
            sessionId,
            adapterEpoch,
            promptSequence: event.identity.promptSequence,
            idempotencyKey: key("agent-turn-accepted"),
            ...(hasText
              ? {
                  durableNotices: Object.freeze([Object.freeze({
                    entryId: unique("outbound-prompt-proof"),
                    text: "Guild outbound prompt replay proof.",
                    metadata: Object.freeze({
                      hidden: true,
                      outboundPromptProof: true,
                      outboundPromptProofVersion: 2,
                      outboundPromptSha256: outboundPromptSha256(text, []),
                      outboundPromptHadResources: false,
                      outboundPromptRecoveryCapsule: false,
                    }),
                  })]),
                }
              : {}),
          });
          if (steered !== undefined) {
            store.linkInterjectionStartedRun({
              taskId,
              interjectionId: steered.interjectionId,
              startedRunId: runId,
            });
          }
        } catch (cause: unknown) {
          controller.activeRunId = undefined;
          const run = safeLoadRun(taskId, runId);
          if (run !== undefined && !TERMINAL_RUN_STATES.has(run.state)) {
            store.applyRun({
              taskId,
              runId,
              event: { type: "launch_failure", idempotencyKey: key("agent-turn-launch-failure") },
            });
          }
          throw cause;
        }
        beginPhase(controller, "prompt_sent");
        logRuntime({
          category: "prompt",
          event: "agent_turn_started",
          taskId,
          runId,
          sessionId: event.identity.sessionId,
          adapterEpoch: event.identity.adapterEpoch,
        });
        void beginRunCheckpoint(taskId, controller, runId);
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

  /** Streamed content and tool state are Guild-authoritative inputs of the phase indicator. */
  function notePhaseForTurn(controller: RuntimeController, payload: RuntimeTurnPayload): void {
    if (payload.type === "agent_text_chunk") {
      notePhase(controller, { type: "content", kind: "message" });
    } else if (payload.type === "agent_thought_chunk") {
      notePhase(controller, { type: "content", kind: "thought" });
    } else if (payload.type === "tool_call_create" || payload.type === "tool_call_update") {
      const previous = controller.toolStates.get(payload.toolCallId);
      notePhase(controller, {
        type: "tool",
        toolCallId: payload.toolCallId,
        status: payload.status ?? previous?.status ?? "pending",
        fallbackName: payload.kind ?? previous?.kind ?? "other",
      });
    }
  }

  async function commitTurnUpdate(
    taskId: TaskId,
    controller: RuntimeController,
    adapterEpoch: AdapterEpoch,
    update: Extract<AcpV1DecodedUpdate, { readonly type: "turn" }>,
  ): Promise<void> {
    const runId = requireActiveRun(controller);
    const payload = update.payload;
    notePhaseForTurn(controller, payload);
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
      markStartCheckpointLateIfPending(controller, runId);
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
      publishStreamChunk({
        taskId,
        runId,
        kind: payload.type === "agent_text_chunk" ? "assistant" : "thought",
        entryId: committed.record?.entryId ?? mutation.entryId,
        text: payload.text,
        created: mutation.type === "create",
        duplicate: committed.duplicate,
        committedLength: committed.record?.text.length ?? 0,
      });
      // The adapter keeps commits ordered. Yield during a buffered burst so
      // publication, cancellation and process events can run between commits.
      if (performance.now() - lastStreamYieldAt >= 8) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        lastStreamYieldAt = performance.now();
      }
    } else {
      // Tool, plan and sub-agent updates must not hold the one-at-a-time update queue.
      schedulePublish();
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
              controller.engine,
            ),
            metadata: { incidentId, reason },
            status: "failed",
          });
        }
      }
      controller.activeRunId = undefined;
      if (run !== undefined) afterRunEnded(taskId, controller, runId, { dispatchQueue: false });
    }
    endPhase(controller);
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
              ? `原 ${engineName(engineOfTask(taskId))} 会话已恢复。为避免重复修改，刚才中断的指令没有自动重发；需要时请手动重试。`
              : `The original ${engineName(engineOfTask(taskId))} session was restored. The interrupted instruction was not resent automatically, avoiding duplicate changes; retry it manually if needed.`,
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
    beginPhase(controller, "prompt_sent");
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
      // The start checkpoint gets a short head start; one that is still running continues alongside
      // the prompt and is discarded if a tool call arrives first (markStartCheckpointLateIfPending).
      await awaitStartCheckpointBriefly(controller, runId);
      // The stored model and effort are brought up to date between turns, never mid-turn. Grok: a
      // refusal keeps the session on its previous selection and never blocks the turn. Claude: a
      // selection that could not be applied ends the turn here, before the prompt is sent.
      assertProcessModeMatchesModel(taskId, controller, session);
      await reconcileRuntimeSelection(taskId, controller, adapter, session).catch((cause: unknown) => {
        if (isAdapterEngine(controller.engine) && errorMessageIncludes(cause, MODEL_SELECTION_FAILED)) throw cause;
        logRuntime({ category: "runtime", event: "model_switch_failed", taskId });
      });
      // A Claude or Codex session never runs a turn looser than the setting says; a refusal ends the turn here.
      await reconcileAdapterPermissionMode(taskId, controller, adapter, session);
      // Which model answers is known now: the selection has been applied and nothing has been sent yet.
      recordRunModel(taskId, controller, runId);
      notePhase(controller, { type: "prompt_sent" });
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
      const loginRequired = isAuthRequired(controller, cause);
      if (loginRequired) noteLoginRequired(controller.engine);
      const selectionFailed = isAdapterEngine(controller.engine) && errorMessageIncludes(cause, MODEL_SELECTION_FAILED);
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
                  ? `指令已经写入 ${engineName(controller.engine)}，但 Guild 未能确认本地接收记录。为避免重复修改，不会自动重发；请先查看原任务状态。`
                  : `The instruction was written to ${engineName(controller.engine)}, but Guild could not confirm its local acceptance record. It will not resend automatically; check the original task state first.`)
              : loginRequired
                ? loginRequiredMessage(store.loadAppSettings().locale, controller.engine)
                : selectionFailed
                  ? modelSelectionFailedMessage(store.loadAppSettings().locale, controller.engine)
                  : (store.loadAppSettings().locale === "zh-CN"
                    ? `${engineName(controller.engine)} 运行时未能开始这次任务。你可以重新发送这条消息。`
                    : `The ${engineName(controller.engine)} runtime could not start this task. You can send the message again.`),
            metadata: deliveryUnconfirmed
              ? { failureCategory: "prompt_delivery_unconfirmed" }
              : {
                  failureCategory: loginRequired
                    ? loginRequiredCategory(controller.engine)
                    : selectionFailed ? MODEL_SELECTION_FAILED : "prompt_launch_failed",
                },
            status: "failed",
          });
          controller.activeRunId = undefined;
          endPhase(controller);
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
            text: loginRequired ? loginRequiredMessage(locale, controller.engine) : promptFailureMessage(locale, controller.engine),
            metadata: { failureCategory: loginRequired ? loginRequiredCategory(controller.engine) : "runtime_prompt_rejected" },
            status: "failed",
          });
          controller.activeRunId = undefined;
          endPhase(controller);
          runTerminalized = true;
        }
      }
      if (runTerminalized) {
        controller.streamingEntries.clear();
        controller.toolStates.clear();
        controller.auxiliarySessions.clear();
        clearCancelTimer(controller);
        clearPromptSilenceTimer(controller);
        afterRunEnded(taskId, controller, runId, { dispatchQueue: false });
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
    // The silence watchdog is opt-in (tests and diagnostics). Without it there is nothing to
    // re-arm, so skip the Run reload this check used to repeat for every streamed chunk.
    if (options.promptSilenceMs === undefined) return;
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
    const workspacePath = await realpath(taskRootPath(taskId, workspace.canonicalPath));
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
      const engine = engineName(controller.engine);
      const alt = media.mediaType === "image"
        ? (zh ? `${engine} 图片` : `${engine} image`)
        : (zh ? `${engine} 音频` : `${engine} audio`);
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

  /**
   * After the machine wakes, a process that was serving a Run (or was still starting) is closed:
   * its Run was just terminalized and a prompt that may still be in flight inside it must not
   * overlap the next one. An idle healthy process is kept and only has to prove, with a local
   * stdio round trip, that it still answers; this keeps the next message free of a cold start.
   * A process that does not answer is closed and restarts lazily from the durable binding.
   */
  async function recoverRuntimesAfterResume(
    interruptedTaskIds: ReadonlySet<TaskId>,
  ): Promise<void> {
    const recoveries: Promise<unknown>[] = [];
    for (const [taskId, controller] of controllers) {
      const adapter = controller.adapter;
      if (adapter === undefined) continue;
      const hadWork =
        interruptedTaskIds.has(taskId) ||
        controller.activeRunId !== undefined ||
        controller.promptRunId !== undefined ||
        controller.pendingPermissions.size > 0 ||
        controller.startOperation !== undefined;
      recoveries.push(
        hadWork || adapter.state !== "ready"
          ? adapter.close()
          : probeIdleRuntimeAfterResume(taskId, controller, adapter),
      );
    }
    await Promise.allSettled(recoveries);
  }

  async function probeIdleRuntimeAfterResume(
    taskId: TaskId,
    controller: RuntimeController,
    adapter: RuntimeAdapterPort,
  ): Promise<void> {
    const alive = await adapter.probeLiveness(RESUME_LIVENESS_PROBE_MS).catch(() => false);
    if (alive || controller.adapter !== adapter) return;
    logRuntime({
      category: "recovery",
      event: "resume_probe_failed",
      taskId,
      ...(controller.adapterEpoch === undefined ? {} : { adapterEpoch: controller.adapterEpoch }),
      reason: "process_fault",
    });
    // An alive process with dead stdio is a transport fault, not an ordinary close.
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
    controller.phase.end();
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
      const validated = await canonicalPromptAttachment(
        taskRootPath(taskId, workspace.canonicalPath),
        requested.relativePath,
      );
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
  // The bundle icon already is the dark one, so a launch on the default changes nothing at all.
  if (store.loadAppSettings().dockIcon !== "dark") applyDockIcon(store.loadAppSettings().dockIcon);
  discardStoredPristineTasks();
  void sweepPristineWorktreeTasks();
  const diagnosticsHydration = hydrateRuntimeIncidents().catch(() => undefined);

  const service: DesktopApplicationService = {
    bootstrap: async () => {
      await diagnosticsHydration;
      refreshClaudeInstall();
      refreshAddonInstalls();
      // PC-CONV-002: renderer reload loses its cache; restore its requested history once.
      // Normal publish() calls keep sending only the bounded live tail.
      const projection = buildBootstrap(true);
      if (activeTaskId !== undefined) prewarmTask(activeTaskId);
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
      const attachmentRoot = taskRootPath(taskId, workspace.canonicalPath);
      const selected = await options.choosePromptFiles?.({
        workspacePath: attachmentRoot,
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
        const validated = await canonicalPromptAttachment(attachmentRoot, path);
        if (seen.has(validated.attachment.relativePath)) continue;
        seen.add(validated.attachment.relativePath);
        attachments.push(validated.attachment);
      }
      return Object.freeze({ status: "selected", attachments: Object.freeze(attachments) });
    },
    createTask: async (workspaceId, isolation?: GuildTaskIsolation, engine?: GuildEngine) => enqueueCommand(async () => {
      assertOpen();
      const workspace = store.loadWorkspace(workspaceId);
      if (workspace.disposition !== "active") throw new Error("workspace_not_active");
      if (activeTaskId !== undefined) await discardPristineTask(activeTaskId);
      const taskId = id(parseTaskId, "task");
      const title = store.loadAppSettings().locale === "zh-CN" ? "新任务" : "New task";
      const createTaskRow = (): void => {
        store.createConversationTask({
          taskId,
          workspaceId,
          title,
          owningWindowId: PRIMARY_WINDOW_ID,
          ...(engine === undefined ? {} : { engine }),
        });
      };
      if (isolation === "worktree") {
        // F3: the worktree is created first, so a refused one (not a git repository, no commits)
        // leaves no task behind. It throws `worktree_<reason>`.
        await worktreeManager.create({
          taskId,
          workspaceId,
          workspacePath: workspace.canonicalPath,
          title,
          createTaskRow,
        });
        await worktreeManager.refresh(taskId, { force: true });
      } else {
        createTaskRow();
      }
      activeTaskId = taskId;
      conversationPageDepths.set(taskId, 1);
      persistTaskSelection(taskId);
      await publish();
      onActiveTaskChanged(taskId);
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
      // F3: the user opened the task, so its worktree numbers are re-read if they are over a second old.
      void worktreeManager.refresh(taskId, { minIntervalMs: 1_000 }).catch(() => undefined);
      await publish();
      scheduleQueuedDispatch(taskId);
      onActiveTaskChanged(taskId);
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
        // A branch continues the conversation on the engine it was written for.
        engine: source.engine,
      });
      const rolledBackRuns = new Set<string>(store.listRolledBackRunIds(taskId));
      for (const entry of allTaskConversationEntries(taskId)) {
        if (throughSequence !== undefined && entry.sequence > throughSequence) continue;
        if (entry.status === "streaming" || entry.metadata["hidden"] === true) continue;
        if (entry.runId !== undefined && rolledBackRuns.has(entry.runId)) continue;
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
          ? `已从“${source.title}”复制本地对话快照。此分支会启动新的${source.engine === "grok" ? "官方 Grok " : ` ${engineName(source.engine)} `}会话，不会冒充上游会话克隆。`
          : `Copied a local transcript snapshot from “${source.title}”. This branch starts a new ${source.engine === "grok" ? "official Grok" : engineName(source.engine)} session; it is not an upstream session clone.`,
        status: "complete",
      });
      activeTaskId = branchTaskId;
      conversationPageDepths.set(branchTaskId, 1);
      persistTaskSelection(branchTaskId);
      await publish();
      onActiveTaskChanged(branchTaskId);
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
      // The store matches in SQL and returns only candidate entries; the same JavaScript matcher
      // as before confirms each one and builds the snippet.
      for (const entry of store.searchConversationEntries({ query, limit: 50 })) {
        for (const match of conversationMatches([entry], query, locale)) {
          const task = store.loadTaskMetadata(entry.taskId);
          results.push(Object.freeze({
            taskId: task.taskId,
            workspaceId: must(parseWorkspaceId(task.workspaceId)),
            taskTitle: task.title,
            workspaceName: store.loadWorkspace(task.workspaceId).displayName,
            ...match,
            updatedAtMs: task.lastActivityAtMs,
          }));
        }
      }
      results.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      return Object.freeze({ results: Object.freeze(results) });
    }),
    previewWorktreeApply: async (taskId) => previewWorktreeApply(taskId),
    applyWorktree: async (taskId) => applyWorktree(taskId),
    discardWorktree: async (taskId) => discardWorktree(taskId),
    openWorktreeResource: async (taskId, action) => {
      assertOpen();
      const task = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(task.workspaceId);
      if (task.disposition === "deleted" || workspace.disposition !== "active") {
        throw new Error("worktree_unavailable");
      }
      const path = await worktreeManager.resourcePath(taskId, workspace.canonicalPath);
      if (action === "folder") {
        if (options.openWorkspaceFolder === undefined) throw new Error("workspace_folder_unavailable");
        await options.openWorkspaceFolder(path);
        return;
      }
      if (options.openWorkspaceTerminal === undefined) throw new Error("task_terminal_unavailable");
      await options.openWorkspaceTerminal(path);
    },
    openTaskResource: async (taskId, action, requestedPath) => {
      assertOpen();
      const task = store.loadTaskMetadata(taskId);
      const workspace = store.loadWorkspace(task.workspaceId);
      if (task.disposition === "deleted" || workspace.disposition !== "active") {
        throw new Error("task_resource_unavailable");
      }
      const workspacePath = await realpath(taskRootPath(taskId, workspace.canonicalPath));
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
          // Model and effort have their own validated channel (D-011: only official models, between turns).
          option.category === "model" ||
          option.category === "thought_level" ||
          // The permission mode of an adapter engine follows its settings (reconcileAdapterPermissionMode).
          (isAdapterEngine(controller.engine) && option.category === "mode") ||
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
        applySessionOptions(controller, await controller.adapter.setConfigOption(session, configId, value));
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
      await settlePrewarmStarts(tasks.map((task) => task.taskId));
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
      await settlePrewarmStarts([taskId]);
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
      if (worktreeManager.rowOf(taskId) !== undefined) {
        // F3: a discarded worktree cannot run, and a worktree folder deleted by hand is not a place to send into.
        await worktreeManager.assertUsable(taskId);
        const sendWorkspace = store.loadWorkspace(store.loadTaskMetadata(taskId).workspaceId);
        await assertWorkspaceFolderExists(taskRootPath(taskId, sendWorkspace.canonicalPath));
      }
      if (mode === "continuous" && attachments.length > 0) {
        throw new Error("continuous_task_attachments_not_supported");
      }
      messageAdmissionsActive += 1;
      const phaseController = controllerFor(taskId);
      phaseController.sendsInFlight += 1;
      beginPhase(
        phaseController,
        phaseController.session !== undefined && phaseController.adapter?.state === "ready"
          ? "prompt_sent"
          : "starting_runtime",
      );
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
          if (
            session === undefined ||
            controller.adapter?.state !== "ready" ||
            // A routed switch started (or became due) after ensureSession handed this session out.
            sessionStartPending(taskId, controller)
          ) {
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
          // The working tree is captured before the prompt can reach the agent (see runPrompt).
          void beginRunCheckpoint(taskId, controller, runId);
          // The prompt goes to the official process first; the projection that shows
          // the new Run follows. A failed launch is still published before it surfaces.
          try {
            launchPrompt(taskId, controller, session, prompt, runId, resources);
          } catch (cause: unknown) {
            await publish().catch(() => undefined);
            throw cause;
          }
          // The Run is already started, so a projection fault must not look like a failed send.
          await publish().catch(() => {
            logRuntime({ category: "runtime", event: "stream_projection_failed" });
          });
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
        phaseController.sendsInFlight -= 1;
        // A send that never created a Run (start failure, rejection) leaves no phase behind.
        if (phaseController.activeRunId === undefined && phaseController.promptRunId === undefined) {
          endPhase(phaseController);
        }
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
    steerMessage: async (taskId, text) => steerMessage(taskId, text),
    convertQueuedTurnToSteer: async (taskId, queueId) => convertQueuedTurnToSteer(taskId, queueId),
    previewRewind: async (taskId, runId) => previewRewind(taskId, runId),
    executeRewind: async (request) => executeRewind(request),
    loadRunFileDiff: async (request) => loadRunFileDiff(request),
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
      // Typing in the composer is the strongest sign that a send is coming.
      if (taskId === activeTaskId) prewarmTask(taskId);
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
            next = await fetchUsageSnapshot(abortController.signal);
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
      model: GuildGrokModel | null,
      reasoningEffort: GuildGrokReasoningEffort | null,
      permissionMode: GuildGrokPermissionMode,
      startup: GuildGrokStartupSettings,
    ) => enqueueCommand(async () => {
      assertOpen();
      if (model === null && reasoningEffort !== null) {
        throw new Error("runtime_settings_change_unavailable");
      }
      if (model !== null && modelCatalog.models.length > 0) {
        const offered = grokModelById(modelCatalog, model);
        // The stored default must be something the runtime has advertised; the effort must be one of its.
        if (
          offered === undefined ||
          (reasoningEffort !== null && !modelSupportsReasoningEffort(offered, reasoningEffort))
        ) {
          throw new Error("runtime_settings_change_unavailable");
        }
      }
      const currentSettings = store.loadAppSettings();
      const processSettingsSame =
        currentSettings.permissionMode === permissionMode &&
        currentSettings.startup.webSearchEnabled === startup.webSearchEnabled &&
        currentSettings.startup.planEnabled === startup.planEnabled &&
        currentSettings.startup.subagentsEnabled === startup.subagentsEnabled &&
        currentSettings.startup.maxTurns === startup.maxTurns;
      if (
        currentSettings.grokModel === model &&
        currentSettings.reasoningEffort === reasoningEffort &&
        processSettingsSame
      ) {
        return buildBootstrap();
      }
      if (processSettingsSame) {
        // Model and effort are applied to each session between turns (reconcileRuntimeSelection),
        // so changing the default never closes a process or loses a conversation's context.
        store.updateAppSettings({
          expectedRevision: currentSettings.revision,
          grokModel: model,
          reasoningEffort,
        });
        await publish();
        return buildBootstrap();
      }
      await settlePrewarmStarts();
      if (!runtimeSettingsCanChange()) throw new Error("runtime_settings_change_unavailable");
      // Permission mode and startup behavior are process arguments: the idle processes restart.
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
    setTaskRuntimeSettings: async (request: SetTaskRuntimeSettingsRequest) => {
      const outcome = await enqueueCommand(
      async (): Promise<SetTaskRuntimeSettingsResponse | ModeSelectionRestart> => {
        assertOpen();
        const { taskId } = request;
        const metadata = store.loadTaskMetadata(taskId);
        if (metadata.disposition !== "active") throw new Error("task_not_writable");
        const view = (): TaskViewProjection => taskView(taskId, conversationPageDepths.get(taskId) ?? 1);
        if (!taskSelectionCanChange(taskId)) throw new Error("task_runtime_settings_unavailable");
        const existing = store.loadTaskRuntimeSettings(taskId);
        const persist = (): void => {
          if (request.model === null) {
            if (existing !== undefined) {
              store.clearTaskRuntimeSettings({ taskId, expectedRevision: existing.revision });
            }
            return;
          }
          store.saveTaskRuntimeSettings({
            taskId,
            expectedRevision: existing?.revision ?? 0,
            modelId: request.model,
            reasoningEffort: request.reasoningEffort,
            contextWindow: request.contextWindow ?? null,
          });
        };
        const refuse = async (reason: GuildModelSwitchRefusalReason): Promise<SetTaskRuntimeSettingsResponse> => {
          await publish();
          return Object.freeze({ status: "refused" as const, reason, task: view() });
        };
        const claude = metadata.engine === "claude";
        const addon = isAddonEngine(metadata.engine) ? metadata.engine : undefined;
        if (addon !== undefined) {
          if (request.model !== null) {
            // The engine's own list is the choice: a model its sessions did not report cannot be stored, and neither
            // can an effort that model does not offer (Codex lists every model's efforts when a session starts).
            const offered = addonState(addon).catalog.models.find((candidate) => candidate.id === request.model);
            if (
              offered === undefined ||
              (request.contextWindow ?? null) !== null ||
              (request.reasoningEffort !== null &&
                offered.reasoningEfforts.length > 0 &&
                !modelSupportsReasoningEffort(offered, request.reasoningEffort))
            ) {
              return refuse("unsupported_value");
            }
          }
        } else if (claude) {
          if (request.model !== null) {
            // The effort of a model the session has not switched to is only known after the switch,
            // so only its form is checked here; the engine has the last word when it is applied.
            try {
              parseGuildModelId("claude", request.model);
              if (request.reasoningEffort !== null) parseGuildClaudeReasoningEffort(request.reasoningEffort);
            } catch {
              return refuse("unsupported_value");
            }
            if ((request.contextWindow ?? null) !== null || !claudeModelStorable(request.model)) {
              return refuse("unsupported_value");
            }
          }
        } else if (request.model !== null && modelCatalog.models.length > 0) {
          const offered = grokModelById(modelCatalog, request.model);
          if (
            offered === undefined ||
            (request.reasoningEffort !== null &&
              !modelSupportsReasoningEffort(offered, request.reasoningEffort)) ||
            (request.contextWindow !== undefined &&
              request.contextWindow !== null &&
              !offered.contextWindows.includes(request.contextWindow))
          ) {
            return refuse("unsupported_value");
          }
        }
        const controller = controllers.get(taskId);
        const adapter = controller?.adapter;
        const session = controller?.session;
        if (
          controller !== undefined &&
          adapter !== undefined &&
          session !== undefined &&
          adapter.state === "ready"
        ) {
          // docs/20 3.3, D-062: a model of the other mode (native Claude, routed Online / Local) restarts the
          // process in that mode between turns, as does a routed model the routed process does not list yet.
          // Clearing the choice means the Claude default, so it is a native target. The restart takes
          // seconds, so it runs after this command, outside the queue.
          if (claude) {
            const targetRouted = request.model !== null && routedModels().some((model) => model.id === request.model);
            const modeRestart = targetRouted
              ? !controller.routedProcess || !optionOffersModel(controller.sessionConfigOptions, request.model!)
              : controller.routedProcess;
            if (modeRestart) {
              if (targetRouted) {
                try {
                  await ensureRouterReady(taskId);
                } catch {
                  return refuse("unavailable");
                }
              }
              persist();
              await publish();
              return Object.freeze({ status: "mode_restart" as const, previous: existing });
            }
          }
          // Apply to the live session first: a refused switch must leave the stored choice untouched.
          const outcome = request.model === null
            ? undefined
            : await applyRuntimeSelection({
                port: adapter,
                session,
                options: controller.sessionConfigOptions,
                catalog: catalogOfEngine(metadata.engine),
                desired: {
                  modelId: request.model,
                  reasoningEffort: request.reasoningEffort,
                  contextWindow: request.contextWindow ?? null,
                },
                currentContextWindow: controller.contextWindowUsage?.size ?? controller.contextWindowSize,
              });
          if (outcome !== undefined) {
            applySessionOptions(controller, outcome.options);
            if (outcome.status === "refused") {
              logRuntime({
                category: "runtime",
                event: "model_switch_refused",
                taskId,
                sessionId: session.sessionId,
                reason: outcome.reason,
              });
              return refuse(outcome.reason);
            }
            if (outcome.contextWindow !== undefined) controller.contextWindowSize = outcome.contextWindow;
          }
          controller.selectionRefused = false;
          persist();
          // Clearing the override sends the session back to the default at the next turn start.
          if (request.model === null) {
            await reconcileRuntimeSelection(taskId, controller, adapter, session).catch(() => undefined);
          }
          await publish();
          return Object.freeze({ status: "applied" as const, task: view() });
        }
        persist();
        await publish();
        return Object.freeze({ status: "saved" as const, task: view() });
      },
      );
      if (outcome.status !== "mode_restart") return outcome;
      // The override is stored; ensureSession sees the process has the wrong mode and restarts it.
      const taskId = request.taskId;
      try {
        await ensureSession(taskId);
      } catch {
        // The previous choice comes back, and with it the mode the process had; the next turn starts
        // a process in that mode again.
        await enqueueCommand(async () => {
          const current = store.loadTaskRuntimeSettings(taskId);
          if (outcome.previous === undefined) {
            if (current !== undefined) store.clearTaskRuntimeSettings({ taskId, expectedRevision: current.revision });
          } else {
            store.saveTaskRuntimeSettings({
              taskId,
              expectedRevision: current?.revision ?? 0,
              modelId: outcome.previous.modelId,
              reasoningEffort: outcome.previous.reasoningEffort,
              contextWindow: outcome.previous.contextWindow,
            });
          }
          await publish();
        }).catch(() => undefined);
        return enqueueCommand(async () => Object.freeze({
          status: "refused" as const,
          reason: "unavailable" as const,
          task: taskView(taskId, conversationPageDepths.get(taskId) ?? 1),
        }));
      }
      return enqueueCommand(async () => {
        // The start succeeded: a projection that cannot be built now is not a failed switch.
        await publish().catch(() => {
          logRuntime({ category: "runtime", event: "mode_switch_publish_failed", taskId });
        });
        // "Applied" only when the new process is the one running the model. A session that became
        // busy while the router came up keeps its process: the choice is stored and the switch
        // happens at the next idle point.
        const controller = controllers.get(taskId);
        const targetRouted = request.model !== null && routedModels().some((model) => model.id === request.model);
        const live = controller?.session !== undefined && controller.adapter?.state === "ready" &&
          controller.routedProcess === targetRouted &&
          (request.model === null || sessionSelectionOf(controller.sessionConfigOptions).modelId === request.model);
        return Object.freeze({
          status: live ? "applied" as const : "saved" as const,
          task: taskView(taskId, conversationPageDepths.get(taskId) ?? 1),
        });
      });
    },
    setTaskEngine: async (taskId, engine) => enqueueCommand(async () => {
      assertOpen();
      const metadata = store.loadTaskMetadata(taskId);
      if (metadata.disposition !== "active") throw new Error("task_not_writable");
      if (metadata.engine === engine) return taskView(taskId, conversationPageDepths.get(taskId) ?? 1);
      // PC-TASK-001: no silent rebinding. The engine is chosen before the first turn and then fixed.
      if (
        metadata.routedAtMs !== undefined ||
        store.listTaskRuns(taskId).length > 0 ||
        !taskSelectionCanChange(taskId)
      ) {
        throw new Error(TASK_ENGINE_LOCKED);
      }
      // A session the slash-command menu opened belongs to the old engine: stop its process first;
      // the store then starts the task's session over.
      await settlePrewarmStarts([taskId]);
      const controller = controllers.get(taskId);
      if (controller !== undefined) {
        await closeController(taskId, controller, true);
        controllers.delete(taskId);
      }
      persistedContextTokens.delete(taskId);
      try {
        store.setTaskEngine({ taskId, expectedRevision: store.loadTaskMetadata(taskId).revision, engine });
      } catch {
        throw new Error(TASK_ENGINE_LOCKED);
      }
      logRuntime({ category: "runtime", event: "task_engine_changed", taskId });
      await publish();
      return taskView(taskId, conversationPageDepths.get(taskId) ?? 1);
    }),
    setClaudeSettings: async (model, reasoningEffort, permissionMode) => enqueueCommand(async () => {
      assertOpen();
      const exactMode = parseGuildClaudePermissionMode(permissionMode);
      if (model === null && reasoningEffort !== null) throw new Error("runtime_settings_change_unavailable");
      try {
        if (model !== null) parseGuildModelId("claude", model);
        if (reasoningEffort !== null) parseGuildClaudeReasoningEffort(reasoningEffort);
      } catch {
        throw new Error("runtime_settings_change_unavailable");
      }
      // The stored default must be something the engine or the router offers. The effort of a model
      // the session has not switched to is only known after the switch, so only its form is checked.
      const catalog = claudeCatalogProjection();
      if (model !== null && !claudeModelStorable(model)) {
        throw new Error("runtime_settings_change_unavailable");
      }
      // An Online / Local model is a per-task choice behind the online reminder; as the global default
      // it would start new tasks on a third-party vendor without one.
      if (model !== null) {
        const offered = catalog.models.find((candidate) => candidate.id === model);
        if (
          (offered !== undefined && offered.group !== "claude") ||
          routedModels().some((candidate) => candidate.id === model)
        ) {
          throw new Error(CLAUDE_DEFAULT_MUST_BE_NATIVE);
        }
      }
      const current = store.loadAppSettings();
      if (
        current.claudeModel === model &&
        current.claudeEffort === reasoningEffort &&
        current.claudePermissionMode === exactMode
      ) return buildBootstrap();
      // Applied to each session between turns (reconcileRuntimeSelection, reconcileAdapterPermissionMode),
      // so changing a default never closes a process or loses a conversation's context.
      store.updateAppSettings({
        expectedRevision: current.revision,
        claudeModel: model,
        claudeEffort: reasoningEffort,
        claudePermissionMode: exactMode,
      });
      await publish();
      return buildBootstrap();
    }),
    setEngineSettings: async (engine, model, reasoningEffort, permissionMode) => enqueueCommand(async () => {
      assertOpen();
      if (!isAddonEngine(engine)) throw new Error("runtime_settings_change_unavailable");
      let exactMode: string;
      try {
        exactMode = parseGuildAddonPermissionMode(engine, permissionMode);
        if (model === null && reasoningEffort !== null) throw new TypeError("effort_without_model");
        if (model !== null) parseGuildModelId(engine, model);
        if (reasoningEffort !== null) parseGuildReasoningEffort(engine, reasoningEffort);
      } catch {
        throw new Error("runtime_settings_change_unavailable");
      }
      // The stored default must be a model the engine's own sessions listed, with an effort that model offers.
      if (model !== null) {
        const offered = addonState(engine).catalog.models.find((candidate) => candidate.id === model);
        if (
          offered === undefined ||
          (reasoningEffort !== null && offered.reasoningEfforts.length > 0 && !modelSupportsReasoningEffort(offered, reasoningEffort))
        ) {
          throw new Error("runtime_settings_change_unavailable");
        }
      }
      const current = store.loadAppSettings();
      const stored = current.engineDefaults[engine];
      if (stored.model === model && stored.reasoningEffort === reasoningEffort && stored.permissionMode === exactMode) {
        return buildBootstrap();
      }
      // Applied to each session between turns, so changing a default never closes a process or loses context.
      store.updateAppSettings({
        expectedRevision: current.revision,
        engineDefaults: { engine, model, reasoningEffort, permissionMode: exactMode },
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
      dockIcon,
    ) => enqueueCommand(async () => {
      assertOpen();
      const mode = parseGuildNewTaskWorkspaceMode(newTaskWorkspaceMode);
      const icon = parseGuildDockIcon(dockIcon);
      const settings = store.loadAppSettings();
      store.updateAppSettings({
        expectedRevision: settings.revision,
        restoreLastTask,
        newTaskWorkspaceMode: mode,
        browserSyncEnabled,
        taskNotificationsEnabled,
        dockIcon: icon,
      });
      allowAutoSelectActiveTask = restoreLastTask;
      applyDockIcon(icon);
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
      await settlePrewarmStarts();
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
      await settlePrewarmStarts();
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
      await settlePrewarmStarts();
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
        const interruptedTaskIds = new Set<TaskId>();
        for (const workspace of store.listWorkspaces({ includeArchived: true })) {
          for (const task of store.listTasks({
            workspaceId: workspace.workspaceId,
            includeArchived: true,
          })) {
            const run = store.restoreTask(task.taskId).currentRun;
            if (run === undefined || TERMINAL_RUN_STATES.has(run.state)) continue;
            interruptedTaskIds.add(task.taskId);
            store.applyRun({
              taskId: task.taskId,
              runId: run.runId,
              event: { type: event === "suspend" ? "os_suspend" : event === "resume" ? "os_resume" : "renderer_reload" },
            });
          }
        }
        if (event === "resume") await recoverRuntimesAfterResume(interruptedTaskIds);
        await publish();
        if (event === "resume") {
          for (const workspace of store.listWorkspaces()) {
            for (const task of store.listTasks({ workspaceId: workspace.workspaceId })) {
              scheduleQueuedDispatch(task.taskId);
            }
          }
          if (activeTaskId !== undefined) prewarmTask(activeTaskId);
        }
      });
    },
    subscribe: (listener) => {
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeStreamDeltas: (listener) => {
      assertOpen();
      deltaListeners.add(listener);
      return () => deltaListeners.delete(listener);
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
      if (streamPublishTimer !== undefined) clearTimeout(streamPublishTimer);
      streamPublishTimer = undefined;
      if (streamDeltaTimer !== undefined) clearTimeout(streamDeltaTimer);
      streamDeltaTimer = undefined;
      pendingStreamDeltas.clear();
      await streamPublishOperation?.catch(() => undefined);
      if (maintenance) await diagnosticLog.flush();
      else await diagnosticLog.flush().catch(() => undefined);
      unsubscribeRouterChanges?.();
      listeners.clear();
      deltaListeners.clear();
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
      // The runtime persisted a Steer as a user chunk inside the turn it steered.
      if (update.interjection === true) {
        if (current === undefined) throw new Error("session_load_replay_missing_user_anchor");
        continue;
      }
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
  engine: GuildEngine,
): string {
  const evidence = diagnostic.signal !== undefined && diagnostic.signal !== null
    ? (locale === "zh-CN" ? `（信号 ${diagnostic.signal}）` : ` (signal ${diagnostic.signal})`)
    : typeof diagnostic.exitCode === "number"
      ? (locale === "zh-CN" ? `（退出码 ${diagnostic.exitCode}）` : ` (exit code ${diagnostic.exitCode})`)
      : "";
  return locale === "zh-CN"
    ? `${engineName(engine)} 运行连接中断${evidence}。Guild 正在恢复原会话；为避免重复修改，不会自动重发这条指令。诊断详情已写入本地日志。`
    : `The ${engineName(engine)} runtime connection was interrupted${evidence}. Guild is restoring the original session and will not resend this instruction automatically, avoiding duplicate changes. Diagnostic details were written to the local log.`;
}

/** The engine's name as the user knows it, for the notices Guild writes into a task. */
function engineName(engine: GuildEngine): string {
  return engine === "claude" ? "Claude" : engine === "codex" ? "Codex" : "Grok";
}

/** Engines whose process is a user-installed ACP adapter that Guild never authenticates for: every engine but Grok. */
function isAdapterEngine(engine: GuildEngine): boolean {
  return engine !== "grok";
}

/** The turn was not sent because the session could not be brought to the selected model (docs/20 3.3). */
function modelSelectionFailedMessage(locale: GuildLocale, engine: GuildEngine = "claude"): string {
  const name = engineName(engine);
  return locale === "zh-CN"
    ? `${name} 未能切换到这个任务选择的模型，所以这条消息没有发送。请重新选择模型，或换一个模型后再发送。`
    : `${name} could not switch to the model selected for this task, so the message was not sent. Choose the model again, or pick another one, then send it again.`;
}

function claudeLoginRequiredMessage(locale: GuildLocale): string {
  return locale === "zh-CN"
    ? "Claude Code 尚未登录。请先在终端运行一次 `claude` 并完成登录，然后重试。"
    : "Claude Code is not logged in. Run `claude` in Terminal once and log in, then retry.";
}

function loginRequiredMessage(locale: GuildLocale, engine: GuildEngine): string {
  return isAddonEngine(engine) ? addonLoginRequiredMessage(locale, engine) : claudeLoginRequiredMessage(locale);
}

/** The `failureCategory` of the error entry a missing login leaves in the conversation. */
function loginRequiredCategory(engine: GuildEngine): string {
  return isAddonEngine(engine) ? `${engine}_login_required` : "claude_login_required";
}

/** The login command of each add-on engine; Guild shows it and never runs it. */
const ADDON_LOGIN_COMMAND: Readonly<Record<GuildAddonEngine, string>> = Object.freeze({ codex: "codex login" });

function addonLoginRequiredMessage(locale: GuildLocale, engine: GuildAddonEngine): string {
  const name = engineName(engine);
  const command = ADDON_LOGIN_COMMAND[engine];
  return locale === "zh-CN"
    ? `${name} 尚未登录。请先在终端运行 \`${command}\` 并完成登录，然后重试。`
    : `${name} is not logged in. Run \`${command}\` in Terminal and log in, then retry.`;
}

async function createProductionRuntime(
  input: Parameters<RuntimeFactory>[0],
  options: Readonly<{ codexAdapterRoot?: string | undefined }> = {},
) {
  if (input.engine === "codex") {
    return createCodexRuntime(
      {
        adapterEpoch: input.adapterEpoch,
        sink: input.sink,
        stagingRoot: input.stagingRoot,
        workingDirectory: input.workingDirectory,
      },
      {
        locatorOptions: options.codexAdapterRoot === undefined ? {} : { extraAdapterRoots: [options.codexAdapterRoot] },
      },
    );
  }
  if (input.engine === "claude") {
    return createClaudeRuntime({
      adapterEpoch: input.adapterEpoch,
      sink: input.sink,
      stagingRoot: input.stagingRoot,
      workingDirectory: input.workingDirectory,
      ...(input.extraEnvironment === undefined ? {} : { extraEnvironment: input.extraEnvironment }),
    });
  }
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
  host.onEvent((event) => {
    // A binary that failed its pin or its spawn may have been replaced; locate it afresh next time.
    if (event.type === "preflight_failure" || event.type === "spawn_failure") {
      invalidateOfficialGrokRuntimeCache();
    }
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

function promptFailureMessage(locale: GuildLocale, engine: GuildEngine): string {
  return locale === "zh-CN"
    ? `${engineName(engine)} 返回了无法处理的错误，本轮已经停止。你的消息仍保留在对话中，可以直接重试。`
    : `${engineName(engine)} returned an error that could not be processed. This turn has stopped, and your message remains in the conversation so you can retry it.`;
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
  readonly engineName: string;
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
    `The prior official ${input.engineName} session for this exact Guild task could not be resumed. This is a replacement session, not a new or different task.`,
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
