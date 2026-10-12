import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function cssBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"));
  assert.ok(match?.[1], `missing ${selector} block`);
  return match[1];
}

test("the picker popover opens upward from a positioned wrapper, like the context-usage popover", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const wrapper = cssBlock(css, ".guild-model-picker");
  const trigger = cssBlock(css, ".guild-model-picker-trigger");
  const popover = cssBlock(css, ".guild-model-popover");
  const contextPopover = cssBlock(css, ".guild-context-usage-detail");

  assert.match(wrapper, /position:\s*relative/);
  assert.match(wrapper, /min-width:\s*0/);
  assert.match(trigger, /cursor:\s*pointer/);
  assert.match(popover, /position:\s*absolute/);
  assert.match(popover, /right:\s*0/);
  assert.match(popover, /bottom:\s*calc\(100% \+ 7px\)/);
  assert.match(popover, /max-width:\s*min\(360px,\s*calc\(100vw - 32px\)\)/);
  assert.match(popover, /overflow-y:\s*auto/);
  assert.match(popover, /border:\s*1px solid var\(--guild-line\)/);
  assert.match(popover, /box-shadow:/);
  // Theme tokens, so the popover follows light and dark like its neighbours.
  assert.match(popover, /background:\s*var\(--guild-surface\)/);
  assert.match(popover, /color:\s*var\(--guild-text\)/);
  assert.match(popover, new RegExp(`z-index:\\s*${contextPopover.match(/z-index:\s*(\d+)/)![1]}`));
});

test("the composer clips overflow except while the picker popover is open", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(cssBlock(css, ".guild-composer-wrap"), /overflow:\s*hidden/);
  assert.match(cssBlock(css, ".guild-composer-wrap:has(.guild-model-popover)"), /overflow:\s*visible/);
});

test("every picker class the component renders is styled, and the old summary button is gone", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const component = await readFile(new URL("../src/ModelPicker.tsx", import.meta.url), "utf8");
  for (const name of [
    "guild-model-picker", "guild-model-picker-trigger", "guild-model-popover", "guild-model-heading",
    "guild-model-hint", "guild-model-list", "guild-model-row", "guild-model-row-name",
    "guild-model-row-description", "guild-model-row-meta", "guild-model-efforts",
    "guild-model-default-dot", "guild-model-notice", "guild-model-use-default",
    "guild-model-group", "guild-model-group-heading", "guild-model-action", "guild-model-engine-note",
    "guild-model-group-note", "guild-model-older", "guild-model-older-caret",
  ]) {
    assert.match(css, new RegExp(`\\.${name}[\\s,:{.\\[]`), `${name} is not styled`);
    assert.match(component, new RegExp(name), `${name} is not rendered`);
  }
  assert.doesNotMatch(css, /guild-runtime-summary/);
  assert.match(cssBlock(css, ".guild-model-row"), /text-align:\s*left/);
  assert.match(cssBlock(css, ".guild-model-efforts"), /grid-auto-flow:\s*column/);
});

test("forced-colors mode keeps the selected state and the popover edge visible", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.guild-model-popover \{ border-color: CanvasText; \}/);
  assert.match(forced, /\.guild-model-row\.selected, \.guild-model-efforts button\.selected \{ outline: 2px solid Highlight;/);
});

test("the phase line reuses the run-status layout instead of defining its own", async () => {
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const runStatus = cssBlock(css, ".guild-run-status");
  assert.match(runStatus, /grid-template-columns:\s*14px minmax\(0,1fr\) auto/);
  assert.doesNotMatch(css, /\.guild-run-phase\s*\{/);
});
