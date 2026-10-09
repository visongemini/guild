import type {
  GuildCheckpointUnavailableReason,
  GuildInterjectionState,
  GuildRewindIrreversibleKind,
  GuildRewindRefusalReason,
  GuildSteerFallbackReason,
  RewindAvailabilityProjection,
  RunFileChangeStatus,
} from "@guild/contracts";
import { zhModelDescription } from "./model-descriptions.js";

// F2 (changed files, rewind) and F4 (Steer) strings. Kept in their own module, like the workshop strings, so the
// two catalogs in locales.ts only gain a spread and the UI round stays easy to merge.

type UnavailableAvailability = Extract<RewindAvailabilityProjection, { readonly available: false }>["reason"];
export type SteerNoticeKind = "queued" | "started" | "unchanged";
type RewindConflictReason = "later_run" | "modified_after_run";

export type ChangeMessages = {
  // The per-run changed-files card
  readonly changesTitle: (count: number) => string;
  readonly changesCapturing: string;
  readonly changesUnavailable: (reason: GuildCheckpointUnavailableReason | undefined) => string;
  readonly changesViewDiff: string;
  readonly changesRewind: string;
  readonly changesRolledBack: string;
  readonly changesTruncated: (listed: number, total: number) => string;
  readonly changesShowAll: (total: number) => string;
  readonly changesShowLess: string;
  readonly changesBinary: string;
  readonly changesStatusLabel: (status: RunFileChangeStatus) => string;
  readonly changesRenamedFrom: (oldPath: string) => string;
  readonly changesOpenFileDiff: (path: string) => string;
  readonly rewindDisabledReason: (reason: UnavailableAvailability) => string;
  // The topbar summary
  readonly changesSummaryLabel: string;
  readonly changesSummaryTitle: (files: number) => string;
  // The unified diff view in the workbench
  readonly runDiffHeading: (ordinal: number) => string;
  readonly runDiffFiles: string;
  readonly runDiffClose: string;
  readonly runDiffLoading: string;
  readonly runDiffBinary: string;
  readonly runDiffTruncated: string;
  readonly runDiffEmpty: string;
  readonly runDiffUnavailable: (reason: "no_checkpoint" | "not_in_run" | "git_failed") => string;
  readonly runDiffFailed: string;
  readonly runDiffRetry: string;
  // The rewind dialog
  readonly rewindTitle: string;
  readonly rewindLoading: string;
  readonly rewindIntro: (laterRuns: number) => string;
  readonly rewindFilesOnlyTitle: string;
  readonly rewindFilesOnlyBody: (reason: "unsupported" | "runtime_unavailable") => string;
  readonly rewindRestoreHeading: (count: number) => string;
  readonly rewindRemoveHeading: (count: number) => string;
  readonly rewindNoFileChanges: string;
  readonly rewindListTruncated: string;
  readonly rewindNoCheckpoint: (reason: GuildCheckpointUnavailableReason | "no_checkpoint_row") => string;
  readonly rewindRuntimeRestoreHeading: (count: number) => string;
  readonly rewindConflictsHeading: (count: number) => string;
  readonly rewindConflictReason: (reason: RewindConflictReason) => string;
  readonly rewindOverwriteLabel: string;
  readonly rewindOverwriteNeeded: string;
  readonly rewindConflictsChanged: string;
  readonly rewindCannotUndoHeading: string;
  readonly rewindCannotUndoKind: (kind: GuildRewindIrreversibleKind) => string;
  readonly rewindConfirm: string;
  readonly rewindConfirmFilesOnly: string;
  readonly rewindWorking: string;
  readonly rewindRefused: (reason: GuildRewindRefusalReason) => string;
  readonly rewindFailed: string;
  readonly rewindRetry: string;
  readonly rewindDoneTitle: string;
  readonly rewindDoneConversation: (runs: number, restored: number, removed: number) => string;
  readonly rewindDoneFilesOnly: (restored: number, removed: number) => string;
  readonly rewindDraftBack: string;
  readonly rewindFailedFiles: (count: number) => string;
  readonly rewindDone: string;
  // Rolled-back runs in the timeline
  readonly rolledBackTag: string;
  readonly rolledBackRuns: (count: number) => string;
  readonly rolledBackExpandHint: string;
  // Steer
  readonly steerAction: string;
  readonly steerShortcut: string;
  readonly steerHelp: string;
  readonly steerNeedsText: string;
  readonly hintSteer: string;
  readonly queueSteerPlaceholder: string;
  readonly interjectionTag: string;
  readonly interjectionState: (state: GuildInterjectionState) => string;
  readonly interjectionReason: (reason: GuildSteerFallbackReason) => string;
  readonly convertToSteer: string;
  readonly convertToSteerHelp: string;
  readonly preemptQueuedHelp: string;
  readonly steerNotice: (kind: SteerNoticeKind, reason: GuildSteerFallbackReason) => string;
  /** The Chinese description for a model id the catalog lists; undefined for ids it does not know (the official text then stays). */
  readonly modelDescription: (modelId: string, officialDescription: string | undefined) => string | undefined;
};

