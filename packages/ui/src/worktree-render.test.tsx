import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ApplyWorktreeResponse,
  PreviewWorktreeApplyResponse,
  TaskViewProjection,
  TaskWorktreeProjection,
  WorkspaceProjection,
  WorktreeChangeSummary,
} from "@guild/contracts";
import { WorkspaceTree } from "./App.js";
import {
  WorktreeApplyDialog,
  WorktreeBanner,
  WorktreeChip,
  WorktreeDiscardDialog,
  WorktreeGlyph,
  WorktreeMenu,
  WorktreeStartOption,
  clampMenu,
  useWorktreeUi,
  type WorktreeApplyViewState,
} from "./Worktree.js";
import { worktreeMessagesFor } from "./worktree-messages.js";
import { worktreeDiscardFacts } from "./worktree-state.js";

const zh = worktreeMessagesFor("zh-CN");
const en = worktreeMessagesFor("en-US");
const noop = () => undefined;

const worktree = (patch: Partial<TaskWorktreeProjection> = {}): TaskWorktreeProjection => ({
  status: "active", branch: "guild/task-1a2b3c4d", baseBranch: "main", ahead: 0, behind: 0, dirtyFiles: 0, measured: true, ...patch,
});

const summary = (patch: Partial<WorktreeChangeSummary> = {}): WorktreeChangeSummary => ({
  branch: "guild/task-1a2b3c4d", baseBranch: "main", commitsAhead: 2, uncommittedFiles: 1,
  files: [
    { path: "src/app.ts", status: "M", adds: 12, dels: 3 },
    { path: "src/new.ts", status: "A", adds: 40, dels: 0 },
    { path: "old.txt", status: "D", adds: 0, dels: 9 },
    { path: "logo.png", status: "A", adds: null, dels: null },
  ],
  filesTotal: 4, adds: 52, dels: 12, filesTruncated: false, ...patch,
});

const applyDialog = (state: WorktreeApplyViewState, locale = en) => renderToStaticMarkup(
  <WorktreeApplyDialog
    state={state} branch="guild/task-1a2b3c4d" baseBranch="main" messages={locale}
    closeLabel="Close" cancelLabel="Cancel" onConfirm={noop} onClose={noop}
  />,
);

