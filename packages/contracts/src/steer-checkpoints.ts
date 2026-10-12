/**
 * Renderer-facing shapes for F4 Steer (interject into the running turn) and F2 run checkpoints,
 * changed-file summaries and rewind. Everything here is plain data crossing the IPC boundary; the
 * main process owns every decision. Fields added to `TaskViewProjection` from this module are
 * optional so a renderer that predates them keeps compiling and rendering.
 */

import type { RunId, TaskId } from "./ids.js";

// ---------------------------------------------------------------------------------------------
// F4 Steer
// ---------------------------------------------------------------------------------------------

/** Longest steer text, the same bound as an ordinary message. */
export const GUILD_STEER_MAX_LENGTH = 200_000;

/** Why a Steer was not injected into the running turn and went to the durable queue instead. */
export const GUILD_STEER_FALLBACK_REASONS = Object.freeze([
  /** The installed runtime answered -32601 for `_x.ai/interject`. */
  "unsupported",
  /** No turn is running (or it already ended), so there is nothing to steer. */
  "turn_not_running",
  /** The running turn is being cancelled or has not been accepted by the runtime yet. */
  "turn_not_steerable",
  /** The runtime rejected the interjection, or the process was unreachable. */
  "runtime_error",
] as const);
export type GuildSteerFallbackReason = (typeof GUILD_STEER_FALLBACK_REASONS)[number];

export type SteerMessageRequest = { readonly taskId: TaskId; readonly text: string };

export type ConvertQueuedTurnToSteerRequest = {
  readonly taskId: TaskId;
  readonly queueId: string;
};

export type SteerMessageResponse =
  /** Sent to the running turn; `delivered` flips on the runtime's echo (see `TimelineInterjectionProjection`). */
  | { readonly status: "steered"; readonly interjectionId: string }
  /** Steer was not possible; the text now waits in Guild's durable queue. */
  | {
      readonly status: "queued";
      readonly queueId: string;
      readonly reason: GuildSteerFallbackReason;
    }
  /** No turn was running, so the text started a new Run like an ordinary send. */
  | {
      readonly status: "started";
      readonly runId: RunId;
      readonly reason: GuildSteerFallbackReason;
    };

export type ConvertQueuedTurnToSteerResponse =
  | { readonly status: "steered"; readonly interjectionId: string }
  /** The queued turn stays queued, untouched; `reason` says why Steer was not possible. */
  | { readonly status: "unchanged"; readonly reason: GuildSteerFallbackReason };

/** Whether the composer may offer Steer for the task right now. */
export type SteerAvailabilityProjection =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason:
        | "no_active_run"
        | "turn_not_steerable"
        | "unsupported"
        | "runtime_unavailable";
    };

export const GUILD_INTERJECTION_STATES = Object.freeze([
  /** Sent to the runtime; its echo has not arrived. */
  "pending",
  /** The runtime echoed the interjection id back: it holds the message. */
  "delivered",
  /** Steer was not possible; the message went to the durable queue (a notice entry says why). */
  "fallen_back",
] as const);
export type GuildInterjectionState = (typeof GUILD_INTERJECTION_STATES)[number];

/** Present on the `user` entry of a steer (pending / delivered) and on the `notice` entry of a fallback. */
export type TimelineInterjectionProjection = {
  readonly interjectionId: string;
  readonly state: GuildInterjectionState;
  /** Set when `state` is `fallen_back`. */
  readonly reason?: GuildSteerFallbackReason;
};

// ---------------------------------------------------------------------------------------------
// F2 checkpoints, changed files
// ---------------------------------------------------------------------------------------------

export const GUILD_CHECKPOINT_STATUSES = Object.freeze([
  /** The start checkpoint exists; the Run is still running. */
  "capturing",
  /** Start and end checkpoints exist and the changed-file summary is stored. */
  "captured",
  /** The folder is not a git work tree, git is missing, or a guard tripped; see `detail`. */
  "unavailable",
  /** The Run was undone by a rewind (kept for audit; the timeline dims it). */
  "rolled_back",
] as const);
export type GuildCheckpointStatus = (typeof GUILD_CHECKPOINT_STATUSES)[number];

