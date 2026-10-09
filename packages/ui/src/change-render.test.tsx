import assert from "node:assert/strict";
import test from "node:test";
import type { RewindPlanProjection, TaskId, TimelineItemProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline, TimelineItem } from "./App.js";
import { RewindDialog } from "./RewindDialog.js";
import { RolledBackBlock } from "./RolledBackBlock.js";
import { RUN_CARD_VISIBLE_FILES, RunChangesCard } from "./RunChangesCard.js";
import { RunDiffView, diffResultOf } from "./RunDiffView.js";
import { checkpoint, entry, file, gitPlan, runId } from "./checkpoint.fixture.js";
import { messagesFor } from "./locales.js";
import { afterPreview, beginSubmit, toggleOverwrite, type RewindState } from "./rewind-flow.js";
import { segmentTimeline } from "./rolled-back.js";
import { groupTimeline } from "./timeline.js";

const ZH = messagesFor("zh-CN");
const EN = messagesFor("en-US");
const noop = () => undefined;

function card(patch: Parameters<typeof checkpoint>[0], options: { rewind?: { available: true } | { available: false; reason: "run_active" | "queue_not_empty" | "runtime_unavailable" | "no_checkpoints" }; locale?: "zh-CN" | "en-US"; expanded?: boolean } = {}) {
  return renderToStaticMarkup(
    <RunChangesCard
      data={{ checkpoint: checkpoint(patch), rewind: options.rewind ?? { available: true } }}
      messages={options.locale === "en-US" ? EN : ZH}
      onViewDiff={noop}
      onRewind={noop}
      {...(options.expanded === undefined ? {} : { initialExpanded: options.expanded })}
    />,
  );
}

// ---------------------------------------------------------------------------------------------
// The changed-files card
// ---------------------------------------------------------------------------------------------

test("the card shows the header, one row per file with a status badge, a dimmed directory and mono counts", () => {
  const markup = card({ runId: runId("r1") });
  assert.match(markup, /<b>本轮改了 3 个文件<\/b>/u);
  assert.match(markup, /<span class="a">\+142<\/span> <span class="d">−58<\/span>/u);
  assert.match(markup, /<span class="guild-changes-badge M" aria-hidden="true">M<\/span>/u);
  assert.match(markup, /<span class="guild-changes-badge A" aria-hidden="true">A<\/span>/u);
  assert.match(markup, /<span class="guild-changes-dir">Assets\/Scripts\/World\/<\/span>StylizedWorldMeshFactory\.cs/u);
  assert.match(markup, /<span class="a">\+96<\/span><span class="d">−41<\/span>/u);
  assert.match(markup, />查看差异<\/button>/u);
  assert.match(markup, /退回到这轮之前<\/button>/u);
  assert.equal(markup.match(/class="guild-changes-row"/gu)?.length, 3);
  assert.match(markup, /data-run-card="r1"/u);
});

test("a binary file shows a label instead of counts and a rename names its origin in the tooltip", () => {
  const markup = card({ runId: runId("r1"), files: [file("art/logo.png", "M", null, null), file("src/new.ts", "R", 1, 1, "src/old.ts")] });
  assert.match(markup, /<span class="guild-changes-binary">二进制<\/span>/u);
  assert.match(markup, /title="从 src\/old\.ts 重命名\nsrc\/new\.ts"/u);
});

test("a long list folds behind a show-all control and says when the projection capped it", () => {
  const many = Array.from({ length: 12 }, (_, index) => file(`src/f${index}.ts`, "M", 1, 0));
  const folded = card({ runId: runId("r1"), files: many });
  assert.equal(folded.match(/class="guild-changes-row"/gu)?.length, RUN_CARD_VISIBLE_FILES);
  assert.match(folded, /显示全部 12 个文件/u);
  const open = card({ runId: runId("r1"), files: many }, { expanded: true });
  assert.equal(open.match(/class="guild-changes-row"/gu)?.length, 12);
  assert.match(open, /收起/u);
  const truncated = card({ runId: runId("r1"), files: many.slice(0, 3), filesChanged: 450, filesTruncated: true });
  assert.match(truncated, /<span class="guild-changes-truncated">只列出了前 3 个，合计已包含全部 450 个文件<\/span>/u);
  assert.match(truncated, /本轮改了 450 个文件/u);
});