test("the topbar chip shows the branch, commits ahead and uncommitted files like the approved mockup", () => {
  const markup = renderToStaticMarkup(
    <WorktreeChip worktree={worktree({ ahead: 2, dirtyFiles: 3 })} messages={zh} open={false} onToggle={noop} />,
  );
  assert.match(markup, /class="guild-worktree-chip active "/u);
  assert.match(markup, /<span class="guild-worktree-branch">guild\/task-1a2b3c4d<\/span>/u);
  assert.match(markup, /guild-worktree-stat ahead">领先 2</u);
  assert.match(markup, /guild-worktree-stat dirty">有 3 处未提交</u);
  assert.match(markup, /aria-haspopup="menu"/u);
  assert.match(markup, /aria-expanded="false"/u);
  assert.match(markup, /aria-label="独立 worktree，分支 guild\/task-1a2b3c4d，基于 main"/u);
});

test("a clean fresh worktree shows only its branch; open, merged, missing and discarded chips differ", () => {
  const fresh = renderToStaticMarkup(<WorktreeChip worktree={worktree()} messages={en} open onToggle={noop} />);
  assert.doesNotMatch(fresh, /guild-worktree-stat/u);
  assert.match(fresh, /class="guild-worktree-chip active open"/u);
  assert.match(fresh, /aria-expanded="true"/u);
  assert.doesNotMatch(renderToStaticMarkup(<WorktreeChip worktree={worktree({ measured: false, ahead: 4, dirtyFiles: 4 })} messages={en} open={false} onToggle={noop} />), /guild-worktree-stat/u);
  assert.match(renderToStaticMarkup(<WorktreeChip worktree={worktree({ status: "applied" })} messages={en} open={false} onToggle={noop} />), /guild-worktree-stat applied">Merged</u);
  const missing = renderToStaticMarkup(<WorktreeChip worktree={worktree({ status: "missing" })} messages={en} open={false} onToggle={noop} />);
  assert.match(missing, /guild-worktree-chip missing/u);
  assert.match(missing, /Folder missing/u);
  const discarded = renderToStaticMarkup(<WorktreeChip worktree={worktree({ status: "discarded" })} messages={en} open={false} onToggle={noop} />);
  assert.match(discarded, /disabled=""/u);
  assert.doesNotMatch(discarded, /aria-haspopup/u);
  assert.match(discarded, /Discarded/u);
});

test("the chip menu offers merge, discard, Finder and Terminal and notes what a fresh worktree lacks", () => {
  const markup = renderToStaticMarkup(
    <WorktreeMenu worktree={worktree()} messages={zh} running={false} x={10} y={20} onMerge={noop} onDiscard={noop} onFolder={noop} onTerminal={noop} />,
  );
  assert.match(markup, /role="menu"/u);
  assert.match(markup, /left:10px;top:20px/u);
  for (const label of ["合并回 main…", "丢弃这个 worktree…", "在 Finder 打开", "在终端打开"]) assert.ok(markup.includes(label), label);
  assert.match(markup, /node_modules/u);
  assert.match(markup, /class="danger"/u);
  assert.doesNotMatch(markup, /disabled/u);
  assert.doesNotMatch(markup, /guild-context-blocked/u);
});

test("while the task runs, merge and discard are disabled with the reason, and the folder still opens", () => {
  const markup = renderToStaticMarkup(
    <WorktreeMenu worktree={worktree()} messages={en} running x={0} y={0} onMerge={noop} onDiscard={noop} onFolder={noop} onTerminal={noop} />,
  );
  assert.equal(markup.match(/disabled=""/gu)?.length, 2);
  assert.match(markup, /Merging or discarding is not possible while the task is running/u);
  assert.match(markup, /Merge back to main…/u);
  const missing = renderToStaticMarkup(
    <WorktreeMenu worktree={worktree({ status: "missing" })} messages={en} running={false} x={0} y={0} onMerge={noop} onDiscard={noop} onFolder={noop} onTerminal={noop} />,
  );
  assert.equal(missing.match(/disabled=""/gu)?.length, 3, "merge, Finder and Terminal are off; discard stays");
  const detached = renderToStaticMarkup(
    <WorktreeMenu worktree={worktree({ baseBranch: undefined })} messages={en} running={false} x={0} y={0} onMerge={noop} onDiscard={noop} onFolder={noop} onTerminal={noop} />,
  );
  assert.match(detached, /Merge back to the base branch…/u);
});

test("the menu stays inside the window", () => {
  assert.deepEqual(clampMenu({ left: 100, bottom: 40 }, { width: 1280, height: 820 }), { x: 100, y: 44 });
  assert.deepEqual(clampMenu({ left: 1200, bottom: 40 }, { width: 1280, height: 820 }), { x: 1280 - 288 - 8, y: 44 });
  const low = clampMenu({ left: 10, bottom: 800 }, { width: 1280, height: 820 });
  assert.ok(low.y + 292 <= 820);
  assert.deepEqual(clampMenu({ left: -50, bottom: -50 }, { width: 400, height: 300 }), { x: 8, y: 8 });
});

test("the new-task option is a labelled checkbox with the one-line explanation", () => {
  const off = renderToStaticMarkup(<WorktreeStartOption checked={false} busy={false} notice={undefined} messages={zh} onChange={noop} />);
  assert.match(off, /<input type="checkbox"/u);
  assert.doesNotMatch(off, /checked=""/u);
  assert.match(off, /在独立 worktree 里做/u);
  assert.match(off, /改动会留在单独的分支上，合并回主分支之前不会碰你现在的目录/u);
  const on = renderToStaticMarkup(<WorktreeStartOption checked busy notice="没能创建" messages={zh} onChange={noop} />);
  assert.match(on, /checked=""/u);
  assert.match(on, /disabled=""/u);
  assert.match(on, /正在准备 worktree…/u);
  assert.match(on, /role="status">没能创建</u);
});

const workspace = (patch: Partial<WorkspaceProjection> = {}): WorkspaceProjection => ({
  workspaceId: "workspace-1" as WorkspaceProjection["workspaceId"], name: "repo", archived: false, tasks: [], ...patch,
});
const taskView = (patch: Partial<TaskViewProjection> = {}): TaskViewProjection => ({
  task: { taskId: "task-1", workspaceId: "workspace-1", title: "New task", pinned: false, archived: false, updatedAtMs: 1 },
  timeline: [], ...patch,
}) as unknown as TaskViewProjection;

function Harness({ workspaces, task, pristine }: {
  readonly workspaces: readonly WorkspaceProjection[];
  readonly task: TaskViewProjection | undefined;
  readonly pristine: boolean;
}) {
  const ui = useWorktreeUi({
    api: {} as never, locale: "en-US", workspaces, setProjection: noop, storage: undefined,
    viewport: { width: 1280, height: 820 }, cancelLabel: "Cancel", closeLabel: "Close",
  });
  return <div>{ui.renderChip(task)}{ui.renderStartOption(task, pristine, false, noop)}{ui.renderBanner(task)}{ui.renderOverlays(task, false)}</div>;
}

test("the option appears only for a git workspace and a task without messages", () => {
  const git = [workspace({ worktreeAvailable: true })];
  assert.match(renderToStaticMarkup(<Harness workspaces={git} task={taskView()} pristine />), /guild-worktree-option/u);
  assert.doesNotMatch(renderToStaticMarkup(<Harness workspaces={[workspace()]} task={taskView()} pristine />), /guild-worktree-option/u);
  assert.doesNotMatch(renderToStaticMarkup(<Harness workspaces={git} task={taskView()} pristine={false} />), /guild-worktree-option/u);
  assert.doesNotMatch(renderToStaticMarkup(<Harness workspaces={git} task={undefined} pristine />), /guild-worktree-option/u);
  const checked = renderToStaticMarkup(<Harness workspaces={git} task={taskView({ worktree: worktree() })} pristine />);
  assert.match(checked, /checked=""/u);
  assert.match(checked, /guild-worktree-chip/u, "the chip shows next to it");
  assert.doesNotMatch(renderToStaticMarkup(<Harness workspaces={git} task={taskView({ worktree: worktree({ status: "discarded" }) })} pristine />), /checked=""/u);
});

test("a task without a worktree has no chip, no banner and no menu", () => {
  const markup = renderToStaticMarkup(<Harness workspaces={[workspace()]} task={taskView()} pristine={false} />);
  assert.equal(markup, "<div></div>");
});

test("the composer banner explains a discarded or missing worktree", () => {
  assert.match(renderToStaticMarkup(<WorktreeBanner worktree={worktree({ status: "discarded" })} messages={zh} />), /不能再发送消息/u);
  assert.match(renderToStaticMarkup(<WorktreeBanner worktree={worktree({ status: "missing" })} messages={en} />), /folder is gone/u);
  assert.equal(renderToStaticMarkup(<WorktreeBanner worktree={worktree()} messages={en} />), "");
  assert.equal(renderToStaticMarkup(<WorktreeBanner worktree={undefined} messages={en} />), "");
});

test("the merge dialog lists the files, the commits and the uncommitted files, and offers the merge", () => {
  const ready: PreviewWorktreeApplyResponse = { status: "ready", summary: summary() };
  const markup = applyDialog({ phase: "preview", result: ready });
  assert.match(markup, /role="dialog"/u);
  assert.match(markup, /aria-modal="true"/u);
  assert.match(markup, /Merge back to main/u);
  assert.match(markup, /4 files changed, \+52 −12/u);
  assert.match(markup, /2 commits on the branch already/u);
  assert.match(markup, /1 uncommitted change will be committed to this branch first, as “Guild”/u);
  for (const path of ["src/app.ts", "src/new.ts", "old.txt", "logo.png"]) assert.ok(markup.includes(path), path);
  assert.match(markup, /guild-wt-status A/u);
  assert.match(markup, /guild-wt-status D/u);
  assert.match(markup, /<button type="button" class="primary"[^>]*>Merge into main<\/button>/u);
  assert.match(markup, />Cancel<\/button>/u);
  assert.match(markup, /Nothing is pushed and no other branch is touched/u);
});

test("a truncated file list says how many files are not shown", () => {
  const markup = applyDialog({ phase: "preview", result: { status: "ready", summary: summary({ filesTotal: 250, filesTruncated: true }) } });
  assert.match(markup, /246 more files not listed/u);
});

test("conflicts are listed and there is nothing to confirm", () => {
  const conflicts: PreviewWorktreeApplyResponse = {
    status: "conflicts", summary: summary(), conflicts: ["src/app.ts", "README.md"], conflictsTruncated: true,
  };
  const markup = applyDialog({ phase: "preview", result: conflicts }, zh);
  assert.match(markup, /这次合并会产生冲突/u);
  assert.match(markup, /什么都没有改动/u);
  assert.match(markup, /src\/app\.ts/u);
  assert.match(markup, /README\.md/u);
  assert.match(markup, /…以及更多/u);
  assert.doesNotMatch(markup, /class="primary"/u);
});

test("blocking reasons are spelled out with the branch and the files involved", () => {
  const blocked: PreviewWorktreeApplyResponse = {
    status: "blocked",
    blocking: [
      { reason: "source_not_on_base_branch", currentBranch: "feature-x" },
      { reason: "source_dirty_in_touched_paths", paths: ["a.txt", "b/c.txt"] },
    ],
  };
  const markup = applyDialog({ phase: "preview", result: blocked });
  assert.match(markup, /Your folder is on feature-x\. Switch back to main first/u);
  assert.match(markup, /uncommitted changes in files this merge also changes/u);
  assert.match(markup, /<li>a\.txt<\/li>/u);
  assert.match(markup, /<li>b\/c\.txt<\/li>/u);
  assert.doesNotMatch(markup, /class="primary"/u);
  assert.match(markup, />Close<\/button>/u);
  const running = applyDialog({ phase: "preview", result: { status: "refused", reason: "run_active" } });
  assert.match(running, /still running/u);
});

test("checking and merging disable every button; the finished states offer Done or Close", () => {
  const checking = applyDialog({ phase: "checking" });
  assert.match(checking, /Checking for a clean merge/u);
  assert.match(checking, /aria-busy="true"/u);
  assert.match(checking, /<button type="button" disabled=""/u);
  const merging = applyDialog({ phase: "merging", summary: summary() });
  assert.match(merging, /Merging…/u);
  assert.match(merging, /<button type="button" disabled=""/u);
  assert.doesNotMatch(merging, /class="primary"/u);
  const applied: Extract<ApplyWorktreeResponse, { status: "applied" }> = {
    status: "applied", baseBranch: "main", mergeCommit: "abcdef123456", committedUncommitted: true, summary: summary(),
    task: taskView(),
  };
  const done = applyDialog({ phase: "done", result: applied });
  assert.match(done, /Merged into main/u);
  assert.match(done, /Merge commit abcdef123456\. Uncommitted changes were committed to the branch first/u);
  assert.match(done, />Done<\/button>/u);
  assert.match(done, /The worktree and branch are kept/u);
  assert.match(applyDialog({ phase: "error" }), /did not complete/u);
  const raced = applyDialog({ phase: "result", result: { status: "conflicts", conflicts: ["a.txt"] } });
  assert.match(raced, /undone; your folder is unchanged/u);
  assert.match(raced, /<li>a\.txt<\/li>/u);
  assert.match(applyDialog({ phase: "result", result: { status: "failed", reason: "repository_changed" } }), /git status/u);
});

test("the discard dialog is a destructive confirmation that lists what goes", () => {
  const facts = worktreeDiscardFacts(worktree({ ahead: 2, dirtyFiles: 3 }));
  const markup = renderToStaticMarkup(
    <WorktreeDiscardDialog state={{ phase: "confirm" }} facts={facts} messages={en} cancelLabel="Cancel" onConfirm={noop} onClose={noop} />,
  );
  assert.match(markup, /role="alertdialog"/u);
  assert.match(markup, /Discard this worktree\?/u);
  assert.match(markup, /permanently deletes/u);
  assert.match(markup, /The worktree folder and every file in it/u);
  assert.match(markup, /including 3 uncommitted changes/u);
  assert.match(markup, /Branch guild\/task-1a2b3c4d, with 2 commits not merged yet/u);
  assert.match(markup, /the conversation is kept/iu);
  assert.match(markup, /<button type="button" class="danger"[^>]*>.*Discard<\/button>/u);
  assert.match(markup, /<button type="button" autoFocus=""|<button type="button"[^>]*>Cancel<\/button>/u);
  assert.doesNotMatch(markup, /already merged back/u);

  const merged = renderToStaticMarkup(
    <WorktreeDiscardDialog state={{ phase: "confirm" }} facts={worktreeDiscardFacts(worktree({ status: "applied" }))} messages={zh} cancelLabel="取消" onConfirm={noop} onClose={noop} />,
  );
  assert.match(merged, /改动已经合并回去了，丢弃只是清理/u);
  assert.doesNotMatch(merged, /未提交的改动/u);

  const other = renderToStaticMarkup(
    <WorktreeDiscardDialog state={{ phase: "confirm" }} facts={undefined} messages={en} cancelLabel="Cancel" onConfirm={noop} onClose={noop} />,
  );
  assert.match(other, /The worktree folder and every file in it/u);
  assert.doesNotMatch(other, /Branch guild/u, "no invented numbers for a task that is not open");
});

test("discarding disables both buttons, and a failure is shown inside the dialog", () => {
  const working = renderToStaticMarkup(
    <WorktreeDiscardDialog state={{ phase: "working" }} facts={undefined} messages={en} cancelLabel="Cancel" onConfirm={noop} onClose={noop} />,
  );
  assert.equal(working.match(/disabled=""/gu)?.length, 2);
  assert.match(working, /Discarding…/u);
  const failed = renderToStaticMarkup(
    <WorktreeDiscardDialog state={{ phase: "failed", message: "The worktree could not be discarded." }} facts={undefined} messages={en} cancelLabel="Cancel" onConfirm={noop} onClose={noop} />,
  );
  assert.match(failed, /role="alert">The worktree could not be discarded\./u);
  assert.doesNotMatch(failed, /disabled=""/u);
});

test("the sidebar glyph is a branch mark with a status label", () => {
  const markup = renderToStaticMarkup(<WorktreeGlyph status="applied" messages={zh} />);
  assert.match(markup, /guild-worktree-glyph applied/u);
  assert.match(markup, /aria-label="独立 worktree（已合并）"/u);
});

function sidebarRow(patch: Record<string, unknown>) {
  const task = {
    taskId: "task-wt", workspaceId: "workspace-1", title: "Sample review", pinned: false, archived: false, updatedAtMs: 1,
    ...patch,
  };
  return renderToStaticMarkup(
    <WorkspaceTree
      workspace={workspace({ tasks: [task] as never })} expanded activeTaskId="other"
      pendingTaskIds={new Set()} unreadTaskIds={new Set()} locale="en-US"
      onToggle={noop} onOpenTask={noop} onNewTask={noop} onPinTask={noop} onArchiveTask={noop} onContextMenu={noop}
    />,
  );
}

test("an idle worktree task shows the branch mark in the status slot; running and waiting marks keep precedence", () => {
  const idle = sidebarRow({ worktreeStatus: "active" });
  assert.match(idle, /<span class="guild-task-state idle" title="Isolated worktree">/u);
  assert.match(idle, /guild-worktree-glyph active/u);
  assert.doesNotMatch(idle, /guild-status-mark/u);
  assert.match(sidebarRow({ worktreeStatus: "applied" }), /title="Isolated worktree \(merged\)"/u);

  const running = sidebarRow({ worktreeStatus: "active", activeRunState: "running" });
  assert.doesNotMatch(running, /guild-worktree-glyph/u);
  assert.match(running, /guild-status-mark running/u);
  const waiting = sidebarRow({ worktreeStatus: "active", activeRunState: "awaiting_permission" });
  assert.doesNotMatch(waiting, /guild-worktree-glyph/u);
  assert.match(waiting, /guild-status-mark permission/u);
  const failed = sidebarRow({ worktreeStatus: "active", activeRunState: "failed" });
  assert.doesNotMatch(failed, /guild-worktree-glyph/u);

  const plain = sidebarRow({});
  assert.doesNotMatch(plain, /guild-worktree-glyph/u);
  assert.match(plain, /guild-status-mark idle/u);
});

test("the stylesheet gives the chip a no-drag region, tokens only, and the dialogs reuse the shared dialog frame", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const chip = /\.guild-worktree-chip \{[^}]*\}/u.exec(css)?.[0] ?? "";
  assert.match(chip, /-webkit-app-region: no-drag/u);
  assert.match(chip, /border: 1px solid var\(--guild-line-strong\)/u);
  const worktreeSection = css.slice(css.indexOf("worktree (F3)"), css.indexOf("responsive */"));
  assert.doesNotMatch(worktreeSection, /#[0-9a-fA-F]{3,8}\b|\brgb\(/u);
  assert.match(css, /\.guild-worktree-dialog \{/u);
});
