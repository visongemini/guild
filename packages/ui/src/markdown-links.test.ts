import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { renderText } from "./App.js";

test("raw HTTPS and local development URLs render as clickable links", () => {
  const html = renderToStaticMarkup(renderText(
    "线上：https://example.com/docs 本机：http://127.0.0.1:4176/",
    () => undefined,
  ));

  assert.match(html, /href="https:\/\/example\.com\/docs"/u);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:4176\/"/u);
});

test("raw public HTTP URLs remain non-clickable", () => {
  const html = renderToStaticMarkup(renderText(
    "不安全：http://example.com/docs",
    () => undefined,
  ));

  assert.doesNotMatch(html, /href=/u);
  assert.match(html, /http:\/\/example\.com\/docs/u);
});
