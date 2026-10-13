/**
 * Closed desktop IPC surface and renderer projections.
 * Implements PC-SEC-003, PC-TASK-001, PC-CONV-001 and PC-I18N-001.
 */

import {
  parseRunId,
  parseTaskId,
  parseWorkspaceId,
  type RunId,
  type TaskId,
  type WorkspaceId,
} from "./ids.js";
import type { RunState } from "./run-events.js";
import {
  GUILD_CLAUDE_PERMISSION_MODES,
  engineApiKeySpec,
  isAddonEngine,
  parseGuildAddonPermissionMode,
  parseGuildClaudeModel,
  parseGuildClaudePermissionMode,
  parseGuildClaudeReasoningEffort,
  parseGuildEngine,
  type GuildAddonEngine,
  type GuildClaudePermissionMode,
  type GuildEngine,
} from "./engines.js";
import {
  parseGuildGrokContextWindow,
  parseGuildGrokModel,
  parseGuildGrokReasoningEffort,
  parseGuildModelId,
  parseGuildModelIdOfAnyEngine,
  parseGuildReasoningEffort,
  type GrokModelCatalog,
  type GuildGrokModel,
  type GuildGrokReasoningEffort,
  type GuildModelSelectionSource,
  type ModelCatalog,
} from "./grok-models.js";
import {
  parseBrowserCommand,
  type BrowserCommand,
  type BrowserPaneProjection,
} from "./browser-pane.js";
import {
  parseModelSourceDraft,
  parseModelSourceIdRequest,
  parseModelSourceKeyFile,
  parseModelSourceKeyVariable,
  type ConfirmModelSourceRequest,
  type ConfirmModelSourceResponse,
  type TestModelSourceRequest,
  type TestModelSourceResponse,
  type DeleteModelSourceRequest,
  type ListModelSourcesRequest,
  type ListModelSourcesResponse,
  type UpsertModelSourceRequest,
  type UpsertModelSourceResponse,
} from "./model-sources.js";
import { boundedText, exactRecord } from "./request-record.js";
import type { RunPhaseProjection } from "./run-phase.js";
import {
  GUILD_TASK_ISOLATIONS,
  type ApplyWorktreeRequest,
  type ApplyWorktreeResponse,
  type DiscardWorktreeRequest,
  type DiscardWorktreeResponse,
  type GuildTaskIsolation,
  type GuildWorktreeStatus,
  type OpenWorktreeResourceRequest,
  type PreviewWorktreeApplyRequest,
  type PreviewWorktreeApplyResponse,
  type TaskWorktreeProjection,
} from "./worktrees.js";
import {
  GUILD_REWIND_SCOPES,
  GUILD_STEER_MAX_LENGTH,
  type ConvertQueuedTurnToSteerRequest,
  type ConvertQueuedTurnToSteerResponse,
  type ExecuteRewindRequest,
  type ExecuteRewindResponse,
  type LoadRunFileDiffRequest,
  type LoadRunFileDiffResponse,
  type PreviewRewindRequest,
  type PreviewRewindResponse,
  type RewindAvailabilityProjection,
  type RunCheckpointProjection,
  type RunModelProjection,
  type SteerAvailabilityProjection,
  type SteerMessageRequest,
  type SteerMessageResponse,
  type TimelineInterjectionProjection,
} from "./steer-checkpoints.js";
import type {
  AcpPermissionOptionKind,
  AcpToolKind,
  AcpToolStatus,
  RuntimeCommand,
  RuntimeConfigOption,
  RuntimeToolContent,
  RuntimeToolLocation,
} from "./runtime-payload.js";

export type TimelineToolContent =
  | Exclude<RuntimeToolContent, { readonly type: "media" }>
  | {
      readonly type: "media";
      readonly mediaType: "image";
      readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
      readonly grantUrl: string;
      readonly alt: string;
      readonly mediaSha256: string;
    };

export const GUILD_API_VERSION = 1 as const;

export const GUILD_LOCALES = Object.freeze(["zh-CN", "en-US"] as const);
export type GuildLocale = (typeof GUILD_LOCALES)[number];

export const GUILD_GROK_PERMISSION_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
] as const);
export type GuildGrokPermissionMode =
  (typeof GUILD_GROK_PERMISSION_MODES)[number];
export type GuildGrokStartupSettings = Readonly<{
  webSearchEnabled: boolean;
  planEnabled: boolean;
  subagentsEnabled: boolean;
  maxTurns: number | null;
}>;
export const GUILD_DEFAULT_GROK_STARTUP_SETTINGS: GuildGrokStartupSettings = Object.freeze({
  webSearchEnabled: true,
  planEnabled: true,
  subagentsEnabled: true,
  maxTurns: null,
});

export const DESKTOP_IPC_CHANNELS = Object.freeze({
  bootstrap: "guild:v1:bootstrap",
  chooseWorkspace: "guild:v1:workspace:choose",
  choosePromptFiles: "guild:v1:prompt-files:choose",
  createTask: "guild:v1:task:create",
  openTask: "guild:v1:task:open",
  loadEarlierTimeline: "guild:v1:task:timeline:earlier",
  loadSlashCommands: "guild:v1:task:slash-commands",
  forkTask: "guild:v1:task:fork",
  exportTask: "guild:v1:task:export",
  searchConversations: "guild:v1:conversation:search",
  openTaskResource: "guild:v1:task:resource:open",
  setSessionConfigOption: "guild:v1:task:session-config:set",
  setTaskRuntimeSettings: "guild:v1:task:runtime-settings:set",
  updateWorkspace: "guild:v1:workspace:update",
  updateTask: "guild:v1:task:update",
  sendMessage: "guild:v1:run:send",
  setContinuousTask: "guild:v1:task:continuous:set",
  prioritizeQueuedTurn: "guild:v1:queue:prioritize",
  preemptQueuedTurn: "guild:v1:queue:preempt",
  cancelQueuedTurn: "guild:v1:queue:cancel",
  cancelRun: "guild:v1:run:cancel",
  steerMessage: "guild:v1:run:steer",
  convertQueuedTurnToSteer: "guild:v1:queue:steer",
  previewRewind: "guild:v1:run:rewind:preview",
  executeRewind: "guild:v1:run:rewind:execute",
  loadRunFileDiff: "guild:v1:run:file-diff:load",
  previewWorktreeApply: "guild:v1:worktree:preview-apply",
  applyWorktree: "guild:v1:worktree:apply",
  discardWorktree: "guild:v1:worktree:discard",
  openWorktreeResource: "guild:v1:worktree:resource:open",
  decidePermission: "guild:v1:permission:decide",
  setDraft: "guild:v1:draft:set",
  authorizeSessionReplacement: "guild:v1:session:authorize-replacement",
  refreshUsage: "guild:v1:account:usage:refresh",
  openExternal: "guild:v1:platform:open-external",
  setLocale: "guild:v1:settings:locale",
  setRuntimeSettings: "guild:v1:settings:runtime",
  setSidebarWidth: "guild:v1:settings:sidebar-width",
  chooseAvatar: "guild:v1:profile:avatar:choose",
  saveProfile: "guild:v1:profile:save",
  setGeneralSettings: "guild:v1:settings:general",
  openUserData: "guild:v1:settings:open-user-data",
  backupUserData: "guild:v1:settings:backup-user-data",
  restoreUserData: "guild:v1:settings:restore-user-data",
  openRuntimeDiagnostics: "guild:v1:diagnostics:open-runtime-log",
  runGrokManagement: "guild:v1:grok:management:run",
  setTaskEngine: "guild:v1:task:engine:set",
  setClaudeSettings: "guild:v1:settings:claude",
  setEngineSettings: "guild:v1:settings:engine",
  setEngineApiKey: "guild:v1:settings:engine-key",
  confirmEngineApiKey: "guild:v1:settings:engine-key:confirm",
  listModelSources: "guild:v1:model-sources:list",
  upsertModelSource: "guild:v1:model-sources:upsert",
  deleteModelSource: "guild:v1:model-sources:delete",
  confirmModelSource: "guild:v1:model-sources:confirm",
  testModelSource: "guild:v1:model-sources:test",
  getWorkspacePrefs: "guild:v1:workspace-prefs:get",
  setWorkspacePrefs: "guild:v1:workspace-prefs:set",
  browserCommand: "guild:v1:browser:command",
  projectionChanged: "guild:v1:event:projection-changed",
  streamDelta: "guild:v1:event:stream-delta",
  browserPaneChanged: "guild:v1:event:browser-pane-changed",
} as const);

/** Main-to-renderer push channels. Every other registered channel is renderer-initiated invoke. */
export const DESKTOP_EVENT_CHANNELS = Object.freeze([
  DESKTOP_IPC_CHANNELS.projectionChanged,
  DESKTOP_IPC_CHANNELS.streamDelta,
  DESKTOP_IPC_CHANNELS.browserPaneChanged,
] as const);
export type DesktopEventChannel = (typeof DESKTOP_EVENT_CHANNELS)[number];

export const GUILD_DEFAULT_NICKNAME = "BDV";

export function canonicalGuildExternalUrl(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const loopbackHttp = parsed.protocol === "http:" && (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.origin === "null"
  ) {
    throw new TypeError("invalid_external_url");
  }
  return parsed.href;
}
export const GUILD_NICKNAME_MAX_LENGTH = 32;
/** The Dock icon the user picks in Settings > General (PC-SET-002): `dark` is the bundle icon, `light` the alternate. */
export const GUILD_DOCK_ICONS = Object.freeze(["dark", "light"] as const);
export type GuildDockIcon = (typeof GUILD_DOCK_ICONS)[number];
export const GUILD_DEFAULT_DOCK_ICON: GuildDockIcon = "dark";
export const GUILD_NEW_TASK_WORKSPACE_MODES = Object.freeze(["ask", "last"] as const);
export type GuildNewTaskWorkspaceMode = (typeof GUILD_NEW_TASK_WORKSPACE_MODES)[number];
export const GUILD_AVATAR_REJECTION_REASONS = Object.freeze([
  "too_large",
  "invalid_image",
  "unsupported_type",
] as const);
export type GuildAvatarRejectionReason = (typeof GUILD_AVATAR_REJECTION_REASONS)[number];

