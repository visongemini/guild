import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match?.[1], `missing ${selector} block`);
  return match[1];
}

test("window chrome stays in reserved tracks instead of overlaying the pane", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const shell = cssBlock(css, ".guild-shell");
  const sidebar = cssBlock(css, ".guild-sidebar");
  const projects = cssBlock(css, ".guild-project-section");
  const profile = cssBlock(css, ".guild-profile-bar");
  const accountPopover = cssBlock(css, ".guild-account-popover");
  const composer = cssBlock(css, ".guild-composer-wrap");
  const main = cssBlock(css, ".guild-main");
  const conversation = cssBlock(css, ".guild-conversation");
  const topbar = cssBlock(css, ".guild-topbar");
  const topActions = cssBlock(css, ".guild-top-actions");
  const settingsSectionSpacing = cssBlock(css, ".guild-settings-panel > .guild-setting-label:not(:first-child)");
  const settingsSection = cssBlock(css, ".guild-settings-section");
  const taskRow = cssBlock(css, ".guild-task-row");
  const taskRowWrap = cssBlock(css, ".guild-task-row-wrap");
  const taskHoverActions = cssBlock(css, ".guild-task-hover-actions");
  const taskTrailing = cssBlock(css, ".guild-task-trailing");
  const taskState = cssBlock(css, ".guild-task-state");
  const activityIcons = cssBlock(css, ".guild-activity-tool-icons");
  const runStatus = cssBlock(css, ".guild-run-status");
  const commandStatus = cssBlock(css, ".guild-command-status");
  const message = cssBlock(css, ".guild-message");

  assert.match(shell, /overflow:\s*hidden/);
  assert.match(shell, /minmax\(0,\s*1fr\)/);
  assert.match(main, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(main, /--guild-content-width:\s*840px/);
  assert.match(main, /--guild-content-gutter:\s*28px/);
  assert.match(conversation, /calc\(\(100% - var\(--guild-content-width\)\) \/ 2\)/);
  assert.match(topbar, /min-width:\s*0/);
  assert.match(topActions, /display:\s*flex/);
  assert.match(topActions, /align-items:\s*center/);
  assert.match(topActions, /gap:\s*2px/);
  assert.match(settingsSectionSpacing, /margin-top:\s*16px/);
  assert.match(settingsSection, /margin-top:\s*16px/);
  assert.match(sidebar, /overflow:\s*hidden/);
  assert.match(sidebar, /font-size:\s*15px/);
  assert.match(taskRow, /font-size:\s*15px/);
  assert.match(taskRow, /grid-template-columns:\s*16px minmax\(0,1fr\) auto/);
  assert.match(taskRowWrap, /position:\s*relative/);
  assert.match(taskHoverActions, /position:\s*absolute/);
  assert.match(taskHoverActions, /visibility:\s*hidden/);
  assert.match(taskTrailing, /justify-content:\s*flex-end/);
  assert.match(taskState, /place-items:\s*center/);
  assert.match(activityIcons, /inline-flex/);
  assert.match(runStatus, /grid-template-columns:\s*14px minmax\(0,1fr\) auto/);
  assert.doesNotMatch(runStatus, /position:\s*(?:absolute|fixed)/);
  assert.match(commandStatus, /grid-template-columns:\s*14px auto minmax\(0,1fr\)/);
  assert.match(message, /font-size:\s*15px/);
  assert.match(projects, /flex:\s*1 1 0/);
  assert.match(profile, /flex:\s*0 0 auto/);
  assert.match(accountPopover, /bottom:\s*58px/);
  assert.match(accountPopover, /max-height:\s*min\(420px,\s*calc\(100% - 68px\)\)/);
  assert.match(composer, /grid-area:\s*composer/);
  assert.match(composer, /position:\s*relative/);
  assert.match(composer, /min-width:\s*0/);
  assert.match(composer, /width:\s*min\(calc\(var\(--guild-content-width\) \+ var\(--guild-content-gutter\) \+ var\(--guild-content-gutter\)\),\s*100%\)/);
  assert.match(composer, /padding:\s*0 var\(--guild-content-gutter\)/);
  assert.doesNotMatch(composer, /position:\s*absolute/);
});

test("user message actions do not reserve a blank row inside the bubble", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const userActions = cssBlock(css, ".guild-message-user .guild-message-actions");

  assert.match(userActions, /position:\s*absolute/);
  assert.match(userActions, /right:\s*calc\(100% \+ 5px\)/);
  assert.match(userActions, /bottom:\s*0/);
  assert.match(userActions, /justify-content:\s*flex-end/);
});

