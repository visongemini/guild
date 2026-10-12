import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RunPhaseProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPhaseLine, RunPhaseLineView } from "./RunPhaseLine.js";
import { messagesFor } from "./locales.js";
import { describeRunPhase, describeRunPhaseTrail, advanceRunPhaseHistory, startRunPhaseHistory } from "./run-phase-display.js";

const TURN_START = 1_000_000;

function render(
  projection: Partial<RunPhaseProjection> & Pick<RunPhaseProjection, "phase">,
  nowMs: number,
  locale: "en-US" | "zh-CN" = "en-US",
): string {
  return renderToStaticMarkup(
    <RunPhaseLine
      projection={{ turnStartedAtMs: TURN_START, phaseStartedAtMs: TURN_START + 12_000, ...projection }}
      locale={locale}
      initialNowMs={nowMs}
    />,
  );
}

test("renders a pulsing dot, the label with the time in this phase, and the whole turn on the right", () => {
  const markup = render({ phase: "thinking" }, TURN_START + 35_000);
  assert.match(markup, /^<div class="guild-run-status guild-run-phase thinking">/u);
  assert.match(markup, /<span class="guild-run-pip" aria-hidden="true"><\/span>/u);
  assert.match(markup, /<span class="guild-run-label" role="status" aria-live="polite">Thinking<\/span>/u);
  assert.match(markup, /<span class="guild-run-elapsed" aria-hidden="true">23s<\/span>/u);
  assert.match(markup, /<time aria-hidden="true">total 35s<\/time>/u);
  // A trail needs a phase that already ended while the line was mounted; a first render has none.
  assert.doesNotMatch(markup, /guild-run-trail/u);
});

test("the live region is the label only, never the ticking time", () => {
  const markup = render({ phase: "running_tool", toolName: "Bash" }, TURN_START + 35_000);
  assert.equal(markup.match(/role="status"/gu)?.length, 1);
  assert.equal(markup.match(/aria-live="polite"/gu)?.length, 1);
  assert.match(markup, /<span class="guild-run-label" role="status" aria-live="polite" title="Bash">Running Bash<\/span>/u);
  assert.doesNotMatch(markup, /<time[^>]*role=/u);
});

test("omits the phase part when the phase began with the turn", () => {
  const markup = render({ phase: "starting_runtime", phaseStartedAtMs: TURN_START }, TURN_START + 12_000);
  assert.match(markup, /<time aria-hidden="true">total 12s<\/time>/u);
  assert.doesNotMatch(markup, /guild-run-elapsed/u);
});

test("shows the soft notice without error styling once a sent prompt has waited ten seconds", () => {
  const sent = { phase: "prompt_sent" as const, phaseStartedAtMs: TURN_START };
  const early = render(sent, TURN_START + 9_999);
  const late = render(sent, TURN_START + 10_000);
  assert.match(early, />Sent<\/span>/u);
  assert.doesNotMatch(early, /not picked it up/u);
  assert.match(late, />Sent \u00b7 Grok has not picked it up yet<\/span>/u);
  assert.match(late, /guild-run-phase prompt_sent notice"/u);
  assert.doesNotMatch(late, /error|alert|failed/u);
});

test("localizes both the label and the time", () => {
  const markup = render({ phase: "waiting_for_model" }, TURN_START + 65_000, "zh-CN");
  assert.match(markup, />\u7b49\u5f85\u6a21\u578b\u54cd\u5e94<\/span>/u);
  assert.match(markup, /<span class="guild-run-elapsed" aria-hidden="true">53 \u79d2<\/span>/u);
  assert.match(markup, /<time aria-hidden="true">\u5171 1 \u5206 05 \u79d2<\/time>/u);
});

test("the only timer is one 1 Hz interval that is cleared on unmount", async () => {
  const source = await readFile(new URL("../src/RunPhaseLine.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/setInterval\(/gu)?.length, 1);
  assert.match(source, /setInterval\(update, 1_000\)/u);
  assert.match(source, /return \(\) => window\.clearInterval\(interval\)/u);
  assert.doesNotMatch(source, /setTimeout|requestAnimationFrame/u);
});

test("the timeline shows the phase line instead of the legacy status line and re-renders on change", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /runPhase !== undefined\s*\?\s*<RunPhaseLine projection=\{runPhase\} locale=\{locale\} engine=\{engine\} \/>\s*:\s*runStatus !== undefined && <RunStatusLine/u);
  assert.match(app, /previous\.runPhase === next\.runPhase/u);
  assert.match(app, /runPhase=\{commandStatus === undefined \? activeTask\.runPhase : undefined\}/u);
});

test("the trail reads in the order things happened and ends with the phase running now", () => {
  const messages = messagesFor("zh-CN");
  const phase = (name: RunPhaseProjection["phase"], started: number): RunPhaseProjection =>
    ({ phase: name, turnStartedAtMs: TURN_START, phaseStartedAtMs: TURN_START + started });
  let history = startRunPhaseHistory(phase("running_hooks", 0));
  history = advanceRunPhaseHistory(history, phase("waiting_for_model", 2_000));
  history = advanceRunPhaseHistory(history, phase("thinking", 7_000));
  const now = TURN_START + 19_000;
  const display = describeRunPhase(history.last, now, messages);
  const markup = renderToStaticMarkup(
    <RunPhaseLineView
      display={display}
      trail={describeRunPhaseTrail(history, messages)}
      totalText={messages.runPhaseTime(undefined, messages.runDuration(display.totalSeconds))}
      elapsedText={messages.runDuration(display.phaseSeconds)}
    />,
  );
  const hooks = markup.indexOf("\u6b63\u5728\u8fd0\u884c\u94a9\u5b50 2 \u79d2");
  const waiting = markup.indexOf("\u7b49\u5f85\u6a21\u578b\u54cd\u5e94 5 \u79d2");
  const thinking = markup.indexOf("\u601d\u8003\u4e2d</span>");
  assert.ok(hooks >= 0 && waiting > hooks && thinking > waiting, `order in ${markup}`);
  assert.match(markup, /<span class="guild-run-trail" aria-hidden="true">/u);
  assert.match(markup, /<span class="guild-run-current"><span class="guild-run-label"[^>]*>\u601d\u8003\u4e2d<\/span><span class="guild-run-elapsed" aria-hidden="true">12 \u79d2<\/span><\/span>/u);
});

test("an unknown tool shows the generic label and keeps the raw name in the title", () => {
  const markup = render({ phase: "running_tool", toolName: "figma_get_design" }, TURN_START + 35_000, "zh-CN");
  assert.match(markup, /title="figma_get_design">\u6b63\u5728\u8fd0\u884c\u5de5\u5177<\/span>/u);
  const known = render({ phase: "running_tool", toolName: "Read" }, TURN_START + 35_000, "zh-CN");
  assert.match(known, /title="Read">\u6b63\u5728\u8bfb\u53d6<\/span>/u);
  assert.doesNotMatch(render({ phase: "thinking" }, TURN_START + 35_000), /title=/u);
});