export type DesktopIpcChannel =
  (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

export const GUILD_TASK_ACTIVITIES = Object.freeze([
  "working", "thinking", "planning", "reading", "editing", "deleting", "moving",
  "searching", "executing", "fetching", "switching_mode", "responding",
] as const);
export type GuildTaskActivity = (typeof GUILD_TASK_ACTIVITIES)[number];

export type WorkspaceProjection = {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly archived: boolean;
  /** True when the folder is inside a git work tree, so a task may ask for an isolated worktree (F3). */
  readonly worktreeAvailable?: true;
  readonly tasks: readonly TaskSummaryProjection[];
};

export type TaskSummaryProjection = {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly updatedAtMs: number;
  readonly queuedTurnCount?: number;
  readonly activeRunState?: RunState;
  readonly activeActivity?: GuildTaskActivity;
  /** Present when the task works in its own git worktree (F3); the sidebar shows a branch glyph. */
  readonly worktreeStatus?: GuildWorktreeStatus;
  /**
   * Engine the task runs on (PC-ENG-001). Absent means `"grok"`; the task view carries it through
   * its `task`. It is fixed at the task's first turn (`setTaskEngine` works only before any Run).
   */
  readonly engine?: GuildEngine;
};

export type TimelineItemStatus =
  | "streaming"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

type TimelineBase = {
  readonly entryId: string;
  readonly taskId: TaskId;
  readonly runId?: RunId;
  readonly sequence: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly status: TimelineItemStatus;
  /** Steer state; only on a steered `user` entry and on the `notice` entry of a fallback. */
  readonly interjection?: TimelineInterjectionProjection;
  /** True when a rewind undid this entry's Run; the entry is kept for audit and should be dimmed. */
  readonly rolledBack?: true;
};

export type TimelineItemProjection = TimelineBase &
  (
    | { readonly kind: "user" | "assistant"; readonly text: string }
    | {
        readonly kind: "error";
        readonly text: string;
        /** Correlates a transport error with the recovery notice that replaces it in the UI. */
        readonly incidentId?: string;
      }
    | {
        readonly kind: "notice";
        readonly text: string;
        readonly noticeType?: "session_restored";
        readonly incidentId?: string;
      }
    | {
        readonly kind: "thought";
        readonly text: string;
        readonly startedAtMs: number;
        readonly elapsedMs: number;
      }
    | {
        readonly kind: "tool";
        readonly toolCallId?: string;
        /** Explicit ACP semantic kind; tool call IDs are agent-owned opaque values. */
        readonly runtimeReplayKind?: "tool" | "plan";
        readonly title: string;
        readonly toolKind: AcpToolKind;
        readonly toolStatus: AcpToolStatus;
        readonly content: readonly TimelineToolContent[];
        readonly locations: readonly RuntimeToolLocation[];
      }
    | {
        readonly kind: "permission";
        readonly permissionId: string;
        readonly title: string;
        readonly options: readonly {
          readonly optionId: string;
          readonly name: string;
          readonly kind: AcpPermissionOptionKind;
        }[];
      }
    | {
        readonly kind: "media";
        readonly mediaType: "image" | "audio" | "video" | "document";
        readonly grantUrl: string;
        readonly alt: string;
        readonly mimeType: string;
      }
  );

export type TaskViewProjection = {
  readonly task: TaskSummaryProjection;
  readonly timeline: readonly TimelineItemProjection[];
  readonly hasEarlierTimeline: boolean;
  readonly queuedTurns: readonly QueuedTurnProjection[];
  readonly draft: string;
  readonly canSend: boolean;
  readonly sessionRecovery: "available" | "replacement_required";
  readonly contextWindow: ContextWindowProjection;
  readonly availableCommands: readonly RuntimeCommand[];
  readonly sessionModes: {
    readonly currentModeId: string;
    readonly availableModes: readonly {
      readonly id: string;
      readonly name: string;
      readonly description?: string | null;
    }[];
  } | null;
  readonly sessionConfigOptions: readonly RuntimeConfigOption[];
  readonly modelSelection: TaskModelSelectionProjection;
  /** Account summary and reduced states of a Claude-engine task (docs/20 3.8). Absent for a Grok task. */
  readonly engineStatus?: EngineStatusProjection;
  /** Ephemeral phase of the running turn; absent when no turn is running. */
  readonly runPhase?: RunPhaseProjection;
  /** Whether the composer may Steer the running turn (F4). */
  readonly steer?: SteerAvailabilityProjection;
  /** Checkpoint and changed-file summary of the Runs in the loaded timeline window (F2). */
  readonly runCheckpoints?: readonly RunCheckpointProjection[];
  /** The model each Run of the loaded timeline window started on (answer footers); Runs without a record are absent. */
  readonly runModels?: readonly RunModelProjection[];
  /** Whether a rewind could be offered right now (F2). */
  readonly rewind?: RewindAvailabilityProjection;
  /** Branch, ahead / behind and uncommitted count of the task's isolated worktree (F3). */
  readonly worktree?: TaskWorktreeProjection;
  readonly auxiliaryActivity?: Readonly<{
    activity: GuildTaskActivity;
    startedAtMs: number;
    workerCount: number;
    toolKinds: readonly AcpToolKind[];
  }>;
  readonly workbench: TaskWorkbenchProjection;
  readonly recentResult?: Readonly<{
    runId: RunId;
    state: "completed" | "failed" | "cancelled" | "interrupted";
    workbench: TaskWorkbenchProjection;
  }>;
  readonly continuousTask?: Readonly<{
    objective: string;
    lastRunId?: RunId;
    status: "active" | "paused" | "completed" | "blocked" | "stopped";
    phase: "work" | "audit";
    cycle: number;
    summary?: string;
    remaining?: string;
    stopReason?: string;
  }>;
};

/**
 * What a Claude or add-on engine reported about itself, for the usage panel and the composer
 * (PC-ENG-001, PC-FALLBACK-001). Quota and billing belong to the engine, so there is nothing to meter here.
 */
export type EngineStatusProjection = Readonly<{
  /** Plan label of the logged-in account, for example "Claude Max". Never an e-mail address. */
  accountLabel?: string;
  /** The engine reported that nobody is logged in: the user must log in with the engine's own command. */
  loginRequired?: true;
}>;

export type TaskWorkbenchProjection = {
  readonly files: readonly {
    readonly path: string;
    readonly displayPath: string;
    readonly line?: number;
  }[];
  readonly diffs: readonly {
    readonly path: string;
    readonly displayPath: string;
    readonly oldText?: string;
    readonly newText: string;
  }[];
  readonly terminalObserved: boolean;
};

/**
 * Streaming text delta for one authored entry (assistant text or thought).
 * It is an optimization over the full projection, never an authority:
 * `offset` is the UTF-16 length of the entry text before `appendText`, so the renderer
 * can detect gaps and duplicates and always converges on the next full projection.
 */
export const GUILD_STREAM_DELTA_KINDS = Object.freeze(["assistant", "thought"] as const);
export type GuildStreamDeltaKind = (typeof GUILD_STREAM_DELTA_KINDS)[number];
export const GUILD_STREAM_DELTA_LIMITS = Object.freeze({
  /** Bounds one coalesced delta; a single runtime chunk is at most 65,536 characters. */
  maxAppendTextLength: 131_072,
  /** Persistence caps one entry at 1 MiB of UTF-8, which is fewer UTF-16 units than this. */
  maxOffset: 1_048_576,
  maxRevision: 4_294_967_295,
});
export type StreamDeltaEvent = Readonly<{
  taskId: TaskId;
  runId?: RunId;
  entryId: string;
  kind: GuildStreamDeltaKind;
  /** UTF-16 length of the entry text before this delta was appended. */
  offset: number;
  appendText: string;
  /** Strictly increasing per entry; counts runtime chunks applied by main. */
  revision: number;
  updatedAtMs: number;
}>;

export type ConversationSearchResult = {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly taskTitle: string;
  readonly workspaceName: string;
  readonly sequence: number;
  readonly snippet: string;
  readonly updatedAtMs: number;
};

export type ContextWindowProjection =
  | { readonly status: "unavailable" }
  | {
      readonly status: "used_only";
      readonly used: number;
    }
  | {
      readonly status: "available";
      readonly used: number;
      readonly size: number;
    };

export type QueuedTurnProjection = {
  readonly queueId: string;
  readonly text: string;
  readonly createdAtMs: number;
};

export type OfficialUsageProjection =
  | { readonly status: "loading" }
  | { readonly status: "unavailable"; readonly reason: "not_reported_by_runtime" }
  | {
      readonly status: "available";
      readonly usedLabel: string;
      readonly limitLabel?: string;
      readonly resetsAtIso?: string;
      readonly fetchedAtIso: string;
    };

export type RuntimeSettingsProjection = {
  /** Global default model; null follows the runtime's advertised default. */
  readonly model: GuildGrokModel | null;
  /** Global default reasoning effort; null follows the selected model's advertised default. */
  readonly reasoningEffort: GuildGrokReasoningEffort | null;
  /** Last list the official runtime advertised; empty until a runtime has started once. */
  readonly modelCatalog: GrokModelCatalog;
  readonly permissionMode: GuildGrokPermissionMode;
  readonly availablePermissionModes: typeof GUILD_GROK_PERMISSION_MODES;
  readonly startup: GuildGrokStartupSettings;
  readonly canChange: boolean;
  /** Claude-engine defaults (PC-SET-002). Absent until the main process supplies them. */
  readonly claude?: ClaudeEngineSettingsProjection;
  /** Defaults and state of each add-on engine (PC-SET-002, PC-ENG-003). Absent until the main process supplies them. */
  readonly engines?: Readonly<Partial<Record<GuildAddonEngine, AddonEngineSettingsProjection>>>;
  /**
   * Last model list each engine advertised (PC-MODEL-001). `modelCatalog` above stays the Grok
   * catalog for the existing UI; `modelCatalogs.grok` is the same value. The Claude catalog also
   * carries the enabled Online / Local models, labelled by `group`.
   */
  readonly modelCatalogs?: Readonly<Record<GuildEngine, ModelCatalog>>;
};

/**
 * Whether Claude Code can run on this machine (PC-ENG-002): `not_found` when node, the ACP adapter
 * or the `claude` binary is missing or unsupported, `not_logged_in` when the engine reported that
 * nobody is logged in, `unavailable` when it is installed but could not be checked, and
 * `integrity_changed` when its pinned files changed without an update and Guild refuses to run them.
 */
export const GUILD_CLAUDE_ENGINE_STATUSES = Object.freeze([
  "ready", "not_found", "not_logged_in", "unavailable", "integrity_changed",
] as const);
export type GuildClaudeEngineStatus = (typeof GUILD_CLAUDE_ENGINE_STATUSES)[number];

/** The same states for every engine that is installed separately (Claude Code and the add-on engines). */
export type GuildEngineStatus = GuildClaudeEngineStatus;

/**
 * Defaults and state of an add-on engine (Codex): the Claude shape, with the engine's own permission modes by id.
 * `permissionMode` is one of `availablePermissionModes`.
 */
export type AddonEngineSettingsProjection = {
  /** Absent until the main process has looked for the engine. */
  readonly status?: GuildEngineStatus;
  /** Plan label of the logged-in account, for example "ChatGPT Pro". Never an e-mail address. */
  readonly accountLabel?: string;
  /** Version of the engine's core, for example the installed Codex. */
  readonly version?: string;
  /** Default model id; null follows the engine's own default. */
  readonly model: string | null;
  /** Default effort; null follows the engine. */
  readonly reasoningEffort: string | null;
  readonly permissionMode: string;
  readonly availablePermissionModes: readonly string[];
  /** The API key binding of an engine that is paid for per use (Gemini); absent for an engine with no key field. */
  readonly apiKey?: EngineApiKeyProjection;
};

/**
 * What the renderer sees of an engine's API key binding (PC-ENG-004): the names of the file and variable the key is
 * read from, the host it may be sent to and whether the user confirmed that. Never a key, and never a path the
 * renderer could not already have typed itself.
 */
export type EngineApiKeyProjection = Readonly<{
  /** Absolute path of the env file, or null for `defaultKeyFile`. */
  keyFile: string | null;
  keyVariable: string;
  /** The only host the key is sent to. */
  host: string;
  /** The user confirmed this file, variable and host in the native dialog. */
  confirmed: boolean;
  /** The file used when `keyFile` is null. */
  defaultKeyFile: string;
  /**
   * What the main process found when it last looked: `usable` (confirmed and the variable has a value),
   * `unusable` (confirmed but the file or variable gives nothing), `unconfirmed`, or `unchecked` (not looked yet).
   */
  state: "unconfirmed" | "unchecked" | "usable" | "unusable";
}>;

/** Defaults a new Claude-engine task starts from. Same rules as the Grok defaults, Claude grammar. */
export type ClaudeEngineSettingsProjection = {
  /** Absent until the main process has looked for the engine. */
  readonly status?: GuildClaudeEngineStatus;
  /** Plan label of the logged-in account, for example "Claude Max". Never an e-mail address. */
  readonly accountLabel?: string;
  /** Version of the installed `claude` binary. */
  readonly version?: string;
  /** Default model id; null follows the adapter's own default. */
  readonly model: string | null;
  /** Default effort (`default`, `low`, `medium`, `high`, `xhigh`, `max`); null follows the adapter. */
  readonly reasoningEffort: string | null;
  readonly permissionMode: GuildClaudePermissionMode;
  readonly availablePermissionModes: typeof GUILD_CLAUDE_PERMISSION_MODES;
};

/** Model and effort one task will use for its next turn, with where the choice comes from. */
export type TaskModelSelectionProjection = {
  readonly modelId: GuildGrokModel | null;
  readonly reasoningEffort: GuildGrokReasoningEffort | null;
  readonly source: GuildModelSelectionSource;
  /** False while a turn runs or the task cannot take a change. */
  readonly canChange: boolean;
};

export type ProfileProjection = {
  readonly nickname: string;
  readonly avatarGrantUrl?: string;
};

export type GeneralSettingsProjection = {
  readonly restoreLastTask: boolean;
  readonly newTaskWorkspaceMode: GuildNewTaskWorkspaceMode;
  readonly taskNotificationsEnabled: boolean;
  /** The Dock icon (PC-SET-002); the main process applies it. */
  readonly dockIcon: GuildDockIcon;
  readonly lastWorkspaceId?: WorkspaceId;
};

export type GrokManagementProgressProjection = {
  readonly action: GuildGrokManagementAction;
  readonly commandLabel: string;
  readonly startedAtIso: string;
  readonly output: string;
};

export type RuntimeIncidentProjection = Readonly<{
  incidentId: string;
  occurredAtIso: string;
  taskId: TaskId;
  taskTitle: string;
  reason: string;
  recovery: "restoring" | "restored" | "failed";
  exitCode?: number | null;
  signal?: string | null;
  hasStderr: boolean;
}>;

export type RuntimeDiagnosticsProjection = Readonly<{
  enabled: true;
  logRelativePath: "diagnostics/runtime.jsonl";
  recentIncidents: readonly RuntimeIncidentProjection[];
}>;

export type DesktopBootstrapProjection = {
  readonly apiVersion: typeof GUILD_API_VERSION;
  readonly appVersion: string;
  readonly runtimeVersion?: string;
  readonly locale: GuildLocale;
  readonly runtimeSettings: RuntimeSettingsProjection;
  readonly generalSettings: GeneralSettingsProjection;
  readonly profile: ProfileProjection;
  readonly sidebarWidth: number;
  readonly browserSyncEnabled: boolean;
  readonly recoveredAfterUncleanShutdown: boolean;
  readonly workspaces: readonly WorkspaceProjection[];
  readonly activeTask?: TaskViewProjection;
  readonly usage: OfficialUsageProjection;
  readonly runtimeDiagnostics?: RuntimeDiagnosticsProjection;
  readonly grokManagementProgress?: GrokManagementProgressProjection;
};

export type ChooseWorkspaceRequest = Readonly<Record<string, never>>;
export const GUILD_PROMPT_ATTACHMENT_LIMIT = 8;
export const GUILD_PROMPT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export type PromptAttachment = Readonly<{
  relativePath: string;
  name: string;
  size: number;
  mimeType?: string;
}>;
export type ChoosePromptFilesRequest = { readonly taskId: TaskId };
export type ChoosePromptFilesResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "selected"; readonly attachments: readonly PromptAttachment[] };
export type CreateTaskRequest = {
  readonly workspaceId: WorkspaceId;
  /** `"worktree"` makes the task work in its own git worktree on its own branch (F3). */
  readonly isolation?: GuildTaskIsolation;
  /** Engine for the new task (PC-ENG-001); absent means `"grok"`. */
  readonly engine?: GuildEngine;
};
/** Changes a task's engine. The main process allows it only while the task has no Run. */
export type SetTaskEngineRequest = { readonly taskId: TaskId; readonly engine: GuildEngine };
export type OpenTaskRequest = { readonly taskId: TaskId; readonly sequence?: number };
export type UpdateWorkspaceRequest = {
  readonly workspaceId: WorkspaceId;
  readonly action: "archive" | "restore" | "delete";
};
export type UpdateTaskRequest =
  | { readonly taskId: TaskId; readonly action: "archive" | "restore" | "delete" | "pin" | "unpin" }
  | { readonly taskId: TaskId; readonly action: "rename"; readonly title: string };
