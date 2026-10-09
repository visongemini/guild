/**
 * Strings of the per-task git worktree (F3): the new-task option, the topbar chip and its menu, the
 * merge-back and discard dialogs. They live beside the feature, with their own catalog test, and are
 * looked up like the main catalog: `worktreeMessagesFor(locale)`.
 */

import type {
  GuildLocale,
  GuildWorktreeBlockReason,
  GuildWorktreeCreateRefusalReason,
  GuildWorktreeRefusalReason,
  GuildWorktreeStatus,
} from "@guild/contracts";

export type WorktreeMessages = {
  // New-task option.
  readonly startOption: string;
  readonly startOptionHelp: string;
  readonly startOptionPreparing: string;
  readonly startFallback: (reasonText: string) => string;
  readonly createRefusal: (reason: GuildWorktreeCreateRefusalReason) => string;
  // Topbar chip.
  readonly chipAhead: (count: number) => string;
  readonly chipDirty: (count: number, capped: boolean) => string;
  readonly chipApplied: string;
  readonly chipMissing: string;
  readonly chipDiscarded: string;
  readonly chipAria: (branch: string, baseBranch: string | undefined, status: GuildWorktreeStatus) => string;
  readonly sidebarTitle: (status: GuildWorktreeStatus) => string;
  // Chip menu.
  readonly menuMerge: (baseBranch: string | undefined) => string;
  readonly menuDiscard: string;
  readonly menuFinder: string;
  readonly menuTerminal: string;
  readonly menuRunning: string;
  readonly menuNote: string;
  readonly menuBranchLine: (branch: string, baseBranch: string | undefined) => string;
  readonly menuAria: string;
  // Banner above the composer.
  readonly bannerDiscarded: string;
  readonly bannerMissing: string;
  // Task menu.
  readonly taskMenuMerge: string;
  readonly taskMenuDiscard: string;
  // Merge-back dialog.
  readonly applyTitle: (baseBranch: string | undefined) => string;
  readonly applyBranch: (branch: string) => string;
  readonly applyChecking: string;
  readonly applyFiles: (files: number, adds: number, dels: number) => string;
  readonly applyNoFiles: string;
  readonly applyCommits: (count: number) => string;
  readonly applyUncommitted: (count: number) => string;
  readonly applyMoreFiles: (count: number) => string;
  readonly applyReady: (baseBranch: string) => string;
  readonly applyConfirm: (baseBranch: string | undefined) => string;
  readonly applyWorking: string;
  readonly applyConflictsTitle: string;
  readonly applyConflictsHelp: string;
  readonly applyConflictsRaced: string;
  readonly applyMoreConflicts: string;
  readonly applyBlockedTitle: string;
  readonly applyBlock: (reason: GuildWorktreeBlockReason, baseBranch: string | undefined, currentBranch: string | undefined) => string;
  readonly applyPathsMore: string;
  readonly applyRefusal: (reason: GuildWorktreeRefusalReason) => string;
  readonly applyFailed: (reason: "git_failed" | "timeout" | "repository_changed") => string;
  readonly applyUnexpected: string;
  readonly applyDoneTitle: (baseBranch: string) => string;
  readonly applyDoneBody: (mergeCommit: string, committed: boolean) => string;
  readonly applyDoneKept: string;
  readonly done: string;
  // Discard dialog.
  readonly discardTitle: string;
  readonly discardIntro: string;
  readonly discardFolder: string;
  readonly discardDirty: (count: number, capped: boolean) => string;
  readonly discardBranch: (branch: string, ahead: number) => string;
  readonly discardKeeps: string;
  readonly discardMergedNote: string;
  readonly discardConfirm: string;
  readonly discardWorking: string;
  readonly discardFailed: string;
  readonly discardRefusal: (reason: GuildWorktreeRefusalReason) => string;
};

const ZH_REFUSAL: Readonly<Record<GuildWorktreeRefusalReason, string>> = Object.freeze({
  no_worktree: "这个任务没有独立 worktree。",
  discarded: "这个 worktree 已经丢弃了。",
  run_active: "任务还在运行，等这一轮结束再试。",
  worktree_missing: "worktree 文件夹已经不在了，只能丢弃。",
  git_unavailable: "找不到 git。",
  git_too_old: "预检合并需要 git 2.38 或更新的版本。",
  timeout: "git 响应超时，什么都没有改动，可以稍后再试。",
  git_failed: "git 报错了，什么都没有改动。",
});

const EN_REFUSAL: Readonly<Record<GuildWorktreeRefusalReason, string>> = Object.freeze({
  no_worktree: "This task has no isolated worktree.",
  discarded: "This worktree was already discarded.",
  run_active: "The task is still running. Try again when this turn ends.",
  worktree_missing: "The worktree folder is gone; it can only be discarded.",
  git_unavailable: "git was not found.",
  git_too_old: "Checking a merge in advance needs git 2.38 or newer.",
  timeout: "git did not answer in time. Nothing was changed; try again later.",
  git_failed: "git reported an error. Nothing was changed.",
});

