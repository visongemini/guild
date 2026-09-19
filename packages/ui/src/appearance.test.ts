import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readAppearance } from "./appearance.js";
test("reading preferences tolerate corrupted or unavailable storage and reject unsupported values", () => {
  assert.deepEqual(readAppearance({ getItem: () => "{broken" }), { theme: "light", textSize: 16, density: "comfortable" });
  assert.equal(readAppearance({ getItem: () => { throw new Error("blocked"); } }).textSize, 16);
  assert.deepEqual(readAppearance({ getItem: () => JSON.stringify({ theme: "dark", textSize: 18, density: "compact" }) }),
    { theme: "dark", textSize: 18, density: "compact" });
  assert.deepEqual(readAppearance({ getItem: () => JSON.stringify({ theme: "injected", textSize: -40, density: "tiny" }) }),
    { theme: "light", textSize: 16, density: "comfortable" });
});

test("settings selects keep theme-owned text and surfaces in dark mode", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = styles.match(/\.guild-setting-field select \{[^}]+\}/u)?.[0] ?? "";
  const optionRule = styles.match(/\.guild-setting-field select option \{[^}]+\}/u)?.[0] ?? "";
  assert.match(rule, /background: var\(--guild-surface\)/u);
  assert.match(rule, /color: var\(--guild-text\)/u);
  assert.match(rule, /color-scheme: inherit/u);
  assert.match(optionRule, /background: var\(--guild-surface\)/u);
  assert.match(optionRule, /color: var\(--guild-text\)/u);
  assert.doesNotMatch(rule, /rgba\(255,255,255/u);
});
