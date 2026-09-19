import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import {
  isTerminalRunState,
  parseAdapterEpoch,
  parseGuildGrokModel,
  parseGuildGrokPermissionMode,
  parseGuildGrokReasoningEffort,
  parseGuildGrokStartupSettings,
  parseGuildNewTaskWorkspaceMode,
  parseGuildNickname,
  supportsGuildGrokReasoningEffort,
  type GuildNewTaskWorkspaceMode,
  parseIdempotencyKey,
  parsePermissionIdentity,
  permissionIdentitiesEqual,
  parseRunId,
  parseRuntimeTurnEvent,
  parseSessionId,
  parseTaskId,
  parseWindowId,
  type AdapterEpoch,
  type AdapterEpochStatus,
  type IdempotencyKey,
  type GuildGrokModel,
  type GuildGrokPermissionMode,
  type GuildGrokReasoningEffort,
  type GuildGrokStartupSettings,
  type JsonRpcCallbackId,
  type PermissionDeliveryAttemptId,
  type PermissionIdentity,
  type PermissionOutboxCommandId,
  type PermissionOutboxVersion,
  type RuntimePermissionRequestPayload,
  type RuntimeTurnEvent,
  type RunEvent,
  type RunId,
  type SessionId,
  type TaskId,
  type WindowId,
} from "@guild/contracts";
import {
  admitRuntimeTurnEvent,
  applyPermissionEvent,
  applyRunEvent,
  applySessionBindingEvent,
  createQueuedRun,
  createUnboundBinding,
  envelopeFingerprint,
  isTerminalPermissionState,
  registerPermissionRequest,
  type PermissionApplyResult,
  type PermissionOutboxCommand,
  type PermissionOrphanCause,
  type PermissionRecord,
  type PermissionResolutionInput,
  type RunApplyResult,
  type RunRecord,
  type SessionBindingEvent,
  type SessionBindingRecord,
  type SessionBindingResult,
} from "@guild/domain";
import {
  decodePermission,
  decodeRun,
  decodeSessionBinding,
  encodeDecisionCommit,
  encodeOutboxCommand,
  encodePermission,
  encodeRun,
  encodeSessionBinding,
  sha256,
} from "./codec.js";
import {
  PersistenceError,
  persistenceError,
} from "./errors.js";
import {
  acquireDatabaseLease,
  DatabaseLeaseError,
  type DatabaseLease,
} from "./lease.js";
import { migrateSchema, SCHEMA_VERSION } from "./schema.js";

const BUSY_TIMEOUT_MS = 5_000;
const MAX_WORKSPACE_ID_LENGTH = 128;
const MAX_CANONICAL_PATH_LENGTH = 4_096;
const MAX_WORKSPACE_NAME_LENGTH = 256;
const MAX_TASK_TITLE_LENGTH = 512;
const MAX_ENTRY_ID_LENGTH = 128;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_APPEND_BYTES = 262_144;
const MAX_METADATA_BYTES = 65_536;
const MAX_METADATA_DEPTH = 32;
const MAX_METADATA_MEMBERS = 1_000;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 600;
const DEFAULT_CONVERSATION_PAGE_SIZE = 200;
const MAX_CONVERSATION_PAGE_SIZE = 500;
const MAX_QUEUED_TURNS_PER_TASK = 32;

type SqlRow = Record<string, unknown>;

type Loaded<T> = {
  readonly value: T;
  readonly revision: number;
  readonly json: string;
};

type PhysicalRecord<T> = {
  readonly row: SqlRow;
  readonly record: T;
};

export type TaskAuthority = {
  readonly taskId: TaskId;
  readonly owningWindowId: WindowId | undefined;
};

export type RecordDisposition = "active" | "archived" | "deleted";

export type GuildLocale = "zh-CN" | "en-US";

export type WorkspaceRecord = {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly disposition: RecordDisposition;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly archivedAtMs: number | undefined;
  readonly deletedAtMs: number | undefined;
};

export type WorkspaceListItem = WorkspaceRecord & {
  readonly taskCount: number;
  readonly lastActivityAtMs: number | undefined;
};

export type TaskMetadataRecord = {
  readonly taskId: TaskId;
  readonly workspaceId: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly disposition: RecordDisposition;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly lastActivityAtMs: number;
  readonly archivedAtMs: number | undefined;
  readonly deletedAtMs: number | undefined;
};

export type PersistedAdapterEpochStatus = Exclude<AdapterEpochStatus, "absent">;

export type AdapterEpochRecord = {
  readonly taskId: TaskId;
  readonly sessionId: SessionId;
  readonly adapterEpoch: AdapterEpoch;
  readonly status: PersistedAdapterEpochStatus;
  readonly current: boolean;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type PromptTerminalClassification =
  | "cancelled"
  | "completed"
  | "refused"
  | "truncated";

export type PromptCorrelationRecord = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly adapterEpoch: AdapterEpoch;
  readonly promptSequence: number;
  readonly status: "accepted" | "terminal";
  readonly terminalClassification: PromptTerminalClassification | undefined;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type CreateConversationTaskResult = {
  readonly task: TaskAuthority;
  readonly metadata: TaskMetadataRecord;
  readonly sessionBinding: SessionBindingRecord;
  readonly duplicate: boolean;
};

export type ConversationEntryKind =
  | "user"
  | "assistant"
  | "thought"
  | "tool"
  | "permission"
  | "media"
  | "notice"
  | "error";

export type ConversationEntryStatus = "streaming" | "complete" | "failed";

export type ConversationMetadataValue =
  | null
  | boolean
  | number
  | string
  | readonly ConversationMetadataValue[]
  | { readonly [key: string]: ConversationMetadataValue };

export type ConversationEntryMetadata = Readonly<
  Record<string, ConversationMetadataValue>
>;

export type ConversationEntryRecord = {
  readonly taskId: TaskId;
  readonly entryId: string;
  readonly sequence: number;
  readonly kind: ConversationEntryKind;
  readonly runId: RunId | undefined;
  readonly text: string;
  readonly metadata: ConversationEntryMetadata;
  readonly status: ConversationEntryStatus;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type ConversationEntryCreationResult = {
  readonly record: ConversationEntryRecord;
  readonly duplicate: boolean;
};

export type QueuedTurnRecord = {
  readonly taskId: TaskId;
  readonly queueId: string;
  readonly intendedSessionId: SessionId;
  readonly reservedRunId: RunId;
  readonly entryId: string;
  readonly text: string;
  readonly createdAtMs: number;
  readonly priority: number;
};

export type QueuedTurnDispatchResult = {
  readonly run: RunRecord;
  readonly entry: ConversationEntryRecord;
};

export type ContinuousTaskStatus =
  | "active"
  | "paused"
  | "completed"
  | "blocked"
  | "stopped";

export type ContinuousTaskPhase = "work" | "audit";

export type ContinuousTaskRecord = {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly status: ContinuousTaskStatus;
  readonly phase: ContinuousTaskPhase;
  readonly cycle: number;
  readonly lastRunId: RunId | undefined;
  readonly summary: string | undefined;
  readonly remaining: string | undefined;
  readonly stopReason: string | undefined;
  readonly consecutiveNoProgress: number;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type LiveConversationEntryMutation =
  | {
      readonly type: "create";
      readonly entryId: string;
      readonly kind: ConversationEntryKind;
      readonly text: string;
      readonly metadata?: ConversationEntryMetadata;
      readonly status: ConversationEntryStatus;
    }
  | {
      readonly type: "append_text";
      readonly entryId: string;
      readonly expectedRevision: number;
      readonly text: string;
    }
  | {
      readonly type: "finalize";
      readonly entryId: string;
      readonly expectedRevision: number;
      readonly status: Exclude<ConversationEntryStatus, "streaming">;
    };

export type LiveRuntimeEventCommitResult =
  | {
      readonly ok: true;
      readonly duplicate: boolean;
      readonly record: ConversationEntryRecord | undefined;
      readonly run: RunRecord;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export type PromptAcceptanceDurableNotice = Readonly<{
  entryId: string;
  text: string;
  metadata: ConversationEntryMetadata;
}>;

export type RuntimeReplayOrderMarker = Readonly<{
  entryId: string;
  token: string;
}>;

export type PromptAcceptanceResult = {
  readonly correlation: PromptCorrelationRecord;
  readonly run: RunRecord;
  readonly duplicate: boolean;
};

export type DraftRecord = {
  readonly taskId: TaskId;
  readonly text: string;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
};

export type AppSettingsRecord = {
  readonly locale: GuildLocale;
  readonly grokModel: GuildGrokModel;
  readonly reasoningEffort: GuildGrokReasoningEffort;
  readonly permissionMode: GuildGrokPermissionMode;
  readonly startup: GuildGrokStartupSettings;
  readonly sidebarWidth: number;
  readonly browserSyncEnabled: boolean;
  readonly nickname: string;
  readonly avatarFilename?: string;
  readonly restoreLastTask: boolean;
  readonly newTaskWorkspaceMode: GuildNewTaskWorkspaceMode;
  readonly taskNotificationsEnabled: boolean;
  readonly lastActiveTaskId?: TaskId;
  readonly lastWorkspaceId?: string;
  readonly revision: number;
  readonly updatedAtMs: number;
};

export type CanonicalTaskRestore = {
  readonly task: TaskAuthority;
  readonly sessionBinding: SessionBindingRecord | undefined;
  readonly currentRun: RunRecord | undefined;
  readonly permissions: readonly PermissionRecord[];
};

export type PermissionRegistrationResult =
  | {
      readonly ok: true;
      readonly record: PermissionRecord;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly record: PermissionRecord | undefined;
      readonly reason: string;
    };

export type PendingPermissionRegistrationInput = {
  readonly identity: PermissionIdentity;
  readonly request: RuntimePermissionRequestPayload;
  readonly idempotencyKey: IdempotencyKey;
  readonly runIdempotencyKey: IdempotencyKey;
};

export type PermissionWriteClaim = {
  readonly commandId: PermissionOutboxCommandId;
  readonly version: PermissionOutboxVersion;
  readonly deliveryAttemptId: PermissionDeliveryAttemptId;
  readonly command: PermissionOutboxCommand;
};

export type PermissionDecisionAndClaimResult =
  | {
      readonly ok: true;
      readonly record: PermissionRecord;
      readonly duplicate: boolean;
      readonly writeClaim: PermissionWriteClaim | undefined;
    }
  | {
      readonly ok: false;
      readonly record: PermissionRecord | undefined;
      readonly reason: string;
    };

export type SafeCancelPermissionRegistrationAndClaimInput = {
  readonly identity: PermissionIdentity;
  readonly request: RuntimePermissionRequestPayload;
  readonly idempotencyKey: IdempotencyKey;
  readonly runIdempotencyKey: IdempotencyKey;
  readonly commandId: PermissionOutboxCommandId;
  readonly deliveryAttemptId: PermissionDeliveryAttemptId;
};

export type SafeCancelPermissionRegistrationAndClaimResult =
  PermissionDecisionAndClaimResult;

type AutomaticPermissionSettlementBase = {
  readonly identity: PermissionIdentity;
  readonly runResolutionIdempotencyKey: IdempotencyKey;
};

type AutomaticPermissionSettlementReason =
  | { readonly type: "deadline_passed" }
  | {
      readonly type: "orphan";
      readonly cause:
        | "window_closed"
        | "window_reloaded"
        | "run_cancel_requested";
    };

type AutomaticPermissionSettlementTransport =
  | {
      readonly transportCanReceive: false;
      readonly commandId?: never;
      readonly deliveryAttemptId?: never;
    }
  | {
      readonly transportCanReceive: true;
      readonly commandId: PermissionOutboxCommandId;
      readonly deliveryAttemptId: PermissionDeliveryAttemptId;
    };

export type AutomaticPermissionSettlementInput =
  AutomaticPermissionSettlementBase &
  AutomaticPermissionSettlementReason &
  AutomaticPermissionSettlementTransport;

export type AutomaticPermissionSettlementResult =
  PermissionDecisionAndClaimResult;

export type PermanentPermissionDeliveryLossCause = Extract<
  PermissionOrphanCause,
  | "run_terminalized"
  | "session_changed"
  | "epoch_exited"
  | "transport_cannot_reply"
>;

export type PermissionDeliveryUncertainResult =
  PermissionAcknowledgementResult;

export type PermissionAcknowledgementResult =
  | {
      readonly ok: true;
      readonly record: PermissionRecord;
      readonly duplicate: boolean;
    }
  | {
      readonly ok: false;
      readonly record: PermissionRecord | undefined;
      readonly reason: string;
    };

type PermissionAcknowledgementBase = {
  readonly identity: PermissionIdentity;
  readonly commandId: PermissionOutboxCommandId;
  readonly version: PermissionOutboxVersion;
  readonly deliveryAttemptId: PermissionDeliveryAttemptId;
};

export type PermissionAcknowledgementInput =
  | (PermissionAcknowledgementBase & {
      readonly registrationMode: "pending";
      readonly runResolutionIdempotencyKey: IdempotencyKey;
    })
  | (PermissionAcknowledgementBase & {
      readonly registrationMode: "run_cancel_requested";
      readonly runResolutionIdempotencyKey?: never;
    });

export type IntegrityReport = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly recoveredAfterUncleanShutdown: boolean;
  readonly checkedAtMs: number;
};

export type OpenGuildPersistenceOptions = {
  readonly path: string;
  readonly initialLocale?: GuildLocale;
};

export interface GuildPersistence {
  readonly recoveredAfterUncleanShutdown: boolean;

  createWorkspace(input: {
    readonly workspaceId: string;
    readonly canonicalPath: string;
    readonly displayName: string;
  }): WorkspaceRecord;
  loadWorkspace(workspaceId: string): WorkspaceRecord;
  listWorkspaces(input?: {
    readonly includeArchived?: boolean;
    readonly includeDeleted?: boolean;
  }): readonly WorkspaceListItem[];
  archiveWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord;
  restoreWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord;
  reAddDeletedWorkspace(input: { readonly workspaceId: string; readonly expectedRevision: number }): WorkspaceRecord;
  deleteWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord;

  createTask(input: {
    readonly taskId: TaskId;
    readonly owningWindowId?: WindowId;
  }): TaskAuthority;
  bindTaskToWorkspace(input: {
    readonly taskId: TaskId;
    readonly workspaceId: string;
    readonly title: string;
  }): TaskMetadataRecord;
  createConversationTask(input: {
    readonly taskId: TaskId;
    readonly workspaceId: string;
    readonly title: string;
    readonly owningWindowId?: WindowId;
  }): CreateConversationTaskResult;
  loadTaskMetadata(taskId: TaskId): TaskMetadataRecord;
  listTasks(input: {
    readonly workspaceId: string;
    readonly includeArchived?: boolean;
    readonly includeDeleted?: boolean;
  }): readonly TaskMetadataRecord[];
  renameTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly title: string;
  }): TaskMetadataRecord;
  setTaskPinned(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly pinned: boolean;
  }): TaskMetadataRecord;
  archiveTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord;
  unarchiveTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord;
  deleteTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord;
  commitAdapterEpoch(input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly expectedRevision: number;
    readonly status: PersistedAdapterEpochStatus;
  }): AdapterEpochRecord;
  loadCurrentAdapterEpoch(taskId: TaskId): AdapterEpochRecord | undefined;
  commitPromptAccepted(input: {
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly promptSequence: number;
    readonly idempotencyKey: IdempotencyKey;
    readonly durableNotices?: readonly PromptAcceptanceDurableNotice[];
  }): PromptAcceptanceResult;
  loadPromptCorrelation(
    taskId: TaskId,
    runId: RunId,
  ): PromptCorrelationRecord;
  commitLiveRuntimeEvent(input: {
    readonly event: RuntimeTurnEvent;
    readonly mutation: LiveConversationEntryMutation;
    readonly replayOrderMarker?: RuntimeReplayOrderMarker;
    readonly terminalFinalizationIdempotencyKey?: IdempotencyKey;
  }): LiveRuntimeEventCommitResult;
  createConversationEntry(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly kind: ConversationEntryKind;
    readonly runId?: RunId;
    readonly text: string;
    readonly metadata?: ConversationEntryMetadata;
    readonly status: ConversationEntryStatus;
  }): ConversationEntryCreationResult;
  appendConversationEntryText(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly expectedRevision: number;
    readonly text: string;
  }): ConversationEntryRecord;
  finalizeConversationEntry(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly expectedRevision: number;
    readonly status: Exclude<ConversationEntryStatus, "streaming">;
  }): ConversationEntryRecord;
  loadConversationEntry(
    taskId: TaskId,
    entryId: string,
  ): ConversationEntryRecord;
  listConversationEntries(input: {
    readonly taskId: TaskId;
    readonly afterSequence?: number;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[];
  listRecentConversationEntries(input: {
    readonly taskId: TaskId;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[];
  listConversationEntriesBefore(input: {
    readonly taskId: TaskId;
    readonly beforeSequence: number;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[];
  countConversationEntries(taskId: TaskId): number;
  loadLatestContextTokensUsed(taskId: TaskId): number | undefined;
  saveContextWindowSize(input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly size: number;
  }): void;
  loadContextWindowSize(taskId: TaskId): number | undefined;
  enqueueQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
    readonly intendedSessionId: SessionId;
    readonly reservedRunId: RunId;
    readonly entryId: string;
    readonly text: string;
  }): QueuedTurnRecord;
  listQueuedTurns(taskId: TaskId): readonly QueuedTurnRecord[];
  prioritizeQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
  }): void;
  cancelQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
  }): void;
  dispatchQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly idempotencyKey: IdempotencyKey;
  }): QueuedTurnDispatchResult;
  startContinuousTask(input: {
    readonly taskId: TaskId;
    readonly objective: string;
  }): ContinuousTaskRecord;
  loadContinuousTask(taskId: TaskId): ContinuousTaskRecord | undefined;
  updateContinuousTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly status?: ContinuousTaskStatus;
    readonly phase?: ContinuousTaskPhase;
    readonly cycle?: number;
    readonly lastRunId?: RunId | null;
    readonly summary?: string | null;
    readonly remaining?: string | null;
    readonly stopReason?: string | null;
    readonly consecutiveNoProgress?: number;
  }): ContinuousTaskRecord;
  saveDraft(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly text: string;
  }): DraftRecord;
  loadDraft(taskId: TaskId): DraftRecord | undefined;
  clearDraft(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): void;
  loadAppSettings(): AppSettingsRecord;
  updateAppSettings(input: {
    readonly expectedRevision: number;
    readonly locale?: GuildLocale;
    readonly grokModel?: GuildGrokModel;
    readonly reasoningEffort?: GuildGrokReasoningEffort;
    readonly permissionMode?: GuildGrokPermissionMode;
    readonly startup?: GuildGrokStartupSettings;
    readonly sidebarWidth?: number;
    readonly browserSyncEnabled?: boolean;
    readonly nickname?: string;
    readonly avatarFilename?: string | null;
    readonly restoreLastTask?: boolean;
    readonly newTaskWorkspaceMode?: GuildNewTaskWorkspaceMode;
    readonly taskNotificationsEnabled?: boolean;
    readonly lastActiveTaskId?: TaskId | null;
    readonly lastWorkspaceId?: string | null;
  }): AppSettingsRecord;
  createRun(input: { readonly taskId: TaskId; readonly runId: RunId }): RunRecord;
  applyRun(input: {
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly event: RunEvent;
  }): RunApplyResult;
  loadRun(taskId: TaskId, runId: RunId): RunRecord;
  createSessionBinding(taskId: TaskId): SessionBindingRecord;
  applySessionBinding(input: {
    readonly taskId: TaskId;
    readonly event: SessionBindingEvent;
  }): SessionBindingResult;
  loadSessionBinding(taskId: TaskId): SessionBindingRecord;
  registerPermission(
    input: PendingPermissionRegistrationInput,
  ): PermissionRegistrationResult;
  registerSafeCancelPermissionAndClaim(
    input: SafeCancelPermissionRegistrationAndClaimInput,
  ): SafeCancelPermissionRegistrationAndClaimResult;
  loadPermission(identity: PermissionIdentity): PermissionRecord;
  decidePermissionAndClaim(input: {
    readonly identity: PermissionIdentity;
    readonly callbackRequestId: JsonRpcCallbackId;
    readonly outcome: PermissionResolutionInput;
    readonly commandId: PermissionOutboxCommandId;
    readonly deliveryAttemptId: PermissionDeliveryAttemptId;
  }): PermissionDecisionAndClaimResult;
  settlePermissionAutomaticallyAndMaybeClaim(
    input: AutomaticPermissionSettlementInput,
  ): AutomaticPermissionSettlementResult;
  acknowledgePermissionResponse(
    input: PermissionAcknowledgementInput,
  ): PermissionAcknowledgementResult;
  markPermissionDeliveryUncertain(input: {
    readonly identity: PermissionIdentity;
    readonly commandId: PermissionOutboxCommandId;
    readonly version: PermissionOutboxVersion;
    readonly deliveryAttemptId: PermissionDeliveryAttemptId;
    readonly cause: PermanentPermissionDeliveryLossCause;
  }): PermissionDeliveryUncertainResult;
  restoreTask(taskId: TaskId): CanonicalTaskRestore;
  verifyIntegrity(): IntegrityReport;
  backupTo(destinationPath: string): void;
  close(): void;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function exactText(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw persistenceError("aggregate_integrity_failed");
  }
  return value;
}