export const WORKTREE_ZH: WorktreeMessages = Object.freeze({
  startOption: "在独立 worktree 里做",
  startOptionHelp: "改动会留在单独的分支上，合并回主分支之前不会碰你现在的目录。",
  startOptionPreparing: "正在准备 worktree…",
  startFallback: (reasonText) => `没能创建独立 worktree：${reasonText}。已改为在原目录里做。`,
  createRefusal: (reason) => ({
    not_a_git_repo: "这个文件夹不在 git 仓库里",
    no_commits: "仓库还没有任何提交",
    git_unavailable: "找不到 git",
    timeout: "git 响应超时",
    git_failed: "git 报错了",
    workspace_not_in_commit: "这个文件夹还没有提交到仓库",
  })[reason],
  chipAhead: (count) => `领先 ${count}`,
  chipDirty: (count, capped) => `有 ${count}${capped ? "+" : ""} 处未提交`,
  chipApplied: "已合并",
  chipMissing: "目录已丢失",
  chipDiscarded: "已丢弃",
  chipAria: (branch, baseBranch, status) =>
    `独立 worktree，分支 ${branch}${baseBranch === undefined ? "" : `，基于 ${baseBranch}`}${status === "applied" ? "，已合并" : status === "missing" ? "，目录已丢失" : status === "discarded" ? "，已丢弃" : ""}`,
  sidebarTitle: (status) => status === "discarded" ? "独立 worktree（已丢弃）"
    : status === "missing" ? "独立 worktree（目录已丢失）"
    : status === "applied" ? "独立 worktree（已合并）"
    : "独立 worktree",
  menuMerge: (baseBranch) => baseBranch === undefined ? "合并回基础分支…" : `合并回 ${baseBranch}…`,
  menuDiscard: "丢弃这个 worktree…",
  menuFinder: "在 Finder 打开",
  menuTerminal: "在终端打开",
  menuRunning: "任务运行时不能合并或丢弃。",
  menuNote: "新建的 worktree 只含已提交的文件：没有 node_modules 这类被忽略的文件，也没有主目录里未提交的改动。",
  menuBranchLine: (branch, baseBranch) => baseBranch === undefined ? branch : `${branch}，基于 ${baseBranch}`,
  menuAria: "worktree 操作",
  bannerDiscarded: "这个 worktree 已经丢弃：对话仍可查看，但不能再发送消息。",
  bannerMissing: "worktree 文件夹已经不在了。可以把它放回原处，或在上方的分支菜单里丢弃它。",
  taskMenuMerge: "合并回基础分支…",
  taskMenuDiscard: "丢弃这个 worktree…",
  applyTitle: (baseBranch) => baseBranch === undefined ? "合并回基础分支" : `合并回 ${baseBranch}`,
  applyBranch: (branch) => `分支 ${branch}`,
  applyChecking: "正在检查能否干净合并，不会改动任何文件…",
  applyFiles: (files, adds, dels) => `${files} 个文件有改动，+${adds} −${dels}`,
  applyNoFiles: "没有文件改动。",
  applyCommits: (count) => `分支上已有 ${count} 个提交。`,
  applyUncommitted: (count) => `${count} 处未提交的改动会先以 “Guild” 的名义提交到这个分支。`,
  applyMoreFiles: (count) => `另有 ${count} 个文件没有列出。`,
  applyReady: (baseBranch) => `会在 ${baseBranch} 上新建一个合并提交。不会推送，也不会动其他分支。`,
  applyConfirm: (baseBranch) => baseBranch === undefined ? "合并" : `合并回 ${baseBranch}`,
  applyWorking: "正在合并…",
  applyConflictsTitle: "这次合并会产生冲突",
  applyConflictsHelp: "什么都没有改动。先在 worktree 里解决这些文件（可以让 Grok 处理），再回来合并。",
  applyConflictsRaced: "合并时出现了冲突，已经撤销，你的目录没有变化。冲突文件：",
  applyMoreConflicts: "还有更多冲突文件没有列出。",
  applyBlockedTitle: "现在还不能合并",
  applyBlock: (reason, baseBranch, currentBranch) => ({
    nothing_to_merge: "没有可合并的内容：分支上没有新提交，也没有未提交的改动。",
    no_base_branch: "创建 worktree 时主目录处于游离 HEAD（不在任何分支上），没有可合并回去的分支。",
    base_branch_missing: `基础分支${baseBranch === undefined ? "" : ` ${baseBranch}`} 已经不存在。`,
    source_missing: "找不到原来的仓库。",
    source_not_on_base_branch: currentBranch === undefined
      ? `主目录现在不在任何分支上，请先切回 ${baseBranch ?? "基础分支"}。`
      : `主目录现在在 ${currentBranch} 分支上，请先切回 ${baseBranch ?? "基础分支"}。`,
    source_operation_in_progress: "主目录正在进行合并、变基、cherry-pick 或还原，先把它完成或中止。",
    source_has_staged_changes: "主目录里有已暂存的改动，合并会把它们一起带进去。先提交，或取消暂存。",
    source_dirty_in_touched_paths: "主目录里这些文件有未提交的改动，而这次合并也要改它们。先提交、暂存起来，或还原。",
  })[reason],
  applyPathsMore: "…以及更多",
  applyRefusal: (reason) => ZH_REFUSAL[reason],
  applyFailed: (reason) => reason === "repository_changed"
    ? "合并之后主目录的状态和预期不一致，请用 git status 检查一下。"
    : reason === "timeout" ? "git 响应超时。请先用 git status 确认主目录的状态再重试。"
    : "git 报错了。请用 git status 确认主目录的状态。",
  applyUnexpected: "没能完成合并。",
  applyDoneTitle: (baseBranch) => `已合并回 ${baseBranch}`,
  applyDoneBody: (mergeCommit, committed) =>
    `合并提交 ${mergeCommit}。${committed ? "未提交的改动已先提交到分支。" : ""}`,
  applyDoneKept: "worktree 和分支都保留着，任务可以继续在里面做。不需要时再丢弃。",
  done: "完成",
  discardTitle: "丢弃这个 worktree？",
  discardIntro: "下面这些会被永久删除，无法撤销：",
  discardFolder: "worktree 文件夹，里面的所有文件",
  discardDirty: (count, capped) => `其中还有 ${count}${capped ? "+" : ""} 处未提交的改动`,
  discardBranch: (branch, ahead) => ahead > 0
    ? `分支 ${branch}，包含 ${ahead} 个还没合并的提交`
    : `分支 ${branch}`,
  discardKeeps: "对话会保留，仍可查看；但这个任务不能再发送消息。",
  discardMergedNote: "改动已经合并回去了，丢弃只是清理。",
  discardConfirm: "丢弃",
  discardWorking: "正在丢弃…",
  discardFailed: "没能丢弃这个 worktree。",
  discardRefusal: (reason) => ZH_REFUSAL[reason],
});

