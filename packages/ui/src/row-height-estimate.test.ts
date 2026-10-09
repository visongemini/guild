import assert from "node:assert/strict";
import test from "node:test";
import type { TimelineItemProjection } from "@guild/contracts";
import { estimateTimelineGroupHeight, groupTimeline } from "./timeline.js";

function item(patch: Record<string, unknown>): TimelineItemProjection {
  return {
    entryId: "e", taskId: "t", sequence: 1, createdAtMs: 1, updatedAtMs: 1, status: "completed", ...patch,
  } as TimelineItemProjection;
}

const single = (patch: Record<string, unknown>) => {
  const [group] = groupTimeline([item(patch)]);
  return estimateTimelineGroupHeight(group!);
};

test("collapsed activity rows reserve exactly one summary line", () => {
  const [group] = groupTimeline([
    item({ kind: "thought", text: "x".repeat(5_000), startedAtMs: 1, elapsedMs: 1 }),
    item({ entryId: "tool", kind: "tool", title: "Read", toolKind: "read", toolStatus: "completed", content: [], locations: [] }),
  ]);
  assert.equal(group!.type, "activity");
  assert.equal(estimateTimelineGroupHeight(group!), 36);
});

test("message estimates grow with text, count wide characters double, and stay whole pixels", () => {
  const short = single({ kind: "assistant", text: "ok" });
  const long = single({ kind: "assistant", text: "word ".repeat(400) });
  const paragraphs = single({ kind: "assistant", text: Array.from({ length: 10 }, () => "line").join("\n\n") });
  assert.ok(long > short * 5, `${long} vs ${short}`);
  assert.ok(paragraphs > short);
  const latin = single({ kind: "assistant", text: "a".repeat(600) });
  const cjk = single({ kind: "assistant", text: "你".repeat(600) });
  assert.ok(cjk > latin, "wide characters wrap sooner");
  for (const value of [short, long, paragraphs, latin, cjk]) assert.equal(value, Math.round(value));
  assert.ok(single({ kind: "user", text: "hi" }) > 40);
  assert.ok(single({ kind: "user", text: "word ".repeat(200) }) > single({ kind: "user", text: "hi" }));
});

test("other row kinds reserve a plausible fixed height", () => {
  assert.equal(single({ kind: "permission", permissionId: "p", title: "Allow", options: [] }), 96);
  assert.ok(single({ kind: "media", mediaType: "image", grantUrl: "guild-media://media/x.png", alt: "x", mimeType: "image/png" }) >= 100);
  assert.ok(single({ kind: "notice", text: "Session restored" }) >= 20);
  assert.ok(single({ kind: "error", text: "e".repeat(2_000) }) > single({ kind: "error", text: "e" }));
});