function optionalText(row: SqlRow, key: string): string | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw persistenceError("aggregate_integrity_failed");
  }
  return value;
}

function exactInteger(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw persistenceError("aggregate_integrity_failed");
  }
  return value;
}

function optionalInteger(row: SqlRow, key: string): number | undefined {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw persistenceError("aggregate_integrity_failed");
  }
  return value;
}

function changes(value: number | bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw persistenceError("persistence_cas_conflict");
  }
  return result;
}

function exactNow(): number {
  const value = Date.now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw persistenceError("storage_configuration_failed");
  }
  return value;
}

function parsedTaskId(value: TaskId): TaskId {
  const parsed = parseTaskId(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedRunId(value: RunId): RunId {
  const parsed = parseRunId(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedIdempotencyKey(value: IdempotencyKey): IdempotencyKey {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedWindowId(value: WindowId | undefined): WindowId | undefined {
  if (value === undefined) return undefined;
  const parsed = parseWindowId(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedIdentity(value: PermissionIdentity): PermissionIdentity {
  const parsed = parsePermissionIdentity(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedSessionIdValue(value: SessionId): SessionId {
  const parsed = parseSessionId(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedAdapterEpochValue(value: AdapterEpoch): AdapterEpoch {
  const parsed = parseAdapterEpoch(value);
  if (!parsed.ok) throw persistenceError("domain_operation_rejected");
  return parsed.value;
}

function parsedAdapterEpochStatus(
  value: unknown,
): PersistedAdapterEpochStatus {
  if (
    value !== "spawning" &&
    value !== "alive" &&
    value !== "stopping" &&
    value !== "exited"
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedPromptSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function boundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    value.includes("\0")
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedWorkspaceId(value: unknown): string {
  const parsed = boundedString(value, MAX_WORKSPACE_ID_LENGTH);
  if (/\p{Cc}/u.test(parsed)) {
    throw persistenceError("domain_operation_rejected");
  }
  return parsed;
}

function parsedCanonicalPath(value: unknown): string {
  return boundedString(value, MAX_CANONICAL_PATH_LENGTH);
}

function parsedDisplayName(value: unknown): string {
  const parsed = boundedString(value, MAX_WORKSPACE_NAME_LENGTH);
  if (parsed.trim().length === 0) {
    throw persistenceError("domain_operation_rejected");
  }
  return parsed;
}

function parsedTaskTitle(value: unknown): string {
  const parsed = boundedString(value, MAX_TASK_TITLE_LENGTH);
  if (parsed.trim().length === 0) {
    throw persistenceError("domain_operation_rejected");
  }
  return parsed;
}

function parsedEntryId(value: unknown): string {
  const parsed = boundedString(value, MAX_ENTRY_ID_LENGTH);
  if (/\p{Cc}/u.test(parsed)) {
    throw persistenceError("domain_operation_rejected");
  }
  return parsed;
}

function parsedRevision(value: unknown, allowZero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedText(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedAppendText(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_APPEND_BYTES
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedDisposition(value: unknown): RecordDisposition {
  if (value !== "active" && value !== "archived" && value !== "deleted") {
    throw persistenceError("aggregate_integrity_failed");
  }
  return value;
}

function parsedEntryKind(value: unknown): ConversationEntryKind {
  switch (value) {
    case "user":
    case "assistant":
    case "thought":
    case "tool":
    case "permission":
    case "media":
    case "notice":
    case "error":
      return value;
    default:
      throw persistenceError("domain_operation_rejected");
  }
}

function parsedEntryStatus(value: unknown): ConversationEntryStatus {
  if (value !== "streaming" && value !== "complete" && value !== "failed") {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedContinuousTaskStatus(value: unknown): ContinuousTaskStatus {
  if (
    value !== "active" &&
    value !== "paused" &&
    value !== "completed" &&
    value !== "blocked" &&
    value !== "stopped"
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedContinuousTaskPhase(value: unknown): ContinuousTaskPhase {
  if (value !== "work" && value !== "audit") {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedLocale(value: unknown): GuildLocale {
  if (value !== "zh-CN" && value !== "en-US") {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedSidebarWidth(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_SIDEBAR_WIDTH ||
    value > MAX_SIDEBAR_WIDTH
  ) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

const AVATAR_FILENAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|webp)$/u;

function parsedAvatarFilename(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!AVATAR_FILENAME.test(value)) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function parsedOptionalId(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    throw persistenceError("domain_operation_rejected");
  }
  return value;
}

function canonicalMetadataValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): ConversationMetadataValue {
  if (depth > MAX_METADATA_DEPTH) {
    throw persistenceError("domain_operation_rejected");
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw persistenceError("domain_operation_rejected");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw persistenceError("domain_operation_rejected");
  }
  if (seen.has(value)) {
    throw persistenceError("domain_operation_rejected");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (
        value.length > MAX_METADATA_MEMBERS ||
        ownKeys.length !== value.length + 1 ||
        ownKeys.some((key) => {
          if (key === "length") return false;
          if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/u.test(key)) {
            return true;
          }
          const index = Number(key);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          return index >= value.length || descriptor === undefined ||
            !("value" in descriptor) || descriptor.enumerable !== true;
        })
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      return Object.freeze(
        value.map((item) => canonicalMetadataValue(item, depth + 1, seen)),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw persistenceError("domain_operation_rejected");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > MAX_METADATA_MEMBERS ||
      ownKeys.some((key) => typeof key !== "string")
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    const record = Object.create(null) as Record<
      string,
      ConversationMetadataValue
    >;
    for (const key of (ownKeys as string[]).sort()) {
      if (key.length === 0 || key.length > 128 || /\p{Cc}/u.test(key)) {
        throw persistenceError("domain_operation_rejected");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      record[key] = canonicalMetadataValue(
        descriptor.value,
        depth + 1,
        seen,
      );
    }
    return Object.freeze(record);
  } finally {
    seen.delete(value);
  }
}

function encodeMetadata(
  value: ConversationEntryMetadata | undefined,
): {
  readonly value: ConversationEntryMetadata;
  readonly json: string;
  readonly sha256: string;
} {
  const canonical = canonicalMetadataValue(
    value ?? {},
    0,
    new WeakSet<object>(),
  );
  if (canonical === null || Array.isArray(canonical) || typeof canonical !== "object") {
    throw persistenceError("domain_operation_rejected");
  }
  const json = JSON.stringify(canonical);
  if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
    throw persistenceError("domain_operation_rejected");
  }
  return freeze({
    value: canonical as ConversationEntryMetadata,
    json,
    sha256: sha256(json),
  });
}

function decodeMetadata(json: string, expectedSha256: string): ConversationEntryMetadata {
  if (sha256(json) !== expectedSha256) {
    throw persistenceError("aggregate_integrity_failed");
  }
  try {
    const encoded = encodeMetadata(JSON.parse(json) as ConversationEntryMetadata);
    if (encoded.json !== json) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return encoded.value;
  } catch (cause: unknown) {
    if (
      cause instanceof PersistenceError &&
      cause.code === "aggregate_integrity_failed"
    ) {
      throw cause;
    }
    throw persistenceError("aggregate_integrity_failed", cause);
  }
}

function entryInitialFingerprint(input: {
  readonly taskId: TaskId;
  readonly entryId: string;
  readonly kind: ConversationEntryKind;
  readonly runId: RunId | undefined;
  readonly text: string;
  readonly metadataJson: string;
  readonly status: ConversationEntryStatus;
}): string {
  return sha256(JSON.stringify([
    input.taskId,
    input.entryId,
    input.kind,
    input.runId ?? null,
    input.text,
    input.metadataJson,
    input.status,
  ]));
}

function identityBindings(identity: PermissionIdentity): readonly (string | number)[] {
  return [
    identity.taskId,
    identity.runId,
    identity.sessionId,
    identity.toolCallId,
    identity.adapterEpoch,
    identity.windowId,
  ];
}

function permissionRunResolutionEvent(
  record: PermissionRecord,
  idempotencyKey: IdempotencyKey,
): RunEvent {
  const identity = record.identity;
  switch (record.state) {
    case "selected_allow":
      return freeze({
        type: "permission_resolved_continue",
        identity,
        idempotencyKey,
      });
    case "selected_rejection":
      return freeze({ type: "permission_denial", identity, idempotencyKey });
    case "cancelled":
      return freeze({ type: "permission_cancelled", identity, idempotencyKey });
    case "expired":
      return freeze({ type: "permission_expired", identity, idempotencyKey });
    case "orphaned":
      return freeze({ type: "permission_orphaned", identity, idempotencyKey });
    default:
      throw persistenceError("domain_operation_rejected");
  }
}

function isCoupledPermissionRunEvent(event: RunEvent): boolean {
  return event.type === "permission_admitted" ||
    event.type === "permission_resolved_continue" ||
    event.type === "permission_denial" ||
    event.type === "permission_cancelled" ||
    event.type === "permission_expired" ||
    event.type === "permission_orphaned";
}

function persistenceLeaseError(cause: unknown): PersistenceError {
  return cause instanceof DatabaseLeaseError &&
      cause.code === "database_lease_held"
    ? persistenceError("database_lease_held", cause)
    : persistenceError("storage_configuration_failed", cause);
}

class SqliteGuildPersistence implements GuildPersistence {
  readonly recoveredAfterUncleanShutdown: boolean;
  readonly #database: DatabaseSync;
  readonly #lease: DatabaseLease;
  #closed = false;

  constructor(
    database: DatabaseSync,
    lease: DatabaseLease,
    recoveredAfterUncleanShutdown: boolean,
  ) {
    this.#database = database;
    this.#lease = lease;
    this.recoveredAfterUncleanShutdown = recoveredAfterUncleanShutdown;
  }

  createWorkspace(input: {
    readonly workspaceId: string;
    readonly canonicalPath: string;
    readonly displayName: string;
  }): WorkspaceRecord {
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const canonicalPath = parsedCanonicalPath(input.canonicalPath);
    const displayName = parsedDisplayName(input.displayName);
    return this.#immediate(() => {
      const candidates = this.#database
        .prepare(`
          SELECT * FROM workspaces
          WHERE workspace_id = ? OR canonical_path = ?
        `)
        .all(workspaceId, canonicalPath);
      if (candidates.length > 0) {
        if (candidates.length !== 1) {
          throw persistenceError("aggregate_integrity_failed");
        }
        const existing = this.#decodeWorkspaceRow(candidates[0] as SqlRow);
        if (
          existing.workspaceId !== workspaceId ||
          existing.canonicalPath !== canonicalPath ||
          existing.displayName !== displayName
        ) {
          throw persistenceError("aggregate_already_exists");
        }
        return existing;
      }
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO workspaces(
            workspace_id, canonical_path, display_name, disposition, revision,
            created_at_ms, updated_at_ms, archived_at_ms, deleted_at_ms
          ) VALUES(?, ?, ?, 'active', 1, ?, ?, NULL, NULL)
        `)
        .run(workspaceId, canonicalPath, displayName, at, at);
      return this.#requiredWorkspace(workspaceId);
    });
  }

  loadWorkspace(workspaceIdInput: string): WorkspaceRecord {
    this.#assertOpen();
    return this.#requiredWorkspace(parsedWorkspaceId(workspaceIdInput));
  }

  listWorkspaces(input: {
    readonly includeArchived?: boolean;
    readonly includeDeleted?: boolean;
  } = {}): readonly WorkspaceListItem[] {
    this.#assertOpen();
    const includeArchived = input.includeArchived === true;
    const includeDeleted = input.includeDeleted === true;
    if (
      input.includeArchived !== undefined &&
      typeof input.includeArchived !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    if (
      input.includeDeleted !== undefined &&
      typeof input.includeDeleted !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    const records = this.#database
      .prepare(`
        SELECT workspace.*,
          COUNT(task.task_id) AS task_count,
          MAX(task.last_activity_at_ms) AS last_activity_at_ms
        FROM workspaces AS workspace
        LEFT JOIN task_metadata AS task
          ON task.workspace_id = workspace.workspace_id
          AND task.disposition <> 'deleted'
        GROUP BY workspace.workspace_id
        ORDER BY COALESCE(MAX(task.last_activity_at_ms), workspace.updated_at_ms) DESC,
          workspace.display_name, workspace.workspace_id
      `)
      .all()
      .map((row) => {
        const workspace = this.#decodeWorkspaceRow(row);
        return freeze({
          ...workspace,
          taskCount: exactInteger(row, "task_count"),
          lastActivityAtMs: optionalInteger(row, "last_activity_at_ms"),
        });
      })
      .filter((workspace) =>
        workspace.disposition === "active" ||
        (workspace.disposition === "archived" && includeArchived) ||
        (workspace.disposition === "deleted" && includeDeleted)
      );
    return Object.freeze(records);
  }

  archiveWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord {
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setWorkspaceDisposition(workspaceId, expectedRevision, "archived")
    );
  }

  listRecentConversationEntries(input: {
    readonly taskId: TaskId;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[] {
    this.#assertOpen();
    const taskId = parsedTaskId(input.taskId);
    this.#requiredTaskMetadata(taskId);
    const limit = input.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONVERSATION_PAGE_SIZE) {
      throw persistenceError("domain_operation_rejected");
    }
    return Object.freeze(
      this.#database
        .prepare(`
          SELECT * FROM (
            SELECT * FROM conversation_entries
            WHERE task_id = ?
            ORDER BY sequence DESC
            LIMIT ?
          )
          ORDER BY sequence
        `)
        .all(taskId, limit)
        .map((row) => this.#decodeConversationEntryRow(row).record),
    );
  }

  listConversationEntriesBefore(input: {
    readonly taskId: TaskId;
    readonly beforeSequence: number;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[] {
    this.#assertOpen();
    const taskId = parsedTaskId(input.taskId);
    this.#requiredTaskMetadata(taskId);
    const beforeSequence = input.beforeSequence;
    const limit = input.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE;
    if (
      !Number.isSafeInteger(beforeSequence) ||
      beforeSequence < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CONVERSATION_PAGE_SIZE
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    return Object.freeze(
      this.#database
        .prepare(`
          SELECT * FROM (
            SELECT * FROM conversation_entries
            WHERE task_id = ? AND sequence < ?
            ORDER BY sequence DESC
            LIMIT ?
          )
          ORDER BY sequence
        `)
        .all(taskId, beforeSequence, limit)
        .map((row) => this.#decodeConversationEntryRow(row).record),
    );
  }

  countConversationEntries(taskIdInput: TaskId): number {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    const row = this.#database
      .prepare("SELECT COUNT(*) AS entry_count FROM conversation_entries WHERE task_id = ?")
      .get(taskId);
    if (row === undefined) throw persistenceError("aggregate_integrity_failed");
    return exactInteger(row, "entry_count");
  }

  loadLatestContextTokensUsed(taskIdInput: TaskId): number | undefined {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    const currentSessionId = this.#requiredSession(taskId).value.sessionId;
    if (currentSessionId === undefined) return undefined;
    const rows = this.#database
      .prepare(`
        SELECT event_json, event_sha256
        FROM committed_envelopes
        WHERE task_id = ?
        ORDER BY committed_at_ms DESC, receive_sequence DESC
      `)
      .all(taskId);
    for (const row of rows) {
      const eventJson = exactText(row, "event_json");
      if (sha256(eventJson) !== exactText(row, "event_sha256")) {
        throw persistenceError("aggregate_integrity_failed");
      }
      let raw: unknown;
      try {
        raw = JSON.parse(eventJson) as unknown;
      } catch {
        throw persistenceError("aggregate_integrity_failed");
      }
      const parsed = parseRuntimeTurnEvent(raw);
      if (!parsed.ok) throw persistenceError("aggregate_integrity_failed");
      if (
        parsed.value.payload.type === "prompt_terminal" &&
        parsed.value.payload.sessionId === currentSessionId &&
        parsed.value.payload.contextTokensUsed !== undefined
      ) {
        return parsed.value.payload.contextTokensUsed;
      }
    }
    return undefined;
  }

  saveContextWindowSize(input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly size: number;
  }): void {
    const taskId = parsedTaskId(input.taskId);
    const sessionId = parsedSessionIdValue(input.sessionId);
    if (!Number.isSafeInteger(input.size) || input.size <= 0) {
      throw persistenceError("domain_operation_rejected");
    }
    this.#immediate(() => {
      this.#requiredTaskMetadata(taskId);
      if (this.#requiredSession(taskId).value.sessionId !== sessionId) {
        throw persistenceError("domain_operation_rejected");
      }
      this.#database.prepare(`
        INSERT INTO session_context_windows(task_id, session_id, size, updated_at_ms)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          session_id = excluded.session_id,
          size = excluded.size,
          updated_at_ms = excluded.updated_at_ms
      `).run(taskId, sessionId, input.size, exactNow());
    });
  }

  loadContextWindowSize(taskIdInput: TaskId): number | undefined {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    const sessionId = this.#requiredSession(taskId).value.sessionId;
    if (sessionId === undefined) return undefined;
    const row = this.#database.prepare(`
      SELECT session_id, size FROM session_context_windows WHERE task_id = ?
    `).get(taskId);
    if (row === undefined) return undefined;
    if (exactText(row, "session_id") !== sessionId) return undefined;
    const size = exactInteger(row, "size");
    if (size <= 0) throw persistenceError("aggregate_integrity_failed");
    return size;
  }

  restoreWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord {
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setWorkspaceDisposition(workspaceId, expectedRevision, "active")
    );
  }

  reAddDeletedWorkspace(input: { readonly workspaceId: string; readonly expectedRevision: number }): WorkspaceRecord {
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const revision = parsedRevision(input.expectedRevision);
    return this.#immediate(() => {
      const current = this.#requiredWorkspace(workspaceId);
      if (current.revision !== revision) throw persistenceError("persistence_cas_conflict");
      if (current.disposition !== "deleted") throw persistenceError("domain_operation_rejected");
      for (const task of this.listTasks({ workspaceId, includeArchived: true, includeDeleted: true })) {
        if (task.disposition !== "deleted") this.#setTaskDisposition(task.taskId, task.revision, "deleted");
      }
      this.#database.prepare(`
        UPDATE workspaces SET disposition = 'active', deleted_at_ms = NULL, archived_at_ms = NULL,
          revision = revision + 1, updated_at_ms = ? WHERE workspace_id = ? AND revision = ?
      `).run(exactNow(), workspaceId, revision);
      return this.#requiredWorkspace(workspaceId);
    });
  }

  deleteWorkspace(input: {
    readonly workspaceId: string;
    readonly expectedRevision: number;
  }): WorkspaceRecord {
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setWorkspaceDisposition(workspaceId, expectedRevision, "deleted")
    );
  }

  createTask(input: {
    readonly taskId: TaskId;
    readonly owningWindowId?: WindowId;
  }): TaskAuthority {
    const taskId = parsedTaskId(input.taskId);
    const owningWindowId = parsedWindowId(input.owningWindowId);
    return this.#immediate(() => {
      const existing = this.#database
        .prepare("SELECT owning_window_id FROM tasks WHERE task_id = ?")
        .get(taskId);
      if (existing !== undefined) {
        const storedWindow = optionalText(existing, "owning_window_id");
        if (storedWindow !== owningWindowId) {
          throw persistenceError("aggregate_already_exists");
        }
        return freeze({ taskId, owningWindowId });
      }
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO tasks(task_id, owning_window_id, revision, created_at_ms, updated_at_ms)
          VALUES(?, ?, 1, ?, ?)
        `)
        .run(taskId, owningWindowId ?? null, at, at);
      return freeze({ taskId, owningWindowId });
    });
  }

  bindTaskToWorkspace(input: {
    readonly taskId: TaskId;
    readonly workspaceId: string;
    readonly title: string;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const title = parsedTaskTitle(input.title);
    return this.#immediate(() => {
      this.#requireTask(taskId);
      const workspace = this.#requiredWorkspace(workspaceId);
      if (workspace.disposition !== "active") {
        throw persistenceError("domain_operation_rejected");
      }
      const existing = this.#selectTaskMetadata(taskId);
      if (existing !== undefined) {
        if (
          existing.workspaceId !== workspaceId ||
          existing.title !== title
        ) {
          throw persistenceError("aggregate_already_exists");
        }
        return existing;
      }
      const taskRow = this.#database
        .prepare("SELECT created_at_ms FROM tasks WHERE task_id = ?")
        .get(taskId);
      if (taskRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const createdAtMs = exactInteger(taskRow, "created_at_ms");
      const at = Math.max(createdAtMs, exactNow());
      this.#insertTaskMetadata({
        taskId,
        workspaceId,
        title,
        createdAtMs,
        at,
      });
      return this.#requiredTaskMetadata(taskId);
    });
  }

  createConversationTask(input: {
    readonly taskId: TaskId;
    readonly workspaceId: string;
    readonly title: string;
    readonly owningWindowId?: WindowId;
  }): CreateConversationTaskResult {
    const taskId = parsedTaskId(input.taskId);
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    const title = parsedTaskTitle(input.title);
    const owningWindowId = parsedWindowId(input.owningWindowId);
    return this.#immediate(() => {
      const existingTask = this.#database
        .prepare("SELECT owning_window_id FROM tasks WHERE task_id = ?")
        .get(taskId);
      if (existingTask !== undefined) {
        const storedWindowId = optionalText(existingTask, "owning_window_id");
        const metadata = this.#selectTaskMetadata(taskId);
        const sessionBinding = this.#selectSession(taskId)?.value;
        if (metadata === undefined || sessionBinding === undefined) {
          throw persistenceError("aggregate_integrity_failed");
        }
        if (
          storedWindowId !== owningWindowId ||
          metadata.workspaceId !== workspaceId ||
          metadata.title !== title
        ) {
          throw persistenceError("aggregate_already_exists");
        }
        return freeze({
          task: freeze({ taskId, owningWindowId }),
          metadata,
          sessionBinding,
          duplicate: true,
        });
      }
      const workspace = this.#requiredWorkspace(workspaceId);
      if (workspace.disposition !== "active") {
        throw persistenceError("domain_operation_rejected");
      }
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO tasks(task_id, owning_window_id, revision, created_at_ms, updated_at_ms)
          VALUES(?, ?, 1, ?, ?)
        `)
        .run(taskId, owningWindowId ?? null, at, at);
      this.#insertTaskMetadata({
        taskId,
        workspaceId,
        title,
        createdAtMs: at,
        at,
      });
      const sessionBinding = createUnboundBinding(taskId);
      const encoded = encodeSessionBinding(sessionBinding);
      this.#database
        .prepare(`
          INSERT INTO session_bindings(
            task_id, codec_version, snapshot_json, snapshot_sha256,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, 1, ?, ?, 1, ?, ?)
        `)
        .run(taskId, encoded.json, encoded.sha256, at, at);
      return freeze({
        task: freeze({ taskId, owningWindowId }),
        metadata: this.#requiredTaskMetadata(taskId),
        sessionBinding,
        duplicate: false,
      });
    });
  }

  loadTaskMetadata(taskIdInput: TaskId): TaskMetadataRecord {
    this.#assertOpen();
    return this.#requiredTaskMetadata(parsedTaskId(taskIdInput));
  }

  listTasks(input: {
    readonly workspaceId: string;
    readonly includeArchived?: boolean;
    readonly includeDeleted?: boolean;
  }): readonly TaskMetadataRecord[] {
    this.#assertOpen();
    const workspaceId = parsedWorkspaceId(input.workspaceId);
    this.#requiredWorkspace(workspaceId);
    const includeArchived = input.includeArchived === true;
    const includeDeleted = input.includeDeleted === true;
    if (
      input.includeArchived !== undefined &&
      typeof input.includeArchived !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    if (
      input.includeDeleted !== undefined &&
      typeof input.includeDeleted !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    const records = this.#database
      .prepare(`
        SELECT * FROM task_metadata
        WHERE workspace_id = ?
        ORDER BY pinned DESC, last_activity_at_ms DESC, title, task_id
      `)
      .all(workspaceId)
      .map((row) => this.#decodeTaskMetadataRow(row))
      .filter((task) =>
        task.disposition === "active" ||
        (task.disposition === "archived" && includeArchived) ||
        (task.disposition === "deleted" && includeDeleted)
      );
    return Object.freeze(records);
  }

  renameTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly title: string;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    const title = parsedTaskTitle(input.title);
    return this.#immediate(() => {
      const current = this.#requiredTaskMetadata(taskId);
      if (current.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (current.disposition !== "active") {
        throw persistenceError("domain_operation_rejected");
      }
      if (current.title === title) return current;
      const at = exactNow();
      const updated = this.#database
        .prepare(`
          UPDATE task_metadata
          SET title = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND revision = ? AND disposition = 'active'
        `)
        .run(title, at, taskId, expectedRevision);
      if (changes(updated.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredTaskMetadata(taskId);
    });
  }

  setTaskPinned(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly pinned: boolean;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    if (typeof input.pinned !== "boolean") {
      throw persistenceError("domain_operation_rejected");
    }
    return this.#immediate(() => {
      const current = this.#requiredTaskMetadata(taskId);
      if (current.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (current.disposition !== "active") {
        throw persistenceError("domain_operation_rejected");
      }
      if (current.pinned === input.pinned) return current;
      const at = exactNow();
      const updated = this.#database
        .prepare(`
          UPDATE task_metadata
          SET pinned = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND revision = ? AND disposition = 'active'
        `)
        .run(input.pinned ? 1 : 0, at, taskId, expectedRevision);
      if (changes(updated.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (input.pinned) this.#touchTaskActivity(taskId, at);
      return this.#requiredTaskMetadata(taskId);
    });
  }

  archiveTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setTaskDisposition(taskId, expectedRevision, "archived")
    );
  }

  unarchiveTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setTaskDisposition(taskId, expectedRevision, "active")
    );
  }

  deleteTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): TaskMetadataRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() =>
      this.#setTaskDisposition(taskId, expectedRevision, "deleted")
    );
  }

  commitAdapterEpoch(input: {
    readonly taskId: TaskId;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly expectedRevision: number;
    readonly status: PersistedAdapterEpochStatus;
  }): AdapterEpochRecord {
    const taskId = parsedTaskId(input.taskId);
    const sessionId = parsedSessionIdValue(input.sessionId);
    const adapterEpoch = parsedAdapterEpochValue(input.adapterEpoch);
    const expectedRevision = parsedRevision(input.expectedRevision, true);
    const status = parsedAdapterEpochStatus(input.status);
    return this.#immediate(() => {
      this.#requiredTaskMetadata(taskId);
      if (status === "alive") {
        const binding = this.#requiredSession(taskId).value;
        if (
          binding.state !== "healthy" ||
          binding.sessionId !== sessionId ||
          binding.retainedSessionId !== sessionId ||
          binding.adapterEpoch !== adapterEpoch
        ) {
          throw persistenceError("domain_operation_rejected");
        }
      }
      const existing = this.#selectAdapterEpoch(taskId, adapterEpoch);
      if (expectedRevision === 0) {
        if (existing !== undefined) {
          throw persistenceError("persistence_cas_conflict");
        }
        const current = this.#selectCurrentAdapterEpoch(taskId);
        if (current !== undefined) {
          throw persistenceError("aggregate_already_exists");
        }
        const at = exactNow();
        this.#database
          .prepare(`
            INSERT INTO adapter_epochs(
              task_id, adapter_epoch, session_id, status, is_current,
              revision, created_at_ms, updated_at_ms
            ) VALUES(?, ?, ?, ?, ?, 1, ?, ?)
          `)
          .run(
            taskId,
            adapterEpoch,
            sessionId,
            status,
            status === "exited" ? 0 : 1,
            at,
            at,
          );
        return this.#requiredAdapterEpoch(taskId, adapterEpoch);
      }
      if (
        existing === undefined ||
        existing.record.revision !== expectedRevision ||
        existing.record.sessionId !== sessionId
      ) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (existing.record.status === status) return existing.record;
      const at = exactNow();
      const update = this.#database
        .prepare(`
          UPDATE adapter_epochs
          SET status = ?, is_current = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND adapter_epoch = ? AND session_id = ? AND revision = ?
        `)
        .run(
          status,
          status === "exited" ? 0 : 1,
          at,
          taskId,
          adapterEpoch,
          sessionId,
          expectedRevision,
        );
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredAdapterEpoch(taskId, adapterEpoch);
    });
  }

  loadCurrentAdapterEpoch(taskIdInput: TaskId): AdapterEpochRecord | undefined {
    this.#assertOpen();
    return this.#selectCurrentAdapterEpoch(parsedTaskId(taskIdInput))?.record;
  }

  commitPromptAccepted(input: {
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly promptSequence: number;
    readonly idempotencyKey: IdempotencyKey;
    readonly durableNotices?: readonly PromptAcceptanceDurableNotice[];
  }): PromptAcceptanceResult {
    const taskId = parsedTaskId(input.taskId);
    const runId = parsedRunId(input.runId);
    const sessionId = parsedSessionIdValue(input.sessionId);
    const adapterEpoch = parsedAdapterEpochValue(input.adapterEpoch);
    const promptSequence = parsedPromptSequence(input.promptSequence);
    const idempotencyKey = parsedIdempotencyKey(input.idempotencyKey);
    const durableNotices = Object.freeze((input.durableNotices ?? []).map((notice) => {
      if (notice === null || typeof notice !== "object") {
        throw persistenceError("domain_operation_rejected");
      }
      return freeze({
        type: "create" as const,
        entryId: parsedEntryId(notice.entryId),
        kind: "notice" as const,
        text: parsedText(notice.text),
        metadata: encodeMetadata(notice.metadata).value,
        status: "complete" as const,
      });
    }));
    if (durableNotices.length > 2) throw persistenceError("domain_operation_rejected");
    const acceptanceFingerprint = sha256(JSON.stringify([
      taskId,
      runId,
      sessionId,
      adapterEpoch,
      promptSequence,
    ]));
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const epoch = this.#selectCurrentAdapterEpoch(taskId)?.record;
      if (
        epoch === undefined ||
        epoch.status !== "alive" ||
        epoch.sessionId !== sessionId ||
        epoch.adapterEpoch !== adapterEpoch
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const binding = this.#requiredSession(taskId).value;
      if (
        binding.state !== "healthy" ||
        binding.sessionId !== sessionId ||
        binding.retainedSessionId !== sessionId ||
        binding.adapterEpoch !== adapterEpoch
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const run = this.#requiredRun(taskId, runId);
      const existing = this.#selectPromptCorrelation(taskId, runId);
      if (existing !== undefined) {
        if (
          existing.record.sessionId !== sessionId ||
          existing.record.adapterEpoch !== adapterEpoch ||
          existing.record.promptSequence !== promptSequence ||
          exactText(existing.row, "acceptance_key") !== idempotencyKey ||
          exactText(existing.row, "acceptance_fingerprint") !== acceptanceFingerprint ||
          !run.value.promptAccepted
        ) {
          throw persistenceError("aggregate_already_exists");
        }
        const at = exactNow();
        for (const notice of durableNotices) {
          this.#ensureConversationEntryCreation(taskId, runId, notice, at);
        }
        return freeze({
          correlation: existing.record,
          run: run.value,
          duplicate: true,
        });
      }
      const accepted = applyRunEvent(run.value, {
        type: "prompt_accepted",
        sessionId,
        adapterEpoch,
        idempotencyKey,
      });
      if (!accepted.ok) {
        throw persistenceError("domain_operation_rejected");
      }
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO prompt_correlations(
            task_id, run_id, session_id, adapter_epoch, prompt_sequence,
            acceptance_key, acceptance_fingerprint, status,
            terminal_classification, terminal_key, final_commit_key,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 'accepted', NULL, NULL, NULL, 1, ?, ?)
        `)
        .run(
          taskId,
          runId,
          sessionId,
          adapterEpoch,
          promptSequence,
          idempotencyKey,
          acceptanceFingerprint,
          at,
          at,
        );
      this.#persistRun(run, accepted.run, at);
      for (const notice of durableNotices) {
        this.#ensureConversationEntryCreation(taskId, runId, notice, at);
      }
      return freeze({
        correlation: this.#requiredPromptCorrelation(taskId, runId).record,
        run: accepted.run,
        duplicate: false,
      });
    });
  }

  loadPromptCorrelation(
    taskIdInput: TaskId,
    runIdInput: RunId,
  ): PromptCorrelationRecord {
    this.#assertOpen();
    return this.#requiredPromptCorrelation(
      parsedTaskId(taskIdInput),
      parsedRunId(runIdInput),
    ).record;
  }

  commitLiveRuntimeEvent(input: {
    readonly event: RuntimeTurnEvent;
    readonly mutation: LiveConversationEntryMutation;
    readonly replayOrderMarker?: RuntimeReplayOrderMarker;
    readonly terminalFinalizationIdempotencyKey?: IdempotencyKey;
  }): LiveRuntimeEventCommitResult {
    const parsed = parseRuntimeTurnEvent(input.event);
    if (!parsed.ok) {
      return freeze({ ok: false, reason: "invalid_runtime_turn_event" });
    }
    const event = parsed.value;
    if (event.envelope.ingestMode !== "live") {
      return freeze({ ok: false, reason: "replay_not_supported" });
    }
    if (event.payload.type === "permission_request") {
      return freeze({ ok: false, reason: "permission_requires_dedicated_api" });
    }
    const mutation = this.#canonicalLiveMutation(input.mutation);
    const replayOrderMarker = input.replayOrderMarker === undefined
      ? undefined
      : freeze({
          type: "create" as const,
          entryId: parsedEntryId(input.replayOrderMarker.entryId),
          kind: "notice" as const,
          text: "Guild runtime replay order marker.",
          metadata: encodeMetadata({
            hidden: true,
            runtimeReplayOrderMarker: true,
            runtimeReplayOrderToken: boundedString(input.replayOrderMarker.token, 512),
          }).value,
          status: "complete" as const,
        });
    const terminalFinalizationIdempotencyKey =
      input.terminalFinalizationIdempotencyKey === undefined
        ? undefined
        : parsedIdempotencyKey(input.terminalFinalizationIdempotencyKey);
    if (
      event.payload.type === "prompt_terminal" &&
      event.payload.classification !== "cancelled" &&
      terminalFinalizationIdempotencyKey === undefined
    ) {
      return freeze({ ok: false, reason: "terminal_finalization_key_required" });
    }
    if (
      event.payload.type !== "prompt_terminal" &&
      terminalFinalizationIdempotencyKey !== undefined
    ) {
      return freeze({ ok: false, reason: "unexpected_terminal_finalization_key" });
    }
    return this.#immediate(() => {
      const taskId = event.envelope.taskId;
      const runId = event.envelope.runId;
      this.#requiredTaskMetadata(taskId);
      const run = this.#requiredRun(taskId, runId);
      const epoch = this.#selectCurrentAdapterEpoch(taskId)?.record;
      if (epoch === undefined) {
        return freeze({ ok: false, reason: "adapter_epoch_absent" });
      }
      if (epoch.status !== "alive") {
        return freeze({ ok: false, reason: "adapter_epoch_not_alive" });
      }
      const binding = this.#requiredSession(taskId).value;
      // Admission compares only this key. The task/key primary key also covers
      // old Runs and adapter epochs without rescanning the task's stream history.
      const committed = this.#database
        .prepare(`
          SELECT idempotency_key, fingerprint
          FROM committed_envelopes WHERE task_id = ? AND idempotency_key = ?
        `)
        .all(taskId, event.envelope.idempotencyKey)
        .map((row) => freeze({
          key: parsedIdempotencyKey(exactText(row, "idempotency_key") as IdempotencyKey),
          fingerprint: exactText(row, "fingerprint"),
        }));
      const sequenceRow = this.#database
        .prepare(`
          SELECT COALESCE(MAX(receive_sequence), 0) AS last_sequence
          FROM committed_envelopes WHERE task_id = ? AND adapter_epoch = ?
        `)
        .get(taskId, event.envelope.adapterEpoch);
      if (sequenceRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const authority = this.#requiredTaskAuthority(taskId);
      const admission = admitRuntimeTurnEvent(event, {
        binding,
        currentEpoch: epoch.adapterEpoch,
        epochStatus: epoch.status,
        committed,
        lastCommittedReceiveSequence: exactInteger(sequenceRow, "last_sequence"),
        run: run.value,
        authorizedWindowId: authority.owningWindowId,
        persistedOwningWindowId: authority.owningWindowId,
        pendingPermissionIdentities: run.value.unresolvedPermissionIdentities,
      });
      if (!admission.ok) {
        return freeze({ ok: false, reason: admission.reason });
      }
      if (admission.destination !== "live") {
        return freeze({ ok: false, reason: "unsupported_admission_destination" });
      }
      if (admission.duplicate) {
        return freeze({
          ok: true,
          duplicate: true,
          record: this.#selectConversationEntry(taskId, mutation.entryId)?.record,
          run: run.value,
        });
      }

      const correlation = this.#requiredPromptCorrelation(taskId, runId);
      if (
        correlation.record.sessionId !== event.envelope.sessionId ||
        correlation.record.adapterEpoch !== event.envelope.adapterEpoch ||
        correlation.record.status !== "accepted"
      ) {
        return freeze({ ok: false, reason: "prompt_correlation_mismatch" });
      }

      let nextRun = run.value;
      if (event.payload.type === "prompt_terminal") {
        const terminalEvent: RunEvent = event.payload.classification === "cancelled"
          ? {
              type: "runtime_confirms_cancellation",
              idempotencyKey: event.envelope.idempotencyKey,
            }
          : {
              type: "successful_terminal_response",
              idempotencyKey: event.envelope.idempotencyKey,
            };
        const terminal = applyRunEvent(nextRun, terminalEvent);
        if (!terminal.ok) {
          return freeze({ ok: false, reason: `run_${terminal.reason}` });
        }
        nextRun = terminal.run;
        if (event.payload.classification !== "cancelled") {
          const finalized = applyRunEvent(nextRun, {
            type: "final_commit_succeeded",
            idempotencyKey: terminalFinalizationIdempotencyKey as IdempotencyKey,
          });
          if (!finalized.ok) {
            return freeze({ ok: false, reason: `run_${finalized.reason}` });
          }
          nextRun = finalized.run;
        }
      }

      const expectedKind = this.#expectedEntryKind(event);
      const at = exactNow();
      const record = this.#applyLiveConversationMutation(
        taskId,
        runId,
        mutation,
        expectedKind,
        at,
      );
      if (replayOrderMarker !== undefined) {
        this.#ensureConversationEntryCreation(taskId, runId, replayOrderMarker, at);
      }
      if (event.payload.type === "prompt_terminal") {
        const correlationUpdate = this.#database
          .prepare(`
            UPDATE prompt_correlations
            SET status = 'terminal', terminal_classification = ?, terminal_key = ?,
                final_commit_key = ?, revision = revision + 1, updated_at_ms = ?
            WHERE task_id = ? AND run_id = ? AND revision = ? AND status = 'accepted'
          `)
          .run(
            event.payload.classification,
            event.envelope.idempotencyKey,
            terminalFinalizationIdempotencyKey ?? null,
            at,
            taskId,
            runId,
            correlation.record.revision,
          );
        if (changes(correlationUpdate.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
        this.#persistRun(run, nextRun, at);
      }
      const eventJson = JSON.stringify(event);
      this.#database
        .prepare(`
          INSERT INTO committed_envelopes(
            task_id, idempotency_key, fingerprint, adapter_epoch, ingest_mode,
            receive_sequence, event_json, event_sha256, committed_at_ms
          ) VALUES(?, ?, ?, ?, 'live', ?, ?, ?, ?)
        `)
        .run(
          taskId,
          event.envelope.idempotencyKey,
          envelopeFingerprint(event.envelope),
          event.envelope.adapterEpoch,
          event.envelope.receiveSequence,
          eventJson,
          sha256(eventJson),
          at,
        );
      return freeze({
        ok: true,
        duplicate: false,
        record,
        run: nextRun,
      });
    });
  }

  createConversationEntry(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly kind: ConversationEntryKind;
    readonly runId?: RunId;
    readonly text: string;
    readonly metadata?: ConversationEntryMetadata;
    readonly status: ConversationEntryStatus;
  }): ConversationEntryCreationResult {
    const taskId = parsedTaskId(input.taskId);
    const entryId = parsedEntryId(input.entryId);
    const kind = parsedEntryKind(input.kind);
    const runId = input.runId === undefined ? undefined : parsedRunId(input.runId);
    const text = parsedText(input.text);
    const metadata = encodeMetadata(input.metadata);
    const status = parsedEntryStatus(input.status);
    const fingerprint = entryInitialFingerprint({
      taskId,
      entryId,
      kind,
      runId,
      text,
      metadataJson: metadata.json,
      status,
    });
    return this.#immediate(() => {
      const existing = this.#selectConversationEntry(taskId, entryId);
      if (existing !== undefined) {
        const storedFingerprint = exactText(existing.row, "initial_fingerprint");
        if (storedFingerprint !== fingerprint) {
          throw persistenceError("aggregate_already_exists");
        }
        return freeze({ record: existing.record, duplicate: true });
      }
      this.#requireWritableConversationTask(taskId);
      if (runId !== undefined) this.#requiredRun(taskId, runId);
      const sequenceRow = this.#database
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS last_sequence
          FROM conversation_entries WHERE task_id = ?
        `)
        .get(taskId);
      if (sequenceRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const sequence = exactInteger(sequenceRow, "last_sequence") + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw persistenceError("persistence_cas_conflict");
      }
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO conversation_entries(
            task_id, entry_id, sequence, kind, run_id, text_content,
            metadata_json, metadata_sha256, initial_fingerprint, status,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .run(
          taskId,
          entryId,
          sequence,
          kind,
          runId ?? null,
          text,
          metadata.json,
          metadata.sha256,
          fingerprint,
          status,
          at,
          at,
        );
      if (kind === "user") this.#touchTaskActivity(taskId, at);
      return freeze({
        record: this.#requiredConversationEntry(taskId, entryId).record,
        duplicate: false,
      });
    });
  }

  appendConversationEntryText(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly expectedRevision: number;
    readonly text: string;
  }): ConversationEntryRecord {
    const taskId = parsedTaskId(input.taskId);
    const entryId = parsedEntryId(input.entryId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    const text = parsedAppendText(input.text);
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const loaded = this.#requiredConversationEntry(taskId, entryId);
      if (loaded.record.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (loaded.record.status !== "streaming") {
        throw persistenceError("domain_operation_rejected");
      }
      parsedText(loaded.record.text + text);
      const at = exactNow();
      const update = this.#database
        .prepare(`
          UPDATE conversation_entries
          SET text_content = text_content || ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND entry_id = ? AND revision = ? AND status = 'streaming'
        `)
        .run(text, at, taskId, entryId, expectedRevision);
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredConversationEntry(taskId, entryId).record;
    });
  }

  finalizeConversationEntry(input: {
    readonly taskId: TaskId;
    readonly entryId: string;
    readonly expectedRevision: number;
    readonly status: Exclude<ConversationEntryStatus, "streaming">;
  }): ConversationEntryRecord {
    const taskId = parsedTaskId(input.taskId);
    const entryId = parsedEntryId(input.entryId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    if (input.status !== "complete" && input.status !== "failed") {
      throw persistenceError("domain_operation_rejected");
    }
    return this.#immediate(() => {
      this.#requiredTaskMetadata(taskId);
      const loaded = this.#requiredConversationEntry(taskId, entryId);
      if (loaded.record.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (loaded.record.status === input.status) return loaded.record;
      if (loaded.record.status !== "streaming") {
        throw persistenceError("domain_operation_rejected");
      }
      const at = exactNow();
      const update = this.#database
        .prepare(`
          UPDATE conversation_entries
          SET status = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND entry_id = ? AND revision = ? AND status = 'streaming'
        `)
        .run(input.status, at, taskId, entryId, expectedRevision);
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredConversationEntry(taskId, entryId).record;
    });
  }

  loadConversationEntry(
    taskIdInput: TaskId,
    entryIdInput: string,
  ): ConversationEntryRecord {
    this.#assertOpen();
    return this.#requiredConversationEntry(
      parsedTaskId(taskIdInput),
      parsedEntryId(entryIdInput),
    ).record;
  }

  listConversationEntries(input: {
    readonly taskId: TaskId;
    readonly afterSequence?: number;
    readonly limit?: number;
  }): readonly ConversationEntryRecord[] {
    this.#assertOpen();
    const taskId = parsedTaskId(input.taskId);
    this.#requiredTaskMetadata(taskId);
    const afterSequence = input.afterSequence ?? 0;
    const limit = input.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE;
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_CONVERSATION_PAGE_SIZE
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    return Object.freeze(
      this.#database
        .prepare(`
          SELECT * FROM conversation_entries
          WHERE task_id = ? AND sequence > ?
          ORDER BY sequence
          LIMIT ?
        `)
        .all(taskId, afterSequence, limit)
        .map((row) => this.#decodeConversationEntryRow(row).record),
    );
  }

  enqueueQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
    readonly intendedSessionId: SessionId;
    readonly reservedRunId: RunId;
    readonly entryId: string;
    readonly text: string;
  }): QueuedTurnRecord {
    const taskId = parsedTaskId(input.taskId);
    const queueId = parsedEntryId(input.queueId);
    const intendedSessionId = parsedSessionIdValue(input.intendedSessionId);
    const reservedRunId = parsedRunId(input.reservedRunId);
    const entryId = parsedEntryId(input.entryId);
    const text = parsedText(input.text);
    if (text.trim().length === 0) {
      throw persistenceError("domain_operation_rejected");
    }
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const existing = this.#selectQueuedTurn(taskId, queueId);
      if (existing !== undefined) {
        if (
          existing.intendedSessionId !== intendedSessionId ||
          existing.reservedRunId !== reservedRunId ||
          existing.entryId !== entryId ||
          existing.text !== text
        ) {
          throw persistenceError("aggregate_already_exists");
        }
        return existing;
      }
      const binding = this.#requiredSession(taskId).value;
      if (binding.state !== "healthy" || binding.sessionId !== intendedSessionId) {
        throw persistenceError("domain_operation_rejected");
      }
      const current = this.#selectCurrentRun(taskId);
      if (current === undefined || isTerminalRunState(current.value.state)) {
        throw persistenceError("domain_operation_rejected");
      }
      const countRow = this.#database
        .prepare("SELECT COUNT(*) AS count FROM queued_turns WHERE task_id = ?")
        .get(taskId);
      if (
        countRow === undefined ||
        exactInteger(countRow, "count") >= MAX_QUEUED_TURNS_PER_TASK
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      if (
        this.#selectRun(taskId, reservedRunId) !== undefined ||
        this.#selectConversationEntry(taskId, entryId) !== undefined
      ) {
        throw persistenceError("aggregate_already_exists");
      }
      const latestQueuedAtRow = this.#database
        .prepare("SELECT MAX(created_at_ms) AS latest_created_at_ms FROM queued_turns WHERE task_id = ?")
        .get(taskId);
      if (latestQueuedAtRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const latestQueuedAt = optionalInteger(latestQueuedAtRow, "latest_created_at_ms");
      const at = Math.max(exactNow(), latestQueuedAt === undefined ? 0 : latestQueuedAt + 1);
      if (!Number.isSafeInteger(at)) {
        throw persistenceError("persistence_cas_conflict");
      }
      this.#database
        .prepare(`
          INSERT INTO queued_turns(
            task_id, queue_id, intended_session_id, reserved_run_id,
            entry_id, text_content, created_at_ms, priority
          ) VALUES(?, ?, ?, ?, ?, ?, ?, 0)
        `)
        .run(
          taskId,
          queueId,
          intendedSessionId,
          reservedRunId,
          entryId,
          text,
          at,
        );
      this.#touchTaskActivity(taskId, at);
      return this.#requiredQueuedTurn(taskId, queueId);
    });
  }

  listQueuedTurns(taskIdInput: TaskId): readonly QueuedTurnRecord[] {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    return Object.freeze(
      this.#database
        .prepare(`
          SELECT * FROM queued_turns
          WHERE task_id = ?
          ORDER BY priority DESC, created_at_ms, queue_id
        `)
        .all(taskId)
        .map((row) => this.#decodeQueuedTurnRow(row)),
    );
  }

  prioritizeQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
  }): void {
    const taskId = parsedTaskId(input.taskId);
    const queueId = parsedEntryId(input.queueId);
    this.#immediate(() => {
      const queued = this.#requiredQueuedTurn(taskId, queueId);
      const first = this.listQueuedTurns(taskId)[0];
      if (first?.queueId === queueId) return;
      const maxRow = this.#database
        .prepare("SELECT MAX(priority) AS priority FROM queued_turns WHERE task_id = ?")
        .get(taskId);
      const maxPriority = maxRow?.["priority"];
      if (
        typeof maxPriority !== "number" ||
        !Number.isSafeInteger(maxPriority) ||
        maxPriority < 0 ||
        maxPriority >= Number.MAX_SAFE_INTEGER
      ) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const updated = this.#database
        .prepare("UPDATE queued_turns SET priority = ? WHERE task_id = ? AND queue_id = ? AND priority = ?")
        .run(maxPriority + 1, taskId, queueId, queued.priority);
      if (changes(updated.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    });
  }

  cancelQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
  }): void {
    const taskId = parsedTaskId(input.taskId);
    const queueId = parsedEntryId(input.queueId);
    this.#immediate(() => {
      this.#requiredQueuedTurn(taskId, queueId);
      const removed = this.#database
        .prepare("DELETE FROM queued_turns WHERE task_id = ? AND queue_id = ?")
        .run(taskId, queueId);
      if (changes(removed.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    });
  }

  dispatchQueuedTurn(input: {
    readonly taskId: TaskId;
    readonly queueId: string;
    readonly sessionId: SessionId;
    readonly adapterEpoch: AdapterEpoch;
    readonly idempotencyKey: IdempotencyKey;
  }): QueuedTurnDispatchResult {
    const taskId = parsedTaskId(input.taskId);
    const queueId = parsedEntryId(input.queueId);
    const sessionId = parsedSessionIdValue(input.sessionId);
    const adapterEpoch = parsedAdapterEpochValue(input.adapterEpoch);
    const idempotencyKey = parsedIdempotencyKey(input.idempotencyKey);
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const queued = this.#requiredQueuedTurn(taskId, queueId);
      const firstRow = this.#database
        .prepare(`
          SELECT * FROM queued_turns
          WHERE task_id = ?
          ORDER BY priority DESC, created_at_ms, queue_id
          LIMIT 1
        `)
        .get(taskId);
      if (
        firstRow === undefined ||
        this.#decodeQueuedTurnRow(firstRow).queueId !== queueId ||
        queued.intendedSessionId !== sessionId
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const binding = this.#requiredSession(taskId).value;
      if (binding.state !== "healthy" || binding.sessionId !== sessionId) {
        throw persistenceError("domain_operation_rejected");
      }
      const current = this.#selectCurrentRun(taskId);
      if (current !== undefined && !isTerminalRunState(current.value.state)) {
        throw persistenceError("domain_operation_rejected");
      }
      if (
        this.#selectRun(taskId, queued.reservedRunId) !== undefined ||
        this.#selectConversationEntry(taskId, queued.entryId) !== undefined
      ) {
        throw persistenceError("aggregate_already_exists");
      }
      const dispatched = applyRunEvent(
        createQueuedRun({ taskId, runId: queued.reservedRunId }),
        {
          type: "scheduler_dispatch",
          sessionId,
          adapterEpoch,
          idempotencyKey,
        },
      );
      if (!dispatched.ok) {
        throw persistenceError("domain_operation_rejected");
      }
      const encodedRun = encodeRun(dispatched.run);
      const metadata = encodeMetadata(undefined);
      const fingerprint = entryInitialFingerprint({
        taskId,
        entryId: queued.entryId,
        kind: "user",
        runId: queued.reservedRunId,
        text: queued.text,
        metadataJson: metadata.json,
        status: "complete",
      });
      const sequenceRow = this.#database
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS last_sequence
          FROM conversation_entries WHERE task_id = ?
        `)
        .get(taskId);
      if (sequenceRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const sequence = exactInteger(sequenceRow, "last_sequence") + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw persistenceError("persistence_cas_conflict");
      }
      const at = exactNow();
      if (current !== undefined) {
        const retired = this.#database
          .prepare(`
            UPDATE runs
            SET is_current = 0, updated_at_ms = ?
            WHERE task_id = ? AND run_id = ? AND revision = ? AND is_current = 1
          `)
          .run(at, taskId, current.value.runId, current.revision);
        if (changes(retired.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
      this.#database
        .prepare(`
          INSERT INTO runs(
            task_id, run_id, codec_version, snapshot_json, snapshot_sha256,
            revision, is_current, created_at_ms, updated_at_ms
          ) VALUES(?, ?, 1, ?, ?, 1, 1, ?, ?)
        `)
        .run(
          taskId,
          queued.reservedRunId,
          encodedRun.json,
          encodedRun.sha256,
          at,
          at,
        );
      this.#database
        .prepare(`
          INSERT INTO conversation_entries(
            task_id, entry_id, sequence, kind, run_id, text_content,
            metadata_json, metadata_sha256, initial_fingerprint, status,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, ?, ?, 'user', ?, ?, ?, ?, ?, 'complete', 1, ?, ?)
        `)
        .run(
          taskId,
          queued.entryId,
          sequence,
          queued.reservedRunId,
          queued.text,
          metadata.json,
          metadata.sha256,
          fingerprint,
          at,
          at,
        );
      const removed = this.#database
        .prepare("DELETE FROM queued_turns WHERE task_id = ? AND queue_id = ?")
        .run(taskId, queueId);
      if (changes(removed.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return freeze({
        run: dispatched.run,
        entry: this.#requiredConversationEntry(taskId, queued.entryId).record,
      });
    });
  }

  startContinuousTask(input: {
    readonly taskId: TaskId;
    readonly objective: string;
  }): ContinuousTaskRecord {
    const taskId = parsedTaskId(input.taskId);
    const objective = parsedText(input.objective).trim();
    if (objective.length === 0) throw persistenceError("domain_operation_rejected");
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const existing = this.#selectContinuousTask(taskId);
      if (existing !== undefined && (existing.status === "active" || existing.status === "paused")) {
        throw persistenceError("aggregate_already_exists");
      }
      const at = exactNow();
      if (existing === undefined) {
        this.#database.prepare(`
          INSERT INTO continuous_tasks(
            task_id, objective, status, phase, cycle, last_run_id,
            summary, remaining, stop_reason, consecutive_no_progress,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, ?, 'active', 'work', 1, NULL, NULL, NULL, NULL, 0, 1, ?, ?)
        `).run(taskId, objective, at, at);
      } else {
        const updated = this.#database.prepare(`
          UPDATE continuous_tasks
          SET objective = ?, status = 'active', phase = 'work', cycle = 1,
              last_run_id = NULL, summary = NULL, remaining = NULL,
              stop_reason = NULL, consecutive_no_progress = 0,
              revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND revision = ?
        `).run(objective, at, taskId, existing.revision);
        if (changes(updated.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
      return this.#requiredContinuousTask(taskId);
    });
  }

  loadContinuousTask(taskIdInput: TaskId): ContinuousTaskRecord | undefined {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    return this.#selectContinuousTask(taskId);
  }

  updateContinuousTask(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly status?: ContinuousTaskStatus;
    readonly phase?: ContinuousTaskPhase;
    readonly cycle?: number;
    readonly lastRunId?: RunId | null;
    readonly summary?: string | null;
    readonly remaining?: string | null;
    readonly stopReason?: string | null;
    readonly consecutiveNoProgress?: number;
  }): ContinuousTaskRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    return this.#immediate(() => {
      const current = this.#requiredContinuousTask(taskId);
      if (current.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      const status = input.status === undefined
        ? current.status
        : parsedContinuousTaskStatus(input.status);
      const phase = input.phase === undefined
        ? current.phase
        : parsedContinuousTaskPhase(input.phase);
      const cycle = input.cycle ?? current.cycle;
      const consecutiveNoProgress = input.consecutiveNoProgress ?? current.consecutiveNoProgress;
      if (!Number.isSafeInteger(cycle) || cycle < 1 ||
          !Number.isSafeInteger(consecutiveNoProgress) || consecutiveNoProgress < 0) {
        throw persistenceError("domain_operation_rejected");
      }
      const lastRunId = input.lastRunId === undefined
        ? current.lastRunId
        : input.lastRunId === null ? undefined : parsedRunId(input.lastRunId);
      const summary = input.summary === undefined
        ? current.summary
        : input.summary === null ? undefined : parsedText(input.summary);
      const remaining = input.remaining === undefined
        ? current.remaining
        : input.remaining === null ? undefined : parsedText(input.remaining);
      const stopReason = input.stopReason === undefined
        ? current.stopReason
        : input.stopReason === null ? undefined : parsedText(input.stopReason);
      const at = exactNow();
      const updated = this.#database.prepare(`
        UPDATE continuous_tasks
        SET status = ?, phase = ?, cycle = ?, last_run_id = ?, summary = ?,
            remaining = ?, stop_reason = ?, consecutive_no_progress = ?,
            revision = revision + 1, updated_at_ms = ?
        WHERE task_id = ? AND revision = ?
      `).run(
        status,
        phase,
        cycle,
        lastRunId ?? null,
        summary ?? null,
        remaining ?? null,
        stopReason ?? null,
        consecutiveNoProgress,
        at,
        taskId,
        expectedRevision,
      );
      if (changes(updated.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredContinuousTask(taskId);
    });
  }

  saveDraft(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
    readonly text: string;
  }): DraftRecord {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision, true);
    const text = parsedText(input.text);
    return this.#immediate(() => {
      this.#requireWritableConversationTask(taskId);
      const existing = this.#selectDraft(taskId);
      if (expectedRevision === 0) {
        if (existing !== undefined) {
          throw persistenceError("persistence_cas_conflict");
        }
        const at = exactNow();
        this.#database
          .prepare(`
            INSERT INTO drafts(task_id, text_content, revision, created_at_ms, updated_at_ms)
            VALUES(?, ?, 1, ?, ?)
          `)
          .run(taskId, text, at, at);
        return this.#requiredDraft(taskId);
      }
      if (existing === undefined || existing.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (existing.text === text) return existing;
      const at = exactNow();
      const update = this.#database
        .prepare(`
          UPDATE drafts
          SET text_content = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND revision = ?
        `)
        .run(text, at, taskId, expectedRevision);
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredDraft(taskId);
    });
  }

  loadDraft(taskIdInput: TaskId): DraftRecord | undefined {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    this.#requiredTaskMetadata(taskId);
    return this.#selectDraft(taskId);
  }

  clearDraft(input: {
    readonly taskId: TaskId;
    readonly expectedRevision: number;
  }): void {
    const taskId = parsedTaskId(input.taskId);
    const expectedRevision = parsedRevision(input.expectedRevision);
    this.#immediate(() => {
      this.#requiredTaskMetadata(taskId);
      const cleared = this.#database
        .prepare("DELETE FROM drafts WHERE task_id = ? AND revision = ?")
        .run(taskId, expectedRevision);
      if (changes(cleared.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    });
  }

  loadAppSettings(): AppSettingsRecord {
    this.#assertOpen();
    return this.#requiredAppSettings();
  }

  updateAppSettings(input: {
    readonly expectedRevision: number;
    readonly locale?: GuildLocale;
    readonly grokModel?: GuildGrokModel;
    readonly reasoningEffort?: GuildGrokReasoningEffort;
    readonly permissionMode?: GuildGrokPermissionMode;
    readonly startup?: GuildGrokStartupSettings;
    readonly sidebarWidth?: number;
    readonly browserSyncEnabled?: boolean;
    readonly nickname?: string;
    readonly avatarFilename?: string | null;
    readonly restoreLastTask?: boolean;
    readonly newTaskWorkspaceMode?: GuildNewTaskWorkspaceMode;
    readonly taskNotificationsEnabled?: boolean;
    readonly lastActiveTaskId?: TaskId | null;
    readonly lastWorkspaceId?: string | null;
  }): AppSettingsRecord {
    const expectedRevision = parsedRevision(input.expectedRevision);
    const locale = input.locale === undefined ? undefined : parsedLocale(input.locale);
    const grokModel = input.grokModel === undefined
      ? undefined
      : parseGuildGrokModel(input.grokModel);
    const reasoningEffort = input.reasoningEffort === undefined
      ? undefined
      : parseGuildGrokReasoningEffort(input.reasoningEffort);
    const permissionMode = input.permissionMode === undefined
      ? undefined
      : parseGuildGrokPermissionMode(input.permissionMode);
    const startup = input.startup === undefined
      ? undefined
      : parseGuildGrokStartupSettings(input.startup);
    const sidebarWidth = input.sidebarWidth === undefined
      ? undefined
      : parsedSidebarWidth(input.sidebarWidth);
    if (
      input.browserSyncEnabled !== undefined &&
      typeof input.browserSyncEnabled !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    if (
      input.restoreLastTask !== undefined &&
      typeof input.restoreLastTask !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    if (
      input.taskNotificationsEnabled !== undefined &&
      typeof input.taskNotificationsEnabled !== "boolean"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    let nickname: string | undefined;
    try {
      nickname = input.nickname === undefined
        ? undefined
        : parseGuildNickname(input.nickname);
    } catch (cause: unknown) {
      throw persistenceError("domain_operation_rejected", cause);
    }
    const avatarFilename = input.avatarFilename === undefined
      ? undefined
      : parsedAvatarFilename(input.avatarFilename);
    const avatarProvided = input.avatarFilename !== undefined;
    let newTaskWorkspaceMode: GuildNewTaskWorkspaceMode | undefined;
    try {
      newTaskWorkspaceMode = input.newTaskWorkspaceMode === undefined
        ? undefined
        : parseGuildNewTaskWorkspaceMode(input.newTaskWorkspaceMode);
    } catch (cause: unknown) {
      throw persistenceError("domain_operation_rejected", cause);
    }
    const lastActiveTaskId = input.lastActiveTaskId === undefined
      ? undefined
      : parsedOptionalId(input.lastActiveTaskId);
    const lastWorkspaceId = input.lastWorkspaceId === undefined
      ? undefined
      : parsedOptionalId(input.lastWorkspaceId);
    return this.#immediate(() => {
      const current = this.#requiredAppSettings();
      if (current.revision !== expectedRevision) {
        throw persistenceError("persistence_cas_conflict");
      }
      const next = freeze({
        locale: locale ?? current.locale,
        grokModel: grokModel ?? current.grokModel,
        reasoningEffort: reasoningEffort ?? current.reasoningEffort,
        permissionMode: permissionMode ?? current.permissionMode,
        startup: startup ?? current.startup,
        sidebarWidth: sidebarWidth ?? current.sidebarWidth,
        browserSyncEnabled:
          input.browserSyncEnabled ?? current.browserSyncEnabled,
        nickname: nickname ?? current.nickname,
        avatarFilename: avatarProvided ? avatarFilename : current.avatarFilename,
        restoreLastTask: input.restoreLastTask ?? current.restoreLastTask,
        newTaskWorkspaceMode: newTaskWorkspaceMode ?? current.newTaskWorkspaceMode,
        taskNotificationsEnabled:
          input.taskNotificationsEnabled ?? current.taskNotificationsEnabled,
        lastActiveTaskId: lastActiveTaskId === undefined
          ? current.lastActiveTaskId
          : lastActiveTaskId,
        lastWorkspaceId: lastWorkspaceId === undefined
          ? current.lastWorkspaceId
          : lastWorkspaceId,
      });
      if (!supportsGuildGrokReasoningEffort(next.grokModel, next.reasoningEffort)) {
        throw persistenceError("domain_operation_rejected");
      }
      if (
        next.locale === current.locale &&
        next.grokModel === current.grokModel &&
        next.reasoningEffort === current.reasoningEffort &&
        next.permissionMode === current.permissionMode &&
        next.startup.webSearchEnabled === current.startup.webSearchEnabled &&
        next.startup.planEnabled === current.startup.planEnabled &&
        next.startup.subagentsEnabled === current.startup.subagentsEnabled &&
        next.startup.maxTurns === current.startup.maxTurns &&
        next.sidebarWidth === current.sidebarWidth &&
        next.browserSyncEnabled === current.browserSyncEnabled &&
        next.nickname === current.nickname &&
        next.avatarFilename === current.avatarFilename &&
        next.restoreLastTask === current.restoreLastTask &&
        next.newTaskWorkspaceMode === current.newTaskWorkspaceMode &&
        next.taskNotificationsEnabled === current.taskNotificationsEnabled &&
        next.lastActiveTaskId === current.lastActiveTaskId &&
        next.lastWorkspaceId === current.lastWorkspaceId
      ) {
        return current;
      }
      const at = exactNow();
      const update = this.#database
        .prepare(`
          UPDATE app_settings
          SET locale = ?, grok_model = ?, reasoning_effort = ?, permission_mode = ?,
              web_search_enabled = ?, plan_enabled = ?, subagents_enabled = ?, max_turns = ?,
              sidebar_width = ?, browser_sync_enabled = ?,
              nickname = ?, avatar_filename = ?, restore_last_task = ?,
              new_task_workspace_mode = ?, task_notifications_enabled = ?, last_active_task_id = ?,
              last_workspace_id = ?,
              revision = revision + 1, updated_at_ms = ?
          WHERE singleton = 1 AND revision = ?
        `)
        .run(
          next.locale,
          next.grokModel,
          next.reasoningEffort,
          next.permissionMode,
          next.startup.webSearchEnabled ? 1 : 0,
          next.startup.planEnabled ? 1 : 0,
          next.startup.subagentsEnabled ? 1 : 0,
          next.startup.maxTurns,
          next.sidebarWidth,
          next.browserSyncEnabled ? 1 : 0,
          next.nickname,
          next.avatarFilename ?? null,
          next.restoreLastTask ? 1 : 0,
          next.newTaskWorkspaceMode,
          next.taskNotificationsEnabled ? 1 : 0,
          next.lastActiveTaskId ?? null,
          next.lastWorkspaceId ?? null,
          at,
          expectedRevision,
        );
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return this.#requiredAppSettings();
    });
  }

  createRun(input: { readonly taskId: TaskId; readonly runId: RunId }): RunRecord {
    const taskId = parsedTaskId(input.taskId);
    const runId = parsedRunId(input.runId);
    return this.#immediate(() => {
      this.#requireTask(taskId);
      const existing = this.#selectRun(taskId, runId);
      if (existing !== undefined) {
        const current = this.#selectCurrentRun(taskId);
        if (current?.value.runId !== runId) {
          throw persistenceError("aggregate_already_exists");
        }
        return existing.value;
      }
      const current = this.#selectCurrentRun(taskId);
      if (current !== undefined && !isTerminalRunState(current.value.state)) {
        throw persistenceError("aggregate_already_exists");
      }
      const run = createQueuedRun({ taskId, runId });
      const encoded = encodeRun(run);
      const at = exactNow();
      if (current !== undefined) {
        const retired = this.#database
          .prepare(`
            UPDATE runs
            SET is_current = 0, updated_at_ms = ?
            WHERE task_id = ? AND run_id = ? AND revision = ? AND is_current = 1
          `)
          .run(
            at,
            taskId,
            current.value.runId,
            current.revision,
          );
        if (changes(retired.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
      this.#database
        .prepare(`
          INSERT INTO runs(
            task_id, run_id, codec_version, snapshot_json, snapshot_sha256,
            revision, is_current, created_at_ms, updated_at_ms
          ) VALUES(?, ?, 1, ?, ?, 1, 1, ?, ?)
        `)
        .run(taskId, runId, encoded.json, encoded.sha256, at, at);
      return run;
    });
  }

  applyRun(input: {
    readonly taskId: TaskId;
    readonly runId: RunId;
    readonly event: RunEvent;
  }): RunApplyResult {
    const taskId = parsedTaskId(input.taskId);
    const runId = parsedRunId(input.runId);
    if (isCoupledPermissionRunEvent(input.event)) {
      throw persistenceError("domain_operation_rejected");
    }
    return this.#immediate(() => {
      const loaded = this.#requiredRun(taskId, runId);
      const result = applyRunEvent(loaded.value, input.event);
      const removedPermissions = loaded.value.unresolvedPermissionIdentities.filter(
        (identity) =>
          !result.run.unresolvedPermissionIdentities.some((candidate) =>
            permissionIdentitiesEqual(candidate, identity),
          ),
      );
      const permissionsToClose = [...removedPermissions];
      if (result.ok && isTerminalRunState(result.run.state)) {
        for (const identity of this.#inFlightPermissionIdentitiesForRun(
          taskId,
          runId,
        )) {
          if (
            !permissionsToClose.some((candidate) =>
              permissionIdentitiesEqual(candidate, identity)
            )
          ) {
            permissionsToClose.push(identity);
          }
        }
      }
      const at = exactNow();
      for (const identity of permissionsToClose) {
        this.#closePermissionForRunTransition(identity, at);
      }
      this.#persistRun(loaded, result.run, at);
      return result;
    });
  }

  loadRun(taskIdInput: TaskId, runIdInput: RunId): RunRecord {
    this.#assertOpen();
    return this.#requiredRun(
      parsedTaskId(taskIdInput),
      parsedRunId(runIdInput),
    ).value;
  }

  createSessionBinding(taskIdInput: TaskId): SessionBindingRecord {
    const taskId = parsedTaskId(taskIdInput);
    return this.#immediate(() => {
      this.#requireTask(taskId);
      const existing = this.#selectSession(taskId);
      if (existing !== undefined) return existing.value;
      const binding = createUnboundBinding(taskId);
      const encoded = encodeSessionBinding(binding);
      const at = exactNow();
      this.#database
        .prepare(`
          INSERT INTO session_bindings(
            task_id, codec_version, snapshot_json, snapshot_sha256,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, 1, ?, ?, 1, ?, ?)
        `)
        .run(taskId, encoded.json, encoded.sha256, at, at);
      return binding;
    });
  }

  applySessionBinding(input: {
    readonly taskId: TaskId;
    readonly event: SessionBindingEvent;
  }): SessionBindingResult {
    const taskId = parsedTaskId(input.taskId);
    return this.#immediate(() => {
      const loaded = this.#requiredSession(taskId);
      const result = applySessionBindingEvent(loaded.value, input.event);
      const encoded = encodeSessionBinding(result.binding);
      if (encoded.json !== loaded.json) {
        const at = exactNow();
        const update = this.#database
          .prepare(`
            UPDATE session_bindings
            SET snapshot_json = ?, snapshot_sha256 = ?, revision = revision + 1, updated_at_ms = ?
            WHERE task_id = ? AND revision = ?
          `)
          .run(encoded.json, encoded.sha256, at, taskId, loaded.revision);
        if (changes(update.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
      return result;
    });
  }

  loadSessionBinding(taskIdInput: TaskId): SessionBindingRecord {
    this.#assertOpen();
    return this.#requiredSession(parsedTaskId(taskIdInput)).value;
  }

  registerPermission(
    input: PendingPermissionRegistrationInput,
  ): PermissionRegistrationResult {
    const identity = parsedIdentity(input.identity);
    const runIdempotencyKey = parsedIdempotencyKey(input.runIdempotencyKey);
    if (
      Object.hasOwn(input, "mode") ||
      Object.hasOwn(input, "transportCanReceive") ||
      Object.hasOwn(input, "commandId") ||
      Object.hasOwn(input, "deliveryAttemptId")
    ) {
      return freeze({
        ok: false,
        record: undefined,
        reason: "invalid_pending_permission_registration",
      });
    }
    return this.#immediate(() => {
      const run = this.#requiredRun(identity.taskId, identity.runId);
      if (run.value.state !== "running" && run.value.state !== "awaiting_permission") {
        return freeze({
          ok: false,
          record: undefined,
          reason: "run_requires_safe_cancel_registration",
        });
      }
      const admitted = applyRunEvent(run.value, {
        type: "permission_admitted",
        identity,
        idempotencyKey: runIdempotencyKey,
      });
      if (!admitted.ok) {
        return freeze({
          ok: false,
          record: undefined,
          reason: `run_${admitted.reason}`,
        });
      }
      const candidates = this.#registrationCandidates(identity, input.idempotencyKey);
      const result = registerPermissionRequest(
        candidates.map((candidate) => candidate.value),
        {
          identity,
          request: input.request,
          idempotencyKey: input.idempotencyKey,
          mode: "pending",
          transportCanReceive: false,
        },
      );
      if (!result.ok) return this.#registrationFailure(result);
      this.#persistRun(run, admitted.run);
      if (result.duplicate) {
        return freeze({ ok: true, record: result.record, duplicate: true });
      }
      this.#insertPermission(result.record);
      return freeze({ ok: true, record: result.record, duplicate: false });
    });
  }

  registerSafeCancelPermissionAndClaim(
    input: SafeCancelPermissionRegistrationAndClaimInput,
  ): SafeCancelPermissionRegistrationAndClaimResult {
    const identity = parsedIdentity(input.identity);
    const runIdempotencyKey = parsedIdempotencyKey(input.runIdempotencyKey);
    return this.#immediate(() => {
      const run = this.#requiredRun(identity.taskId, identity.runId);
      if (run.value.state !== "cancel_requested") {
        return freeze({
          ok: false,
          record: undefined,
          reason: "run_not_cancel_requested",
        });
      }
      const admitted = applyRunEvent(run.value, {
        type: "permission_admitted",
        identity,
        idempotencyKey: runIdempotencyKey,
      });
      if (!admitted.ok) {
        return freeze({
          ok: false,
          record: undefined,
          reason: `run_${admitted.reason}`,
        });
      }
      const candidates = this.#registrationCandidates(
        identity,
        input.idempotencyKey,
      );
      const registered = registerPermissionRequest(
        candidates.map((candidate) => candidate.value),
        {
          identity,
          request: input.request,
          idempotencyKey: input.idempotencyKey,
          mode: "run_cancel_requested",
          transportCanReceive: true,
          commandId: input.commandId,
        },
      );
      if (!registered.ok) return this.#decisionFailure(registered);
      const pendingOutbox = registered.record.outbox;
      if (
        pendingOutbox === undefined ||
        pendingOutbox.commandId !== input.commandId ||
        registered.record.decisionCommit?.commandId !== input.commandId ||
        registered.record.decisionCommit?.outboxVersion !== pendingOutbox.version
      ) {
        return freeze({
          ok: false,
          record: registered.record,
          reason: "outbox_cas_mismatch",
        });
      }
      const claimed = applyPermissionEvent([registered.record], {
        type: "request_outbox_delivery",
        identity,
        commandId: input.commandId,
        version: pendingOutbox.version,
        deliveryAttemptId: input.deliveryAttemptId,
      });
      if (!claimed.ok) return this.#decisionFailure(claimed);
      if (claimed.duplicate) {
        this.#persistRun(run, admitted.run);
        return freeze({
          ok: true,
          record: claimed.record,
          duplicate: true,
          writeClaim: undefined,
        });
      }
      if (
        claimed.sideEffect !== "request_one_upstream_write" ||
        claimed.record.outbox?.lifecycle !== "in_flight"
      ) {
        throw persistenceError("domain_operation_rejected");
      }

      const at = exactNow();
      this.#persistRun(run, admitted.run, at);
      let permissionRevision: number;
      let incrementRevision: 0 | 1;
      if (registered.duplicate) {
        const existing = this.#requiredPermission(identity);
        if (existing.json !== encodePermission(registered.record).json) {
          throw persistenceError("aggregate_integrity_failed");
        }
        permissionRevision = existing.revision;
        incrementRevision = 1;
      } else {
        this.#insertPermission(registered.record, at);
        permissionRevision = 1;
        incrementRevision = 0;
      }
      const outboxClaim = this.#database
        .prepare(`
          UPDATE permission_outbox
          SET lifecycle = 'in_flight', delivery_attempt_id = ?, updated_at_ms = ?
          WHERE command_id = ? AND version = ? AND lifecycle = 'pending'
            AND delivery_attempt_id IS NULL
        `)
        .run(
          input.deliveryAttemptId,
          at,
          pendingOutbox.commandId,
          pendingOutbox.version,
        );
      if (changes(outboxClaim.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      const claimedEncoded = encodePermission(claimed.record);
      const finalSnapshot = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?,
              revision = revision + ?, updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ? AND revision = ?
            AND decision_command_id = ? AND decision_outbox_version = ?
        `)
        .run(
          claimedEncoded.json,
          claimedEncoded.sha256,
          incrementRevision,
          at,
          ...identityBindings(identity),
          permissionRevision,
          pendingOutbox.commandId,
          pendingOutbox.version,
        );
      if (changes(finalSnapshot.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return freeze({
        ok: true,
        record: claimed.record,
        duplicate: false,
        writeClaim: freeze({
          commandId: pendingOutbox.commandId,
          version: pendingOutbox.version,
          deliveryAttemptId: input.deliveryAttemptId,
          command: pendingOutbox.command,
        }),
      });
    });
  }

  loadPermission(identityInput: PermissionIdentity): PermissionRecord {
    this.#assertOpen();
    return this.#requiredPermission(parsedIdentity(identityInput)).value;
  }

  decidePermissionAndClaim(input: {
    readonly identity: PermissionIdentity;
    readonly callbackRequestId: JsonRpcCallbackId;
    readonly outcome: PermissionResolutionInput;
    readonly commandId: PermissionOutboxCommandId;
    readonly deliveryAttemptId: PermissionDeliveryAttemptId;
  }): PermissionDecisionAndClaimResult {
    const identity = parsedIdentity(input.identity);
    return this.#immediate(() => {
      const loaded = this.#requiredPermission(identity);
      if (loaded.value.state === "pending") {
        const current = this.#selectCurrentRun(identity.taskId);
        const ownsPendingPermission =
          current?.value.runId === identity.runId &&
          current.value.state === "awaiting_permission" &&
          current.value.unresolvedPermissionIdentities.some((candidate) =>
            permissionIdentitiesEqual(candidate, identity),
          );
        if (!ownsPendingPermission) {
          return freeze({
            ok: false,
            record: loaded.value,
            reason: "run_not_authoritative_for_permission",
          });
        }
      }
      const resolved = applyPermissionEvent([loaded.value], {
        type: "resolve",
        identity,
        callbackRequestId: input.callbackRequestId,
        outcome: input.outcome,
        commandId: input.commandId,
      });
      if (!resolved.ok) return this.#decisionFailure(resolved);
      if (resolved.duplicate) {
        return freeze({
          ok: true,
          record: resolved.record,
          duplicate: true,
          writeClaim: undefined,
        });
      }
      const pendingOutbox = resolved.record.outbox;
      const decisionCommit = resolved.record.decisionCommit;
      if (
        pendingOutbox === undefined ||
        pendingOutbox.lifecycle !== "pending" ||
        decisionCommit === undefined ||
        decisionCommit.commandId !== pendingOutbox.commandId ||
        decisionCommit.outboxVersion !== pendingOutbox.version
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const resolvedEncoded = encodePermission(resolved.record);
      const commitEncoded = encodeDecisionCommit(decisionCommit);
      const at = exactNow();
      const cas = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?,
              decision_commit_json = ?, decision_commit_sha256 = ?,
              decision_command_id = ?, decision_outbox_version = ?,
              revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ?
            AND revision = ? AND decision_commit_json IS NULL
        `)
        .run(
          resolvedEncoded.json,
          resolvedEncoded.sha256,
          commitEncoded.json,
          commitEncoded.sha256,
          pendingOutbox.commandId,
          pendingOutbox.version,
          at,
          ...identityBindings(identity),
          loaded.revision,
        );
      if (changes(cas.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      this.#insertOutbox(identity, pendingOutbox, at);

      const claimed = applyPermissionEvent([resolved.record], {
        type: "request_outbox_delivery",
        identity,
        commandId: pendingOutbox.commandId,
        version: pendingOutbox.version,
        deliveryAttemptId: input.deliveryAttemptId,
      });
      if (
        !claimed.ok ||
        claimed.duplicate ||
        claimed.sideEffect !== "request_one_upstream_write" ||
        claimed.record.outbox?.lifecycle !== "in_flight"
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const outboxClaim = this.#database
        .prepare(`
          UPDATE permission_outbox
          SET lifecycle = 'in_flight', delivery_attempt_id = ?, updated_at_ms = ?
          WHERE command_id = ? AND version = ? AND lifecycle = 'pending'
            AND delivery_attempt_id IS NULL
        `)
        .run(
          input.deliveryAttemptId,
          at,
          pendingOutbox.commandId,
          pendingOutbox.version,
        );
      if (changes(outboxClaim.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      const claimedEncoded = encodePermission(claimed.record);
      const finalSnapshot = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?, updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ?
            AND revision = ? AND decision_commit_json = ?
              AND decision_commit_sha256 = ? AND decision_command_id = ?
              AND decision_outbox_version = ?
        `)
        .run(
          claimedEncoded.json,
          claimedEncoded.sha256,
          at,
          ...identityBindings(identity),
          loaded.revision + 1,
          commitEncoded.json,
          commitEncoded.sha256,
          pendingOutbox.commandId,
          pendingOutbox.version,
        );
      if (changes(finalSnapshot.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return freeze({
        ok: true,
        record: claimed.record,
        duplicate: false,
        writeClaim: freeze({
          commandId: pendingOutbox.commandId,
          version: pendingOutbox.version,
          deliveryAttemptId: input.deliveryAttemptId,
          command: pendingOutbox.command,
        }),
      });
    });
  }

  settlePermissionAutomaticallyAndMaybeClaim(
    input: AutomaticPermissionSettlementInput,
  ): AutomaticPermissionSettlementResult {
    const identity = parsedIdentity(input.identity);
    const runResolutionIdempotencyKey = parsedIdempotencyKey(
      input.runResolutionIdempotencyKey,
    );
    if (
      input.type !== "deadline_passed" &&
      (input.type !== "orphan" ||
        (input.cause !== "window_closed" &&
          input.cause !== "window_reloaded" &&
          input.cause !== "run_cancel_requested"))
    ) {
      return freeze({
        ok: false,
        record: undefined,
        reason: "invalid_automatic_permission_settlement",
      });
    }
    return this.#immediate(() => {
      const loaded = this.#requiredPermission(identity);
      if (loaded.value.registrationMode !== "pending") {
        return freeze({
          ok: false,
          record: loaded.value,
          reason: "registration_mode_mismatch",
        });
      }

      let owningRun: Loaded<RunRecord> | undefined;
      if (loaded.value.state === "pending") {
        const current = this.#selectCurrentRun(identity.taskId);
        const unresolved =
          current?.value.runId === identity.runId &&
          current.value.unresolvedPermissionIdentities.some((candidate) =>
            permissionIdentitiesEqual(candidate, identity),
          );
        const stateAllowsSettlement =
          current?.value.state === "awaiting_permission" ||
          (current?.value.state === "cancel_requested" &&
            input.type === "orphan" &&
            input.cause === "run_cancel_requested");
        if (!unresolved || !stateAllowsSettlement || current === undefined) {
          return freeze({
            ok: false,
            record: loaded.value,
            reason: "run_not_authoritative_for_permission",
          });
        }
        owningRun = current;
      }

      const settled = applyPermissionEvent(
        [loaded.value],
        input.type === "deadline_passed"
          ? {
              type: "deadline_passed",
              identity,
              transportCanReceive: input.transportCanReceive,
              ...(input.transportCanReceive
                ? { commandId: input.commandId }
                : {}),
            }
          : {
              type: "orphan",
              identity,
              cause: input.cause,
              transportCanReceive: input.transportCanReceive,
              ...(input.transportCanReceive
                ? { commandId: input.commandId }
                : {}),
            },
      );
      if (!settled.ok) return this.#decisionFailure(settled);
      if (settled.duplicate) {
        return freeze({
          ok: true,
          record: settled.record,
          duplicate: true,
          writeClaim: undefined,
        });
      }

      let finalRecord = settled.record;
      let writeClaim: PermissionWriteClaim | undefined;
      const pendingOutbox = settled.record.outbox;
      if (input.transportCanReceive) {
        if (
          pendingOutbox === undefined ||
          pendingOutbox.lifecycle !== "pending" ||
          input.deliveryAttemptId === undefined
        ) {
          throw persistenceError("domain_operation_rejected");
        }
        const claimed = applyPermissionEvent([settled.record], {
          type: "request_outbox_delivery",
          identity,
          commandId: pendingOutbox.commandId,
          version: pendingOutbox.version,
          deliveryAttemptId: input.deliveryAttemptId,
        });
        if (
          !claimed.ok ||
          claimed.duplicate ||
          claimed.sideEffect !== "request_one_upstream_write" ||
          claimed.record.outbox?.lifecycle !== "in_flight"
        ) {
          throw persistenceError("domain_operation_rejected");
        }
        finalRecord = claimed.record;
        writeClaim = freeze({
          commandId: pendingOutbox.commandId,
          version: pendingOutbox.version,
          deliveryAttemptId: input.deliveryAttemptId,
          command: pendingOutbox.command,
        });
      } else if (pendingOutbox !== undefined) {
        throw persistenceError("domain_operation_rejected");
      }

      let runResolution: RunApplyResult | undefined;
      if (owningRun?.value.state === "awaiting_permission") {
        const result = applyRunEvent(
          owningRun.value,
          permissionRunResolutionEvent(
            finalRecord,
            runResolutionIdempotencyKey,
          ),
        );
        if (!result.ok) {
          return freeze({
            ok: false,
            record: loaded.value,
            reason: `run_${result.reason}`,
          });
        }
        runResolution = result;
      }

      const commit = settled.record.decisionCommit;
      if (commit === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const settledEncoded = encodePermission(settled.record);
      const commitEncoded = encodeDecisionCommit(commit);
      const at = exactNow();
      const decisionUpdate = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?,
              decision_commit_json = ?, decision_commit_sha256 = ?,
              decision_command_id = ?, decision_outbox_version = ?,
              revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ? AND revision = ?
            AND decision_commit_json IS NULL
        `)
        .run(
          settledEncoded.json,
          settledEncoded.sha256,
          commitEncoded.json,
          commitEncoded.sha256,
          commit.commandId ?? null,
          commit.outboxVersion ?? null,
          at,
          ...identityBindings(identity),
          loaded.revision,
        );
      if (changes(decisionUpdate.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }

      if (pendingOutbox !== undefined) {
        this.#insertOutbox(identity, pendingOutbox, at);
        const claimedOutbox = this.#database
          .prepare(`
            UPDATE permission_outbox
            SET lifecycle = 'in_flight', delivery_attempt_id = ?, updated_at_ms = ?
            WHERE command_id = ? AND version = ? AND lifecycle = 'pending'
              AND delivery_attempt_id IS NULL
          `)
          .run(
            writeClaim?.deliveryAttemptId ?? null,
            at,
            pendingOutbox.commandId,
            pendingOutbox.version,
          );
        if (changes(claimedOutbox.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
        const finalEncoded = encodePermission(finalRecord);
        const finalSnapshot = this.#database
          .prepare(`
            UPDATE permission_requests
            SET snapshot_json = ?, snapshot_sha256 = ?, updated_at_ms = ?
            WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
              AND adapter_epoch = ? AND window_id = ? AND revision = ?
              AND decision_commit_json = ? AND decision_commit_sha256 = ?
          `)
          .run(
            finalEncoded.json,
            finalEncoded.sha256,
            at,
            ...identityBindings(identity),
            loaded.revision + 1,
            commitEncoded.json,
            commitEncoded.sha256,
          );
        if (changes(finalSnapshot.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
      if (owningRun !== undefined && runResolution !== undefined) {
        this.#persistRun(owningRun, runResolution.run, at);
      }
      return freeze({
        ok: true,
        record: finalRecord,
        duplicate: false,
        writeClaim,
      });
    });
  }

  markPermissionDeliveryUncertain(input: {
    readonly identity: PermissionIdentity;
    readonly commandId: PermissionOutboxCommandId;
    readonly version: PermissionOutboxVersion;
    readonly deliveryAttemptId: PermissionDeliveryAttemptId;
    readonly cause: PermanentPermissionDeliveryLossCause;
  }): PermissionDeliveryUncertainResult {
    const identity = parsedIdentity(input.identity);
    if (
      input.cause !== "run_terminalized" &&
      input.cause !== "session_changed" &&
      input.cause !== "epoch_exited" &&
      input.cause !== "transport_cannot_reply"
    ) {
      return freeze({
        ok: false,
        record: undefined,
        reason: "invalid_permanent_loss_cause",
      });
    }
    return this.#immediate(() => {
      const loaded = this.#requiredPermission(identity);
      const outbox = loaded.value.outbox;
      if (
        outbox === undefined ||
        outbox.commandId !== input.commandId ||
        outbox.version !== input.version ||
        outbox.deliveryAttemptId !== input.deliveryAttemptId
      ) {
        return freeze({
          ok: false,
          record: loaded.value,
          reason: "outbox_cas_mismatch",
        });
      }
      const uncertain = applyPermissionEvent([loaded.value], {
        type: "orphan",
        identity,
        cause: input.cause,
        transportCanReceive: false,
      });
      if (!uncertain.ok) return this.#acknowledgementFailure(uncertain);
      if (uncertain.duplicate) {
        return freeze({
          ok: true,
          record: uncertain.record,
          duplicate: true,
        });
      }
      if (
        uncertain.record.state !== "delivery_uncertain" ||
        uncertain.record.outbox?.lifecycle !== "delivery_uncertain"
      ) {
        throw persistenceError("domain_operation_rejected");
      }
      const at = exactNow();
      const outboxUpdate = this.#database
        .prepare(`
          UPDATE permission_outbox
          SET lifecycle = 'delivery_uncertain', updated_at_ms = ?
          WHERE command_id = ? AND version = ? AND delivery_attempt_id = ?
            AND lifecycle = 'in_flight'
        `)
        .run(
          at,
          input.commandId,
          input.version,
          input.deliveryAttemptId,
        );
      if (changes(outboxUpdate.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      const encoded = encodePermission(uncertain.record);
      const permissionUpdate = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?, revision = revision + 1,
              updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ? AND revision = ?
        `)
        .run(
          encoded.json,
          encoded.sha256,
          at,
          ...identityBindings(identity),
          loaded.revision,
        );
      if (changes(permissionUpdate.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      return freeze({
        ok: true,
        record: uncertain.record,
        duplicate: false,
      });
    });
  }

  acknowledgePermissionResponse(
    input: PermissionAcknowledgementInput,
  ): PermissionAcknowledgementResult {
    const identity = parsedIdentity(input.identity);
    const runResolutionIdempotencyKey =
      input.registrationMode === "pending"
        ? parsedIdempotencyKey(input.runResolutionIdempotencyKey)
        : undefined;
    return this.#immediate(() => {
      const loaded = this.#requiredPermission(identity);
      if (loaded.value.registrationMode !== input.registrationMode) {
        return freeze({
          ok: false,
          record: loaded.value,
          reason: "registration_mode_mismatch",
        });
      }
      const acknowledged = applyPermissionEvent([loaded.value], {
        type: "response_frame_flush_completed",
        identity,
        commandId: input.commandId,
        version: input.version,
        deliveryAttemptId: input.deliveryAttemptId,
      });
      if (!acknowledged.ok) return this.#acknowledgementFailure(acknowledged);
      if (acknowledged.duplicate) {
        return freeze({
          ok: true,
          record: acknowledged.record,
          duplicate: true,
        });
      }
      let runResolution:
        | { readonly loaded: Loaded<RunRecord>; readonly result: RunApplyResult }
        | undefined;
      if (loaded.value.registrationMode === "pending") {
        if (runResolutionIdempotencyKey === undefined) {
          throw persistenceError("domain_operation_rejected");
        }
        const run = this.#requiredRun(identity.taskId, identity.runId);
        const unresolved = run.value.unresolvedPermissionIdentities.some(
          (candidate) => permissionIdentitiesEqual(candidate, identity),
        );
        const explicitUserDecision =
          loaded.value.decisionCommit?.cause === "explicit_user";
        if (!explicitUserDecision) {
          if (unresolved && run.value.state !== "cancel_requested") {
            throw persistenceError("aggregate_integrity_failed");
          }
        } else if (isTerminalRunState(run.value.state)) {
          if (unresolved) throw persistenceError("aggregate_integrity_failed");
        } else if (run.value.state === "completing") {
          if (unresolved) throw persistenceError("aggregate_integrity_failed");
        } else if (run.value.state === "cancel_requested") {
          if (!unresolved) throw persistenceError("aggregate_integrity_failed");
        } else {
          if (!unresolved) {
            throw persistenceError("aggregate_integrity_failed");
          }
          const result = applyRunEvent(
            run.value,
            permissionRunResolutionEvent(
              acknowledged.record,
              runResolutionIdempotencyKey,
            ),
          );
          if (!result.ok) {
            return freeze({
              ok: false,
              record: loaded.value,
              reason: `run_${result.reason}`,
            });
          }
          runResolution = freeze({ loaded: run, result });
        }
      }
      const at = exactNow();
      const exactAck = this.#database
        .prepare(`
          UPDATE permission_outbox
          SET lifecycle = 'completed', updated_at_ms = ?
          WHERE command_id = ? AND version = ? AND delivery_attempt_id = ?
            AND lifecycle IN ('in_flight', 'delivery_uncertain')
        `)
        .run(at, input.commandId, input.version, input.deliveryAttemptId);
      if (changes(exactAck.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      const encoded = encodePermission(acknowledged.record);
      const permissionUpdate = this.#database
        .prepare(`
          UPDATE permission_requests
          SET snapshot_json = ?, snapshot_sha256 = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
            AND adapter_epoch = ? AND window_id = ? AND revision = ?
        `)
        .run(
          encoded.json,
          encoded.sha256,
          at,
          ...identityBindings(identity),
          loaded.revision,
        );
      if (changes(permissionUpdate.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
      if (runResolution !== undefined) {
        this.#persistRun(
          runResolution.loaded,
          runResolution.result.run,
          at,
        );
      }
      return freeze({
        ok: true,
        record: acknowledged.record,
        duplicate: false,
      });
    });
  }

  restoreTask(taskIdInput: TaskId): CanonicalTaskRestore {
    this.#assertOpen();
    const taskId = parsedTaskId(taskIdInput);
    const task = this.#requiredTaskAuthority(taskId);
    const sessionBinding = this.#selectSession(taskId)?.value;
    const currentRows = this.#database
      .prepare("SELECT * FROM runs WHERE task_id = ? AND is_current = 1")
      .all(taskId);
    if (currentRows.length > 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const currentRun =
      currentRows[0] === undefined ? undefined : this.#decodeRunRow(currentRows[0]).value;
    const permissions = this.#database
      .prepare(`
        SELECT * FROM permission_requests
        WHERE task_id = ?
        ORDER BY created_at_ms, run_id, session_id, tool_call_id, adapter_epoch, window_id
      `)
      .all(taskId)
      .map((row) => this.#decodePermissionRow(row).value);
    return freeze({
      task,
      sessionBinding,
      currentRun,
      permissions: Object.freeze(permissions),
    });
  }

  verifyIntegrity(): IntegrityReport {
    this.#assertOpen();
    const quick = this.#database.prepare("PRAGMA quick_check").all();
    if (
      quick.length !== 1 ||
      !Object.values(quick[0] ?? {}).includes("ok")
    ) {
      throw persistenceError("schema_integrity_failed");
    }
    if (this.recoveredAfterUncleanShutdown) {
      const full = this.#database.prepare("PRAGMA integrity_check").all();
      if (
        full.length !== 1 ||
        !Object.values(full[0] ?? {}).includes("ok")
      ) {
        throw persistenceError("schema_integrity_failed");
      }
    }
    if (this.#database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw persistenceError("schema_integrity_failed");
    }
    for (const row of this.#database.prepare("SELECT * FROM runs").all()) {
      this.#decodeRunRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM session_bindings").all()) {
      this.#decodeSessionRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM permission_requests").all()) {
      this.#decodePermissionRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM workspaces").all()) {
      this.#decodeWorkspaceRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM task_metadata").all()) {
      this.#decodeTaskMetadataRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM adapter_epochs").all()) {
      this.#decodeAdapterEpochRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM prompt_correlations").all()) {
      this.#decodePromptCorrelationRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM conversation_entries").all()) {
      this.#decodeConversationEntryRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM queued_turns").all()) {
      this.#decodeQueuedTurnRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM continuous_tasks").all()) {
      this.#decodeContinuousTaskRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM drafts").all()) {
      this.#decodeDraftRow(row);
    }
    for (const row of this.#database.prepare("SELECT * FROM session_context_windows").all()) {
      const parsedTask = parseTaskId(exactText(row, "task_id"));
      const parsedSession = parseSessionId(exactText(row, "session_id"));
      if (!parsedTask.ok || !parsedSession.ok) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const taskId = parsedTask.value;
      const sessionId = parsedSession.value;
      const size = exactInteger(row, "size");
      if (size <= 0 || this.#requiredSession(taskId).value.sessionId !== sessionId) {
        throw persistenceError("aggregate_integrity_failed");
      }
    }
    this.#requiredAppSettings();
    for (const row of this.#database.prepare("SELECT * FROM committed_envelopes").all()) {
      const json = exactText(row, "event_json");
      if (sha256(json) !== exactText(row, "event_sha256")) {
        throw persistenceError("aggregate_integrity_failed");
      }
      let parsedEvent: ReturnType<typeof parseRuntimeTurnEvent>;
      try {
        parsedEvent = parseRuntimeTurnEvent(JSON.parse(json));
      } catch (cause: unknown) {
        throw persistenceError("aggregate_integrity_failed", cause);
      }
      if (!parsedEvent.ok) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const envelope = parsedEvent.value.envelope;
      if (
        envelope.taskId !== exactText(row, "task_id") ||
        envelope.idempotencyKey !== exactText(row, "idempotency_key") ||
        envelopeFingerprint(envelope) !== exactText(row, "fingerprint") ||
        envelope.adapterEpoch !== exactInteger(row, "adapter_epoch") ||
        envelope.ingestMode !== exactText(row, "ingest_mode") ||
        envelope.receiveSequence !== exactInteger(row, "receive_sequence")
      ) {
        throw persistenceError("aggregate_integrity_failed");
      }
    }
    const checkedAtMs = exactNow();
    this.#database
      .prepare("UPDATE guild_meta SET last_integrity_at_ms = ? WHERE singleton = 1")
      .run(checkedAtMs);
    return freeze({
      schemaVersion: SCHEMA_VERSION,
      recoveredAfterUncleanShutdown: this.recoveredAfterUncleanShutdown,
      checkedAtMs,
    });
  }

  backupTo(destinationPath: string): void {
    this.#assertOpen();
    if (destinationPath.length === 0 || existsSync(destinationPath)) {
      throw persistenceError("schema_integrity_failed");
    }
    try {
      this.#database.prepare("VACUUM INTO ?").run(destinationPath);
    } catch (cause: unknown) {
      throw persistenceError("schema_integrity_failed", cause);
    }
  }

  close(): void {
    if (this.#closed) return;
    let cleanMarked = false;
    let failure: unknown;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      this.#database
        .prepare("UPDATE guild_meta SET clean_shutdown = 1 WHERE singleton = 1")
        .run();
      this.#database.exec("COMMIT");
      cleanMarked = true;
      const checkpoint = this.#database
        .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
        .get();
      if (checkpoint === undefined || exactInteger(checkpoint, "busy") !== 0) {
        throw persistenceError("schema_integrity_failed");
      }
    } catch (cause: unknown) {
      if (this.#database.isTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch (_ignored: unknown) {
          // Preserve the original close failure.
        }
      }
      if (cleanMarked) {
        try {
          this.#database
            .prepare("UPDATE guild_meta SET clean_shutdown = 0 WHERE singleton = 1")
            .run();
        } catch (_ignored: unknown) {
          // Preserve the original close failure.
        }
      }
      failure = cause instanceof PersistenceError
        ? cause
        : persistenceError("schema_integrity_failed", cause);
    }
    this.#closed = true;
    try {
      if (!this.#lease.release({
        preserveRecoveryEvidence: failure !== undefined,
      })) {
        throw new DatabaseLeaseError("database_lease_corrupt");
      }
    } catch (cause: unknown) {
      failure ??= persistenceLeaseError(cause);
    }
    if (failure !== undefined) throw failure;
  }

  #assertOpen(): void {
    if (this.#closed) throw persistenceError("persistence_closed");
  }

  #immediate<T>(operation: () => T): T {
    this.#assertOpen();
    if (this.#database.isTransaction) {
      throw persistenceError("persistence_cas_conflict");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (cause: unknown) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      if (cause instanceof PersistenceError) throw cause;
      throw persistenceError("persistence_cas_conflict", cause);
    }
  }

  #decodeWorkspaceRow(row: SqlRow): WorkspaceRecord {
    const workspaceId = exactText(row, "workspace_id");
    const canonicalPath = exactText(row, "canonical_path");
    const displayName = exactText(row, "display_name");
    if (
      workspaceId.length === 0 ||
      workspaceId.length > MAX_WORKSPACE_ID_LENGTH ||
      canonicalPath.length === 0 ||
      canonicalPath.length > MAX_CANONICAL_PATH_LENGTH ||
      displayName.length === 0 ||
      displayName.length > MAX_WORKSPACE_NAME_LENGTH ||
      displayName.trim().length === 0
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      workspaceId,
      canonicalPath,
      displayName,
      disposition: parsedDisposition(exactText(row, "disposition")),
      revision: exactInteger(row, "revision"),
      createdAtMs: exactInteger(row, "created_at_ms"),
      updatedAtMs: exactInteger(row, "updated_at_ms"),
      archivedAtMs: optionalInteger(row, "archived_at_ms"),
      deletedAtMs: optionalInteger(row, "deleted_at_ms"),
    });
  }

  #selectWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workspaces WHERE workspace_id = ?")
      .get(workspaceId);
    return row === undefined ? undefined : this.#decodeWorkspaceRow(row);
  }

  #requiredWorkspace(workspaceId: string): WorkspaceRecord {
    const workspace = this.#selectWorkspace(workspaceId);
    if (workspace === undefined) throw persistenceError("aggregate_not_found");
    return workspace;
  }

  #setWorkspaceDisposition(
    workspaceId: string,
    expectedRevision: number,
    target: "active" | "archived" | "deleted",
  ): WorkspaceRecord {
    const current = this.#requiredWorkspace(workspaceId);
    if (current.revision !== expectedRevision) {
      throw persistenceError("persistence_cas_conflict");
    }
    if (current.disposition === target) return current;
    if (
      current.disposition === "deleted" ||
      (target === "active" && current.disposition !== "archived") ||
      (target === "archived" && current.disposition !== "active")
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    const at = exactNow();
    const update = target === "active"
      ? this.#database
          .prepare(`
            UPDATE workspaces
            SET disposition = 'active', archived_at_ms = NULL, deleted_at_ms = NULL,
                revision = revision + 1, updated_at_ms = ?
            WHERE workspace_id = ? AND revision = ? AND disposition = 'archived'
          `)
          .run(at, workspaceId, expectedRevision)
      : target === "archived"
      ? this.#database
          .prepare(`
            UPDATE workspaces
            SET disposition = 'archived', archived_at_ms = ?, deleted_at_ms = NULL,
                revision = revision + 1, updated_at_ms = ?
            WHERE workspace_id = ? AND revision = ? AND disposition = 'active'
          `)
          .run(at, at, workspaceId, expectedRevision)
      : this.#database
          .prepare(`
            UPDATE workspaces
            SET disposition = 'deleted', deleted_at_ms = ?,
                revision = revision + 1, updated_at_ms = ?
            WHERE workspace_id = ? AND revision = ? AND disposition IN ('active', 'archived')
          `)
          .run(at, at, workspaceId, expectedRevision);
    if (changes(update.changes) !== 1) {
      throw persistenceError("persistence_cas_conflict");
    }
    return this.#requiredWorkspace(workspaceId);
  }

  #decodeTaskMetadataRow(row: SqlRow): TaskMetadataRecord {
    const parsedId = parseTaskId(exactText(row, "task_id"));
    if (!parsedId.ok) throw persistenceError("aggregate_integrity_failed");
    const workspaceId = exactText(row, "workspace_id");
    const title = exactText(row, "title");
    if (
      workspaceId.length === 0 ||
      workspaceId.length > MAX_WORKSPACE_ID_LENGTH ||
      title.length === 0 ||
      title.length > MAX_TASK_TITLE_LENGTH ||
      title.trim().length === 0
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      taskId: parsedId.value,
      workspaceId,
      title,
      pinned: exactInteger(row, "pinned") === 1,
      disposition: parsedDisposition(exactText(row, "disposition")),
      revision: exactInteger(row, "revision"),
      createdAtMs: exactInteger(row, "created_at_ms"),
      updatedAtMs: exactInteger(row, "updated_at_ms"),
      lastActivityAtMs: exactInteger(row, "last_activity_at_ms"),
      archivedAtMs: optionalInteger(row, "archived_at_ms"),
      deletedAtMs: optionalInteger(row, "deleted_at_ms"),
    });
  }

  #selectTaskMetadata(taskId: TaskId): TaskMetadataRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM task_metadata WHERE task_id = ?")
      .get(taskId);
    return row === undefined ? undefined : this.#decodeTaskMetadataRow(row);
  }

  #requiredTaskMetadata(taskId: TaskId): TaskMetadataRecord {
    const metadata = this.#selectTaskMetadata(taskId);
    if (metadata === undefined) throw persistenceError("aggregate_not_found");
    return metadata;
  }

  #insertTaskMetadata(input: {
    readonly taskId: TaskId;
    readonly workspaceId: string;
    readonly title: string;
    readonly createdAtMs: number;
    readonly at: number;
  }): void {
    this.#database
      .prepare(`
        INSERT INTO task_metadata(
          task_id, workspace_id, title, disposition, revision, created_at_ms,
          updated_at_ms, last_activity_at_ms, archived_at_ms, deleted_at_ms
        ) VALUES(?, ?, ?, 'active', 1, ?, ?, ?, NULL, NULL)
      `)
      .run(
        input.taskId,
        input.workspaceId,
        input.title,
        input.createdAtMs,
        input.at,
        input.at,
      );
  }

  #setTaskDisposition(
    taskId: TaskId,
    expectedRevision: number,
    target: "active" | "archived" | "deleted",
  ): TaskMetadataRecord {
    const current = this.#requiredTaskMetadata(taskId);
    if (current.revision !== expectedRevision) {
      throw persistenceError("persistence_cas_conflict");
    }
    if (current.disposition === target) return current;
    if (
      current.disposition === "deleted" ||
      (target === "active" && current.disposition !== "archived") ||
      (target === "archived" && current.disposition !== "active")
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    const at = exactNow();
    const update = target === "active"
      ? this.#database
          .prepare(`
            UPDATE task_metadata
            SET disposition = 'active', archived_at_ms = NULL, deleted_at_ms = NULL,
                revision = revision + 1, updated_at_ms = ?
            WHERE task_id = ? AND revision = ? AND disposition = 'archived'
          `)
          .run(at, taskId, expectedRevision)
      : target === "archived"
      ? this.#database
          .prepare(`
            UPDATE task_metadata
            SET disposition = 'archived', archived_at_ms = ?, deleted_at_ms = NULL,
                revision = revision + 1, updated_at_ms = ?
            WHERE task_id = ? AND revision = ? AND disposition = 'active'
          `)
          .run(at, at, taskId, expectedRevision)
      : this.#database
          .prepare(`
            UPDATE task_metadata
            SET disposition = 'deleted', deleted_at_ms = ?,
                revision = revision + 1, updated_at_ms = ?
            WHERE task_id = ? AND revision = ? AND disposition IN ('active', 'archived')
          `)
          .run(at, at, taskId, expectedRevision);
    if (changes(update.changes) !== 1) {
      throw persistenceError("persistence_cas_conflict");
    }
    return this.#requiredTaskMetadata(taskId);
  }

  #requireWritableConversationTask(taskId: TaskId): TaskMetadataRecord {
    const row = this.#database
      .prepare(`
        SELECT task.*,
          workspace.disposition AS workspace_disposition
        FROM task_metadata AS task
        INNER JOIN workspaces AS workspace
          ON workspace.workspace_id = task.workspace_id
        WHERE task.task_id = ?
      `)
      .get(taskId);
    if (row === undefined) throw persistenceError("aggregate_not_found");
    const task = this.#decodeTaskMetadataRow(row);
    if (
      task.disposition !== "active" ||
      parsedDisposition(exactText(row, "workspace_disposition")) !== "active"
    ) {
      throw persistenceError("domain_operation_rejected");
    }
    return task;
  }

  #touchTaskActivity(taskId: TaskId, at: number): void {
    const update = this.#database
      .prepare(`
        UPDATE task_metadata
        SET last_activity_at_ms = MAX(last_activity_at_ms, ?)
        WHERE task_id = ?
      `)
      .run(at, taskId);
    if (changes(update.changes) !== 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
  }

  #decodeAdapterEpochRow(row: SqlRow): PhysicalRecord<AdapterEpochRecord> {
    const task = parseTaskId(exactText(row, "task_id"));
    const session = parseSessionId(exactText(row, "session_id"));
    const adapterEpoch = parseAdapterEpoch(exactInteger(row, "adapter_epoch"));
    const status = exactText(row, "status");
    if (
      !task.ok ||
      !session.ok ||
      !adapterEpoch.ok ||
      (status !== "spawning" && status !== "alive" && status !== "stopping" && status !== "exited")
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const current = exactInteger(row, "is_current");
    if (current !== 0 && current !== 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      row,
      record: freeze({
        taskId: task.value,
        sessionId: session.value,
        adapterEpoch: adapterEpoch.value,
        status,
        current: current === 1,
        revision: exactInteger(row, "revision"),
        createdAtMs: exactInteger(row, "created_at_ms"),
        updatedAtMs: exactInteger(row, "updated_at_ms"),
      }),
    });
  }

  #selectAdapterEpoch(
    taskId: TaskId,
    adapterEpoch: AdapterEpoch,
  ): PhysicalRecord<AdapterEpochRecord> | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM adapter_epochs WHERE task_id = ? AND adapter_epoch = ?
      `)
      .get(taskId, adapterEpoch);
    return row === undefined ? undefined : this.#decodeAdapterEpochRow(row);
  }

  #requiredAdapterEpoch(
    taskId: TaskId,
    adapterEpoch: AdapterEpoch,
  ): AdapterEpochRecord {
    const epoch = this.#selectAdapterEpoch(taskId, adapterEpoch);
    if (epoch === undefined) throw persistenceError("aggregate_not_found");
    return epoch.record;
  }

  #selectCurrentAdapterEpoch(
    taskId: TaskId,
  ): PhysicalRecord<AdapterEpochRecord> | undefined {
    const rows = this.#database
      .prepare("SELECT * FROM adapter_epochs WHERE task_id = ? AND is_current = 1")
      .all(taskId);
    if (rows.length > 1) throw persistenceError("aggregate_integrity_failed");
    const row = rows[0];
    return row === undefined ? undefined : this.#decodeAdapterEpochRow(row);
  }

  #decodePromptCorrelationRow(
    row: SqlRow,
  ): PhysicalRecord<PromptCorrelationRecord> {
    const task = parseTaskId(exactText(row, "task_id"));
    const run = parseRunId(exactText(row, "run_id"));
    const session = parseSessionId(exactText(row, "session_id"));
    const epoch = parseAdapterEpoch(exactInteger(row, "adapter_epoch"));
    const promptSequence = exactInteger(row, "prompt_sequence");
    const acceptanceKey = parseIdempotencyKey(exactText(row, "acceptance_key"));
    const status = exactText(row, "status");
    const terminalClassification = optionalText(row, "terminal_classification");
    if (
      !task.ok || !run.ok || !session.ok || !epoch.ok || !acceptanceKey.ok ||
      promptSequence < 1 ||
      (status !== "accepted" && status !== "terminal") ||
      (terminalClassification !== undefined &&
        terminalClassification !== "cancelled" &&
        terminalClassification !== "completed" &&
        terminalClassification !== "refused" &&
        terminalClassification !== "truncated")
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const fingerprint = sha256(JSON.stringify([
      task.value,
      run.value,
      session.value,
      epoch.value,
      promptSequence,
    ]));
    if (fingerprint !== exactText(row, "acceptance_fingerprint")) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const terminalKey = optionalText(row, "terminal_key");
    const finalCommitKey = optionalText(row, "final_commit_key");
    if (
      (status === "accepted" &&
        (terminalClassification !== undefined || terminalKey !== undefined || finalCommitKey !== undefined)) ||
      (status === "terminal" &&
        (terminalClassification === undefined || terminalKey === undefined ||
          (terminalClassification === "cancelled"
            ? finalCommitKey !== undefined
            : finalCommitKey === undefined)))
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    if (terminalKey !== undefined && !parseIdempotencyKey(terminalKey).ok) {
      throw persistenceError("aggregate_integrity_failed");
    }
    if (finalCommitKey !== undefined && !parseIdempotencyKey(finalCommitKey).ok) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      row,
      record: freeze({
        taskId: task.value,
        runId: run.value,
        sessionId: session.value,
        adapterEpoch: epoch.value,
        promptSequence,
        status,
        terminalClassification: terminalClassification as PromptTerminalClassification | undefined,
        revision: exactInteger(row, "revision"),
        createdAtMs: exactInteger(row, "created_at_ms"),
        updatedAtMs: exactInteger(row, "updated_at_ms"),
      }),
    });
  }

  #selectPromptCorrelation(
    taskId: TaskId,
    runId: RunId,
  ): PhysicalRecord<PromptCorrelationRecord> | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM prompt_correlations WHERE task_id = ? AND run_id = ?
      `)
      .get(taskId, runId);
    return row === undefined ? undefined : this.#decodePromptCorrelationRow(row);
  }

  #requiredPromptCorrelation(
    taskId: TaskId,
    runId: RunId,
  ): PhysicalRecord<PromptCorrelationRecord> {
    const correlation = this.#selectPromptCorrelation(taskId, runId);
    if (correlation === undefined) throw persistenceError("aggregate_not_found");
    return correlation;
  }

  #decodeConversationEntryRow(
    row: SqlRow,
  ): PhysicalRecord<ConversationEntryRecord> {
    const task = parseTaskId(exactText(row, "task_id"));
    const runText = optionalText(row, "run_id");
    const run = runText === undefined ? undefined : parseRunId(runText);
    const entryId = exactText(row, "entry_id");
    const text = exactText(row, "text_content");
    const kindText = exactText(row, "kind");
    const statusText = exactText(row, "status");
    if (
      !task.ok ||
      (run !== undefined && !run.ok) ||
      entryId.length === 0 ||
      entryId.length > MAX_ENTRY_ID_LENGTH ||
      Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    let kind: ConversationEntryKind;
    let status: ConversationEntryStatus;
    try {
      kind = parsedEntryKind(kindText);
      status = parsedEntryStatus(statusText);
    } catch (cause: unknown) {
      throw persistenceError("aggregate_integrity_failed", cause);
    }
    const metadata = decodeMetadata(
      exactText(row, "metadata_json"),
      exactText(row, "metadata_sha256"),
    );
    if (!/^[0-9a-f]{64}$/u.test(exactText(row, "initial_fingerprint"))) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      row,
      record: freeze({
        taskId: task.value,
        entryId,
        sequence: exactInteger(row, "sequence"),
        kind,
        runId: run?.value,
        text,
        metadata,
        status,
        revision: exactInteger(row, "revision"),
        createdAtMs: exactInteger(row, "created_at_ms"),
        updatedAtMs: exactInteger(row, "updated_at_ms"),
      }),
    });
  }

  #selectConversationEntry(
    taskId: TaskId,
    entryId: string,
  ): PhysicalRecord<ConversationEntryRecord> | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM conversation_entries WHERE task_id = ? AND entry_id = ?
      `)
      .get(taskId, entryId);
    return row === undefined ? undefined : this.#decodeConversationEntryRow(row);
  }

  #requiredConversationEntry(
    taskId: TaskId,
    entryId: string,
  ): PhysicalRecord<ConversationEntryRecord> {
    const entry = this.#selectConversationEntry(taskId, entryId);
    if (entry === undefined) throw persistenceError("aggregate_not_found");
    return entry;
  }

  #decodeQueuedTurnRow(row: SqlRow): QueuedTurnRecord {
    const taskId = parseTaskId(exactText(row, "task_id"));
    const intendedSessionId = parseSessionId(exactText(row, "intended_session_id"));
    const reservedRunId = parseRunId(exactText(row, "reserved_run_id"));
    const queueId = exactText(row, "queue_id");
    const entryId = exactText(row, "entry_id");
    const text = exactText(row, "text_content");
    if (
      !taskId.ok ||
      !intendedSessionId.ok ||
      !reservedRunId.ok ||
      queueId.length === 0 ||
      queueId.length > MAX_ENTRY_ID_LENGTH ||
      entryId.length === 0 ||
      entryId.length > MAX_ENTRY_ID_LENGTH ||
      text.trim().length === 0 ||
      Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      taskId: taskId.value,
      queueId,
      intendedSessionId: intendedSessionId.value,
      reservedRunId: reservedRunId.value,
      entryId,
      text,
      createdAtMs: exactInteger(row, "created_at_ms"),
      priority: exactInteger(row, "priority"),
    });
  }

  #selectQueuedTurn(taskId: TaskId, queueId: string): QueuedTurnRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM queued_turns WHERE task_id = ? AND queue_id = ?")
      .get(taskId, queueId);
    return row === undefined ? undefined : this.#decodeQueuedTurnRow(row);
  }

  #requiredQueuedTurn(taskId: TaskId, queueId: string): QueuedTurnRecord {
    const queued = this.#selectQueuedTurn(taskId, queueId);
    if (queued === undefined) throw persistenceError("aggregate_not_found");
    return queued;
  }

  #decodeContinuousTaskRow(row: SqlRow): ContinuousTaskRecord {
    const taskId = parseTaskId(exactText(row, "task_id"));
    const objective = exactText(row, "objective");
    const lastRunText = optionalText(row, "last_run_id");
    const lastRunId = lastRunText === undefined ? undefined : parseRunId(lastRunText);
    let status: ContinuousTaskStatus;
    let phase: ContinuousTaskPhase;
    try {
      status = parsedContinuousTaskStatus(exactText(row, "status"));
      phase = parsedContinuousTaskPhase(exactText(row, "phase"));
    } catch (cause: unknown) {
      throw persistenceError("aggregate_integrity_failed", cause);
    }
    if (
      !taskId.ok ||
      objective.trim().length === 0 ||
      Buffer.byteLength(objective, "utf8") > MAX_TEXT_BYTES ||
      (lastRunId !== undefined && !lastRunId.ok)
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const summary = optionalText(row, "summary");
    const remaining = optionalText(row, "remaining");
    const stopReason = optionalText(row, "stop_reason");
    for (const value of [summary, remaining, stopReason]) {
      if (value !== undefined && Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
        throw persistenceError("aggregate_integrity_failed");
      }
    }
    const cycle = exactInteger(row, "cycle");
    const consecutiveNoProgress = exactInteger(row, "consecutive_no_progress");
    if (cycle < 1 || consecutiveNoProgress < 0) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      taskId: taskId.value,
      objective,
      status,
      phase,
      cycle,
      lastRunId: lastRunId?.value,
      summary,
      remaining,
      stopReason,
      consecutiveNoProgress,
      revision: exactInteger(row, "revision"),
      createdAtMs: exactInteger(row, "created_at_ms"),
      updatedAtMs: exactInteger(row, "updated_at_ms"),
    });
  }

  #selectContinuousTask(taskId: TaskId): ContinuousTaskRecord | undefined {
    const row = this.#database.prepare(
      "SELECT * FROM continuous_tasks WHERE task_id = ?",
    ).get(taskId);
    return row === undefined ? undefined : this.#decodeContinuousTaskRow(row);
  }

  #requiredContinuousTask(taskId: TaskId): ContinuousTaskRecord {
    const mission = this.#selectContinuousTask(taskId);
    if (mission === undefined) throw persistenceError("aggregate_not_found");
    return mission;
  }

  #canonicalLiveMutation(
    mutation: LiveConversationEntryMutation,
  ): LiveConversationEntryMutation {
    if (mutation === null || typeof mutation !== "object") {
      throw persistenceError("domain_operation_rejected");
    }
    switch (mutation.type) {
      case "create":
        return freeze({
          type: "create",
          entryId: parsedEntryId(mutation.entryId),
          kind: parsedEntryKind(mutation.kind),
          text: parsedText(mutation.text),
          metadata: encodeMetadata(mutation.metadata).value,
          status: parsedEntryStatus(mutation.status),
        });
      case "append_text":
        return freeze({
          type: "append_text",
          entryId: parsedEntryId(mutation.entryId),
          expectedRevision: parsedRevision(mutation.expectedRevision),
          text: parsedAppendText(mutation.text),
        });
      case "finalize":
        if (mutation.status !== "complete" && mutation.status !== "failed") {
          throw persistenceError("domain_operation_rejected");
        }
        return freeze({
          type: "finalize",
          entryId: parsedEntryId(mutation.entryId),
          expectedRevision: parsedRevision(mutation.expectedRevision),
          status: mutation.status,
        });
      default:
        throw persistenceError("domain_operation_rejected");
    }
  }

  #expectedEntryKind(event: RuntimeTurnEvent): ConversationEntryKind | undefined {
    switch (event.payload.type) {
      case "agent_text_chunk":
        return "assistant";
      case "user_text_chunk":
        return "user";
      case "agent_thought_chunk":
        return "thought";
      case "tool_call_create":
      case "tool_call_update":
      case "plan":
        return "tool";
      case "permission_request":
        return "permission";
      case "prompt_terminal":
        return undefined;
    }
  }

  #ensureConversationEntryCreation(
    taskId: TaskId,
    runId: RunId,
    mutation: Extract<LiveConversationEntryMutation, { readonly type: "create" }>,
    at: number,
  ): ConversationEntryRecord {
    const metadata = encodeMetadata(mutation.metadata);
    const fingerprint = entryInitialFingerprint({
      taskId,
      entryId: mutation.entryId,
      kind: mutation.kind,
      runId,
      text: mutation.text,
      metadataJson: metadata.json,
      status: mutation.status,
    });
    const existing = this.#selectConversationEntry(taskId, mutation.entryId);
    if (existing !== undefined) {
      if (
        existing.record.runId !== runId ||
        exactText(existing.row, "initial_fingerprint") !== fingerprint
      ) {
        throw persistenceError("aggregate_already_exists");
      }
      return existing.record;
    }
    return this.#applyLiveConversationMutation(taskId, runId, mutation, undefined, at)!;
  }

  #applyLiveConversationMutation(
    taskId: TaskId,
    runId: RunId,
    mutation: LiveConversationEntryMutation,
    expectedKind: ConversationEntryKind | undefined,
    at: number,
  ): ConversationEntryRecord {
    if (mutation.type === "create") {
      if (expectedKind !== undefined && mutation.kind !== expectedKind) {
        throw persistenceError("domain_operation_rejected");
      }
      if (this.#selectConversationEntry(taskId, mutation.entryId) !== undefined) {
        throw persistenceError("aggregate_already_exists");
      }
      const metadata = encodeMetadata(mutation.metadata);
      const fingerprint = entryInitialFingerprint({
        taskId,
        entryId: mutation.entryId,
        kind: mutation.kind,
        runId,
        text: mutation.text,
        metadataJson: metadata.json,
        status: mutation.status,
      });
      const sequenceRow = this.#database
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS last_sequence
          FROM conversation_entries WHERE task_id = ?
        `)
        .get(taskId);
      if (sequenceRow === undefined) {
        throw persistenceError("aggregate_integrity_failed");
      }
      const sequence = exactInteger(sequenceRow, "last_sequence") + 1;
      if (!Number.isSafeInteger(sequence)) {
        throw persistenceError("persistence_cas_conflict");
      }
      this.#database
        .prepare(`
          INSERT INTO conversation_entries(
            task_id, entry_id, sequence, kind, run_id, text_content,
            metadata_json, metadata_sha256, initial_fingerprint, status,
            revision, created_at_ms, updated_at_ms
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .run(
          taskId,
          mutation.entryId,
          sequence,
          mutation.kind,
          runId,
          mutation.text,
          metadata.json,
          metadata.sha256,
          fingerprint,
          mutation.status,
          at,
          at,
        );
      return this.#requiredConversationEntry(taskId, mutation.entryId).record;
    }
    const loaded = this.#requiredConversationEntry(taskId, mutation.entryId);
    if (
      loaded.record.runId !== runId ||
      (expectedKind !== undefined && loaded.record.kind !== expectedKind) ||
      loaded.record.revision !== mutation.expectedRevision
    ) {
      throw persistenceError("persistence_cas_conflict");
    }
    if (mutation.type === "append_text") {
      if (loaded.record.status !== "streaming") {
        throw persistenceError("domain_operation_rejected");
      }
      parsedText(loaded.record.text + mutation.text);
      const update = this.#database
        .prepare(`
          UPDATE conversation_entries
          SET text_content = text_content || ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND entry_id = ? AND revision = ? AND status = 'streaming'
        `)
        .run(mutation.text, at, taskId, mutation.entryId, mutation.expectedRevision);
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    } else {
      if (loaded.record.status === mutation.status) return loaded.record;
      if (loaded.record.status !== "streaming") {
        throw persistenceError("domain_operation_rejected");
      }
      const update = this.#database
        .prepare(`
          UPDATE conversation_entries
          SET status = ?, revision = revision + 1, updated_at_ms = ?
          WHERE task_id = ? AND entry_id = ? AND revision = ? AND status = 'streaming'
        `)
        .run(
          mutation.status,
          at,
          taskId,
          mutation.entryId,
          mutation.expectedRevision,
        );
      if (changes(update.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    }
    return this.#requiredConversationEntry(taskId, mutation.entryId).record;
  }

  #decodeDraftRow(row: SqlRow): DraftRecord {
    const task = parseTaskId(exactText(row, "task_id"));
    const text = exactText(row, "text_content");
    if (!task.ok || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      taskId: task.value,
      text,
      revision: exactInteger(row, "revision"),
      createdAtMs: exactInteger(row, "created_at_ms"),
      updatedAtMs: exactInteger(row, "updated_at_ms"),
    });
  }

  #selectDraft(taskId: TaskId): DraftRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM drafts WHERE task_id = ?")
      .get(taskId);
    return row === undefined ? undefined : this.#decodeDraftRow(row);
  }

  #requiredDraft(taskId: TaskId): DraftRecord {
    const draft = this.#selectDraft(taskId);
    if (draft === undefined) throw persistenceError("aggregate_not_found");
    return draft;
  }

  #requiredAppSettings(): AppSettingsRecord {
    const row = this.#database
      .prepare("SELECT * FROM app_settings WHERE singleton = 1")
      .get();
    if (row === undefined) throw persistenceError("aggregate_integrity_failed");
    const localeText = exactText(row, "locale");
    let locale: GuildLocale;
    try {
      locale = parsedLocale(localeText);
    } catch (cause: unknown) {
      throw persistenceError("aggregate_integrity_failed", cause);
    }
    const sidebarWidth = exactInteger(row, "sidebar_width");
    if (sidebarWidth < MIN_SIDEBAR_WIDTH || sidebarWidth > MAX_SIDEBAR_WIDTH) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const browserSync = exactInteger(row, "browser_sync_enabled");
    if (browserSync !== 0 && browserSync !== 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    let grokModel: GuildGrokModel;
    let reasoningEffort: GuildGrokReasoningEffort;
    let permissionMode: GuildGrokPermissionMode;
    try {
      grokModel = parseGuildGrokModel(exactText(row, "grok_model"));
      reasoningEffort = parseGuildGrokReasoningEffort(
        exactText(row, "reasoning_effort"),
      );
      permissionMode = parseGuildGrokPermissionMode(exactText(row, "permission_mode"));
      if (!supportsGuildGrokReasoningEffort(grokModel, reasoningEffort)) {
        throw new TypeError("unsupported_grok_reasoning_effort");
      }
    } catch (cause: unknown) {
      throw persistenceError("aggregate_integrity_failed", cause);
    }
    const restoreLastTask = exactInteger(row, "restore_last_task");
    if (restoreLastTask !== 0 && restoreLastTask !== 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const taskNotificationsEnabled = exactInteger(row, "task_notifications_enabled");
    if (taskNotificationsEnabled !== 0 && taskNotificationsEnabled !== 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const webSearchEnabled = exactInteger(row, "web_search_enabled");
    const planEnabled = exactInteger(row, "plan_enabled");
    const subagentsEnabled = exactInteger(row, "subagents_enabled");
    if (
      (webSearchEnabled !== 0 && webSearchEnabled !== 1) ||
      (planEnabled !== 0 && planEnabled !== 1) ||
      (subagentsEnabled !== 0 && subagentsEnabled !== 1)
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const rawMaxTurns = row["max_turns"];
    if (
      rawMaxTurns !== null &&
      (typeof rawMaxTurns !== "number" || !Number.isSafeInteger(rawMaxTurns) || rawMaxTurns < 1 || rawMaxTurns > 10_000)
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const startup = parseGuildGrokStartupSettings({
      webSearchEnabled: webSearchEnabled === 1,
      planEnabled: planEnabled === 1,
      subagentsEnabled: subagentsEnabled === 1,
      maxTurns: rawMaxTurns,
    });
    let nickname: string;
    let newTaskWorkspaceMode: GuildNewTaskWorkspaceMode;
    try {
      nickname = parseGuildNickname(exactText(row, "nickname"));
      newTaskWorkspaceMode = parseGuildNewTaskWorkspaceMode(
        exactText(row, "new_task_workspace_mode"),
      );
    } catch (cause: unknown) {
      throw persistenceError("aggregate_integrity_failed", cause);
    }
    const avatarFilename = optionalText(row, "avatar_filename");
    if (avatarFilename !== undefined && !AVATAR_FILENAME.test(avatarFilename)) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({
      locale,
      grokModel,
      reasoningEffort,
      permissionMode,
      startup,
      sidebarWidth,
      browserSyncEnabled: browserSync === 1,
      nickname,
      ...(avatarFilename === undefined ? {} : { avatarFilename }),
      restoreLastTask: restoreLastTask === 1,
      newTaskWorkspaceMode,
      taskNotificationsEnabled: taskNotificationsEnabled === 1,
      ...(optionalText(row, "last_active_task_id") === undefined
        ? {}
        : { lastActiveTaskId: optionalText(row, "last_active_task_id") as TaskId }),
      ...(optionalText(row, "last_workspace_id") === undefined
        ? {}
        : { lastWorkspaceId: optionalText(row, "last_workspace_id") }),
      revision: exactInteger(row, "revision"),
      updatedAtMs: exactInteger(row, "updated_at_ms"),
    });
  }

  #requireTask(taskId: TaskId): void {
    if (
      this.#database
        .prepare("SELECT 1 AS present FROM tasks WHERE task_id = ?")
        .get(taskId) === undefined
    ) {
      throw persistenceError("aggregate_not_found");
    }
  }

  #requiredTaskAuthority(taskId: TaskId): TaskAuthority {
    const row = this.#database
      .prepare("SELECT owning_window_id FROM tasks WHERE task_id = ?")
      .get(taskId);
    if (row === undefined) throw persistenceError("aggregate_not_found");
    const rawWindow = optionalText(row, "owning_window_id");
    const owningWindowId =
      rawWindow === undefined ? undefined : parsedWindowId(rawWindow as WindowId);
    return freeze({ taskId, owningWindowId });
  }

  #selectRun(taskId: TaskId, runId: RunId): Loaded<RunRecord> | undefined {
    const row = this.#database
      .prepare("SELECT * FROM runs WHERE task_id = ? AND run_id = ?")
      .get(taskId, runId);
    return row === undefined ? undefined : this.#decodeRunRow(row);
  }

  #selectCurrentRun(taskId: TaskId): Loaded<RunRecord> | undefined {
    const rows = this.#database
      .prepare("SELECT * FROM runs WHERE task_id = ? AND is_current = 1")
      .all(taskId);
    if (rows.length > 1) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const row = rows[0];
    return row === undefined ? undefined : this.#decodeRunRow(row);
  }

  #requiredRun(taskId: TaskId, runId: RunId): Loaded<RunRecord> {
    const loaded = this.#selectRun(taskId, runId);
    if (loaded === undefined) throw persistenceError("aggregate_not_found");
    return loaded;
  }

  #persistRun(
    loaded: Loaded<RunRecord>,
    run: RunRecord,
    at: number = exactNow(),
  ): void {
    const encoded = encodeRun(run);
    if (encoded.json === loaded.json) return;
    const update = this.#database
      .prepare(`
        UPDATE runs
        SET snapshot_json = ?, snapshot_sha256 = ?, revision = revision + 1,
            updated_at_ms = ?
        WHERE task_id = ? AND run_id = ? AND revision = ?
      `)
      .run(
        encoded.json,
        encoded.sha256,
        at,
        run.taskId,
        run.runId,
        loaded.revision,
      );
    if (changes(update.changes) !== 1) {
      throw persistenceError("persistence_cas_conflict");
    }
  }

  #decodeRunRow(row: SqlRow): Loaded<RunRecord> {
    const json = exactText(row, "snapshot_json");
    const value = decodeRun(json, exactText(row, "snapshot_sha256"));
    if (
      value.taskId !== exactText(row, "task_id") ||
      value.runId !== exactText(row, "run_id")
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({ value, revision: exactInteger(row, "revision"), json });
  }

  #selectSession(taskId: TaskId): Loaded<SessionBindingRecord> | undefined {
    const row = this.#database
      .prepare("SELECT * FROM session_bindings WHERE task_id = ?")
      .get(taskId);
    return row === undefined ? undefined : this.#decodeSessionRow(row);
  }

  #requiredSession(taskId: TaskId): Loaded<SessionBindingRecord> {
    const loaded = this.#selectSession(taskId);
    if (loaded === undefined) throw persistenceError("aggregate_not_found");
    return loaded;
  }

  #decodeSessionRow(row: SqlRow): Loaded<SessionBindingRecord> {
    const json = exactText(row, "snapshot_json");
    const value = decodeSessionBinding(json, exactText(row, "snapshot_sha256"));
    if (value.taskId !== exactText(row, "task_id")) {
      throw persistenceError("aggregate_integrity_failed");
    }
    return freeze({ value, revision: exactInteger(row, "revision"), json });
  }

  #registrationCandidates(
    identity: PermissionIdentity,
    registrationKey: string,
  ): readonly Loaded<PermissionRecord>[] {
    return this.#database
      .prepare(`
        SELECT * FROM permission_requests
        WHERE registration_key = ? OR (
          task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
          AND adapter_epoch = ? AND window_id = ?
        )
      `)
      .all(registrationKey, ...identityBindings(identity))
      .map((row) => this.#decodePermissionRow(row));
  }

  #selectPermission(identity: PermissionIdentity): Loaded<PermissionRecord> | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM permission_requests
        WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
          AND adapter_epoch = ? AND window_id = ?
      `)
      .get(...identityBindings(identity));
    return row === undefined ? undefined : this.#decodePermissionRow(row);
  }

  #requiredPermission(identity: PermissionIdentity): Loaded<PermissionRecord> {
    const loaded = this.#selectPermission(identity);
    if (loaded === undefined) throw persistenceError("aggregate_not_found");
    return loaded;
  }

  #inFlightPermissionIdentitiesForRun(
    taskId: TaskId,
    runId: RunId,
  ): readonly PermissionIdentity[] {
    return this.#database
      .prepare(`
        SELECT request.*
        FROM permission_requests AS request
        INNER JOIN permission_outbox AS outbox
          ON outbox.task_id = request.task_id
          AND outbox.run_id = request.run_id
          AND outbox.session_id = request.session_id
          AND outbox.tool_call_id = request.tool_call_id
          AND outbox.adapter_epoch = request.adapter_epoch
          AND outbox.window_id = request.window_id
        WHERE request.task_id = ? AND request.run_id = ?
          AND outbox.lifecycle = 'in_flight'
      `)
      .all(taskId, runId)
      .map((row) => this.#decodePermissionRow(row).value.identity);
  }

  #decodePermissionRow(row: SqlRow): Loaded<PermissionRecord> {
    const json = exactText(row, "snapshot_json");
    const value = decodePermission(json, exactText(row, "snapshot_sha256"));
    const identity = value.identity;
    const physical = identityBindings(identity);
    const stored = [
      exactText(row, "task_id"),
      exactText(row, "run_id"),
      exactText(row, "session_id"),
      exactText(row, "tool_call_id"),
      exactInteger(row, "adapter_epoch"),
      exactText(row, "window_id"),
    ];
    if (physical.some((part, index) => part !== stored[index])) {
      throw persistenceError("aggregate_integrity_failed");
    }
    if (value.registrationKey !== exactText(row, "registration_key")) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const commitJson = optionalText(row, "decision_commit_json");
    const commitSha = optionalText(row, "decision_commit_sha256");
    const commandId = optionalText(row, "decision_command_id");
    const outboxVersion = optionalInteger(row, "decision_outbox_version");
    if (value.decisionCommit === undefined) {
      if (
        commitJson !== undefined ||
        commitSha !== undefined ||
        commandId !== undefined ||
        outboxVersion !== undefined
      ) {
        throw persistenceError("aggregate_integrity_failed");
      }
    } else {
      const encodedCommit = encodeDecisionCommit(value.decisionCommit);
      if (
        commitJson !== encodedCommit.json ||
        commitSha !== encodedCommit.sha256 ||
        commandId !== value.decisionCommit.commandId ||
        outboxVersion !== value.decisionCommit.outboxVersion
      ) {
        throw persistenceError("aggregate_integrity_failed");
      }
    }
    this.#verifyOutbox(value);
    return freeze({ value, revision: exactInteger(row, "revision"), json });
  }

  #verifyOutbox(record: PermissionRecord): void {
    const row = this.#database
      .prepare(`
        SELECT * FROM permission_outbox
        WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
          AND adapter_epoch = ? AND window_id = ?
      `)
      .get(...identityBindings(record.identity));
    const outbox = record.outbox;
    if (outbox === undefined) {
      if (row !== undefined) throw persistenceError("aggregate_integrity_failed");
      return;
    }
    if (row === undefined) throw persistenceError("aggregate_integrity_failed");
    const encodedCommand = encodeOutboxCommand(outbox.command);
    if (
      exactText(row, "command_id") !== outbox.commandId ||
      exactInteger(row, "version") !== outbox.version ||
      exactText(row, "command_json") !== encodedCommand.json ||
      exactText(row, "command_sha256") !== encodedCommand.sha256 ||
      exactText(row, "lifecycle") !== outbox.lifecycle ||
      optionalText(row, "delivery_attempt_id") !== outbox.deliveryAttemptId
    ) {
      throw persistenceError("aggregate_integrity_failed");
    }
  }

  #insertPermission(record: PermissionRecord, at: number = exactNow()): void {
    const encoded = encodePermission(record);
    const commit =
      record.decisionCommit === undefined
        ? undefined
        : encodeDecisionCommit(record.decisionCommit);
    this.#database
      .prepare(`
        INSERT INTO permission_requests(
          task_id, run_id, session_id, tool_call_id, adapter_epoch, window_id,
          registration_key, codec_version, snapshot_json, snapshot_sha256,
          decision_commit_json, decision_commit_sha256, decision_command_id,
          decision_outbox_version, revision, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `)
      .run(
        ...identityBindings(record.identity),
        record.registrationKey,
        encoded.json,
        encoded.sha256,
        commit?.json ?? null,
        commit?.sha256 ?? null,
        record.decisionCommit?.commandId ?? null,
        record.decisionCommit?.outboxVersion ?? null,
        at,
        at,
      );
    if (record.outbox !== undefined) {
      this.#insertOutbox(record.identity, record.outbox, at);
    }
  }

  #insertOutbox(
    identity: PermissionIdentity,
    outbox: NonNullable<PermissionRecord["outbox"]>,
    at: number,
  ): void {
    if (outbox.lifecycle !== "pending" || outbox.deliveryAttemptId !== undefined) {
      throw persistenceError("domain_operation_rejected");
    }
    const encoded = encodeOutboxCommand(outbox.command);
    this.#database
      .prepare(`
        INSERT INTO permission_outbox(
          command_id, task_id, run_id, session_id, tool_call_id, adapter_epoch,
          window_id, version, command_json, command_sha256, lifecycle,
          delivery_attempt_id, created_at_ms, updated_at_ms
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
      `)
      .run(
        outbox.commandId,
        ...identityBindings(identity),
        outbox.version,
        encoded.json,
        encoded.sha256,
        at,
        at,
      );
  }

  #closePermissionForRunTransition(
    identity: PermissionIdentity,
    at: number,
  ): void {
    const loaded = this.#requiredPermission(identity);
    if (
      isTerminalPermissionState(loaded.value.state) &&
      loaded.value.outbox?.lifecycle !== "in_flight"
    ) {
      return;
    }
    const closed = applyPermissionEvent([loaded.value], {
      type: "orphan",
      identity,
      cause: "run_terminalized",
      transportCanReceive: false,
    });
    if (!closed.ok) {
      throw persistenceError("domain_operation_rejected");
    }
    if (closed.duplicate) return;

    const previousOutbox = loaded.value.outbox;
    const nextOutbox = closed.record.outbox;
    if (previousOutbox === undefined && nextOutbox !== undefined) {
      throw persistenceError("aggregate_integrity_failed");
    }
    if (previousOutbox !== undefined && nextOutbox === undefined) {
      const deleted = this.#database
        .prepare(`
          DELETE FROM permission_outbox
          WHERE command_id = ? AND version = ? AND lifecycle = 'pending'
            AND delivery_attempt_id IS NULL
        `)
        .run(previousOutbox.commandId, previousOutbox.version);
      if (changes(deleted.changes) !== 1) {
        throw persistenceError("persistence_cas_conflict");
      }
    } else if (previousOutbox !== undefined && nextOutbox !== undefined) {
      if (
        previousOutbox.commandId !== nextOutbox.commandId ||
        previousOutbox.version !== nextOutbox.version ||
        previousOutbox.deliveryAttemptId !== nextOutbox.deliveryAttemptId
      ) {
        throw persistenceError("aggregate_integrity_failed");
      }
      if (previousOutbox.lifecycle !== nextOutbox.lifecycle) {
        const transitioned = this.#database
          .prepare(`
            UPDATE permission_outbox
            SET lifecycle = ?, updated_at_ms = ?
            WHERE command_id = ? AND version = ? AND lifecycle = ?
              AND delivery_attempt_id = ?
          `)
          .run(
            nextOutbox.lifecycle,
            at,
            previousOutbox.commandId,
            previousOutbox.version,
            previousOutbox.lifecycle,
            previousOutbox.deliveryAttemptId ?? null,
          );
        if (changes(transitioned.changes) !== 1) {
          throw persistenceError("persistence_cas_conflict");
        }
      }
    }

    const commit = closed.record.decisionCommit;
    if (commit === undefined) {
      throw persistenceError("aggregate_integrity_failed");
    }
    const encoded = encodePermission(closed.record);
    const encodedCommit = encodeDecisionCommit(commit);
    const update = this.#database
      .prepare(`
        UPDATE permission_requests
        SET snapshot_json = ?, snapshot_sha256 = ?,
            decision_commit_json = ?, decision_commit_sha256 = ?,
            decision_command_id = ?, decision_outbox_version = ?,
            revision = revision + 1, updated_at_ms = ?
        WHERE task_id = ? AND run_id = ? AND session_id = ? AND tool_call_id = ?
          AND adapter_epoch = ? AND window_id = ? AND revision = ?
      `)
      .run(
        encoded.json,
        encoded.sha256,
        encodedCommit.json,
        encodedCommit.sha256,
        commit.commandId ?? null,
        commit.outboxVersion ?? null,
        at,
        ...identityBindings(identity),
        loaded.revision,
      );
    if (changes(update.changes) !== 1) {
      throw persistenceError("persistence_cas_conflict");
    }
  }

  #registrationFailure(result: PermissionApplyResult): PermissionRegistrationResult {
    if (result.ok) throw persistenceError("domain_operation_rejected");
    return freeze({ ok: false, record: result.record, reason: result.reason });
  }

  #decisionFailure(result: PermissionApplyResult): PermissionDecisionAndClaimResult {
    if (result.ok) throw persistenceError("domain_operation_rejected");
    return freeze({ ok: false, record: result.record, reason: result.reason });
  }

  #acknowledgementFailure(result: PermissionApplyResult): PermissionAcknowledgementResult {
    if (result.ok) throw persistenceError("domain_operation_rejected");
    return freeze({ ok: false, record: result.record, reason: result.reason });
  }
}

