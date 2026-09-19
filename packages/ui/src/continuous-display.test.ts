import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { continuousFooter } from "./continuous-display.js";
import { ContinuousRoundRecord, ContinuousTaskCard } from "./ContinuousTask.js";

const footerText = "GUILD_CONTINUOUS_SUMMARY: Tests passed\nGUILD_CONTINUOUS_REMAINING: Review the app\nGUILD_CONTINUOUS_VERDICT: CONTINUE";

test("extracts only the complete terminal control footer, retaining the original body", () => {
  const raw = `# Result\n\nFixed the draft.\n\n${footerText}\n`;
  assert.deepEqual(continuousFooter(raw), {
    body: "# Result\n\nFixed the draft.",
    summary: "Tests passed",
    remaining: "Review the app",
    verdict: "CONTINUE",
  });
  assert.ok(raw.endsWith(footerText + "\n"), "parsing must not mutate source text");
  assert.equal(continuousFooter(footerText.replace("CONTINUE", "UNKNOWN")), undefined);
  assert.equal(continuousFooter(footerText.split("\n").slice(0, 2).join("\n")), undefined);
  assert.equal(continuousFooter(footerText + "\nFurther authored explanation"), undefined);
  assert.equal(continuousFooter(footerText.replaceAll("\n", "\r\n"))?.verdict, "CONTINUE");
});

test("preserves protocol examples in fenced, quoted, and indented code", () => {
  assert.equal(continuousFooter("~~~text\n" + footerText), undefined);
  assert.equal(continuousFooter("```text\n" + footerText + "\n```"), undefined);
  assert.equal(continuousFooter(footerText.split("\n").map((line) => "> " + line).join("\n")), undefined);
  assert.equal(continuousFooter(footerText.split("\n").map((line) => "    " + line).join("\n")), undefined);
  assert.equal(continuousFooter("~~~text\ncode\n~~~\n" + footerText)?.body, "~~~text\ncode\n~~~");
});

test("renders bilingual round notes without raw protocol fields or an authoritative completion claim", () => {
  const footer = continuousFooter(footerText)!;
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderToStaticMarkup(createElement(ContinuousRoundRecord, { footer, locale }));
    assert.match(html, /<details/u);
    assert.doesNotMatch(html, /GUILD_CONTINUOUS_|<details[^>]* open/u);
    assert.match(html, locale === "zh-CN" ? /模型判断/u : /Model assessment/u);
    assert.match(html, /Tests passed/u);
  }
});

test("continuous task cards retain escaped detail and controls matching their persisted status", () => {
  const base = {
    objective: "Keep the learner's own voice",
    phase: "audit" as const,
    cycle: 3,
    summary: "<script>untrusted</script>",
    remaining: "Verify the printed result",
  };
  for (const status of ["active", "paused", "blocked", "completed", "stopped"] as const) {
    const html = renderToStaticMarkup(createElement(ContinuousTaskCard, {
      task: { ...base, status }, locale: "en-US", running: true, busy: false, onAction: () => undefined,
    }));
    assert.match(html, /Keep the learner/u);
    assert.match(html, /Verify the printed result/u);
    assert.doesNotMatch(html, /<script>/u);
    assert.match(html, /&lt;script&gt;/u);
    assert.equal(html.includes(">Pause cycles<"), status === "active");
    assert.equal(html.includes(">Resume cycles<"), status === "paused" || status === "blocked");
  }
});