test("rewinding is disabled with the reason in plain words when the backend says so", () => {
  for (const [reason, text] of [
    ["run_active", "这一轮还在运行，停止或结束后才能退回"],
    ["queue_not_empty", "还有排队的消息，清空后才能退回"],
    ["runtime_unavailable", "Grok 暂时不可用，稍后再试"],
    ["no_checkpoints", "这个任务没有可退回的检查点"],
  ] as const) {
    const markup = card({ runId: runId("r1") }, { rewind: { available: false, reason } });
    assert.match(markup, /aria-disabled="true"/u, reason);
    assert.match(markup, new RegExp(`title="${text}"`, "u"), reason);
  }
  const enabled = card({ runId: runId("r1") });
  assert.doesNotMatch(enabled, /aria-disabled/u);
  assert.doesNotMatch(enabled, /class="guild-changes-rewind"[^>]*title=/u);
});

test("capturing is a quiet placeholder, unavailable is one faint line with the reason, no changes renders nothing", () => {
  assert.match(card({ runId: runId("r1"), status: "capturing" }), /^<p class="guild-changes-note" role="status">正在统计改动…<\/p>$/u);
  assert.equal(
    card({ runId: runId("r1"), status: "unavailable", detail: "not_a_git_repo", files: [] }),
    '<p class="guild-changes-note unavailable">不是 git 仓库，无法统计改动</p>',
  );
  assert.match(card({ runId: runId("r1"), status: "unavailable", detail: "too_many_files", files: [] }), /文件太多/u);
  assert.equal(card({ runId: runId("r1"), files: [] }), "");
});

test("a rewound run is dimmed with the rewound tag and offers no second rewind", () => {
  const markup = card({ runId: runId("r1"), rolledBack: true });
  assert.match(markup, /class="guild-changes rolled-back"/u);
  assert.match(markup, /<span class="guild-changes-tag">已退回<\/span>/u);
  assert.doesNotMatch(markup, /guild-changes-rewind/u);
  assert.match(markup, />查看差异<\/button>/u, "the diff stays readable");
  assert.match(card({ runId: runId("r1") }, { locale: "en-US" }), /Changed 3 files this turn/u);
});

// ---------------------------------------------------------------------------------------------
// The unified diff view
// ---------------------------------------------------------------------------------------------

function diffView(result: Parameters<typeof RunDiffView>[0]["initialResult"], paths = ["a.ts", "b.ts"]) {
  return renderToStaticMarkup(
    <RunDiffView
      messages={ZH}
      checkpoint={checkpoint({ runId: runId("r1"), ordinal: 3, files: paths.map((path) => file(path, "M", 1, 1)) })}
      path={paths[0]}
      onSelect={noop}
      onClose={noop}
      load={async () => { throw new Error("not called"); }}
      initialResult={result}
    />,
  );
}

test("the diff view colors added and removed lines and lets the reader pick a file of the run", () => {
  const markup = diffView(diffResultOf({
    status: "ok", path: "a.ts", binary: false, truncated: false,
    diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  }));
  assert.match(markup, /第 3 轮的改动/u);
  assert.match(markup, /<span class="line hunk">@@ -1 \+1 @@<\/span>/u);
  assert.match(markup, /<span class="line del">-old<\/span><span class="line add">\+new<\/span>/u);
  assert.equal(markup.match(/guild-rundiff-file/gu)?.length, 3, "two files, one selected class mention");
  assert.match(markup, /aria-pressed="true"/u);
  assert.doesNotMatch(markup, /diff --git/u, "path headers are dropped");
});