export const WORKTREE_EN: WorktreeMessages = Object.freeze({
  startOption: "Work in an isolated worktree",
  startOptionHelp: "Changes stay on a separate branch until you merge them back; your current folder is not touched.",
  startOptionPreparing: "Preparing the worktree…",
  startFallback: (reasonText) => `Could not create an isolated worktree: ${reasonText}. The task works in the original folder instead.`,
  createRefusal: (reason) => ({
    not_a_git_repo: "this folder is not in a git repository",
    no_commits: "the repository has no commits yet",
    git_unavailable: "git was not found",
    timeout: "git did not answer in time",
    git_failed: "git reported an error",
    workspace_not_in_commit: "this folder is not committed to the repository",
  })[reason],
  chipAhead: (count) => `${count} ahead`,
  chipDirty: (count, capped) => `${count}${capped ? "+" : ""} uncommitted`,
  chipApplied: "Merged",
  chipMissing: "Folder missing",
  chipDiscarded: "Discarded",
  chipAria: (branch, baseBranch, status) =>
    `Isolated worktree, branch ${branch}${baseBranch === undefined ? "" : `, based on ${baseBranch}`}${status === "applied" ? ", merged" : status === "missing" ? ", folder missing" : status === "discarded" ? ", discarded" : ""}`,
  sidebarTitle: (status) => status === "discarded" ? "Isolated worktree (discarded)"
    : status === "missing" ? "Isolated worktree (folder missing)"
    : status === "applied" ? "Isolated worktree (merged)"
    : "Isolated worktree",
  menuMerge: (baseBranch) => baseBranch === undefined ? "Merge back to the base branch…" : `Merge back to ${baseBranch}…`,
  menuDiscard: "Discard this worktree…",
  menuFinder: "Show in Finder",
  menuTerminal: "Open in Terminal",
  menuRunning: "Merging or discarding is not possible while the task is running.",
  menuNote: "A fresh worktree has only committed files: no ignored files such as node_modules, and none of the uncommitted changes from your folder.",
  menuBranchLine: (branch, baseBranch) => baseBranch === undefined ? branch : `${branch}, based on ${baseBranch}`,
  menuAria: "Worktree actions",
  bannerDiscarded: "This worktree was discarded: the conversation stays readable, but messages can no longer be sent.",
  bannerMissing: "The worktree folder is gone. Put it back where it was, or discard it from the branch menu above.",
  taskMenuMerge: "Merge back to the base branch…",
  taskMenuDiscard: "Discard this worktree…",
  applyTitle: (baseBranch) => baseBranch === undefined ? "Merge back" : `Merge back to ${baseBranch}`,
  applyBranch: (branch) => `Branch ${branch}`,
  applyChecking: "Checking for a clean merge. No file is changed…",
  applyFiles: (files, adds, dels) => `${files} ${files === 1 ? "file" : "files"} changed, +${adds} −${dels}`,
  applyNoFiles: "No files changed.",
  applyCommits: (count) => `${count} ${count === 1 ? "commit" : "commits"} on the branch already.`,
  applyUncommitted: (count) => `${count} uncommitted ${count === 1 ? "change" : "changes"} will be committed to this branch first, as “Guild”.`,
  applyMoreFiles: (count) => `${count} more ${count === 1 ? "file" : "files"} not listed.`,
  applyReady: (baseBranch) => `A merge commit is created on ${baseBranch}. Nothing is pushed and no other branch is touched.`,
  applyConfirm: (baseBranch) => baseBranch === undefined ? "Merge" : `Merge into ${baseBranch}`,
  applyWorking: "Merging…",
  applyConflictsTitle: "This merge would conflict",
  applyConflictsHelp: "Nothing was changed. Resolve these files in the worktree first (Grok can do it), then merge.",
  applyConflictsRaced: "The merge hit a conflict at the last moment and was undone; your folder is unchanged. Conflicting files:",
  applyMoreConflicts: "More conflicting files are not listed.",
  applyBlockedTitle: "Not possible right now",
  applyBlock: (reason, baseBranch, currentBranch) => ({
    nothing_to_merge: "Nothing to merge: the branch has no new commits and nothing is uncommitted.",
    no_base_branch: "Your folder was on a detached HEAD when the worktree was created, so there is no branch to merge back into.",
    base_branch_missing: `The base branch${baseBranch === undefined ? "" : ` ${baseBranch}`} no longer exists.`,
    source_missing: "The original repository cannot be found.",
    source_not_on_base_branch: currentBranch === undefined
      ? `Your folder is not on any branch. Switch back to ${baseBranch ?? "the base branch"} first.`
      : `Your folder is on ${currentBranch}. Switch back to ${baseBranch ?? "the base branch"} first.`,
    source_operation_in_progress: "A merge, rebase, cherry-pick or revert is in progress in your folder. Finish or abort it first.",
    source_has_staged_changes: "Your folder has staged changes, and git would fold them into the merge. Commit them or unstage them first.",
    source_dirty_in_touched_paths: "Your folder has uncommitted changes in files this merge also changes. Commit, stash or revert them first.",
  })[reason],
  applyPathsMore: "…and more",
  applyRefusal: (reason) => EN_REFUSAL[reason],
  applyFailed: (reason) => reason === "repository_changed"
    ? "After the merge your folder is not in the expected state. Check it with git status."
    : reason === "timeout" ? "git did not answer in time. Check your folder with git status before trying again."
    : "git reported an error. Check your folder with git status.",
  applyUnexpected: "The merge did not complete.",
  applyDoneTitle: (baseBranch) => `Merged into ${baseBranch}`,
  applyDoneBody: (mergeCommit, committed) =>
    `Merge commit ${mergeCommit}.${committed ? " Uncommitted changes were committed to the branch first." : ""}`,
  applyDoneKept: "The worktree and branch are kept, and the task can keep working in it. Discard it when you no longer need it.",
  done: "Done",
  discardTitle: "Discard this worktree?",
  discardIntro: "This permanently deletes the following and cannot be undone:",
  discardFolder: "The worktree folder and every file in it",
  discardDirty: (count, capped) => `including ${count}${capped ? "+" : ""} uncommitted ${count === 1 && !capped ? "change" : "changes"}`,
  discardBranch: (branch, ahead) => ahead > 0
    ? `Branch ${branch}, with ${ahead} ${ahead === 1 ? "commit" : "commits"} not merged yet`
    : `Branch ${branch}`,
  discardKeeps: "The conversation is kept and stays readable, but the task cannot send messages any more.",
  discardMergedNote: "The changes are already merged back; discarding only cleans up.",
  discardConfirm: "Discard",
  discardWorking: "Discarding…",
  discardFailed: "The worktree could not be discarded.",
  discardRefusal: (reason) => EN_REFUSAL[reason],
});

export function worktreeMessagesFor(locale: GuildLocale): WorktreeMessages {
  return locale === "zh-CN" ? WORKTREE_ZH : WORKTREE_EN;
}