const ZH_UNAVAILABLE: Readonly<Record<GuildCheckpointUnavailableReason, string>> = Object.freeze({
  not_a_git_repo: "不是 git 仓库，无法统计改动",
  git_unavailable: "没有找到 git，无法统计改动",
  timeout: "统计改动超时，这一轮没有记录",
  too_many_files: "文件太多，这一轮没有统计改动",
  too_large: "改动体积太大，这一轮没有统计",
  git_failed: "git 出错了，这一轮没有统计改动",
  unsafe_task_id: "这个任务暂时不能统计改动",
  capture_skipped: "这一轮没有记录改动",
});
const EN_UNAVAILABLE: Readonly<Record<GuildCheckpointUnavailableReason, string>> = Object.freeze({
  not_a_git_repo: "Not a git repository, so changes are not tracked",
  git_unavailable: "git was not found, so changes are not tracked",
  timeout: "Tracking timed out, so this turn has no change record",
  too_many_files: "Too many files, so this turn's changes were not tracked",
  too_large: "The changes are too large to track for this turn",
  git_failed: "git failed, so this turn's changes were not tracked",
  unsafe_task_id: "Changes cannot be tracked for this task right now",
  capture_skipped: "This turn's changes were not recorded",
});

const ZH_REWIND_REFUSED: Readonly<Record<GuildRewindRefusalReason, string>> = Object.freeze({
  run_active: "任务还在运行，停止或等它结束后才能退回。",
  queue_not_empty: "还有排队的消息，清空队列后才能退回。",
  run_not_found: "找不到这一轮，可能已经被删除。",
  already_rolled_back: "这一轮已经退回过了。",
  runtime_unavailable: "Grok 暂时不可用，稍后再试。",
  prompt_index_mismatch: "Grok 的提问记录和 Guild 的对不上，为了安全不能退回这一轮。",
  runtime_refused: "Grok 没有同意退回对话，文件没有被改动。",
  session_replaced: "这一轮属于以前的会话，当前会话已经换过了，不能退回。",
  nothing_to_rewind: "这一轮没有可以退回的内容。",
  conversation_rewind_unsupported: "当前 Grok 版本不能退回对话，这个文件夹也没有检查点，所以没有可退回的内容。",
});
const EN_REWIND_REFUSED: Readonly<Record<GuildRewindRefusalReason, string>> = Object.freeze({
  run_active: "The task is still running. Stop it or wait for it to finish first.",
  queue_not_empty: "There are queued messages. Clear the queue first.",
  run_not_found: "This turn could not be found. It may have been deleted.",
  already_rolled_back: "This turn was already rewound.",
  runtime_unavailable: "Grok is unavailable right now. Try again in a moment.",
  prompt_index_mismatch: "Grok's prompt record does not line up with Guild's, so this turn cannot be rewound safely.",
  runtime_refused: "Grok declined to rewind the conversation. No file was touched.",
  session_replaced: "This turn belongs to an earlier session that is no longer live, so it cannot be rewound.",
  nothing_to_rewind: "There is nothing to rewind for this turn.",
  conversation_rewind_unsupported: "This Grok version cannot rewind the conversation and the folder has no checkpoint, so there is nothing to rewind.",
});

