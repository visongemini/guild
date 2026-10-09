import assert from "node:assert/strict";
import test from "node:test";
import type { TaskWorktreeProjection } from "@guild/contracts";
import { WORKTREE_EN, WORKTREE_ZH, worktreeMessagesFor } from "./worktree-messages.js";
import {
  WORKTREE_PREFERENCE_KEY,
  readWorktreePreferences,
  worktreeChipParts,
  worktreeCreateRefusalOf,
  worktreeDiscardFacts,
  worktreeMenuState,
  worktreeRefusalIsLasting,
  writeWorktreePreference,
} from "./worktree-state.js";

const worktree = (patch: Partial<TaskWorktreeProjection> = {}): TaskWorktreeProjection => ({
  status: "active", branch: "guild/task-1a2b3c4d", baseBranch: "main", ahead: 0, behind: 0, dirtyFiles: 0, measured: true, ...patch,
});

test("the chip shows commits ahead and uncommitted files, and nothing before git has answered", () => {
  const zh = worktreeMessagesFor("zh-CN");
  assert.deepEqual(worktreeChipParts(worktree({ ahead: 2, dirtyFiles: 3 }), zh).map((part) => part.text), ["领先 2", "有 3 处未提交"]);
  assert.deepEqual(worktreeChipParts(worktree({ ahead: 2 }), zh).map((part) => part.kind), ["ahead"]);
  assert.deepEqual(worktreeChipParts(worktree({ dirtyFiles: 1 }), zh).map((part) => part.kind), ["dirty"]);
  assert.deepEqual(worktreeChipParts(worktree(), zh), []);
  assert.deepEqual(worktreeChipParts(worktree({ ahead: 5, dirtyFiles: 9, measured: false }), zh), []);
  const en = worktreeMessagesFor("en-US");
  assert.deepEqual(worktreeChipParts(worktree({ ahead: 1, dirtyFiles: 12, dirtyFilesCapped: true }), en).map((part) => part.text), ["1 ahead", "12+ uncommitted"]);
});

test("a merged, missing or discarded worktree says so instead of the numbers", () => {
  const en = worktreeMessagesFor("en-US");
  assert.deepEqual(worktreeChipParts(worktree({ status: "applied" }), en), [{ kind: "applied", text: "Merged" }]);
  assert.deepEqual(worktreeChipParts(worktree({ status: "applied", measured: false }), en), [{ kind: "applied", text: "Merged" }]);
  assert.deepEqual(worktreeChipParts(worktree({ status: "missing", ahead: 3 }), en), [{ kind: "missing", text: "Folder missing" }]);
  assert.deepEqual(worktreeChipParts(worktree({ status: "discarded", dirtyFiles: 3 }), en), [{ kind: "discarded", text: "Discarded" }]);
});

test("merge and discard are off while a Run is active, open actions only while the folder exists", () => {
  assert.deepEqual(worktreeMenuState(worktree(), false), { interactive: true, canMerge: true, canDiscard: true, canOpen: true, blockedByRun: false });
  assert.deepEqual(worktreeMenuState(worktree(), true), { interactive: true, canMerge: false, canDiscard: false, canOpen: true, blockedByRun: true });
  assert.deepEqual(worktreeMenuState(worktree({ status: "applied" }), false), { interactive: true, canMerge: true, canDiscard: true, canOpen: true, blockedByRun: false });
  assert.deepEqual(worktreeMenuState(worktree({ status: "missing" }), false), { interactive: true, canMerge: false, canDiscard: true, canOpen: false, blockedByRun: false });
  assert.deepEqual(worktreeMenuState(worktree({ status: "discarded" }), false), { interactive: false, canMerge: false, canDiscard: false, canOpen: false, blockedByRun: false });
  assert.equal(worktreeMenuState(worktree({ status: "discarded" }), true).blockedByRun, false);
});

test("the discard dialog lists what is lost, and treats a merged clean worktree as a cleanup", () => {
  assert.deepEqual(worktreeDiscardFacts(worktree({ ahead: 2, dirtyFiles: 3 })), {
    branch: "guild/task-1a2b3c4d", dirtyFiles: 3, dirtyCapped: false, ahead: 2, mergedAndClean: false,
  });
  assert.equal(worktreeDiscardFacts(worktree({ status: "applied" })).mergedAndClean, true);
  assert.equal(worktreeDiscardFacts(worktree({ status: "applied", dirtyFiles: 1 })).mergedAndClean, false);
  assert.equal(worktreeDiscardFacts(worktree({ status: "applied", measured: false })).mergedAndClean, false, "unmeasured is not known to be clean");
  const unknown = worktreeDiscardFacts(worktree({ measured: false, ahead: 4, dirtyFiles: 4 }));
  assert.deepEqual([unknown.ahead, unknown.dirtyFiles], [0, 0]);
  assert.deepEqual([worktreeDiscardFacts(worktree({ status: "missing", dirtyFiles: 4 })).dirtyFiles], [0]);
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

test("the new-task choice is remembered per workspace and survives garbage and a failing store", () => {
  const storage = memoryStorage();
  assert.equal(readWorktreePreferences(storage).size, 0);
  assert.deepEqual([...writeWorktreePreference(storage, "ws-a", true)], [["ws-a", true]]);
  assert.deepEqual([...writeWorktreePreference(storage, "ws-b", false)], [["ws-a", true], ["ws-b", false]]);
  assert.deepEqual([...writeWorktreePreference(storage, "ws-a", false)], [["ws-b", false], ["ws-a", false]]);
  assert.deepEqual([...readWorktreePreferences(storage)], [["ws-b", false], ["ws-a", false]]);

  for (const garbage of ["not json", "[]", "null", "42", "{\"a\": 1, \"b\": \"yes\", \"c\": true}"]) {
    const entries = [...readWorktreePreferences(memoryStorage({ [WORKTREE_PREFERENCE_KEY]: garbage }))];
    assert.deepEqual(entries, garbage.includes("\"c\"") ? [["c", true]] : [], garbage);
  }
  const throwing = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("full"); },
  };
  assert.equal(readWorktreePreferences(throwing).size, 0);
  assert.deepEqual([...writeWorktreePreference(throwing, "ws-a", true)], [["ws-a", true]]);

  const many = memoryStorage();
  for (let index = 0; index < 260; index += 1) writeWorktreePreference(many, `ws-${index}`, index % 2 === 0);
  assert.equal(readWorktreePreferences(many).size, 200);
});

