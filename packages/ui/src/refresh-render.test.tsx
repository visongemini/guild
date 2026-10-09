import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { ActivityGroupView, Timeline, TimelineItem } from "./App.js";
import { messagesFor } from "./locales.js";
import { REAL_CATALOG } from "./model-catalog.fixture.js";
import { ModelPicker } from "./ModelPicker.js";

const answer = (patch: Record<string, unknown> = {}) => ({
  entryId: "a1", taskId: "t", runId: "r", sequence: 2, createdAtMs: 1, updatedAtMs: 2, status: "completed",
  kind: "assistant", text: "Done.", ...patch,
}) as unknown as TimelineItemProjection;

const noop = () => undefined;
const render = (item: TimelineItemProjection, extra: { lastTurn?: boolean; turnMeta?: string; locale?: "en-US" | "zh-CN" } = {}) =>
  renderToStaticMarkup(
    <TimelineItem
      item={item}
      locale={extra.locale ?? "en-US"}
      canRetry={false}
      onOpenExternal={noop}
      onPermissionDecision={async () => undefined}
      onBranch={async () => undefined}
      onRetryToDraft={noop}
      onOpenRuntimeDiagnostics={noop}
      {...(extra.lastTurn === undefined ? {} : { lastTurn: extra.lastTurn })}
      {...(extra.turnMeta === undefined ? {} : { turnMeta: extra.turnMeta })}
    />,
  );

test("a finished answer ends in a footer with labelled copy and branch buttons and the turn time", () => {
  const markup = render(answer(), { lastTurn: true, turnMeta: "Took 4m 12s" });
  assert.match(markup, /class="guild-turn-footer last"/u);
  assert.match(markup, /<button[^>]*guild-ghost-button[^>]*>.*?Copy<\/button>/u);
  assert.match(markup, /Branch from here<\/button>/u);
  assert.match(markup, /<span class="guild-turn-meta">Took 4m 12s<\/span>/u);
});

test("older answers keep the footer for hover, a streaming answer has none, and the slot renders nothing yet", () => {
  assert.match(render(answer()), /class="guild-turn-footer"/u);
  assert.doesNotMatch(render(answer({ status: "streaming" })), /guild-turn-footer/u);
  assert.doesNotMatch(render(answer(), { lastTurn: true }), /guild-turn-slot|guild-turn-meta/u);
});

test("a user bubble keeps its hover actions beside it and gets no turn footer", () => {
  const markup = render(answer({ kind: "user", entryId: "u1" }));
  assert.match(markup, /guild-message-actions/u);
  assert.doesNotMatch(markup, /guild-turn-footer/u);
});

test("the model popover tags only the model whose official description states a premium", () => {
  const markup = renderToStaticMarkup(
    <ModelPicker
      messages={messagesFor("zh-CN")}
      catalog={REAL_CATALOG}
      selection={{ modelId: "grok-4.7", reasoningEffort: "high", source: "task", canChange: true }}
      onApply={async () => { throw new Error("not called"); }}
      initialOpen
    />,
  );
  assert.equal(markup.match(/guild-model-price-tag/gu)?.length, 1);
  assert.match(markup, /<em class="guild-model-price-tag">2 倍价格<\/em>/u);
  assert.match(markup, /class="guild-model-footnote"/u);
  assert.match(markup, /guild-model-picker-caret/u);
});

