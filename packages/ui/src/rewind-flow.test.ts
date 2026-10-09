import assert from "node:assert/strict";
import test from "node:test";
import type { ExecuteRewindRequest, ExecuteRewindResponse, PreviewRewindResponse, TaskId } from "@guild/contracts";
import { gitPlan, runId } from "./checkpoint.fixture.js";
import {
  REWIND_LOADING,
  afterExecute,
  afterPreview,
  beginSubmit,
  canConfirm,
  canDismiss,
  confirmRewind,
  executeRequest,
  loadRewindPreview,
  needsOverwriteOptIn,
  overwriteTargets,
  toggleOverwrite,
  type RewindState,
} from "./rewind-flow.js";

const taskId = "t" as TaskId;
const ready = (state: RewindState) => {
  assert.equal(state.phase, "ready");
  return state as Extract<RewindState, { phase: "ready" }>;
};
const rolledBack: ExecuteRewindResponse = {
  status: "rolled_back", scope: "conversation_and_files", rolledBackRuns: [runId("r1")],
  restoredFiles: ["a"], removedFiles: ["b"], failedFiles: [], draftRestored: true,
};

test("a ready preview can be confirmed straight away when nothing was changed since", () => {
  const state = afterPreview({ status: "ready", plan: gitPlan() });
  assert.equal(ready(state).submitting, false);
  assert.equal(ready(state).overwrite, false);
  assert.equal(canConfirm(state), true);
  assert.equal(needsOverwriteOptIn(ready(state).plan), false);
});

test("a refused preview is its own state with the backend's reason", () => {
  const state = afterPreview({ status: "refused", reason: "run_active" });
  assert.deepEqual(state, { phase: "refused", reason: "run_active" });
  assert.equal(canConfirm(state), false);
  assert.equal(canConfirm(REWIND_LOADING), false);
});

test("files changed after the run need the explicit overwrite opt-in; a later run's changes do not", () => {
  const laterOnly = gitPlan({ conflicts: [{ path: "a.ts", reason: "later_run" }] });
  assert.equal(needsOverwriteOptIn(laterOnly), false);
  const modified = gitPlan({ conflicts: [{ path: "a.ts", reason: "later_run" }, { path: "b.ts", reason: "modified_after_run" }] });
  assert.deepEqual(overwriteTargets(modified), ["b.ts"]);
  let state = afterPreview({ status: "ready", plan: modified });
  assert.equal(canConfirm(state), false, "blocked until the box is ticked");
  state = toggleOverwrite(state);
  assert.equal(canConfirm(state), true);
  assert.equal(toggleOverwrite(state) !== state && canConfirm(toggleOverwrite(state)), false, "unticking blocks it again");
});

test("without a git checkpoint the runtime's own conflicts need the same opt-in", () => {
  const none = gitPlan({}, { files: { kind: "none", reason: "not_a_git_repo", runtimeRestore: ["a.ts"], runtimeConflicts: ["a.ts"] } });
  assert.equal(needsOverwriteOptIn(none), true);
  assert.deepEqual(overwriteTargets(none), ["a.ts"]);
  assert.equal(needsOverwriteOptIn(gitPlan({}, { files: { kind: "none", reason: "not_a_git_repo", runtimeRestore: [], runtimeConflicts: [] } })), false);
});

test("the request carries the plan's scope and overwriteConflicts only when the opt-in was needed and given", () => {
  const plain = ready(afterPreview({ status: "ready", plan: gitPlan() }));
  assert.deepEqual(executeRequest(taskId, plain), { taskId, runId: "r1", scope: "conversation_and_files" });
  const conflicted = ready(toggleOverwrite(afterPreview({
    status: "ready", plan: gitPlan({ conflicts: [{ path: "b.ts", reason: "modified_after_run" }] }),
  })));
  assert.equal(executeRequest(taskId, conflicted).overwriteConflicts, true);
  const filesOnly = ready(afterPreview({
    status: "ready",
    plan: gitPlan({}, { scope: "files_only", conversation: { available: false, reason: "unsupported" } }),
  }));
  assert.equal(executeRequest(taskId, filesOnly).scope, "files_only");
  assert.equal("overwriteConflicts" in executeRequest(taskId, plain), false);
});