export const GUILD_CHECKPOINT_UNAVAILABLE_REASONS = Object.freeze([
  "not_a_git_repo",
  "git_unavailable",
  "timeout",
  "too_many_files",
  "too_large",
  "git_failed",
  "unsafe_task_id",
  "capture_skipped",
] as const);
export type GuildCheckpointUnavailableReason =
  (typeof GUILD_CHECKPOINT_UNAVAILABLE_REASONS)[number];

export type RunFileChangeStatus = "A" | "M" | "D" | "R";

export type RunFileChangeProjection = {
  /** Relative to the task folder. */
  readonly path: string;
  /** Previous path of a rename. */
  readonly oldPath?: string;
  readonly status: RunFileChangeStatus;
  /** `null` for a binary file. */
  readonly adds: number | null;
  readonly dels: number | null;
};

export const GUILD_RUN_FILE_LIST_LIMIT = 200;

export type RunCheckpointProjection = {
  readonly runId: RunId;
  /** 1-based position among the task's Runs that have a checkpoint row. */
  readonly ordinal: number;
  readonly status: GuildCheckpointStatus;
  readonly detail?: GuildCheckpointUnavailableReason;
  /** True once a rewind undid this Run. */
  readonly rolledBack: boolean;
  /** Totals cover every changed file even when `files` is capped. */
  readonly filesChanged: number;
  readonly adds: number;
  readonly dels: number;
  readonly files: readonly RunFileChangeProjection[];
  readonly filesTruncated: boolean;
};

/**
 * The model a Run started on, by the display name the picker showed (for example "Haiku 5.5"). Recorded once the
 * engine applied the task's selection and before the prompt went out; a Run from before it was recorded has none.
 */
export type RunModelProjection = {
  readonly runId: RunId;
  readonly label: string;
};

/** Whether a rewind could be offered for the task right now (per-Run detail comes from the preview). */
export type RewindAvailabilityProjection =
  | { readonly available: true }
  | {
      readonly available: false;
      readonly reason: "run_active" | "queue_not_empty" | "runtime_unavailable" | "no_checkpoints";
    };

export type LoadRunFileDiffRequest = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  readonly path: string;
};

export const GUILD_RUN_FILE_DIFF_MAX_BYTES = 256 * 1024;

export type LoadRunFileDiffResponse =
  | {
      readonly status: "ok";
      readonly path: string;
      /** Unified diff of the Run's own change (start checkpoint to end checkpoint). */
      readonly diff: string;
      readonly binary: boolean;
      readonly truncated: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no_checkpoint" | "not_in_run" | "git_failed";
    };

// ---------------------------------------------------------------------------------------------
// F2 rewind
// ---------------------------------------------------------------------------------------------

export type PreviewRewindRequest = { readonly taskId: TaskId; readonly runId: RunId };

export const GUILD_REWIND_SCOPES = Object.freeze([
  /** Official conversation rewind plus Guild's git file restore. */
  "conversation_and_files",
  /** Only the files; offered when the runtime has no conversation rewind. */
  "files_only",
] as const);
export type GuildRewindScope = (typeof GUILD_REWIND_SCOPES)[number];

export type ExecuteRewindRequest = {
  readonly taskId: TaskId;
  readonly runId: RunId;
  /** Defaults to `conversation_and_files`. */
  readonly scope?: GuildRewindScope;
  /** Restore even where files changed after the Run for reasons other than a later Run. */
  readonly overwriteConflicts?: boolean;
};