function configureConnection(database: DatabaseSync): void {
  const journal = database.prepare("PRAGMA journal_mode = WAL").get();
  if (journal?.["journal_mode"] !== "wal") {
    throw persistenceError("storage_configuration_failed");
  }
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA trusted_schema = OFF;
    PRAGMA recursive_triggers = ON;
    PRAGMA wal_autocheckpoint = 1000;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
  `);
  const synchronous = database.prepare("PRAGMA synchronous").get();
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get();
  const trustedSchema = database.prepare("PRAGMA trusted_schema").get();
  const lockingMode = database.prepare("PRAGMA locking_mode").get();
  if (
    synchronous?.["synchronous"] !== 2 ||
    foreignKeys?.["foreign_keys"] !== 1 ||
    trustedSchema?.["trusted_schema"] !== 0 ||
    lockingMode?.["locking_mode"] !== "exclusive"
  ) {
    throw persistenceError("storage_configuration_failed");
  }
}

export function openGuildPersistence(
  options: OpenGuildPersistenceOptions,
): GuildPersistence {
  const electronProcessType = (
    process as NodeJS.Process & { readonly type?: string }
  ).type;
  if (
    electronProcessType !== undefined &&
    electronProcessType !== "browser"
  ) {
    throw persistenceError("storage_configuration_failed");
  }
  if (!isMainThread) {
    throw persistenceError("storage_configuration_failed");
  }
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw persistenceError("storage_configuration_failed");
  }
  const databaseAlreadyExisted = existsSync(options.path);
  const initialLocale = options.initialLocale === undefined
    ? undefined
    : parsedLocale(options.initialLocale);
  exactNow();
  let lease: DatabaseLease;
  try {
    lease = acquireDatabaseLease(options.path);
  } catch (cause: unknown) {
    throw persistenceLeaseError(cause);
  }

  const database = lease.database;

  try {
    configureConnection(database);
    migrateSchema(database);
    if (!databaseAlreadyExisted && initialLocale !== undefined) {
      const initialized = database
        .prepare("UPDATE app_settings SET locale = ? WHERE singleton = 1")
        .run(initialLocale);
      if (changes(initialized.changes) !== 1) {
        throw persistenceError("schema_integrity_failed");
      }
    }
    const meta = database
      .prepare("SELECT clean_shutdown FROM guild_meta WHERE singleton = 1")
      .get();
    if (meta === undefined) throw persistenceError("schema_integrity_failed");
    const cleanShutdown = exactInteger(meta, "clean_shutdown");
    const store = new SqliteGuildPersistence(
      database,
      lease,
      cleanShutdown === 0 || lease.recoveredStaleOwner,
    );
    store.verifyIntegrity();
    database.exec("BEGIN IMMEDIATE");
    try {
      const dirty = database
        .prepare("UPDATE guild_meta SET clean_shutdown = 0 WHERE singleton = 1")
        .run();
      if (changes(dirty.changes) !== 1) {
        throw persistenceError("schema_integrity_failed");
      }
      database.exec("COMMIT");
    } catch (cause: unknown) {
      if (database.isTransaction) database.exec("ROLLBACK");
      throw cause;
    }
    return store;
  } catch (cause: unknown) {
    if (database.isTransaction) {
      try {
        database.exec("ROLLBACK");
      } catch (_ignored: unknown) {
        // Preserve the original open failure.
      }
    }
    try {
      lease.release({ preserveRecoveryEvidence: true });
    } catch (_ignored: unknown) {
      // Preserve the original open failure.
    }
    if (cause instanceof PersistenceError) throw cause;
    throw persistenceError("schema_integrity_failed", cause);
  }
}