const ZH_FALLBACK: Readonly<Record<GuildSteerFallbackReason, string>> = Object.freeze({
  unsupported: "当前 Grok 版本不支持插话",
  turn_not_running: "这一轮已经结束",
  turn_not_steerable: "这一轮暂时不能插话",
  runtime_error: "Grok 没有收下这条插话",
});
const EN_FALLBACK: Readonly<Record<GuildSteerFallbackReason, string>> = Object.freeze({
  unsupported: "this Grok version cannot take messages mid-turn",
  turn_not_running: "the turn had already ended",
  turn_not_steerable: "the turn cannot take a message right now",
  runtime_error: "Grok did not accept it",
});

export function createChangeMessages(locale: "zh-CN" | "en-US"): ChangeMessages {
  return locale === "zh-CN" ? zhMessages() : enMessages();
}

function zhMessages(): ChangeMessages {
  return {
    changesTitle: (count) => `本轮改了 ${count} 个文件`,
    changesCapturing: "正在统计改动…",
    changesUnavailable: (reason) => reason === undefined ? "无法统计这一轮的改动" : ZH_UNAVAILABLE[reason],
    changesViewDiff: "查看差异",
    changesRewind: "退回到这轮之前",
    changesRolledBack: "已退回",
    changesTruncated: (listed, total) => `只列出了前 ${listed} 个，合计已包含全部 ${total} 个文件`,
    changesShowAll: (total) => `显示全部 ${total} 个文件`,
    changesShowLess: "收起",
    changesBinary: "二进制",
    changesStatusLabel: (status) => ({ A: "新增", M: "修改", D: "删除", R: "重命名" })[status],
    changesRenamedFrom: (oldPath) => `从 ${oldPath} 重命名`,
    changesOpenFileDiff: (path) => `查看 ${path} 的差异`,
    rewindDisabledReason: (reason) => ({
      run_active: "这一轮还在运行，停止或结束后才能退回",
      queue_not_empty: "还有排队的消息，清空后才能退回",
      runtime_unavailable: "Grok 暂时不可用，稍后再试",
      no_checkpoints: "这个任务没有可退回的检查点",
    })[reason],
    changesSummaryLabel: "改动",
    changesSummaryTitle: (files) => `跳到最近一轮的改动（${files} 个文件）`,
    runDiffHeading: (ordinal) => `第 ${ordinal} 轮的改动`,
    runDiffFiles: "文件",
    runDiffClose: "关闭这一轮的差异",
    runDiffLoading: "正在读取差异…",
    runDiffBinary: "二进制文件，不显示差异",
    runDiffTruncated: "差异太长，只显示了前 256 KB",
    runDiffEmpty: "这个文件没有可显示的文本差异",
    runDiffUnavailable: (reason) => ({
      no_checkpoint: "这一轮没有可用的检查点，读不到差异",
      not_in_run: "这个文件不在这一轮的改动里",
      git_failed: "git 读取差异失败，稍后再试",
    })[reason],
    runDiffFailed: "读取差异失败",
    runDiffRetry: "重试",
    rewindTitle: "退回到这轮之前",
    rewindLoading: "正在检查可以退回的内容…",
    rewindIntro: (laterRuns) => laterRuns > 0
      ? `把对话和文件都恢复到这一轮开始之前。这一轮之后的 ${laterRuns} 轮也会一起撤销。`
      : "把对话和文件都恢复到这一轮开始之前。",
    rewindFilesOnlyTitle: "只还原文件",
    rewindFilesOnlyBody: (reason) => reason === "unsupported"
      ? "当前 Grok 版本不能退回对话，所以只能把文件还原到这一轮之前。对话记录保持不变，这一轮的提问也不会放回输入框。"
      : "Grok 暂时不能退回对话，现在只能把文件还原到这一轮之前。对话记录保持不变，这一轮的提问也不会放回输入框。",
    rewindRestoreHeading: (count) => `将恢复 ${count} 个文件`,
    rewindRemoveHeading: (count) => `将删除 ${count} 个这一轮新增的文件`,
    rewindNoFileChanges: "没有文件需要改动。",
    rewindListTruncated: "文件很多，这里只列出了一部分。",
    rewindNoCheckpoint: (reason) => reason === "not_a_git_repo"
      ? "这个文件夹不是 git 仓库，没有检查点。命令行造成的文件改动无法还原。"
      : "这一轮没有 git 检查点。命令行造成的文件改动无法还原。",
    rewindRuntimeRestoreHeading: (count) => `Grok 的编辑快照可以还原 ${count} 个文件`,
    rewindConflictsHeading: (count) => `${count} 个文件在这一轮之后又被改过`,
    rewindConflictReason: (reason) => reason === "later_run"
      ? "被之后的轮次改过，会一起撤销"
      : "之后被你或别的程序改过，退回会覆盖这些改动",
    rewindOverwriteLabel: "覆盖这些文件",
    rewindOverwriteNeeded: "勾选后才能继续。被覆盖的改动找不回来。",
    rewindConflictsChanged: "你预览之后，又有文件被改过了。请确认下面的文件，再决定要不要覆盖。",
    rewindCannotUndoHeading: "这些无法撤销",
    rewindCannotUndoKind: (kind) => ({
      network_and_mcp_effects: "已发出的网络请求、MCP 工具调用，以及对其他服务造成的影响。",
      git_commits_and_pushes: "命令已经做出的 git 提交、推送、分支和 stash 变更。",
      memory_writes: "Agent 写进记忆的内容。",
      shell_file_changes_without_git: "没有 git 检查点，命令行造成的文件改动无法还原。",
    })[kind],
    rewindConfirm: "退回",
    rewindConfirmFilesOnly: "还原文件",
    rewindWorking: "正在退回…",
    rewindRefused: (reason) => ZH_REWIND_REFUSED[reason],
    rewindFailed: "退回没有完成，请重试。",
    rewindRetry: "重试",
    rewindDoneTitle: "已退回",
    rewindDoneConversation: (runs, restored, removed) =>
      `已撤销 ${runs} 轮，还原了 ${restored} 个文件，删除了 ${removed} 个。`,
    rewindDoneFilesOnly: (restored, removed) =>
      `文件已还原到这一轮之前，还原了 ${restored} 个，删除了 ${removed} 个。对话保持不变。`,
    rewindDraftBack: "被撤销的提问已放回输入框，改一改就能重新发送。",
    rewindFailedFiles: (count) => `${count} 个文件没能还原`,
    rewindDone: "完成",
    rolledBackTag: "已退回",
    rolledBackRuns: (count) => `${count} 轮已撤销`,
    rolledBackExpandHint: "展开查看已撤销的内容",
    steerAction: "插话",
    steerShortcut: "⌥↩",
    steerHelp: "把这条消息直接告诉正在进行的这一轮，不打断它",
    steerNeedsText: "先输入要插话的内容",
    hintSteer: "运行中插话",
    queueSteerPlaceholder: "回车排队，⌥↩ 直接插话…",
    interjectionTag: "插话",
    interjectionState: (state) => ({ pending: "发送中", delivered: "已送达", fallen_back: "已改为排队" })[state],
    interjectionReason: (reason) => ZH_FALLBACK[reason],
    convertToSteer: "改成插话",
    convertToSteerHelp: "不打断当前这一轮，把这条直接告诉 Grok",
    preemptQueuedHelp: "停止当前这一轮，马上处理这条消息",
    steerNotice: (kind, reason) => kind === "queued"
      ? `没能插话，这条消息已排队：${ZH_FALLBACK[reason]}。`
      : kind === "started"
        ? `这条消息没有插话，已作为新消息发出：${ZH_FALLBACK[reason]}。`
        : `没能改成插话，这条消息还在队列里：${ZH_FALLBACK[reason]}。`,
    modelDescription: zhModelDescription,
  };
}