test("binary, truncated, empty, unavailable, loading and failed diffs each say so plainly", () => {
  assert.match(diffView(diffResultOf({ status: "ok", path: "a.ts", binary: true, truncated: false, diff: "Binary files differ" })), /二进制文件，不显示差异/u);
  const cut = diffView(diffResultOf({ status: "ok", path: "a.ts", binary: false, truncated: true, diff: "@@ -1 +1 @@\n-a\n+b\n" }));
  assert.match(cut, /差异太长，只显示了前 256 KB/u);
  assert.match(cut, /<span class="line add">\+b<\/span>/u, "the part that fits is still shown");
  assert.match(diffView(diffResultOf({ status: "ok", path: "a.ts", binary: false, truncated: false, diff: "" })), /没有可显示的文本差异/u);
  assert.match(diffView(diffResultOf({ status: "unavailable", reason: "no_checkpoint" })), /这一轮没有可用的检查点/u);
  assert.match(diffView(diffResultOf({ status: "unavailable", reason: "not_in_run" })), /不在这一轮的改动里/u);
  assert.match(diffView(diffResultOf({ status: "unavailable", reason: "git_failed" })), /git 读取差异失败/u);
  assert.match(diffView({ state: "loading" }), /正在读取差异…/u);
  const failed = diffView({ state: "failed" });
  assert.match(failed, /读取差异失败<button/u);
  assert.match(failed, />重试<\/button>/u);
});

test("a single-file run shows no file picker", () => {
  const markup = diffView({ state: "loading" }, ["only.ts"]);
  assert.doesNotMatch(markup, /guild-rundiff-files/u);
  assert.match(markup, /<code class="guild-rundiff-path" title="only\.ts">only\.ts<\/code>/u);
});

// ---------------------------------------------------------------------------------------------
// The rewind dialog
// ---------------------------------------------------------------------------------------------

function dialog(state: RewindState, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    <RewindDialog
      taskId={"t" as TaskId}
      runId={runId("r1")}
      messages={locale === "zh-CN" ? ZH : EN}
      preview={async () => { throw new Error("not called"); }}
      execute={async () => { throw new Error("not called"); }}
      onRolledBack={noop}
      onClose={noop}
      onDialogKeyDown={noop}
      initialState={state}
    />,
  );
}
const readyState = (plan: RewindPlanProjection) => afterPreview({ status: "ready", plan });

test("the dialog is a modal alert dialog that starts on Cancel and names the destructive action", () => {
  const markup = dialog(readyState(gitPlan()));
  assert.match(markup, /role="alertdialog" aria-modal="true" aria-labelledby="[^"]+" aria-describedby="[^"]+"/u);
  assert.match(markup, /<button autofocus="" type="button">取消<\/button>/u);
  assert.match(markup, /<button type="button" class="danger">退回<\/button>/u);
  // The first button of the footer is Cancel, so autoFocus lands there, not on the destructive one.
  assert.ok(markup.indexOf(">取消<") < markup.indexOf('class="danger"'));
});

test("the ready dialog lists what is restored and deleted and what cannot be undone, in plain Chinese", () => {
  const markup = dialog(readyState(gitPlan()));
  assert.match(markup, /把对话和文件都恢复到这一轮开始之前。/u);
  assert.match(markup, /<h3>将恢复 2 个文件<\/h3>/u);
  assert.match(markup, /<code title="Assets\/Scripts\/World\/IslandLagoon\.cs">/u);
  assert.match(markup, /<h3>将删除 1 个这一轮新增的文件<\/h3>/u);
  assert.match(markup, /<h3>这些无法撤销<\/h3>/u);
  assert.match(markup, /已发出的网络请求、MCP 工具调用/u);
  assert.match(markup, /命令已经做出的 git 提交、推送、分支和 stash 变更。/u);
  assert.match(markup, /Agent 写进记忆的内容。/u);
  assert.doesNotMatch(markup, /覆盖这些文件/u, "no conflicts, no opt-in");
});