export type SendMessageRequest = {
  readonly taskId: TaskId;
  readonly text: string;
  readonly attachments?: readonly PromptAttachment[];
  readonly mode?: "standard" | "continuous";
};
export type SetContinuousTaskRequest = {
  readonly taskId: TaskId;
  readonly action: "pause" | "resume" | "stop";
};
export type CancelQueuedTurnRequest = { readonly taskId: TaskId; readonly queueId: string };
export type PrioritizeQueuedTurnRequest = CancelQueuedTurnRequest;
export type PreemptQueuedTurnRequest = CancelQueuedTurnRequest;
export type CancelRunRequest = { readonly taskId: TaskId; readonly runId: RunId };
export type {
  ApplyWorktreeRequest,
  DiscardWorktreeRequest,
  OpenWorktreeResourceRequest,
  PreviewWorktreeApplyRequest,
};
export type {
  ConvertQueuedTurnToSteerRequest,
  ExecuteRewindRequest,
  LoadRunFileDiffRequest,
  PreviewRewindRequest,
  SteerMessageRequest,
};
export type DecidePermissionRequest = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly permissionId: string;
  readonly decision: { readonly type: "cancelled" } | {
    readonly type: "selected";
    readonly optionId: string;
  };
};
export type SetDraftRequest = { readonly taskId: TaskId; readonly text: string };
export type AuthorizeSessionReplacementRequest = { readonly taskId: TaskId };
export type RefreshUsageRequest = Readonly<Record<string, never>>;
export type OpenExternalRequest = { readonly url: string };
export type SetLocaleRequest = { readonly locale: GuildLocale };
export type SetRuntimeSettingsRequest = {
  readonly model: GuildGrokModel | null;
  readonly reasoningEffort: GuildGrokReasoningEffort | null;
  readonly permissionMode: GuildGrokPermissionMode;
  readonly startup: GuildGrokStartupSettings;
};
export type SetClaudeSettingsRequest = {
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: GuildClaudePermissionMode;
};
export type SetEngineSettingsRequest = {
  readonly engine: GuildAddonEngine;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string;
};
/** Names the file and variable an engine's API key is read from; any change voids the confirmation. */
export type SetEngineApiKeyRequest = {
  readonly engine: GuildAddonEngine;
  readonly keyFile: string | null;
  readonly keyVariable: string;
};
/** Asks the main process to show the native confirmation that binds the key to the engine's host. */
export type ConfirmEngineApiKeyRequest = {
  readonly engine: GuildAddonEngine;
};
/** Per-workspace privacy preferences (PC-PRIV-001). */
export type WorkspacePrefsProjection = {
  readonly workspaceId: WorkspaceId;
  /** "Don't remind me again in this workspace" for the Online-model reminder. */
  readonly onlineReminderDismissed: boolean;
};
export type GetWorkspacePrefsRequest = { readonly workspaceId: WorkspaceId };
export type SetWorkspacePrefsRequest = {
  readonly workspaceId: WorkspaceId;
  readonly onlineReminderDismissed: boolean;
};
export type SetSidebarWidthRequest = { readonly width: number };
export type ChooseAvatarRequest = Readonly<Record<string, never>>;
export type SaveProfileAvatar =
  | "keep"
  | "reset"
  | { readonly previewToken: string };
