import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TimelineItemProjection } from "@guild/contracts";
import { renderText, ToolRow } from "./App.js";

const grantUrl = "guild-media://media/123e4567-e89b-42d3-a456-426614174000.png";

test("tool image content renders a compact View Image action without exposing bytes or paths", () => {
  const item = {
    entryId: "tool-image",
    taskId: "task-1",
    runId: "run-1",
    sequence: 1,
    createdAtMs: 1,
    updatedAtMs: 2,
    status: "completed",
    kind: "tool",
    title: "View Image",
    toolKind: "read",
    toolStatus: "completed",
    content: [{
      type: "media",
      mediaType: "image",
      mimeType: "image/png",
      grantUrl,
      alt: "preview.png",
      mediaSha256: "a".repeat(64),
    }],
    locations: [],
  } as unknown as Extract<TimelineItemProjection, { readonly kind: "tool" }>;
  const html = renderToStaticMarkup(createElement(ToolRow, { item, locale: "en-US" }));
  assert.match(html, /View Image: preview\.png/u);
  assert.match(html, /guild-tool-image-button/u);
  assert.match(html, /aria-expanded="false"/u);
  assert.doesNotMatch(html, /guild-image-viewer-backdrop|guild-tool-image-preview-button/u);
  assert.doesNotMatch(html, /base64|\/Users\//u);
});

test("already-visible Markdown images render as buttons for the shared fullscreen viewer", () => {
  const html = renderToStaticMarkup(renderText(
    `![验收图](${grantUrl})`,
    () => undefined,
    "zh-CN",
  ));
  assert.match(html, /查看图片: 验收图/u);
  assert.match(html, /guild-inline-image-button/u);
  assert.match(html, /<img/u);
});
