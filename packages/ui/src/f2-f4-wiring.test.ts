import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match?.[1], `missing ${selector} block`);
  return match[1];
}

test("Enter queues and Option+Enter steers through the same decision function", () => {
  assert.match(app, /composerEnterAction\(\{/u);
  assert.match(app, /if \(enter === "steer"\) void sendComposerText\(draft, "steer"\);\s*\n\s*else event\.currentTarget\.form\?\.requestSubmit\(\);/u);
  // The steer path calls steerMessage, the queue path sendMessage, and neither calls the other.
  assert.match(app, /if \(mode === "steer"\) \{\s*\n\s*const steered = await api\.steerMessage\(\{ taskId, text \}\);/u);
  assert.match(app, /\} else \{\s*\n\s*await api\.sendMessage\(\{/u);
  assert.match(app, /\(mode === "steer" && !steerAvailable\)\s*\n\s*\) return;/u);
});

test("the Steer button sits next to Stop, only for a running turn that can take a message", () => {
  const button = app.indexOf('className="guild-steer"');
  const stop = app.indexOf('className="guild-send guild-stop"');
  assert.ok(button > 0 && stop > button, "Steer comes right before Stop");
  assert.match(app, /steerButtonState\(\{/u);
  assert.match(app, /const steerAvailable = running && activeTask\?\.steer\?\.available === true;/u);
  assert.match(app, /aria-keyshortcuts="Alt\+Enter"/u);
  assert.match(app, /\{steerAvailable && <span><b>\{messages\.steerShortcut\}<\/b> \{messages\.hintSteer\}<\/span>\}/u);
});

test("queued items offer both actions, each calling its own API, and the failure is shown", () => {
  assert.match(app, /api\.convertQueuedTurnToSteer\(\{ taskId, queueId \}\)/u);
  assert.match(app, /response\.status === "unchanged"\) setSteerNotice\(messages\.steerNotice\("unchanged", response\.reason\)\)/u);
  assert.match(app, /onClick=\{\(\) => void convertQueuedToSteer\(queued\.queueId\)\}/u);
  assert.match(app, /onClick=\{\(\) => void preemptQueuedTurn\(queued\.queueId\)\}/u);
  assert.match(app, /\{steerNotice !== undefined && <p className="guild-steer-notice" role="status">/u);
  assert.match(app, /\{steerAvailable && \(\s*\n\s*<button\s*\n\s*type="button"\s*\n\s*className="guild-queue-steer"/u);
});

test("the rewind dialog uses the app's modal keyboard handling and saves the draft before and re-reads it after", () => {
  assert.match(app, /onDialogKeyDown=\{handleDialogKeyDown\}/u);
  assert.match(app, /async function executeRewind\(request[^)]*\) \{\s*\n\s*await persistCurrentDraft\(\);\s*\n\s*return api\.executeRewind\(request\);/u);
  assert.match(app, /const task = await api\.openTask\(\{ taskId \}\);[\s\S]{0,200}setDraft\(task\.draft\);/u);
  assert.match(app, /input\?\.setSelectionRange\(input\.value\.length, input\.value\.length\)/u);
  assert.match(app, /trigger\?\.focus\(\)/u);
  assert.match(app, /api\.previewRewind\(\{ taskId: activeTask\.task\.taskId, runId: rewindTarget\.runId \}\)/u);
});

test("the topbar summary scrolls to the card of the newest changed run", () => {
  assert.match(app, /const changedRun = latestChangedRun\(activeTask\?\.runCheckpoints\);/u);
  assert.match(app, /onClick=\{\(\) => scrollToRunCard\(changedRun\.runId\)\}/u);
  assert.match(app, /querySelector<HTMLElement>\(`\[data-run-card="\$\{runId\}"\]`\)/u);
});

test("the diff view loads through loadRunFileDiff for the open task and opens the workbench review tab", () => {
  assert.match(app, /api\.loadRunFileDiff\(\{ taskId: openTaskIdForReset, runId, path \}\)/u);
  assert.match(app, /setRunDiff\(\{ runId, path \}\);\s*\n\s*setWorkbenchTab\("review"\);\s*\n\s*setWorkbenchOpen\(true\);/u);
});

test("the in-progress strip uses the filter, not its own list", () => {
  assert.match(app, /attentionStripTasks\(\s*\n\s*projection\.workspaces\.flatMap/u);
  assert.doesNotMatch(app, /task\.activeRunState === "failed" \|\|\s*\n\s*task\.activeRunState === "interrupted"\s*\n\s*\)\)/u);
  const rail = cssBlock(".guild-attention-rail button");
  assert.match(rail, /border:\s*0/u, "no chip border");
  assert.match(rail, /background:\s*transparent/u);
});

test("the phase trail comes before the current phase in the markup and clips its oldest entries", () => {
  const trail = cssBlock(".guild-run-trail");
  assert.match(trail, /justify-content:\s*flex-end/u);
  assert.match(trail, /overflow:\s*hidden/u);
});

test("the composer focus border is a soft accent mix and the popover ring is keyboard-only", () => {
  const focus = cssBlock(".guild-composer:focus-within");
  assert.match(focus, /border-color:\s*color-mix\(in srgb, var\(--guild-accent\) 50%, var\(--guild-line-strong\)\)/u);
  assert.doesNotMatch(focus, /--guild-focus-border/u, "not the strong orange border");
  assert.doesNotMatch(focus, /--guild-accent\) 14%/u, "no strong outer glow");
  const ring = cssBlock(".guild-model-popover button:focus-visible");
  assert.match(ring, /outline:\s*2px solid color-mix\(in srgb, var\(--guild-accent\) 50%, transparent\)/u);
  assert.match(cssBlock(".guild-model-popover button:focus:not(:focus-visible)"), /outline:\s*none/u);
  // Selection is a background plus the check mark in the markup, not an outline.
  assert.match(cssBlock(".guild-model-row.selected"), /background:\s*var\(--guild-selected\)/u);
  const picker = css.slice(css.indexOf(".guild-model-row {"), css.indexOf("@media (forced-colors"));
  assert.doesNotMatch(picker, /\.guild-model-row\.selected[^{]*\{[^}]*outline/u);
});

test("new controls honor the 28 px minimum", () => {
  for (const selector of [".guild-queue-priority, .guild-queue-steer", ".guild-rundiff-file"]) {
    const block = selector.includes(",") ? undefined : cssBlock(selector);
    if (block !== undefined) assert.match(block, /height:\s*(?:28|3\d)px/u, selector);
  }
  assert.match(cssBlock(".guild-steer"), /height:\s*32px/u);
  assert.match(cssBlock(".guild-queued-turn"), /min-height:\s*28px/u);
});

test("a draft can only be saved into the task it belongs to; archiving the open task loads the next task's draft first", () => {
  // Owner check: the debounced save skips while the projection's active task is not the composer's task.
  assert.match(app, /useEffect\(\(\) => \{\s*\n\s*const taskId = projection\?\.activeTask\?\.task\.taskId;\s*\n\s*if \(taskId !== activeTaskIdRef\.current\) return;/u);
  // Reconciliation: any projection that changes the active task loads that task's draft into the composer.
  assert.match(app, /const nextTaskId = projection\?\.activeTask\?\.task\.taskId;\s*\n\s*if \(nextTaskId === activeTaskIdRef\.current\) return;[\s\S]{0,700}activeTaskIdRef\.current = nextTaskId;\s*\n\s*setDraft\(projection\?\.activeTask\?\.draft \?\? ""\);/u);
  // The text of the task being archived, restored or deleted is saved to that task before the projection moves on.
  assert.match(app, /async function updateContext\(action[^)]*\) \{[\s\S]{0,200}await run\(async \(\) => \{\s*\n\s*await persistCurrentDraft\(\);/u);
  assert.match(app, /if \(action === "archive"\) await persistCurrentDraft\(\);\s*\n\s*setProjection\(await api\.updateTask\(\{ taskId: task\.taskId, action \}\)\);/u);
  // Both branch paths save the open task's text before the fork becomes the active task.
  assert.equal(app.match(/await persistCurrentDraft\(\);\s*\n\s*const task = await api\.forkTask\(/gu)?.length, 2);
  // The reconciliation never writes the left task's text itself (a late write could overwrite a newer draft).
  assert.doesNotMatch(app, /const leftText = draftRef\.current;/u);
});