export type SaveProfileRequest = {
  readonly nickname: string;
  readonly avatar: SaveProfileAvatar;
};
export type SetGeneralSettingsRequest = {
  readonly restoreLastTask: boolean;
  readonly newTaskWorkspaceMode: GuildNewTaskWorkspaceMode;
  readonly browserSyncEnabled: boolean;
  readonly taskNotificationsEnabled: boolean;
  readonly dockIcon: GuildDockIcon;
};
export type OpenUserDataRequest = Readonly<Record<string, never>>;
export type OpenRuntimeDiagnosticsRequest = Readonly<Record<string, never>>;
export const GUILD_GROK_MANAGEMENT_ACTIONS = Object.freeze([
  "version", "models", "inspect", "doctor", "doctor_fixes", "doctor_fix",
  "disk_usage", "update_check", "update_stable", "update_alpha", "update_version",
  "update_reinstall", "setup_preview", "setup_apply", "login_oauth", "login_device",
  "logout", "plugin_list", "plugin_available", "plugin_details", "plugin_validate",
  "plugin_install", "plugin_uninstall", "plugin_update", "plugin_enable", "plugin_disable",
  "plugin_tag_preview", "plugin_tag", "marketplace_list", "marketplace_add",
  "marketplace_remove", "marketplace_update", "mcp_list", "mcp_doctor", "mcp_add",
  "mcp_remove", "mcp_enable", "mcp_disable", "memory_clear", "sessions_list",
  "sessions_search", "session_delete", "session_export", "session_trace_local",
  "session_trace_upload", "worktree_list", "worktree_show", "worktree_remove",
  "worktree_gc_preview", "worktree_gc", "worktree_detach", "worktree_salvage",
  "worktree_clean_preview", "worktree_clean", "worktree_db_stats", "worktree_db_path",
  "worktree_db_rebuild", "leader_list", "leader_info", "leader_kill", "clone",
] as const);
export type GuildGrokManagementAction = (typeof GUILD_GROK_MANAGEMENT_ACTIONS)[number];
export const GUILD_GROK_MANAGEMENT_PARAMETER_KEYS = Object.freeze({
  version: [], models: [], inspect: [], doctor: [], doctor_fixes: [], doctor_fix: ["id"],
  disk_usage: [], update_check: [], update_stable: [], update_alpha: [], update_version: ["version"],
  update_reinstall: [], setup_preview: [], setup_apply: [], login_oauth: [], login_device: [], logout: [],
  plugin_list: [], plugin_available: [], plugin_details: ["name"], plugin_validate: ["path"],
  plugin_install: ["source"], plugin_uninstall: ["name", "keepData"], plugin_update: ["name"],
  plugin_enable: ["name"], plugin_disable: ["name"], plugin_tag_preview: ["path"],
  plugin_tag: ["path", "push", "force"], marketplace_list: [], marketplace_add: ["source", "force"],
  marketplace_remove: ["source"], marketplace_update: ["name"], mcp_list: [], mcp_doctor: ["name"],
  mcp_add: ["transport", "scope", "name", "endpoint", "env", "headers", "args"],
  mcp_remove: ["name", "scope"], mcp_enable: ["name"], mcp_disable: ["name"], memory_clear: ["scope"],
  sessions_list: ["limit"], sessions_search: ["query", "limit"], session_delete: ["sessionId"],
  session_export: ["sessionId", "output"], session_trace_local: ["sessionId", "output"],
  session_trace_upload: ["sessionId", "output"], worktree_list: ["all", "repo", "type"],
  worktree_show: ["id"], worktree_remove: ["ids", "force"], worktree_gc_preview: ["maxAge"],
  worktree_gc: ["maxAge", "force"], worktree_detach: ["id", "allowCopy"],
  worktree_salvage: ["id", "output"], worktree_clean_preview: ["id"], worktree_clean: ["id"],
  worktree_db_stats: [], worktree_db_path: [], worktree_db_rebuild: [], leader_list: [],
  leader_info: ["pid"], leader_kill: [], clone: ["branch", "cones", "fullHistory", "url", "directory"],
} as const satisfies Readonly<Record<GuildGrokManagementAction, readonly string[]>>);
export type GuildGrokManagementParameter = string | number | boolean | readonly string[];
export type RunGrokManagementRequest = {
  readonly action: GuildGrokManagementAction;
  readonly taskId?: TaskId;
  readonly parameters?: Readonly<Record<string, GuildGrokManagementParameter>>;
  readonly confirmed?: boolean;
};
export type RunGrokManagementResponse = {
  readonly action: GuildGrokManagementAction;
  readonly commandLabel: string;
  readonly completedAtIso: string;
  readonly durationMs: number;
  readonly output: string;
  readonly status: "completed" | "failed";
};
export type LoadEarlierTimelineRequest = { readonly taskId: TaskId };
export type LoadSlashCommandsRequest = { readonly taskId: TaskId };
export type ForkTaskRequest = {
  readonly taskId: TaskId;
  readonly throughSequence?: number;
};
export type ExportTaskRequest = {
  readonly taskId: TaskId;
  readonly format: "markdown" | "json";
};
export type ExportTaskResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "saved" };
export type SearchConversationsRequest = { readonly query: string };
export type SearchConversationsResponse = {
  readonly results: readonly ConversationSearchResult[];
};
export type OpenTaskResourceRequest =
  | { readonly taskId: TaskId; readonly action: "terminal" | "folder" }
  | { readonly taskId: TaskId; readonly action: "file"; readonly path: string };
export type SetSessionConfigOptionRequest = {
  readonly taskId: TaskId;
  readonly configId: string;
  readonly value: string | boolean;
};
/** Per-task model and reasoning effort; null for both clears the override (follow the global default). */
export type SetTaskRuntimeSettingsRequest = {
  readonly taskId: TaskId;
  readonly model: GuildGrokModel | null;
  readonly reasoningEffort: GuildGrokReasoningEffort | null;
  readonly contextWindow?: number | null;
};
export const GUILD_MODEL_SWITCH_REFUSAL_REASONS = Object.freeze([
  /** The runtime refused the switch because the model needs a different agent type (-32602). */
  "incompatible_agent",
  /** The runtime does not offer that model or effort in this session. */
  "unsupported_value",
  /** The runtime could not be reached or refused for another reason. */
  "unavailable",
] as const);
export type GuildModelSwitchRefusalReason = (typeof GUILD_MODEL_SWITCH_REFUSAL_REASONS)[number];
export type SetTaskRuntimeSettingsResponse =
  /** The runtime confirmed the new selection for the task's live session. */
  | { readonly status: "applied"; readonly task: TaskViewProjection }
  /** Saved for the task; there is no live session yet, so it applies when the session opens. */
  | { readonly status: "saved"; readonly task: TaskViewProjection }
  /** The runtime refused; the previous selection is kept. */
  | {
      readonly status: "refused";
      readonly reason: GuildModelSwitchRefusalReason;
      readonly task: TaskViewProjection;
    };
export type ChooseAvatarResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "rejected"; readonly reason: GuildAvatarRejectionReason }
  | {
      readonly status: "selected";
      readonly previewToken: string;
      readonly grantUrl: string;
    };

export type SendMessageResponse =
  | { readonly status: "started"; readonly runId: RunId }
  | { readonly status: "queued"; readonly queueId: string };
export type EmptyDesktopResponse = Readonly<Record<string, never>>;
export type BackupUserDataResponse =
  | { readonly status: "cancelled" }
  | { readonly status: "saved"; readonly path: string };

export type DesktopRequestByChannel = {
  readonly [DESKTOP_IPC_CHANNELS.bootstrap]: Readonly<Record<string, never>>;
  readonly [DESKTOP_IPC_CHANNELS.chooseWorkspace]: ChooseWorkspaceRequest;
  readonly [DESKTOP_IPC_CHANNELS.choosePromptFiles]: ChoosePromptFilesRequest;
  readonly [DESKTOP_IPC_CHANNELS.createTask]: CreateTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.openTask]: OpenTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.loadEarlierTimeline]: LoadEarlierTimelineRequest;
  readonly [DESKTOP_IPC_CHANNELS.loadSlashCommands]: LoadSlashCommandsRequest;
  readonly [DESKTOP_IPC_CHANNELS.forkTask]: ForkTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.exportTask]: ExportTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.searchConversations]: SearchConversationsRequest;
  readonly [DESKTOP_IPC_CHANNELS.openTaskResource]: OpenTaskResourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.setSessionConfigOption]: SetSessionConfigOptionRequest;
  readonly [DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings]: SetTaskRuntimeSettingsRequest;
  readonly [DESKTOP_IPC_CHANNELS.updateWorkspace]: UpdateWorkspaceRequest;
  readonly [DESKTOP_IPC_CHANNELS.updateTask]: UpdateTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.sendMessage]: SendMessageRequest;
  readonly [DESKTOP_IPC_CHANNELS.setContinuousTask]: SetContinuousTaskRequest;
  readonly [DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn]: PrioritizeQueuedTurnRequest;
  readonly [DESKTOP_IPC_CHANNELS.preemptQueuedTurn]: PreemptQueuedTurnRequest;
  readonly [DESKTOP_IPC_CHANNELS.cancelQueuedTurn]: CancelQueuedTurnRequest;
  readonly [DESKTOP_IPC_CHANNELS.cancelRun]: CancelRunRequest;
  readonly [DESKTOP_IPC_CHANNELS.steerMessage]: SteerMessageRequest;
  readonly [DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer]: ConvertQueuedTurnToSteerRequest;
  readonly [DESKTOP_IPC_CHANNELS.previewRewind]: PreviewRewindRequest;
  readonly [DESKTOP_IPC_CHANNELS.executeRewind]: ExecuteRewindRequest;
  readonly [DESKTOP_IPC_CHANNELS.loadRunFileDiff]: LoadRunFileDiffRequest;
  readonly [DESKTOP_IPC_CHANNELS.previewWorktreeApply]: PreviewWorktreeApplyRequest;
  readonly [DESKTOP_IPC_CHANNELS.applyWorktree]: ApplyWorktreeRequest;
  readonly [DESKTOP_IPC_CHANNELS.discardWorktree]: DiscardWorktreeRequest;
  readonly [DESKTOP_IPC_CHANNELS.openWorktreeResource]: OpenWorktreeResourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.decidePermission]: DecidePermissionRequest;
  readonly [DESKTOP_IPC_CHANNELS.setDraft]: SetDraftRequest;
  readonly [DESKTOP_IPC_CHANNELS.authorizeSessionReplacement]: AuthorizeSessionReplacementRequest;
  readonly [DESKTOP_IPC_CHANNELS.refreshUsage]: RefreshUsageRequest;
  readonly [DESKTOP_IPC_CHANNELS.openExternal]: OpenExternalRequest;
  readonly [DESKTOP_IPC_CHANNELS.setLocale]: SetLocaleRequest;
  readonly [DESKTOP_IPC_CHANNELS.setRuntimeSettings]: SetRuntimeSettingsRequest;
  readonly [DESKTOP_IPC_CHANNELS.setSidebarWidth]: SetSidebarWidthRequest;
  readonly [DESKTOP_IPC_CHANNELS.chooseAvatar]: ChooseAvatarRequest;
  readonly [DESKTOP_IPC_CHANNELS.saveProfile]: SaveProfileRequest;
  readonly [DESKTOP_IPC_CHANNELS.setGeneralSettings]: SetGeneralSettingsRequest;
  readonly [DESKTOP_IPC_CHANNELS.openUserData]: OpenUserDataRequest;
  readonly [DESKTOP_IPC_CHANNELS.backupUserData]: Readonly<Record<string, never>>;
  readonly [DESKTOP_IPC_CHANNELS.restoreUserData]: Readonly<Record<string, never>>;
  readonly [DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics]: OpenRuntimeDiagnosticsRequest;
  readonly [DESKTOP_IPC_CHANNELS.runGrokManagement]: RunGrokManagementRequest;
  readonly [DESKTOP_IPC_CHANNELS.setTaskEngine]: SetTaskEngineRequest;
  readonly [DESKTOP_IPC_CHANNELS.setClaudeSettings]: SetClaudeSettingsRequest;
  readonly [DESKTOP_IPC_CHANNELS.setEngineSettings]: SetEngineSettingsRequest;
  readonly [DESKTOP_IPC_CHANNELS.setEngineApiKey]: SetEngineApiKeyRequest;
  readonly [DESKTOP_IPC_CHANNELS.confirmEngineApiKey]: ConfirmEngineApiKeyRequest;
  readonly [DESKTOP_IPC_CHANNELS.listModelSources]: ListModelSourcesRequest;
  readonly [DESKTOP_IPC_CHANNELS.upsertModelSource]: UpsertModelSourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.deleteModelSource]: DeleteModelSourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.confirmModelSource]: ConfirmModelSourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.testModelSource]: TestModelSourceRequest;
  readonly [DESKTOP_IPC_CHANNELS.getWorkspacePrefs]: GetWorkspacePrefsRequest;
  readonly [DESKTOP_IPC_CHANNELS.setWorkspacePrefs]: SetWorkspacePrefsRequest;
  readonly [DESKTOP_IPC_CHANNELS.browserCommand]: BrowserCommand;
};