test("a successful rewind ends in the done state with the backend's numbers", () => {
  const submitting = beginSubmit(afterPreview({ status: "ready", plan: gitPlan() }));
  assert.equal(ready(submitting).submitting, true);
  assert.equal(canConfirm(submitting), false, "no double submit");
  assert.equal(canDismiss(submitting), false, "cannot leave while it runs");
  const done = afterExecute(submitting, rolledBack);
  assert.equal(done.phase, "done");
  assert.equal(done.phase === "done" && done.result.draftRestored, true);
  assert.equal(canDismiss(done), true);
});

test("a conflicts answer returns to the ready state with the fresh list and the opt-in cleared", () => {
  const plan = gitPlan({ conflicts: [{ path: "old.ts", reason: "modified_after_run" }] });
  const confirmed = toggleOverwrite(afterPreview({ status: "ready", plan }));
  const next = ready(afterExecute(beginSubmit(confirmed), {
    status: "conflicts", conflicts: [{ path: "old.ts", reason: "modified_after_run" }, { path: "new.ts", reason: "modified_after_run" }],
  }));
  assert.equal(next.submitting, false);
  assert.equal(next.overwrite, false);
  assert.deepEqual(next.notice, { kind: "conflicts" });
  assert.deepEqual(overwriteTargets(next.plan), ["old.ts", "new.ts"]);
  assert.equal(canConfirm(next), false);
});

test("a refusal while executing replaces the dialog body with the reason", () => {
  const state = afterExecute(beginSubmit(afterPreview({ status: "ready", plan: gitPlan() })), { status: "refused", reason: "queue_not_empty" });
  assert.deepEqual(state, { phase: "refused", reason: "queue_not_empty" });
});

test("loadRewindPreview turns a thrown request into the failed state", async () => {
  const ok: PreviewRewindResponse = { status: "ready", plan: gitPlan() };
  assert.equal((await loadRewindPreview(async () => ok)).phase, "ready");
  assert.deepEqual(await loadRewindPreview(async () => ({ status: "refused", reason: "run_not_found" })), { phase: "refused", reason: "run_not_found" });
  assert.deepEqual(await loadRewindPreview(async () => { throw new Error("ipc"); }), { phase: "failed" });
});

test("confirmRewind sends exactly the planned request and reports the result once", async () => {
  const requests: ExecuteRewindRequest[] = [];
  const state = ready(afterPreview({ status: "ready", plan: gitPlan() }));
  const outcome = await confirmRewind(taskId, state, async (request) => { requests.push(request); return rolledBack; });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { taskId, runId: "r1", scope: "conversation_and_files" });
  assert.equal(outcome.next.phase, "done");
  assert.equal(outcome.rolledBack?.draftRestored, true);
});

test("confirmRewind folds conflicts, refusals and failures back into the dialog without reporting a rewind", async () => {
  const state = ready(afterPreview({ status: "ready", plan: gitPlan() }));
  const conflicts = await confirmRewind(taskId, state, async () => ({ status: "conflicts", conflicts: [{ path: "x", reason: "modified_after_run" }] }));
  assert.equal(conflicts.next.phase, "ready");
  assert.equal(conflicts.rolledBack, undefined);
  const refused = await confirmRewind(taskId, state, async () => ({ status: "refused", reason: "runtime_refused" }));
  assert.deepEqual(refused.next, { phase: "refused", reason: "runtime_refused" });
  const failed = await confirmRewind(taskId, state, async () => { throw new Error("ipc"); });
  assert.equal(failed.rolledBack, undefined);
  const failedState = ready(failed.next);
  assert.deepEqual(failedState.notice, { kind: "failed" });
  assert.equal(failedState.submitting, false);
  assert.equal(canConfirm(failedState), true, "a failed request can be tried again");
});

test("Escape, backdrop and Cancel are held back only while a rewind is running", () => {
  assert.equal(canDismiss(REWIND_LOADING), true);
  assert.equal(canDismiss(afterPreview({ status: "ready", plan: gitPlan() })), true);
  assert.equal(canDismiss(beginSubmit(afterPreview({ status: "ready", plan: gitPlan() }))), false);
});