test("permission cards style allow and reject options from the option kind in the projection", async () => {
  const { renderToStaticMarkup: toMarkup } = await import("react-dom/server");
  const permission = {
    entryId: "p", taskId: "t", runId: "r", sequence: 3, createdAtMs: 1, updatedAtMs: 1, status: "waiting", kind: "permission",
    permissionId: "p1", title: "rm -rf cache",
    options: [
      { optionId: "a", name: "Allow once", kind: "allow_once" },
      { optionId: "r", name: "Reject", kind: "reject_once" },
    ],
  } as unknown as TimelineItemProjection;
  const markup = toMarkup(
    <TimelineItem item={permission} locale="en-US" canRetry={false} onOpenExternal={noop} onPermissionDecision={async () => undefined}
      onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
  assert.match(markup, /<code class="guild-permission-title">rm -rf cache<\/code>/u);
  assert.match(markup, /class="allow primary"[^>]*>Allow once/u);
  assert.match(markup, /class="reject"[^>]*>Reject/u);
  assert.match(markup, /class="dismiss"/u);
});

test("only allow-once is the filled primary action, whatever order the runtime lists the options in", () => {
  const permission = {
    entryId: "p", taskId: "t", runId: "r", sequence: 3, createdAtMs: 1, updatedAtMs: 1, status: "waiting", kind: "permission",
    permissionId: "p1", title: "x",
    options: [
      { optionId: "always", name: "Always", kind: "allow_always" },
      { optionId: "once", name: "Once", kind: "allow_once" },
    ],
  } as unknown as TimelineItemProjection;
  const markup = renderToStaticMarkup(
    <TimelineItem item={permission} locale="en-US" canRetry={false} onOpenExternal={noop} onPermissionDecision={async () => undefined}
      onBranch={async () => undefined} onRetryToDraft={noop} onOpenRuntimeDiagnostics={noop} />,
  );
  assert.match(markup, /class="allow"[^>]*>Always/u);
  assert.match(markup, /class="allow primary"[^>]*>Once/u);
});

const tool = (id: string, toolKind: string, toolStatus: string, patch: Record<string, unknown> = {}) => ({
  entryId: id, taskId: "t", runId: "r", sequence: 1, createdAtMs: 0, updatedAtMs: 4_000, status: "completed", kind: "tool",
  title: id, toolKind, toolStatus, content: [], locations: [], ...patch,
}) as unknown as TimelineItemProjection;
const thought = (elapsedMs: number) => ({
  entryId: `th${elapsedMs}`, taskId: "t", runId: "r", sequence: 1, createdAtMs: 0, updatedAtMs: elapsedMs, status: "completed",
  kind: "thought", text: "hmm", startedAtMs: 0, elapsedMs,
}) as unknown as TimelineItemProjection;
const group = (items: TimelineItemProjection[], locale: "zh-CN" | "en-US" = "zh-CN") =>
  renderToStaticMarkup(<ActivityGroupView items={items} locale={locale} />);

test("a finished group says how many steps ran, counts each kind and the span, and shows failures apart", () => {
  const items = [
    thought(8_000), thought(4_000),
    tool("a", "read", "completed"), tool("b", "read", "completed"), tool("c", "execute", "failed"), tool("d", "edit", "completed"),
  ];
  const markup = group(items);
  assert.match(markup, /<b class="guild-activity-title">已完成 4 步<\/b>/u);
  assert.match(markup, /思考 <b>12 秒<\/b>/u, "thinking time adds up across thought items");
  assert.match(markup, /读取 <b>2<\/b>/u);
  assert.match(markup, /命令 <b>1<\/b>/u);
  assert.match(markup, /修改 <b>1<\/b>/u);
  assert.match(markup, /<span class="guild-activity-failed">失败 <b>1<\/b><\/span>/u);
  assert.match(markup, /<span class="guild-activity-dur">8 秒<\/span>/u);
  assert.doesNotMatch(markup, /guild-activity-body/u, "collapsed groups hold no step rows");
});

test("a running group names its step and shows no span; a thought-only group shows only its thinking time", () => {
  const running = group([tool("a", "read", "completed"), tool("b", "search", "in_progress", { status: "streaming" })]);
  assert.match(running, /<b class="guild-activity-title">进行中 · 第 2 步<\/b>/u);
  assert.doesNotMatch(running, /guild-activity-dur/u);
  const onlyThought = group([thought(9_000)]);
  assert.match(onlyThought, /<b class="guild-activity-title">思考了 9 秒<\/b>/u);
  assert.doesNotMatch(onlyThought, /guild-activity-dur|guild-activity-stats/u);
  assert.match(group([tool("a", "read", "completed")], "en-US"), /Completed 1 step<\/b>/u);
});

const user = (runId: string, createdAtMs: number) => ({
  entryId: `u-${runId}`, taskId: "t", runId, sequence: 1, createdAtMs, updatedAtMs: createdAtMs, status: "completed", kind: "user", text: "go",
}) as unknown as TimelineItemProjection;
const reply = (runId: string, createdAtMs: number, updatedAtMs: number) => ({
  entryId: `a-${runId}`, taskId: "t", runId, sequence: 2, createdAtMs, updatedAtMs, status: "completed", kind: "assistant", text: "ok",
}) as unknown as TimelineItemProjection;

function timeline(items: TimelineItemProjection[], running: boolean): string {
  return renderToStaticMarkup(
    <Timeline
      items={items}
      locale="en-US"
      running={running}
      onOpenExternal={noop}
      onPermissionDecision={async () => undefined}
      onBranch={async () => undefined}
      onRetryToDraft={noop}
      onOpenRuntimeDiagnostics={noop}
    />,
  );
}

test("the turn time shows under finished turns only, never under the run that is still live", () => {
  const items = [user("r1", 0), reply("r1", 1_000, 62_000), user("r2", 70_000), tool("t2", "read", "in_progress", { runId: "r2", createdAtMs: 71_000, updatedAtMs: 90_000 }), reply("r2", 80_000, 90_000)];
  const live = timeline(items, true);
  assert.equal(live.match(/guild-turn-meta/gu)?.length, 1, "only the finished first turn");
  assert.match(live, /Took 1m 02s/u);
  const finished = timeline(items.map((entry) => entry.kind === "tool" ? tool("t2", "read", "completed", { runId: "r2", createdAtMs: 71_000, updatedAtMs: 90_000 }) : entry), false);
  assert.equal(finished.match(/guild-turn-meta/gu)?.length, 2);
});

test("Cmd+N is macOS-only, needs a loaded projection and stays out of modal dialogs", async () => {
  const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /!event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey \|\| event\.shiftKey \|\| event\.key\.toLocaleLowerCase\(\) !== "n"/u);
  assert.match(source, /busy \|\| projection === undefined \? Promise\.resolve\(\) : createTask\(\)/u);
  assert.match(source, /document\.querySelector\('\[aria-modal="true"\]'\) !== null\) return/u);
});