export type DesktopResponseByChannel = {
  readonly [DESKTOP_IPC_CHANNELS.bootstrap]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.chooseWorkspace]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.choosePromptFiles]: ChoosePromptFilesResponse;
  readonly [DESKTOP_IPC_CHANNELS.createTask]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.openTask]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.loadEarlierTimeline]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.loadSlashCommands]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.forkTask]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.exportTask]: ExportTaskResponse;
  readonly [DESKTOP_IPC_CHANNELS.searchConversations]: SearchConversationsResponse;
  readonly [DESKTOP_IPC_CHANNELS.openTaskResource]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.setSessionConfigOption]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings]: SetTaskRuntimeSettingsResponse;
  readonly [DESKTOP_IPC_CHANNELS.updateWorkspace]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.updateTask]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.sendMessage]: SendMessageResponse;
  readonly [DESKTOP_IPC_CHANNELS.setContinuousTask]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.preemptQueuedTurn]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.cancelQueuedTurn]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.cancelRun]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.steerMessage]: SteerMessageResponse;
  readonly [DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer]: ConvertQueuedTurnToSteerResponse;
  readonly [DESKTOP_IPC_CHANNELS.previewRewind]: PreviewRewindResponse;
  readonly [DESKTOP_IPC_CHANNELS.executeRewind]: ExecuteRewindResponse;
  readonly [DESKTOP_IPC_CHANNELS.loadRunFileDiff]: LoadRunFileDiffResponse;
  readonly [DESKTOP_IPC_CHANNELS.previewWorktreeApply]: PreviewWorktreeApplyResponse;
  readonly [DESKTOP_IPC_CHANNELS.applyWorktree]: ApplyWorktreeResponse;
  readonly [DESKTOP_IPC_CHANNELS.discardWorktree]: DiscardWorktreeResponse;
  readonly [DESKTOP_IPC_CHANNELS.openWorktreeResource]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.decidePermission]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.setDraft]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.authorizeSessionReplacement]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.refreshUsage]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.openExternal]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.setLocale]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.setRuntimeSettings]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.setSidebarWidth]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.chooseAvatar]: ChooseAvatarResponse;
  readonly [DESKTOP_IPC_CHANNELS.saveProfile]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.setGeneralSettings]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.openUserData]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.backupUserData]: BackupUserDataResponse;
  readonly [DESKTOP_IPC_CHANNELS.restoreUserData]: { readonly status: "cancelled" | "restarting" };
  readonly [DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.runGrokManagement]: RunGrokManagementResponse;
  readonly [DESKTOP_IPC_CHANNELS.setTaskEngine]: TaskViewProjection;
  readonly [DESKTOP_IPC_CHANNELS.setClaudeSettings]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.setEngineSettings]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.setEngineApiKey]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.confirmEngineApiKey]: DesktopBootstrapProjection;
  readonly [DESKTOP_IPC_CHANNELS.listModelSources]: ListModelSourcesResponse;
  readonly [DESKTOP_IPC_CHANNELS.upsertModelSource]: UpsertModelSourceResponse;
  readonly [DESKTOP_IPC_CHANNELS.deleteModelSource]: EmptyDesktopResponse;
  readonly [DESKTOP_IPC_CHANNELS.confirmModelSource]: ConfirmModelSourceResponse;
  readonly [DESKTOP_IPC_CHANNELS.testModelSource]: TestModelSourceResponse;
  readonly [DESKTOP_IPC_CHANNELS.getWorkspacePrefs]: WorkspacePrefsProjection;
  readonly [DESKTOP_IPC_CHANNELS.setWorkspacePrefs]: WorkspacePrefsProjection;
  readonly [DESKTOP_IPC_CHANNELS.browserCommand]: BrowserPaneProjection;
};

export type DesktopInvokeChannel = keyof DesktopRequestByChannel;

