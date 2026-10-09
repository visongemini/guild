import type {
  ExecuteRewindRequest,
  ExecuteRewindResponse,
  GuildRewindRefusalReason,
  PreviewRewindResponse,
  RewindConflictProjection,
  RewindPlanProjection,
  TaskId,
} from "@guild/contracts";

/*
 * The rewind dialog as a small state machine, kept apart from React so every flow (ready, refused,
 * conflicts, success) is testable without a DOM. The component owns the requests and feeds the
 * responses in here.
 */

export type RolledBackResult = Extract<ExecuteRewindResponse, { readonly status: "rolled_back" }>;

export type RewindNotice =
  /** The runtime or the folder changed since the preview: confirm the listed files again. */
  | Readonly<{ kind: "conflicts" }>
  /** The request itself failed (not a refusal): try again. */
  | Readonly<{ kind: "failed" }>;

export type RewindState =
  | Readonly<{ phase: "loading" }>
  | Readonly<{ phase: "refused"; reason: GuildRewindRefusalReason }>
  /** The preview request failed. */
  | Readonly<{ phase: "failed" }>
  | Readonly<{
      phase: "ready";
      plan: RewindPlanProjection;
      /** The "overwrite these files" opt-in. */
      overwrite: boolean;
      submitting: boolean;
      notice: RewindNotice | undefined;
    }>
  | Readonly<{ phase: "done"; result: RolledBackResult }>;

export const REWIND_LOADING: RewindState = Object.freeze({ phase: "loading" });

export function afterPreview(response: PreviewRewindResponse): RewindState {
  if (response.status === "refused") return Object.freeze({ phase: "refused", reason: response.reason });
  return Object.freeze({
    phase: "ready",
    plan: response.plan,
    overwrite: false,
    submitting: false,
    notice: undefined,
  });
}

/** Files the rewind would overwrite although a later change of yours sits on them. */
export function overwriteTargets(plan: RewindPlanProjection): readonly string[] {
  if (plan.files.kind === "git") {
    return plan.files.conflicts.filter((conflict) => conflict.reason === "modified_after_run").map((conflict) => conflict.path);
  }
  return plan.files.runtimeConflicts;
}

export function needsOverwriteOptIn(plan: RewindPlanProjection): boolean {
  return overwriteTargets(plan).length > 0;
}

export function canConfirm(state: RewindState): boolean {
  if (state.phase !== "ready" || state.submitting) return false;
  return !needsOverwriteOptIn(state.plan) || state.overwrite;
}

export function toggleOverwrite(state: RewindState): RewindState {
  if (state.phase !== "ready" || state.submitting) return state;
  return Object.freeze({ ...state, overwrite: !state.overwrite });
}

export function beginSubmit(state: RewindState): RewindState {
  if (state.phase !== "ready") return state;
  return Object.freeze({ ...state, submitting: true, notice: undefined });
}

export function executeRequest(taskId: TaskId, state: Extract<RewindState, { readonly phase: "ready" }>): ExecuteRewindRequest {
  return Object.freeze({
    taskId,
    runId: state.plan.runId,
    scope: state.plan.scope,
    ...(needsOverwriteOptIn(state.plan) && state.overwrite ? { overwriteConflicts: true } : {}),
  });
}

function withConflicts(plan: RewindPlanProjection, conflicts: readonly RewindConflictProjection[]): RewindPlanProjection {
  if (plan.files.kind !== "git") return plan;
  return Object.freeze({ ...plan, files: Object.freeze({ ...plan.files, conflicts }) });
}

export function afterExecute(state: RewindState, response: ExecuteRewindResponse): RewindState {
  if (state.phase !== "ready") return state;
  switch (response.status) {
    case "rolled_back":
      return Object.freeze({ phase: "done", result: response });
    case "conflicts":
      // Files changed after the preview. Show the current list and ask for the opt-in again.
      return Object.freeze({
        phase: "ready",
        plan: withConflicts(state.plan, response.conflicts),
        overwrite: false,
        submitting: false,
        notice: Object.freeze({ kind: "conflicts" }),
      });
    case "refused":
      return Object.freeze({ phase: "refused", reason: response.reason });
  }
}

export function afterExecuteFailure(state: RewindState): RewindState {
  if (state.phase !== "ready") return state;
  return Object.freeze({ ...state, submitting: false, notice: Object.freeze({ kind: "failed" }) });
}

/** The dialog may be dismissed (Escape, backdrop, cancel) unless a rewind request is in flight. */
export function canDismiss(state: RewindState): boolean {
  return !(state.phase === "ready" && state.submitting);
}

/** Asks for the preview. A failed request is a state of its own, never a thrown error in the view. */
export async function loadRewindPreview(preview: () => Promise<PreviewRewindResponse>): Promise<RewindState> {
  try {
    return afterPreview(await preview());
  } catch {
    return Object.freeze({ phase: "failed" as const });
  }
}

/**
 * Runs the confirmed rewind: builds the request from the plan the person saw, sends it, and folds the
 * answer back into the state. `rolledBack` is set exactly when files and conversation were undone.
 */
export async function confirmRewind(
  taskId: TaskId,
  state: Extract<RewindState, { readonly phase: "ready" }>,
  execute: (request: ExecuteRewindRequest) => Promise<ExecuteRewindResponse>,
): Promise<Readonly<{ next: RewindState; rolledBack: RolledBackResult | undefined }>> {
  try {
    const response = await execute(executeRequest(taskId, state));
    return Object.freeze({
      next: afterExecute(beginSubmit(state), response),
      rolledBack: response.status === "rolled_back" ? response : undefined,
    });
  } catch {
    return Object.freeze({ next: afterExecuteFailure(beginSubmit(state)), rolledBack: undefined });
  }
}
