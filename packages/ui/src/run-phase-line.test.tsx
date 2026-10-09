import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RunPhaseProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { RunPhaseLine } from "./RunPhaseLine.js";

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

test("renders the label and the phase and total time with the run-status look", () => {
  const markup = render({ phase: "thinking" }, TURN_START + 35_000);
  assert.match(markup, /^<div class="guild-run-status guild-run-phase thinking">/u);
  assert.match(markup, /<span role="status" aria-live="polite">Thinking<\/span>/u);
  assert.match(markup, /<time aria-hidden="true">23s \u00b7 total 35s<\/time>/u);
  assert.match(markup, /guild-spin/u);
});

test("the live region is the label only, never the ticking time", () => {
  const markup = render({ phase: "running_tool", toolName: "Bash" }, TURN_START + 35_000);
  assert.equal(markup.match(/role="status"/gu)?.length, 1);
  assert.equal(markup.match(/aria-live="polite"/gu)?.length, 1);
  assert.match(markup, /<span role="status" aria-live="polite">Running Bash<\/span>/u);
  assert.doesNotMatch(markup, /<time[^>]*role=/u);
});

test("omits the phase part when the phase began with the turn", () => {
  const markup = render({ phase: "starting_runtime", phaseStartedAtMs: TURN_START }, TURN_START + 12_000);
  assert.match(markup, /<time aria-hidden="true">total 12s<\/time>/u);
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
  assert.match(markup, /<time aria-hidden="true">53 \u79d2 \u00b7 \u5171 1 \u5206 05 \u79d2<\/time>/u);
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
  assert.match(app, /runPhase !== undefined\s*\?\s*<RunPhaseLine projection=\{runPhase\} locale=\{locale\} \/>\s*:\s*runStatus !== undefined && <RunStatusLine/u);
  assert.match(app, /previous\.runPhase === next\.runPhase/u);
  assert.match(app, /runPhase=\{commandStatus === undefined \? activeTask\.runPhase : undefined\}/u);
});