export type GuildRendererApi = Readonly<{
  readonly apiVersion: typeof GUILD_API_VERSION;
  readonly bootstrap: () => Promise<DesktopBootstrapProjection>;
  readonly chooseWorkspace: () => Promise<DesktopBootstrapProjection>;
  readonly choosePromptFiles: (
    request: ChoosePromptFilesRequest,
  ) => Promise<ChoosePromptFilesResponse>;
  readonly createTask: (request: CreateTaskRequest) => Promise<TaskViewProjection>;
  readonly openTask: (request: OpenTaskRequest) => Promise<TaskViewProjection>;
  readonly loadEarlierTimeline: (
    request: LoadEarlierTimelineRequest,
  ) => Promise<TaskViewProjection>;
  readonly loadSlashCommands: (
    request: LoadSlashCommandsRequest,
  ) => Promise<TaskViewProjection>;
  readonly forkTask: (request: ForkTaskRequest) => Promise<TaskViewProjection>;
  readonly exportTask: (request: ExportTaskRequest) => Promise<ExportTaskResponse>;
  readonly searchConversations: (
    request: SearchConversationsRequest,
  ) => Promise<SearchConversationsResponse>;
  readonly openTaskResource: (
    request: OpenTaskResourceRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly setSessionConfigOption: (
    request: SetSessionConfigOptionRequest,
  ) => Promise<TaskViewProjection>;
  readonly setTaskRuntimeSettings: (
    request: SetTaskRuntimeSettingsRequest,
  ) => Promise<SetTaskRuntimeSettingsResponse>;
  readonly updateWorkspace: (
    request: UpdateWorkspaceRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly updateTask: (request: UpdateTaskRequest) => Promise<DesktopBootstrapProjection>;
  readonly sendMessage: (request: SendMessageRequest) => Promise<SendMessageResponse>;
  readonly setContinuousTask: (
    request: SetContinuousTaskRequest,
  ) => Promise<TaskViewProjection>;
  readonly prioritizeQueuedTurn: (
    request: PrioritizeQueuedTurnRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly preemptQueuedTurn: (
    request: PreemptQueuedTurnRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly cancelQueuedTurn: (
    request: CancelQueuedTurnRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly cancelRun: (request: CancelRunRequest) => Promise<EmptyDesktopResponse>;
  readonly steerMessage: (request: SteerMessageRequest) => Promise<SteerMessageResponse>;
  readonly convertQueuedTurnToSteer: (
    request: ConvertQueuedTurnToSteerRequest,
  ) => Promise<ConvertQueuedTurnToSteerResponse>;
  readonly previewRewind: (request: PreviewRewindRequest) => Promise<PreviewRewindResponse>;
  readonly executeRewind: (request: ExecuteRewindRequest) => Promise<ExecuteRewindResponse>;
  readonly loadRunFileDiff: (
    request: LoadRunFileDiffRequest,
  ) => Promise<LoadRunFileDiffResponse>;
  readonly previewWorktreeApply: (
    request: PreviewWorktreeApplyRequest,
  ) => Promise<PreviewWorktreeApplyResponse>;
  readonly applyWorktree: (request: ApplyWorktreeRequest) => Promise<ApplyWorktreeResponse>;
  readonly discardWorktree: (request: DiscardWorktreeRequest) => Promise<DiscardWorktreeResponse>;
  readonly openWorktreeResource: (
    request: OpenWorktreeResourceRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly decidePermission: (
    request: DecidePermissionRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly setDraft: (request: SetDraftRequest) => Promise<EmptyDesktopResponse>;
  readonly authorizeSessionReplacement: (
    request: AuthorizeSessionReplacementRequest,
  ) => Promise<TaskViewProjection>;
  readonly refreshUsage: (
    request: RefreshUsageRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly openExternal: (
    request: OpenExternalRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly setLocale: (request: SetLocaleRequest) => Promise<DesktopBootstrapProjection>;
  readonly setRuntimeSettings: (
    request: SetRuntimeSettingsRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly setSidebarWidth: (
    request: SetSidebarWidthRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly chooseAvatar: (
    request: ChooseAvatarRequest,
  ) => Promise<ChooseAvatarResponse>;
  readonly saveProfile: (
    request: SaveProfileRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly setGeneralSettings: (
    request: SetGeneralSettingsRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly openUserData: (
    request: OpenUserDataRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly restoreUserData: (request: Readonly<Record<string, never>>) => Promise<{ readonly status: "cancelled" | "restarting" }>;
  readonly backupUserData: (
    request: Readonly<Record<string, never>>,
  ) => Promise<BackupUserDataResponse>;
  readonly openRuntimeDiagnostics: (
    request: OpenRuntimeDiagnosticsRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly runGrokManagement: (
    request: RunGrokManagementRequest,
  ) => Promise<RunGrokManagementResponse>;
  readonly setTaskEngine: (request: SetTaskEngineRequest) => Promise<TaskViewProjection>;
  readonly setClaudeSettings: (
    request: SetClaudeSettingsRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly setEngineSettings: (
    request: SetEngineSettingsRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly setEngineApiKey: (
    request: SetEngineApiKeyRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly confirmEngineApiKey: (
    request: ConfirmEngineApiKeyRequest,
  ) => Promise<DesktopBootstrapProjection>;
  readonly listModelSources: () => Promise<ListModelSourcesResponse>;
  readonly upsertModelSource: (
    request: UpsertModelSourceRequest,
  ) => Promise<UpsertModelSourceResponse>;
  readonly deleteModelSource: (
    request: DeleteModelSourceRequest,
  ) => Promise<EmptyDesktopResponse>;
  readonly confirmModelSource: (
    request: ConfirmModelSourceRequest,
  ) => Promise<ConfirmModelSourceResponse>;
  readonly testModelSource: (
    request: TestModelSourceRequest,
  ) => Promise<TestModelSourceResponse>;
  readonly getWorkspacePrefs: (
    request: GetWorkspacePrefsRequest,
  ) => Promise<WorkspacePrefsProjection>;
  readonly setWorkspacePrefs: (
    request: SetWorkspacePrefsRequest,
  ) => Promise<WorkspacePrefsProjection>;
  readonly browserCommand: (request: BrowserCommand) => Promise<BrowserPaneProjection>;
  readonly onProjectionChanged: (
    listener: (projection: DesktopBootstrapProjection) => void,
  ) => () => void;
  readonly onStreamDelta: (
    listener: (event: StreamDeltaEvent) => void,
  ) => () => void;
  readonly onBrowserPaneChanged: (
    listener: (projection: BrowserPaneProjection) => void,
  ) => () => void;
}>;

export const GUILD_MAX_MESSAGE_LENGTH = 200_000;
const MAX_MESSAGE_LENGTH = GUILD_MAX_MESSAGE_LENGTH;
const MAX_ID_LENGTH = 512;

export function parseGuildLocale(value: unknown): GuildLocale {
  if (typeof value !== "string" || !(GUILD_LOCALES as readonly string[]).includes(value)) {
    throw new TypeError("invalid_locale");
  }
  return value as GuildLocale;
}

export function parseGuildGrokPermissionMode(
  value: unknown,
): GuildGrokPermissionMode {
  if (
    typeof value !== "string" ||
    !(GUILD_GROK_PERMISSION_MODES as readonly string[]).includes(value)
  ) {
    throw new TypeError("invalid_grok_permission_mode");
  }
  return value as GuildGrokPermissionMode;
}

export function parseGuildGrokStartupSettings(value: unknown): GuildGrokStartupSettings {
  const record = exactRecord(value, [
    "webSearchEnabled",
    "planEnabled",
    "subagentsEnabled",
    "maxTurns",
  ]);
  for (const key of ["webSearchEnabled", "planEnabled", "subagentsEnabled"] as const) {
    if (typeof record[key] !== "boolean") throw new TypeError("invalid_grok_startup_settings");
  }
  const maxTurns = record["maxTurns"];
  if (
    maxTurns !== null &&
    (typeof maxTurns !== "number" || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 10_000)
  ) {
    throw new TypeError("invalid_grok_startup_settings");
  }
  return Object.freeze({
    webSearchEnabled: record["webSearchEnabled"] as boolean,
    planEnabled: record["planEnabled"] as boolean,
    subagentsEnabled: record["subagentsEnabled"] as boolean,
    maxTurns: maxTurns as number | null,
  });
}

export function parseGuildDockIcon(value: unknown): GuildDockIcon {
  if (typeof value !== "string" || !(GUILD_DOCK_ICONS as readonly string[]).includes(value)) {
    throw new TypeError("invalid_dock_icon");
  }
  return value as GuildDockIcon;
}

export function parseGuildNewTaskWorkspaceMode(
  value: unknown,
): GuildNewTaskWorkspaceMode {
  if (
    typeof value !== "string" ||
    !(GUILD_NEW_TASK_WORKSPACE_MODES as readonly string[]).includes(value)
  ) {
    throw new TypeError("invalid_new_task_workspace_mode");
  }
  return value as GuildNewTaskWorkspaceMode;
}

export function parseGuildNickname(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("invalid_nickname");
  if (
    value.includes("\0") ||
    /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)
  ) {
    throw new TypeError("invalid_nickname");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new TypeError("invalid_nickname");
  const graphemes = nicknameGraphemes(trimmed);
  if (graphemes.length < 1 || graphemes.length > GUILD_NICKNAME_MAX_LENGTH) {
    throw new TypeError("invalid_nickname");
  }
  return trimmed;
}

export function nicknameInitial(nickname: string): string {
  return nicknameGraphemes(nickname)[0] ?? "?";
}

function nicknameGraphemes(value: string): string[] {
  try {
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value)]
      .map((part) => part.segment);
  } catch {
    return [...value];
  }
}

export function parseAvatarPreviewToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      value,
    )
  ) {
    throw new TypeError("invalid_avatar_preview_token");
  }
  return value;
}

/** Validates a main-to-renderer stream delta before it is sent and before it is applied. */
export function parseStreamDeltaEvent(input: unknown): StreamDeltaEvent {
  const record = exactRecord(
    input,
    ["taskId", "entryId", "kind", "offset", "appendText", "revision", "updatedAtMs"],
    ["runId"],
  );
  const task = parseTaskId(record["taskId"]);
  if (!task.ok) throw new TypeError("invalid_stream_delta_task");
  const kind = record["kind"];
  if (kind !== "assistant" && kind !== "thought") {
    throw new TypeError("invalid_stream_delta_kind");
  }
  const offset = record["offset"];
  const revision = record["revision"];
  const updatedAtMs = record["updatedAtMs"];
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > GUILD_STREAM_DELTA_LIMITS.maxOffset ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > GUILD_STREAM_DELTA_LIMITS.maxRevision ||
    typeof updatedAtMs !== "number" ||
    !Number.isSafeInteger(updatedAtMs) ||
    updatedAtMs < 0
  ) {
    throw new TypeError("invalid_stream_delta_position");
  }
  let runId: RunId | undefined;
  if (Object.hasOwn(record, "runId")) {
    const run = parseRunId(record["runId"]);
    if (!run.ok) throw new TypeError("invalid_stream_delta_run");
    runId = boundedId(run.value);
  }
  return Object.freeze({
    taskId: boundedId(task.value),
    ...(runId === undefined ? {} : { runId }),
    entryId: boundedText(record["entryId"], MAX_ID_LENGTH),
    kind,
    offset,
    appendText: boundedText(record["appendText"], GUILD_STREAM_DELTA_LIMITS.maxAppendTextLength),
    revision,
    updatedAtMs,
  });
}

export function parseDesktopRequest<Channel extends DesktopInvokeChannel>(
  channel: Channel,
  input: unknown,
): DesktopRequestByChannel[Channel] {
  switch (channel) {
    case DESKTOP_IPC_CHANNELS.bootstrap:
    case DESKTOP_IPC_CHANNELS.chooseWorkspace:
    case DESKTOP_IPC_CHANNELS.refreshUsage:
    case DESKTOP_IPC_CHANNELS.chooseAvatar:
    case DESKTOP_IPC_CHANNELS.openUserData:
    case DESKTOP_IPC_CHANNELS.restoreUserData:
    case DESKTOP_IPC_CHANNELS.backupUserData:
    case DESKTOP_IPC_CHANNELS.openRuntimeDiagnostics:
    case DESKTOP_IPC_CHANNELS.listModelSources:
      return exactRecord(input, []) as DesktopRequestByChannel[Channel];
    case DESKTOP_IPC_CHANNELS.createTask: {
      const record = exactRecord(input, ["workspaceId"], ["isolation", "engine"]);
      const parsed = parseWorkspaceId(record["workspaceId"]);
      const isolation = record["isolation"];
      if (!parsed.ok) throw new TypeError("invalid_workspace_id");
      if (isolation !== undefined && !(GUILD_TASK_ISOLATIONS as readonly unknown[]).includes(isolation)) {
        throw new TypeError("invalid_task_isolation");
      }
      const engine = record["engine"] === undefined ? undefined : parseGuildEngine(record["engine"]);
      return Object.freeze({
        workspaceId: boundedId(parsed.value),
        ...(isolation === undefined ? {} : { isolation: isolation as GuildTaskIsolation }),
        ...(engine === undefined ? {} : { engine }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setTaskEngine: {
      const record = exactRecord(input, ["taskId", "engine"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok) throw new TypeError("invalid_task_id");
      return Object.freeze({
        taskId: boundedId(parsed.value),
        engine: parseGuildEngine(record["engine"]),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.upsertModelSource:
      return parseModelSourceDraft(input) as DesktopRequestByChannel[Channel];
    case DESKTOP_IPC_CHANNELS.deleteModelSource:
    case DESKTOP_IPC_CHANNELS.confirmModelSource:
    case DESKTOP_IPC_CHANNELS.testModelSource:
      return parseModelSourceIdRequest(input) as DesktopRequestByChannel[Channel];
    case DESKTOP_IPC_CHANNELS.getWorkspacePrefs: {
      const record = exactRecord(input, ["workspaceId"]);
      const parsed = parseWorkspaceId(record["workspaceId"]);
      if (!parsed.ok) throw new TypeError("invalid_workspace_id");
      return Object.freeze({ workspaceId: boundedId(parsed.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setWorkspacePrefs: {
      const record = exactRecord(input, ["workspaceId", "onlineReminderDismissed"]);
      const parsed = parseWorkspaceId(record["workspaceId"]);
      if (!parsed.ok || typeof record["onlineReminderDismissed"] !== "boolean") {
        throw new TypeError("invalid_workspace_prefs");
      }
      return Object.freeze({
        workspaceId: boundedId(parsed.value),
        onlineReminderDismissed: record["onlineReminderDismissed"],
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.browserCommand:
      return parseBrowserCommand(input) as DesktopRequestByChannel[Channel];
    case DESKTOP_IPC_CHANNELS.choosePromptFiles: {
      const record = exactRecord(input, ["taskId"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok) throw new TypeError("invalid_task_id");
      return Object.freeze({ taskId: boundedId(parsed.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.openTask: {
      const record = exactRecord(input, ["taskId"], ["sequence"]);
      const parsed = parseTaskId(record["taskId"]);
      const sequence = record["sequence"];
      if (!parsed.ok || (sequence !== undefined && (!Number.isSafeInteger(sequence) || (sequence as number) < 1))) {
        throw new TypeError("invalid_task_open");
      }
      return Object.freeze({ taskId: boundedId(parsed.value),
        ...(sequence === undefined ? {} : { sequence }) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.loadEarlierTimeline:
    case DESKTOP_IPC_CHANNELS.loadSlashCommands:
    case DESKTOP_IPC_CHANNELS.authorizeSessionReplacement: {
      const record = exactRecord(input, ["taskId"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok) throw new TypeError("invalid_task_id");
      return Object.freeze({ taskId: boundedId(parsed.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.forkTask: {
      const record = exactRecord(input, ["taskId"], ["throughSequence"]);
      const parsed = parseTaskId(record["taskId"]);
      const throughSequence = record["throughSequence"];
      if (
        !parsed.ok ||
        (throughSequence !== undefined &&
          (!Number.isSafeInteger(throughSequence) || (throughSequence as number) < 1))
      ) throw new TypeError("invalid_task_fork");
      return Object.freeze({
        taskId: boundedId(parsed.value),
        ...(throughSequence === undefined ? {} : { throughSequence: throughSequence as number }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.exportTask: {
      const record = exactRecord(input, ["taskId", "format"]);
      const parsed = parseTaskId(record["taskId"]);
      const format = record["format"];
      if (!parsed.ok || (format !== "markdown" && format !== "json")) {
        throw new TypeError("invalid_task_export");
      }
      return Object.freeze({ taskId: boundedId(parsed.value), format }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.searchConversations: {
      const record = exactRecord(input, ["query"]);
      const query = boundedText(record["query"], 256).trim();
      if (query.length === 0 || /[\u0000-\u001F\u007F-\u009F]/u.test(query)) {
        throw new TypeError("invalid_conversation_search");
      }
      return Object.freeze({ query }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.openTaskResource: {
      const inputRecord = exactRecord(input, [], ["taskId", "action", "path"]);
      const action = inputRecord["action"];
      const record = action === "file"
        ? exactRecord(input, ["taskId", "action", "path"])
        : exactRecord(input, ["taskId", "action"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok || (action !== "file" && action !== "terminal" && action !== "folder")) {
        throw new TypeError("invalid_task_resource");
      }
      if (action === "file") {
        const path = boundedText(record["path"], 4_096);
        if (path.includes("\0")) throw new TypeError("invalid_task_resource");
        return Object.freeze({ taskId: boundedId(parsed.value), action, path }) as DesktopRequestByChannel[Channel];
      }
      return Object.freeze({ taskId: boundedId(parsed.value), action }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setSessionConfigOption: {
      const record = exactRecord(input, ["taskId", "configId", "value"]);
      const parsed = parseTaskId(record["taskId"]);
      const configId = boundedText(record["configId"], 256);
      const value = record["value"];
      if (!parsed.ok || (typeof value !== "string" && typeof value !== "boolean")) {
        throw new TypeError("invalid_session_config_option");
      }
      const boundedValue = typeof value === "string" ? boundedText(value, 512) : value;
      return Object.freeze({ taskId: boundedId(parsed.value), configId, value: boundedValue }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setTaskRuntimeSettings: {
      const record = exactRecord(input, ["taskId", "model", "reasoningEffort"], ["contextWindow"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok) throw new TypeError("invalid_task_runtime_settings");
      // The request names a task, not its engine: the wider grammar applies here, the task's own
      // engine rule (Grok: official grok-* only) is enforced by main and the store.
      const model = record["model"] === null ? null : parseGuildModelIdOfAnyEngine(record["model"]);
      const reasoningEffort = record["reasoningEffort"] === null
        ? null
        : parseGuildGrokReasoningEffort(record["reasoningEffort"]);
      const contextWindow = record["contextWindow"] === undefined || record["contextWindow"] === null
        ? record["contextWindow"] as null | undefined
        : parseGuildGrokContextWindow(record["contextWindow"]);
      if (model === null && (reasoningEffort !== null || (contextWindow !== null && contextWindow !== undefined))) {
        // An override always names its model; only a full clear leaves it out.
        throw new TypeError("invalid_task_runtime_settings");
      }
      return Object.freeze({
        taskId: boundedId(parsed.value),
        model,
        reasoningEffort,
        ...(contextWindow === undefined ? {} : { contextWindow }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.updateWorkspace: {
      const record = exactRecord(input, ["workspaceId", "action"]);
      const parsed = parseWorkspaceId(record["workspaceId"]);
      if (!parsed.ok || !isDisposition(record["action"])) {
        throw new TypeError("invalid_workspace_update");
      }
      return Object.freeze({ workspaceId: boundedId(parsed.value), action: record["action"] }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.updateTask: {
      const inputRecord = exactRecord(input, [], ["taskId", "action", "title"]);
      const action = inputRecord["action"];
      const record = action === "rename"
        ? exactRecord(input, ["taskId", "action", "title"])
        : exactRecord(input, ["taskId", "action"]);
      const parsed = parseTaskId(record["taskId"]);
      if (!parsed.ok || !isTaskUpdateAction(action)) {
        throw new TypeError("invalid_task_update");
      }
      if (action === "rename") {
        const title = boundedText(record["title"], 512).trim();
        if (title.length === 0 || /[\r\n]/u.test(title)) throw new TypeError("invalid_task_title");
        return Object.freeze({ taskId: boundedId(parsed.value), action, title }) as DesktopRequestByChannel[Channel];
      }
      return Object.freeze({ taskId: boundedId(parsed.value), action }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.sendMessage: {
      const record = exactRecord(input, ["taskId", "text"], ["attachments", "mode"]);
      const parsed = parseTaskId(record["taskId"]);
      const text = record["text"];
      const mode = record["mode"] ?? "standard";
      if (
        !parsed.ok ||
        typeof text !== "string" ||
        text.trim().length === 0 ||
        text.length > MAX_MESSAGE_LENGTH ||
        (mode !== "standard" && mode !== "continuous")
      ) {
        throw new TypeError("invalid_message");
      }
      const attachments = Object.hasOwn(record, "attachments")
        ? parsePromptAttachments(record["attachments"])
        : undefined;
      return Object.freeze({
        taskId: boundedId(parsed.value),
        text,
        ...(attachments === undefined ? {} : { attachments }),
        ...(mode === "standard" ? {} : { mode }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setContinuousTask: {
      const record = exactRecord(input, ["taskId", "action"]);
      const taskId = parseTaskId(record["taskId"]);
      const action = record["action"];
      if (
        !taskId.ok ||
        (action !== "pause" && action !== "resume" && action !== "stop")
      ) {
        throw new TypeError("invalid_continuous_task_action");
      }
      return Object.freeze({
        taskId: boundedId(taskId.value),
        action,
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.prioritizeQueuedTurn:
    case DESKTOP_IPC_CHANNELS.preemptQueuedTurn:
    case DESKTOP_IPC_CHANNELS.cancelQueuedTurn: {
      const record = exactRecord(input, ["taskId", "queueId"]);
      const taskId = parseTaskId(record["taskId"]);
      const queueId = boundedText(record["queueId"], MAX_ID_LENGTH);
      if (!taskId.ok) throw new TypeError("invalid_queue_action");
      return Object.freeze({ taskId: boundedId(taskId.value), queueId }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.cancelRun: {
      const record = exactRecord(input, ["taskId", "runId"]);
      const taskId = parseTaskId(record["taskId"]);
      const runId = parseRunId(record["runId"]);
      if (!taskId.ok || !runId.ok) throw new TypeError("invalid_cancel");
      return Object.freeze({ taskId: boundedId(taskId.value), runId: boundedId(runId.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.steerMessage: {
      const record = exactRecord(input, ["taskId", "text"]);
      const parsed = parseTaskId(record["taskId"]);
      const text = record["text"];
      if (
        !parsed.ok ||
        typeof text !== "string" ||
        text.trim().length === 0 ||
        text.length > GUILD_STEER_MAX_LENGTH ||
        text.includes("\0")
      ) {
        throw new TypeError("invalid_steer_message");
      }
      return Object.freeze({ taskId: boundedId(parsed.value), text }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.convertQueuedTurnToSteer: {
      const record = exactRecord(input, ["taskId", "queueId"]);
      const taskId = parseTaskId(record["taskId"]);
      const queueId = boundedText(record["queueId"], MAX_ID_LENGTH);
      if (!taskId.ok) throw new TypeError("invalid_queue_action");
      return Object.freeze({ taskId: boundedId(taskId.value), queueId }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.previewRewind: {
      const record = exactRecord(input, ["taskId", "runId"]);
      const taskId = parseTaskId(record["taskId"]);
      const runId = parseRunId(record["runId"]);
      if (!taskId.ok || !runId.ok) throw new TypeError("invalid_rewind");
      return Object.freeze({ taskId: boundedId(taskId.value), runId: boundedId(runId.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.executeRewind: {
      const record = exactRecord(input, ["taskId", "runId"], ["scope", "overwriteConflicts"]);
      const taskId = parseTaskId(record["taskId"]);
      const runId = parseRunId(record["runId"]);
      const scope = record["scope"];
      const overwrite = record["overwriteConflicts"];
      if (
        !taskId.ok ||
        !runId.ok ||
        (scope !== undefined && (typeof scope !== "string" || !(GUILD_REWIND_SCOPES as readonly string[]).includes(scope))) ||
        (overwrite !== undefined && typeof overwrite !== "boolean")
      ) {
        throw new TypeError("invalid_rewind");
      }
      return Object.freeze({
        taskId: boundedId(taskId.value),
        runId: boundedId(runId.value),
        ...(scope === undefined ? {} : { scope: scope as ExecuteRewindRequest["scope"] }),
        ...(overwrite === undefined ? {} : { overwriteConflicts: overwrite }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.loadRunFileDiff: {
      const record = exactRecord(input, ["taskId", "runId", "path"]);
      const taskId = parseTaskId(record["taskId"]);
      const runId = parseRunId(record["runId"]);
      const path = boundedText(record["path"], 4_096);
      if (!taskId.ok || !runId.ok || path.startsWith("/") || path.startsWith("\\") || /(^|[\\/])\.\.([\\/]|$)/u.test(path)) {
        throw new TypeError("invalid_run_file_diff");
      }
      return Object.freeze({ taskId: boundedId(taskId.value), runId: boundedId(runId.value), path }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.previewWorktreeApply:
    case DESKTOP_IPC_CHANNELS.applyWorktree:
    case DESKTOP_IPC_CHANNELS.discardWorktree: {
      const record = exactRecord(input, ["taskId"]);
      const taskId = parseTaskId(record["taskId"]);
      if (!taskId.ok) throw new TypeError("invalid_worktree_request");
      return Object.freeze({ taskId: boundedId(taskId.value) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.openWorktreeResource: {
      const record = exactRecord(input, ["taskId", "action"]);
      const taskId = parseTaskId(record["taskId"]);
      const action = record["action"];
      if (!taskId.ok || (action !== "folder" && action !== "terminal")) {
        throw new TypeError("invalid_worktree_request");
      }
      return Object.freeze({ taskId: boundedId(taskId.value), action }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.decidePermission: {
      const record = exactRecord(input, ["taskId", "runId", "permissionId", "decision"]);
      const taskId = parseTaskId(record["taskId"]);
      const runId = parseRunId(record["runId"]);
      const permissionId = boundedText(record["permissionId"], MAX_ID_LENGTH);
      const decisionRecord = exactRecord(record["decision"], ["type"], ["optionId"]);
      let decision: DecidePermissionRequest["decision"];
      if (decisionRecord["type"] === "cancelled") {
        if (Object.hasOwn(decisionRecord, "optionId")) throw new TypeError("invalid_permission_decision");
        decision = Object.freeze({ type: "cancelled" });
      } else if (decisionRecord["type"] === "selected") {
        decision = Object.freeze({ type: "selected", optionId: boundedText(decisionRecord["optionId"], MAX_ID_LENGTH) });
      } else {
        throw new TypeError("invalid_permission_decision");
      }
      if (!taskId.ok || !runId.ok) throw new TypeError("invalid_permission_decision");
      return Object.freeze({ taskId: boundedId(taskId.value), runId: boundedId(runId.value), permissionId, decision }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setDraft: {
      const record = exactRecord(input, ["taskId", "text"]);
      const taskId = parseTaskId(record["taskId"]);
      const text = record["text"];
      if (
        !taskId.ok ||
        typeof text !== "string" ||
        text.length > MAX_MESSAGE_LENGTH ||
        text.includes("\0")
      ) {
        throw new TypeError("invalid_draft");
      }
      return Object.freeze({ taskId: boundedId(taskId.value), text }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.openExternal: {
      const record = exactRecord(input, ["url"]);
      const url = boundedText(record["url"], 2_048);
      try {
        return Object.freeze({ url: canonicalGuildExternalUrl(url) }) as DesktopRequestByChannel[Channel];
      } catch {
        throw new TypeError("invalid_external_url");
      }
    }
    case DESKTOP_IPC_CHANNELS.runGrokManagement: {
      const record = exactRecord(input, ["action"], ["taskId", "parameters", "confirmed"]);
      const action = record["action"];
      if (
        typeof action !== "string" ||
        !(GUILD_GROK_MANAGEMENT_ACTIONS as readonly string[]).includes(action)
      ) {
        throw new TypeError("invalid_grok_management_action");
      }
      let taskId: TaskId | undefined;
      if (record["taskId"] !== undefined) {
        const parsed = parseTaskId(record["taskId"]);
        if (!parsed.ok) throw new TypeError("invalid_task_id");
        taskId = boundedId(parsed.value);
      }
      const confirmed = record["confirmed"];
      if (confirmed !== undefined && typeof confirmed !== "boolean") {
        throw new TypeError("invalid_grok_management_confirmation");
      }
      const parameters = record["parameters"] === undefined
        ? undefined
        : parseGrokManagementParameters(
            action as GuildGrokManagementAction,
            record["parameters"],
          );
      return Object.freeze({
        action: action as GuildGrokManagementAction,
        ...(taskId === undefined ? {} : { taskId }),
        ...(parameters === undefined ? {} : { parameters }),
        ...(confirmed === undefined ? {} : { confirmed }),
      }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setLocale: {
      const record = exactRecord(input, ["locale"]);
      return Object.freeze({ locale: parseGuildLocale(record["locale"]) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setRuntimeSettings: {
      const record = exactRecord(input, ["model", "reasoningEffort", "permissionMode", "startup"]);
      const model = record["model"] === null ? null : parseGuildGrokModel(record["model"]);
      const reasoningEffort = record["reasoningEffort"] === null
        ? null
        : parseGuildGrokReasoningEffort(record["reasoningEffort"]);
      if (model === null && reasoningEffort !== null) throw new TypeError("invalid_grok_model");
      const permissionMode = parseGuildGrokPermissionMode(record["permissionMode"]);
      const startup = parseGuildGrokStartupSettings(record["startup"]);
      return Object.freeze({ model, reasoningEffort, permissionMode, startup }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setClaudeSettings: {
      const record = exactRecord(input, ["model", "reasoningEffort", "permissionMode"]);
      const model = record["model"] === null ? null : parseGuildClaudeModel(record["model"]);
      const reasoningEffort = record["reasoningEffort"] === null
        ? null
        : parseGuildClaudeReasoningEffort(record["reasoningEffort"]);
      const permissionMode = parseGuildClaudePermissionMode(record["permissionMode"]);
      return Object.freeze({ model, reasoningEffort, permissionMode }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setEngineSettings: {
      const record = exactRecord(input, ["engine", "model", "reasoningEffort", "permissionMode"]);
      const engine = parseGuildEngine(record["engine"]);
      if (!isAddonEngine(engine)) throw new TypeError("invalid_engine");
      const model = record["model"] === null ? null : parseGuildModelId(engine, record["model"]);
      const reasoningEffort = record["reasoningEffort"] === null
        ? null
        : parseGuildReasoningEffort(engine, record["reasoningEffort"]);
      const permissionMode = parseGuildAddonPermissionMode(engine, record["permissionMode"]);
      return Object.freeze({ engine, model, reasoningEffort, permissionMode }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setEngineApiKey: {
      const record = exactRecord(input, ["engine", "keyFile", "keyVariable"]);
      const engine = parseKeyedAddonEngine(record["engine"]);
      const keyFile = record["keyFile"] === null ? null : parseModelSourceKeyFile(record["keyFile"]);
      const keyVariable = parseModelSourceKeyVariable(record["keyVariable"]);
      return Object.freeze({ engine, keyFile, keyVariable }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.confirmEngineApiKey: {
      const record = exactRecord(input, ["engine"]);
      return Object.freeze({ engine: parseKeyedAddonEngine(record["engine"]) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setSidebarWidth: {
      const record = exactRecord(input, ["width"]);
      const width = record["width"];
      if (typeof width !== "number" || !Number.isFinite(width) || width < 220 || width > 480) {
        throw new TypeError("invalid_sidebar_width");
      }
      return Object.freeze({ width: Math.round(width) }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.saveProfile: {
      const record = exactRecord(input, ["nickname", "avatar"]);
      const nickname = parseGuildNickname(record["nickname"]);
      const avatar = parseSaveProfileAvatar(record["avatar"]);
      return Object.freeze({ nickname, avatar }) as DesktopRequestByChannel[Channel];
    }
    case DESKTOP_IPC_CHANNELS.setGeneralSettings: {
      const record = exactRecord(input, [
        "restoreLastTask",
        "newTaskWorkspaceMode",
        "browserSyncEnabled",
        "taskNotificationsEnabled",
        "dockIcon",
      ]);
      if (
        typeof record["restoreLastTask"] !== "boolean" ||
        typeof record["browserSyncEnabled"] !== "boolean" ||
        typeof record["taskNotificationsEnabled"] !== "boolean"
      ) {
        throw new TypeError("invalid_general_settings");
      }
      return Object.freeze({
        restoreLastTask: record["restoreLastTask"],
        newTaskWorkspaceMode: parseGuildNewTaskWorkspaceMode(
          record["newTaskWorkspaceMode"],
        ),
        browserSyncEnabled: record["browserSyncEnabled"],
        taskNotificationsEnabled: record["taskNotificationsEnabled"],
        dockIcon: parseGuildDockIcon(record["dockIcon"]),
      }) as DesktopRequestByChannel[Channel];
    }
    default:
      // Push-only event channels and any dynamically built name are never requests.
      throw new TypeError("unregistered_channel");
  }
}

/** An add-on engine that takes an API key (Gemini); any other engine is refused. */
function parseKeyedAddonEngine(value: unknown): GuildAddonEngine {
  const engine = parseGuildEngine(value);
  if (!isAddonEngine(engine) || engineApiKeySpec(engine) === undefined) throw new TypeError("invalid_engine");
  return engine;
}

function parseGrokManagementParameters(
  action: GuildGrokManagementAction,
  value: unknown,
): Readonly<Record<string, GuildGrokManagementParameter>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("invalid_grok_management_parameters");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) {
    throw new TypeError("invalid_grok_management_parameters");
  }
  const record = exactRecord(value, [], keys as string[]);
  const entries = Object.entries(record);
  if (entries.length > 24) throw new TypeError("too_many_grok_management_parameters");
  const parsed: Record<string, GuildGrokManagementParameter> = {};
  for (const [key, raw] of entries) {
    if (!(GUILD_GROK_MANAGEMENT_PARAMETER_KEYS[action] as readonly string[]).includes(key)) {
      throw new TypeError("invalid_grok_management_parameter_name");
    }
    if (typeof raw === "string") {
      if (raw.length > 16_384 || raw.includes("\0")) throw new TypeError("invalid_grok_management_parameter");
      parsed[key] = raw;
    } else if (typeof raw === "boolean") {
      parsed[key] = raw;
    } else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 1_000_000) {
      parsed[key] = raw;
    } else if (
      Array.isArray(raw) &&
      raw.length <= 64 &&
      raw.every((item) => typeof item === "string" && item.length <= 4_096 && !item.includes("\0"))
    ) {
      parsed[key] = Object.freeze([...raw]) as readonly string[];
    } else {
      throw new TypeError("invalid_grok_management_parameter");
    }
  }
  return Object.freeze(parsed);
}

function parseSaveProfileAvatar(value: unknown): SaveProfileAvatar {
  if (value === "keep" || value === "reset") return value;
  const record = exactRecord(value, ["previewToken"]);
  return Object.freeze({
    previewToken: parseAvatarPreviewToken(record["previewToken"]),
  });
}

function boundedId<T extends string>(value: T): T {
  return boundedText(value, MAX_ID_LENGTH) as T;
}

function parsePromptAttachments(value: unknown): readonly PromptAttachment[] {
  if (!Array.isArray(value) || value.length > GUILD_PROMPT_ATTACHMENT_LIMIT) {
    throw new TypeError("invalid_prompt_attachments");
  }
  const seen = new Set<string>();
  const attachments = value.map((item) => {
    const record = exactRecord(item, ["relativePath", "name", "size"], ["mimeType"]);
    const relativePath = boundedText(record["relativePath"], 2_048);
    const segments = relativePath.split(/[\\/]/u);
    if (
      relativePath.startsWith("/") ||
      relativePath.startsWith("\\") ||
      /^[A-Za-z]:/u.test(relativePath) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      seen.has(relativePath)
    ) {
      throw new TypeError("invalid_prompt_attachment_path");
    }
    const name = boundedText(record["name"], 512);
    if (name !== segments[segments.length - 1]) {
      throw new TypeError("invalid_prompt_attachment_name");
    }
    const size = record["size"];
    if (
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > GUILD_PROMPT_ATTACHMENT_MAX_BYTES
    ) {
      throw new TypeError("invalid_prompt_attachment_size");
    }
    const mimeType = Object.hasOwn(record, "mimeType")
      ? boundedText(record["mimeType"], 128)
      : undefined;
    seen.add(relativePath);
    return Object.freeze({ relativePath, name, size, ...(mimeType === undefined ? {} : { mimeType }) });
  });
  return Object.freeze(attachments);
}

function isDisposition(value: unknown): value is "archive" | "restore" | "delete" {
  return value === "archive" || value === "restore" || value === "delete";
}

function isTaskUpdateAction(value: unknown): value is UpdateTaskRequest["action"] {
  return isDisposition(value) || value === "pin" || value === "unpin" || value === "rename";
}