test("later runs are named in the intro, and a plan with no file changes says so", () => {
  const later = gitPlan({}, { rolledBackRuns: [runId("r1"), runId("r2"), runId("r3")] });
  assert.match(dialog(readyState(later)), /这一轮之后的 2 轮也会一起撤销/u);
  const empty = dialog(readyState(gitPlan({ restore: [], remove: [] })));
  assert.match(empty, /没有文件需要改动。/u);
});

test("conflicts list each file with its reason and gate the confirm button behind the overwrite opt-in", () => {
  const plan = gitPlan({ conflicts: [{ path: "Assets/Mine.cs", reason: "modified_after_run" }, { path: "Assets/Later.cs", reason: "later_run" }] });
  const gated = dialog(readyState(plan));
  assert.match(gated, /<h3>2 个文件在这一轮之后又被改过<\/h3>/u);
  assert.match(gated, /之后被你或别的程序改过，退回会覆盖这些改动/u);
  assert.match(gated, /被之后的轮次改过，会一起撤销/u);
  assert.match(gated, /<input type="checkbox"\/>/u);
  assert.match(gated, /<strong>覆盖这些文件<\/strong>/u);
  assert.match(gated, /class="danger" disabled=""/u, "unticked: cannot confirm");
  const ticked = dialog(toggleOverwrite(readyState(plan)));
  assert.match(ticked, /<input type="checkbox" checked=""\/>/u);
  assert.doesNotMatch(ticked, /class="danger" disabled/u, "ticked: can confirm");
});

test("a conflicts answer shows the reason to look again", () => {
  const state: RewindState = {
    phase: "ready", plan: gitPlan({ conflicts: [{ path: "x.ts", reason: "modified_after_run" }] }),
    overwrite: false, submitting: false, notice: { kind: "conflicts" },
  };
  assert.match(dialog(state), /role="alert">(?:<svg[\s\S]*?<\/svg>)?你预览之后，又有文件被改过了/u);
});

test("when the conversation cannot be rewound the dialog says it is files only and relabels the button", () => {
  for (const [reason, text] of [["unsupported", "当前 Grok 版本不能退回对话"], ["runtime_unavailable", "Grok 暂时不能退回对话"]] as const) {
    const plan = gitPlan({}, { scope: "files_only", conversation: { available: false, reason }, rolledBackRuns: [] });
    const markup = dialog(readyState(plan));
    assert.match(markup, /<strong>只还原文件<\/strong>/u, reason);
    assert.match(markup, new RegExp(text, "u"), reason);
    assert.match(markup, /对话记录保持不变，这一轮的提问也不会放回输入框/u, reason);
    assert.match(markup, /class="danger">还原文件<\/button>/u, reason);
    assert.doesNotMatch(markup, /把对话和文件都恢复/u, reason);
  }
});

test("without a git checkpoint the dialog lists what the runtime's own snapshots can restore, or says there is nothing", () => {
  const withSnapshots = gitPlan({}, {
    files: { kind: "none", reason: "not_a_git_repo", runtimeRestore: ["a.ts", "b.ts"], runtimeConflicts: ["b.ts"] },
    cannotUndo: [{ kind: "shell_file_changes_without_git", text: "x" }],
  });
  const markup = dialog(readyState(withSnapshots));
  assert.match(markup, /<h3>Grok 的编辑快照可以还原 2 个文件<\/h3>/u);
  assert.match(markup, /没有 git 检查点，命令行造成的文件改动无法还原。/u);
  assert.match(markup, /覆盖这些文件/u, "snapshot conflicts need the opt-in too");
  const nothing = dialog(readyState(gitPlan({}, { files: { kind: "none", reason: "not_a_git_repo", runtimeRestore: [], runtimeConflicts: [] } })));
  assert.match(nothing, /这个文件夹不是 git 仓库，没有检查点/u);
});