test("a refused creation is recognised from the error message and nothing else", () => {
  assert.equal(worktreeCreateRefusalOf(new Error("Error invoking remote method 'guild:v1:task:create': Error: worktree_not_a_git_repo")), "not_a_git_repo");
  assert.equal(worktreeCreateRefusalOf(new Error("worktree_no_commits")), "no_commits");
  assert.equal(worktreeCreateRefusalOf(new Error("worktree_workspace_not_in_commit")), "workspace_not_in_commit");
  assert.equal(worktreeCreateRefusalOf(new Error("guild_operation_failed")), undefined);
  assert.equal(worktreeCreateRefusalOf(new Error("worktree_unavailable")), undefined, "the open-resource error is not a creation refusal");
  assert.equal(worktreeCreateRefusalOf("worktree_git_failed"), "git_failed");
  assert.equal(worktreeCreateRefusalOf(undefined), undefined);
  assert.equal(worktreeRefusalIsLasting("not_a_git_repo"), true);
  assert.equal(worktreeRefusalIsLasting("no_commits"), true);
  assert.equal(worktreeRefusalIsLasting("timeout"), false);
});

test("Chinese and English worktree catalogs have the same keys and non-empty text", () => {
  assert.deepEqual(Object.keys(WORKTREE_ZH).sort(), Object.keys(WORKTREE_EN).sort());
  for (const messages of [WORKTREE_ZH, WORKTREE_EN]) {
    const samples: string[] = [
      messages.startOption, messages.startOptionHelp, messages.startOptionPreparing, messages.startFallback("x"),
      messages.chipAhead(2), messages.chipDirty(3, false), messages.chipDirty(3, true), messages.chipApplied,
      messages.chipMissing, messages.chipDiscarded, messages.chipAria("guild/x", "main", "active"), messages.chipAria("guild/x", undefined, "missing"),
      messages.menuMerge("main"), messages.menuMerge(undefined), messages.menuDiscard, messages.menuFinder, messages.menuTerminal,
      messages.menuRunning, messages.menuNote, messages.menuBranchLine("guild/x", "main"), messages.menuAria,
      messages.bannerDiscarded, messages.bannerMissing, messages.taskMenuMerge, messages.taskMenuDiscard,
      messages.applyTitle("main"), messages.applyTitle(undefined), messages.applyBranch("guild/x"), messages.applyChecking,
      messages.applyFiles(2, 3, 4), messages.applyNoFiles, messages.applyCommits(2), messages.applyUncommitted(3),
      messages.applyMoreFiles(5), messages.applyReady("main"), messages.applyConfirm("main"), messages.applyConfirm(undefined),
      messages.applyWorking, messages.applyConflictsTitle, messages.applyConflictsHelp, messages.applyConflictsRaced,
      messages.applyMoreConflicts, messages.applyBlockedTitle, messages.applyPathsMore, messages.applyUnexpected,
      messages.applyDoneTitle("main"), messages.applyDoneBody("abc", true), messages.applyDoneBody("abc", false),
      messages.applyDoneKept, messages.done, messages.discardTitle, messages.discardIntro, messages.discardFolder,
      messages.discardDirty(2, false), messages.discardBranch("guild/x", 0), messages.discardBranch("guild/x", 3),
      messages.discardKeeps, messages.discardMergedNote, messages.discardConfirm, messages.discardWorking, messages.discardFailed,
    ];
    for (const status of ["active", "applied", "discarded", "missing"] as const) samples.push(messages.sidebarTitle(status));
    for (const reason of ["not_a_git_repo", "no_commits", "git_unavailable", "timeout", "git_failed", "workspace_not_in_commit"] as const) {
      samples.push(messages.createRefusal(reason));
    }
    for (const reason of ["nothing_to_merge", "no_base_branch", "base_branch_missing", "source_missing", "source_not_on_base_branch",
      "source_operation_in_progress", "source_has_staged_changes", "source_dirty_in_touched_paths"] as const) {
      samples.push(messages.applyBlock(reason, "main", "dev"), messages.applyBlock(reason, undefined, undefined));
    }
    for (const reason of ["no_worktree", "discarded", "run_active", "worktree_missing", "git_unavailable", "git_too_old", "timeout", "git_failed"] as const) {
      samples.push(messages.applyRefusal(reason), messages.discardRefusal(reason));
    }
    for (const reason of ["git_failed", "timeout", "repository_changed"] as const) samples.push(messages.applyFailed(reason));
    for (const text of samples) {
      assert.ok(text.length > 0, "empty string");
      assert.ok(!text.includes("undefined") && !text.includes("[object"), text);
    }
  }
});

test("a blocked merge names the branch the checkout is on", () => {
  assert.match(WORKTREE_EN.applyBlock("source_not_on_base_branch", "main", "dev"), /dev.*main/u);
  assert.match(WORKTREE_ZH.applyBlock("source_not_on_base_branch", "main", "dev"), /dev.*main/u);
  assert.match(WORKTREE_EN.applyBlock("source_not_on_base_branch", "main", undefined), /not on any branch/u);
});