test("workbench opens as a persistent third column instead of an overlay", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const shell = cssBlock(css, ".guild-shell.workbench-open");
  const workbench = cssBlock(css, ".guild-workbench");
  const resizer = cssBlock(css, ".guild-workbench-resizer");
  const mainEnd = source.indexOf("</main>");
  const workbenchStart = source.indexOf('<aside ref={workbenchPanel} className="guild-workbench"');

  assert.ok(mainEnd >= 0 && workbenchStart > mainEnd, "workbench must be a sibling of the main pane");
  assert.match(source, /\$\{workbenchOpen && activeTask !== undefined \? "workbench-open" : ""\}/);
  assert.match(source, /const effectiveWorkbenchWidth = viewport\.width <= 1000 \? WORKBENCH_MIN_WIDTH : workbenchWidth/);
  assert.match(source, /--workbench-width": `\$\{effectiveWorkbenchWidth\}px`/);
  assert.match(source, /className={`guild-workbench-resizer \$\{viewport\.width <= 1000 \? "locked" : ""\}`}/);
  assert.match(source, /writeWorkbenchWidth\(window\.localStorage, finalWidth\)/);
  assert.match(shell, /grid-template-columns:\s*minmax\(0,\s*var\(--effective-sidebar-width\)\) minmax\(0,\s*1fr\) minmax\(0,\s*var\(--effective-workbench-width\)\)/);
  assert.match(workbench, /position:\s*relative/);
  assert.match(workbench, /height:\s*100%/);
  assert.doesNotMatch(workbench, /position:\s*absolute/);
  assert.doesNotMatch(workbench, /box-shadow/);
  assert.match(resizer, /cursor:\s*col-resize/);
});

test("pre-activity status stays in the conversation flow on the shared content axis", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const timelineStart = source.indexOf('return <div className="guild-timeline">');
  const timelineEnd = source.indexOf("\nfunction RunStatusLine", timelineStart);
  const runStatus = source.indexOf("<RunStatusLine", timelineStart);

  assert.ok(timelineStart >= 0 && timelineEnd > timelineStart);
  assert.ok(runStatus > timelineStart && runStatus < timelineEnd);
});

test("account usage opens as a sidebar-anchored non-modal popover", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const accountStart = source.indexOf('className="guild-account-popover"');
  const profileBar = source.indexOf('className="guild-profile-bar"');
  const asideEnd = source.indexOf("</aside>");

  assert.ok(profileBar >= 0);
  assert.ok(accountStart > profileBar && accountStart < asideEnd);
  assert.match(source.slice(accountStart, accountStart + 260), /role="dialog"/);
  assert.doesNotMatch(source.slice(accountStart, accountStart + 260), /aria-modal/);
  assert.doesNotMatch(source, /guild-dialog-backdrop[^]*guild-dialog-account[^]*messages\.usage/);
  assert.match(source, /ref=\{profileTriggerRef\}/);
  assert.match(source, /aria-haspopup="dialog"/);
  assert.match(source, /if \(accountOpen\) accountFirstActionRef\.current\?\.focus\(\)/);
  assert.match(source, /ref=\{accountFirstActionRef\}/);
  assert.match(source, /profileTriggerRef\.current\?\.focus\(\)/);
});

test("settings tabs expose roving keyboard focus and linked tab panels", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /tabIndex=\{settingsTab === tab \? 0 : -1\}/);
  assert.match(source, /onKeyDown=\{\(event\) => moveSettingsTabFocus\(event, tab, setSettingsTab\)\}/);
  assert.match(source, /aria-controls=\{`guild-settings-panel-\$\{tab\}`\}/);
  for (const tab of ["general", "grok", "privacy", "about"]) {
    assert.match(source, new RegExp(`id="guild-settings-panel-${tab}" role="tabpanel"`, "u"));
    assert.match(source, new RegExp(`aria-labelledby="guild-settings-tab-${tab}"`, "u"));
  }
  assert.match(source, /event\.key === "Home"/);
  assert.match(source, /event\.key === "End"/);
});

test("task rows expose keyboard-accessible pin and archive controls without nesting buttons", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const rowStart = source.indexOf('className={`guild-task-row-wrap');
  const rowEnd = source.indexOf("</div>", rowStart);
  const row = source.slice(rowStart, rowEnd);

  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  assert.match(row, /className="guild-task-hover-action"/u);
  assert.match(row, /aria-label=\{task\.pinned \? messages\.unpin : messages\.pin\}/u);
  assert.match(row, /aria-label=\{messages\.archive\}/u);
  assert.match(row, /onPinTask\(task\)/u);
  assert.match(row, /onArchiveTask\(task\)/u);
  assert.ok(row.indexOf("</button>") < row.indexOf('className="guild-task-hover-actions"'));
});

test("background projection delivery does not wait for an animation frame", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const unsubscribe = api.onProjectionChanged");
  const end = source.indexOf("}, [api]);", start);
  assert.ok(start >= 0 && end > start);
  const subscription = source.slice(start, end);

  assert.match(subscription, /queueMicrotask/);
  assert.doesNotMatch(subscription, /requestAnimationFrame/);
});