test("loading, refused and failed previews each have a clear body and a way out", () => {
  assert.match(dialog({ phase: "loading" }), /role="status">(?:<svg[\s\S]*?<\/svg>)?正在检查可以退回的内容…/u);
  assert.match(dialog({ phase: "loading" }), /aria-busy="true"/u);
  const refused = dialog({ phase: "refused", reason: "run_active" });
  assert.match(refused, /role="alert">(?:<svg[\s\S]*?<\/svg>)?任务还在运行，停止或等它结束后才能退回。/u);
  assert.doesNotMatch(refused, /class="danger"/u, "nothing to confirm");
  for (const reason of ["queue_not_empty", "run_not_found", "already_rolled_back", "runtime_unavailable", "prompt_index_mismatch", "runtime_refused", "session_replaced", "nothing_to_rewind", "conversation_rewind_unsupported"] as const) {
    assert.ok(ZH.rewindRefused(reason).length > 8 && EN.rewindRefused(reason).length > 8, reason);
  }
  const failed = dialog({ phase: "failed" });
  assert.match(failed, /退回没有完成，请重试。/u);
  assert.match(failed, />重试<\/button>/u);
});

test("while a rewind runs the buttons are held and the confirm button shows progress", () => {
  const markup = dialog(beginSubmit(readyState(gitPlan())));
  assert.match(markup, /<button autofocus="" type="button" disabled="">取消<\/button>/u);
  assert.match(markup, /class="danger" disabled="" aria-busy="true">(?:<svg[\s\S]*?<\/svg>)?正在退回…/u);
});

test("success shows a concise result, tells the prompt is back in the composer and lists files that failed", () => {
  const done = dialog({
    phase: "done",
    result: { status: "rolled_back", scope: "conversation_and_files", rolledBackRuns: [runId("r1"), runId("r2")], restoredFiles: ["a", "b", "c"], removedFiles: ["d"], failedFiles: [{ path: "locked.bin", reason: "restore_failed" }], draftRestored: true },
  });
  assert.match(done, /role="status"/u);
  assert.match(done, /<strong>已退回<\/strong>/u);
  assert.match(done, /已撤销 2 轮，还原了 3 个文件，删除了 1 个。/u);
  assert.match(done, /被撤销的提问已放回输入框/u);
  assert.match(done, /1 个文件没能还原/u);
  assert.match(done, /locked\.bin/u);
  assert.match(done, /class="primary">完成<\/button>/u);
  const filesOnly = dialog({
    phase: "done",
    result: { status: "rolled_back", scope: "files_only", rolledBackRuns: [], restoredFiles: ["a"], removedFiles: [], failedFiles: [], draftRestored: false },
  });
  assert.match(filesOnly, /文件已还原到这一轮之前，还原了 1 个，删除了 0 个。对话保持不变。/u);
  assert.doesNotMatch(filesOnly, /放回输入框/u);
});

test("the English dialog reads naturally too", () => {
  const markup = dialog(readyState(gitPlan()), "en-US");
  assert.match(markup, /Rewind to before this turn/u);
  assert.match(markup, /2 files will be restored/u);
  assert.match(markup, />Cancel<\/button>/u);
});

// ---------------------------------------------------------------------------------------------
// Steer in the timeline
// ---------------------------------------------------------------------------------------------

function item(entryItem: TimelineItemProjection, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    <TimelineItem
      item={entryItem}
      locale={locale}
      canRetry={false}
      onOpenExternal={noop}
      onPermissionDecision={async () => undefined}
      onBranch={async () => undefined}
      onRetryToDraft={noop}
      onOpenRuntimeDiagnostics={noop}
    />,
  );
}