function enMessages(): ChangeMessages {
  return {
    changesTitle: (count) => `Changed ${count} ${count === 1 ? "file" : "files"} this turn`,
    changesCapturing: "Counting changes…",
    changesUnavailable: (reason) => reason === undefined ? "This turn's changes could not be tracked" : EN_UNAVAILABLE[reason],
    changesViewDiff: "View diff",
    changesRewind: "Rewind to before this turn",
    changesRolledBack: "Rewound",
    changesTruncated: (listed, total) => `Showing the first ${listed}; the totals include all ${total} files`,
    changesShowAll: (total) => `Show all ${total} files`,
    changesShowLess: "Show less",
    changesBinary: "binary",
    changesStatusLabel: (status) => ({ A: "Added", M: "Modified", D: "Deleted", R: "Renamed" })[status],
    changesRenamedFrom: (oldPath) => `Renamed from ${oldPath}`,
    changesOpenFileDiff: (path) => `View the diff of ${path}`,
    rewindDisabledReason: (reason) => ({
      run_active: "This turn is still running. Stop it or wait for it to finish",
      queue_not_empty: "There are queued messages. Clear them first",
      runtime_unavailable: "Grok is unavailable right now. Try again in a moment",
      no_checkpoints: "This task has no checkpoint to rewind to",
    })[reason],
    changesSummaryLabel: "Changes",
    changesSummaryTitle: (files) => `Jump to the latest turn's changes (${files} ${files === 1 ? "file" : "files"})`,
    runDiffHeading: (ordinal) => `Changes in turn ${ordinal}`,
    runDiffFiles: "Files",
    runDiffClose: "Close this turn's diff",
    runDiffLoading: "Loading the diff…",
    runDiffBinary: "Binary file, no diff shown",
    runDiffTruncated: "The diff is long; only the first 256 KB is shown",
    runDiffEmpty: "This file has no text diff to show",
    runDiffUnavailable: (reason) => ({
      no_checkpoint: "This turn has no usable checkpoint, so the diff cannot be read",
      not_in_run: "This file is not part of this turn's changes",
      git_failed: "git could not read the diff. Try again in a moment",
    })[reason],
    runDiffFailed: "Could not load the diff",
    runDiffRetry: "Retry",
    rewindTitle: "Rewind to before this turn",
    rewindLoading: "Checking what can be rewound…",
    rewindIntro: (laterRuns) => laterRuns > 0
      ? `Restore the conversation and the files to before this turn started. The ${laterRuns} later ${laterRuns === 1 ? "turn is" : "turns are"} undone too.`
      : "Restore the conversation and the files to before this turn started.",
    rewindFilesOnlyTitle: "Files only",
    rewindFilesOnlyBody: (reason) => reason === "unsupported"
      ? "This Grok version cannot rewind the conversation, so only the files go back to before this turn. The conversation stays as it is and the prompt is not put back in the composer."
      : "Grok cannot rewind the conversation right now, so only the files go back to before this turn. The conversation stays as it is and the prompt is not put back in the composer.",
    rewindRestoreHeading: (count) => `${count} ${count === 1 ? "file" : "files"} will be restored`,
    rewindRemoveHeading: (count) => `${count} ${count === 1 ? "file" : "files"} added by this turn will be deleted`,
    rewindNoFileChanges: "No files need to change.",
    rewindListTruncated: "There are many files; only some are listed.",
    rewindNoCheckpoint: (reason) => reason === "not_a_git_repo"
      ? "This folder is not a git repository, so there is no checkpoint. File changes made by commands cannot be reverted."
      : "This turn has no git checkpoint. File changes made by commands cannot be reverted.",
    rewindRuntimeRestoreHeading: (count) => `Grok's edit snapshots can restore ${count} ${count === 1 ? "file" : "files"}`,
    rewindConflictsHeading: (count) => `${count} ${count === 1 ? "file was" : "files were"} changed again after this turn`,
    rewindConflictReason: (reason) => reason === "later_run"
      ? "Changed by a later turn, which is undone too"
      : "Changed later by you or another program. Rewinding overwrites those changes",
    rewindOverwriteLabel: "Overwrite these files",
    rewindOverwriteNeeded: "Tick this to continue. Overwritten changes cannot be recovered.",
    rewindConflictsChanged: "More files changed after you opened this preview. Check the files below before deciding to overwrite.",
    rewindCannotUndoHeading: "Cannot be undone",
    rewindCannotUndoKind: (kind) => ({
      network_and_mcp_effects: "Network requests, MCP tool calls and anything already sent to other services.",
      git_commits_and_pushes: "Git commits, pushes, branch changes and stashes made by commands.",
      memory_writes: "Notes the agent wrote to memory.",
      shell_file_changes_without_git: "There is no git checkpoint, so file changes made by commands cannot be reverted.",
    })[kind],
    rewindConfirm: "Rewind",
    rewindConfirmFilesOnly: "Restore files",
    rewindWorking: "Rewinding…",
    rewindRefused: (reason) => EN_REWIND_REFUSED[reason],
    rewindFailed: "The rewind did not finish. Try again.",
    rewindRetry: "Retry",
    rewindDoneTitle: "Rewound",
    rewindDoneConversation: (runs, restored, removed) =>
      `Undid ${runs} ${runs === 1 ? "turn" : "turns"}, restored ${restored} ${restored === 1 ? "file" : "files"} and deleted ${removed}.`,
    rewindDoneFilesOnly: (restored, removed) =>
      `Files are back to before this turn: ${restored} restored, ${removed} deleted. The conversation is unchanged.`,
    rewindDraftBack: "The undone prompt is back in the composer, ready to edit and send again.",
    rewindFailedFiles: (count) => `${count} ${count === 1 ? "file" : "files"} could not be restored`,
    rewindDone: "Done",
    rolledBackTag: "Rewound",
    rolledBackRuns: (count) => `${count} ${count === 1 ? "turn" : "turns"} undone`,
    rolledBackExpandHint: "Show what was undone",
    steerAction: "Steer",
    steerShortcut: "⌥↩",
    steerHelp: "Tell the running turn this message now, without interrupting it",
    steerNeedsText: "Type what to say first",
    hintSteer: "steer a running turn",
    queueSteerPlaceholder: "Enter to queue, ⌥↩ to steer…",
    interjectionTag: "Steer",
    interjectionState: (state) => ({ pending: "Sending", delivered: "Delivered", fallen_back: "Queued instead" })[state],
    interjectionReason: (reason) => EN_FALLBACK[reason],
    convertToSteer: "Steer now",
    convertToSteerHelp: "Tell Grok this now without interrupting the current turn",
    preemptQueuedHelp: "Stop the current turn and handle this message right away",
    steerNotice: (kind, reason) => kind === "queued"
      ? `Could not steer, so the message was queued: ${EN_FALLBACK[reason]}.`
      : kind === "started"
        ? `Not steered; sent as a new message: ${EN_FALLBACK[reason]}.`
        : `Could not steer it; the message is still queued: ${EN_FALLBACK[reason]}.`,
    modelDescription: (_modelId, official) => official,
  };
}