export const GUILD_REWIND_REFUSAL_REASONS = Object.freeze([
  "run_active",
  "queue_not_empty",
  "run_not_found",
  "already_rolled_back",
  "runtime_unavailable",
  /** The official prompt list does not line up with Guild's own turn order for this Run. */
  "prompt_index_mismatch",
  /** The runtime refused or failed the conversation rewind; no file was touched. */
  "runtime_refused",
  /** The Run belongs to an earlier session that is no longer the task's live session. */
  "session_replaced",
  /** The conversation cannot be rewound and there is no git checkpoint to offer files-only. */
  "nothing_to_rewind",
  /** The installed runtime has no `_x.ai/rewind/*`; use `scope: "files_only"` where a checkpoint exists. */
  "conversation_rewind_unsupported",
] as const);
export type GuildRewindRefusalReason = (typeof GUILD_REWIND_REFUSAL_REASONS)[number];

export const GUILD_REWIND_IRREVERSIBLE_KINDS = Object.freeze([
  "network_and_mcp_effects",
  "git_commits_and_pushes",
  "memory_writes",
  "shell_file_changes_without_git",
] as const);
export type GuildRewindIrreversibleKind = (typeof GUILD_REWIND_IRREVERSIBLE_KINDS)[number];

export type RewindConflictProjection = {
  readonly path: string;
  /**
   * `later_run`: a later Run (also being rolled back) changed the file.
   * `modified_after_run`: the file differs from the Run's end checkpoint for another reason
   * (you, another tool, a shell command outside any Run); rewinding overwrites that change.
   */
  readonly reason: "later_run" | "modified_after_run";
};

export type RewindFilePlanProjection =
  | {
      readonly kind: "git";
      /** Files that exist in the start checkpoint and will be restored from it. */
      readonly restore: readonly string[];
      /** Files the Runs added; they will be deleted. */
      readonly remove: readonly string[];
      readonly conflicts: readonly RewindConflictProjection[];
      readonly truncated: boolean;
    }
  | {
      /** No checkpoint: file changes made by shell commands cannot be reverted. */
      readonly kind: "none";
      readonly reason: GuildCheckpointUnavailableReason | "no_checkpoint_row";
      /** Files the runtime's own edit-tool snapshots can restore (official mode `all`); shell edits are not among them. */
      readonly runtimeRestore: readonly string[];
      /** Of those, the files that changed since and would be overwritten. */
      readonly runtimeConflicts: readonly string[];
    };

export type RewindPlanProjection = {
  readonly runId: RunId;
  /** What `executeRewind` does by default for this Run. */
  readonly scope: GuildRewindScope;
  readonly conversation:
    | {
        readonly available: true;
        /** Official mode: `conversation_only` with git files, `all` for a non-git folder. */
        readonly mode: "conversation_only" | "all";
        readonly targetPromptIndex: number;
        /** The prompt that goes back into the draft. */
        readonly promptText: string;
      }
    | { readonly available: false; readonly reason: "unsupported" | "runtime_unavailable" };
  /** This Run first, then every later Run (they are undone too). */
  readonly rolledBackRuns: readonly RunId[];
  readonly files: RewindFilePlanProjection;
  readonly cannotUndo: readonly Readonly<{
    readonly kind: GuildRewindIrreversibleKind;
    readonly text: string;
  }>[];
};

export type PreviewRewindResponse =
  | { readonly status: "ready"; readonly plan: RewindPlanProjection }
  | { readonly status: "refused"; readonly reason: GuildRewindRefusalReason };

export type ExecuteRewindResponse =
  | {
      readonly status: "rolled_back";
      readonly scope: GuildRewindScope;
      readonly rolledBackRuns: readonly RunId[];
      readonly restoredFiles: readonly string[];
      readonly removedFiles: readonly string[];
      readonly failedFiles: readonly Readonly<{ path: string; reason: string }>[];
      /** True when the reverted prompt text was put into the task draft. */
      readonly draftRestored: boolean;
    }
  /** Files changed after the Run for reasons other than a later Run; repeat with `overwriteConflicts`. */
  | { readonly status: "conflicts"; readonly conflicts: readonly RewindConflictProjection[] }
  | { readonly status: "refused"; readonly reason: GuildRewindRefusalReason };