test("a steered message renders as a user bubble with a Steer tag and its delivery state", () => {
  const pending = item(entry("user", "u9", { interjection: { interjectionId: "i1", state: "pending" } }));
  assert.match(pending, /class="guild-message guild-message-user guild-message-interjection"/u);
  assert.match(pending, /<span class="guild-interjection-tag">插话<\/span>/u);
  assert.match(pending, /<span class="guild-interjection-state pending"><span class="guild-mini-spin" aria-hidden="true"><\/span>发送中<\/span>/u);
  const delivered = item(entry("user", "u9", { interjection: { interjectionId: "i1", state: "delivered" } }));
  assert.match(delivered, /<span class="guild-interjection-state delivered">已送达<\/span>/u);
  assert.doesNotMatch(delivered, /guild-mini-spin/u);
  assert.match(delivered, /guild-message-actions/u, "it is still a normal bubble");
  assert.doesNotMatch(item(entry("user", "u1")), /guild-interjection/u);
});

test("a Steer that fell back to the queue says so with the reason, in both languages", () => {
  const reasons = [
    ["unsupported", "当前 Grok 版本不支持插话"],
    ["turn_not_running", "这一轮已经结束"],
    ["turn_not_steerable", "这一轮暂时不能插话"],
    ["runtime_error", "Grok 没有收下这条插话"],
  ] as const;
  for (const [reason, text] of reasons) {
    const markup = item(entry("notice", "n1", { interjection: { interjectionId: "i1", state: "fallen_back", reason } }));
    assert.match(markup, /guild-message-interjection-notice/u, reason);
    assert.match(markup, /<span class="guild-interjection-tag">插话<\/span>/u, reason);
    assert.match(markup, /<span class="guild-interjection-state fallen_back">已改为排队<\/span>/u, reason);
    assert.match(markup, new RegExp(`<span>${text}</span>`, "u"), reason);
  }
  const english = item(entry("notice", "n1", { interjection: { interjectionId: "i1", state: "fallen_back", reason: "unsupported" } }), "en-US");
  assert.match(english, /Queued instead/u);
  assert.match(english, /this Grok version cannot take messages mid-turn/u);
  const noReason = item(entry("notice", "n1", { text: "stored sentence", interjection: { interjectionId: "i1", state: "fallen_back" } }));
  assert.match(noReason, /<span>stored sentence<\/span>/u, "falls back to the stored notice text");
});

test("the two queue actions are worded so they cannot be mistaken for each other", () => {
  assert.equal(ZH.convertToSteer, "改成插话");
  assert.equal(ZH.preemptQueued, "打断并先做");
  assert.notEqual(ZH.convertToSteer, ZH.preemptQueued);
  assert.match(ZH.convertToSteerHelp, /不打断/u);
  assert.match(ZH.preemptQueuedHelp, /停止当前/u);
  assert.equal(EN.convertToSteer, "Steer now");
  assert.equal(EN.preemptQueued, "Interrupt & run");
});

// ---------------------------------------------------------------------------------------------
// Cards and rewound runs inside the timeline
// ---------------------------------------------------------------------------------------------

function timeline(items: TimelineItemProjection[], extra: Partial<Parameters<typeof Timeline>[0]> = {}) {
  return renderToStaticMarkup(
    <Timeline
      items={items}
      locale="zh-CN"
      running={false}
      onOpenExternal={noop}
      onPermissionDecision={async () => undefined}
      onBranch={async () => undefined}
      onRetryToDraft={noop}
      onOpenRuntimeDiagnostics={noop}
      {...extra}
    />,
  );
}
const run = (id: string, start: number, patch: Record<string, unknown> = {}): TimelineItemProjection[] => [
  entry("user", `u-${id}`, { runId: id, sequence: start, ...patch }),
  entry("tool", `t-${id}`, { runId: id, sequence: start + 1, ...patch }),
  entry("assistant", `a-${id}`, { runId: id, sequence: start + 2, ...patch }),
];

test("a finished run's card sits in the footer of its last answer; a live run has none yet", () => {
  const items = [...run("r1", 1), ...run("r2", 10)];
  const checkpoints = [checkpoint({ runId: runId("r1"), ordinal: 1 }), checkpoint({ runId: runId("r2"), ordinal: 2, status: "capturing" })];
  const finished = timeline(items, { runCheckpoints: checkpoints, rewind: { available: true } });
  assert.match(finished, /<div class="guild-turn-slot"><section class="guild-changes" data-run-card="r1"/u);
  assert.ok(finished.indexOf('data-run-card="r1"') > finished.indexOf("assistant a-r1"), "after the answer");
  assert.match(finished, /<p class="guild-changes-note" role="status">正在统计改动…<\/p>/u, "capturing shows once the run is over");
  const live = timeline(items, { runCheckpoints: checkpoints, running: true });
  assert.match(live, /data-run-card="r1"/u);
  assert.doesNotMatch(live, /正在统计改动/u, "the live run shows nothing, not even a placeholder");
});

test("a run that produced no answer still gets its card after its last activity", () => {
  const items = [entry("user", "u1", { runId: "r1", sequence: 1 }), entry("tool", "t1", { runId: "r1", sequence: 2 })];
  const markup = timeline(items, { runCheckpoints: [checkpoint({ runId: runId("r1") })], rewind: { available: true } });
  assert.match(markup, /<\/details><div class="guild-turn-slot"><section class="guild-changes"/u);
});

test("a rewound run folds into one dimmed, collapsed line with the rewound tag and its prompt", () => {
  const items = [...run("r1", 1), ...run("r2", 10, { rolledBack: true }), ...run("r3", 20, { rolledBack: true }), entry("notice", "rw", { sequence: 30, text: "rewound" }), ...run("r4", 40)];
  const markup = timeline(items, { runCheckpoints: [checkpoint({ runId: runId("r2"), rolledBack: true })] });
  assert.equal(markup.match(/<details class="guild-rolled-back"/gu)?.length, 1, "consecutive rewound runs share one block");
  assert.match(markup, /<span class="guild-rolled-tag">已退回<\/span>/u);
  assert.match(markup, /<span class="guild-rolled-prompt">user u-r2<\/span>/u);
  assert.match(markup, /<span class="guild-rolled-count">2 轮已撤销<\/span>/u);
  assert.doesNotMatch(markup, /assistant a-r2/u, "collapsed: the undone content is not mounted");
  assert.match(markup, /assistant a-r1/u);
  assert.match(markup, /assistant a-r4/u);
  assert.match(markup, /rewound/u, "the rewind notice stays visible");
});

test("segments group only consecutive rewound groups", () => {
  const groups = groupTimeline([...run("r1", 1, { rolledBack: true }), ...run("r2", 10), ...run("r3", 20, { rolledBack: true })]);
  const segments = segmentTimeline(groups);
  assert.deepEqual(segments.map((segment) => segment.type), ["rolled", "row", "row", "row", "rolled"]);
  assert.equal(segmentTimeline(groupTimeline(run("r1", 1))).every((segment) => segment.type === "row"), true);
});

test("an open rewound block shows its content, and a block holding a search hit opens by itself", () => {
  const groups = groupTimeline(run("r1", 1, { rolledBack: true }));
  const segment = segmentTimeline(groups)[0];
  assert.equal(segment?.type, "rolled");
  if (segment?.type !== "rolled") return;
  const open = renderToStaticMarkup(<RolledBackBlock segment={segment} messages={ZH} containsHighlight={false} initialOpen>{() => <p>undone content</p>}</RolledBackBlock>);
  assert.match(open, /<details class="guild-rolled-back" open=""/u);
  assert.match(open, /<div class="guild-rolled-body"><p>undone content<\/p><\/div>/u);
  const hit = renderToStaticMarkup(<RolledBackBlock segment={segment} messages={ZH} containsHighlight>{() => <p>undone content</p>}</RolledBackBlock>);
  assert.match(hit, /undone content/u);
  const closed = renderToStaticMarkup(<RolledBackBlock segment={segment} messages={ZH} containsHighlight={false}>{() => <p>undone content</p>}</RolledBackBlock>);
  assert.doesNotMatch(closed, /undone content/u);
});
