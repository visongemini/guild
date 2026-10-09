import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { freezeGrokModelCatalog } from "@guild/contracts";
import { REAL_CATALOG } from "./model-catalog.fixture.js";
import { messagesFor } from "./locales.js";
import { zhModelDescription } from "./model-descriptions.js";
import { modelPickerView } from "./model-picker.js";

const ZH = messagesFor("zh-CN");
const EN = messagesFor("en-US");
const selection = { modelId: "grok-4.7", reasoningEffort: "high", source: "task", canChange: true } as const;
const rows = (messages: typeof ZH, catalog = REAL_CATALOG) =>
  Object.fromEntries(modelPickerView({ messages, catalog, selection }).models.map((row) => [row.id, row]));

test("the known ids get their Chinese description in the zh-CN picker", () => {
  const view = rows(ZH);
  assert.equal(view["grok-4.7"]?.description, "最新一代，官方默认");
  assert.equal(view["grok-4.7-build-fast"]?.description, "回得更快，额度消耗约 2 倍");
  assert.equal(view["grok-4.6"]?.description, "上一代");
  assert.equal(view["grok-4.5"]?.description, "更早一代");
});

test("the English picker keeps the official text, and an unknown id keeps it in Chinese too", () => {
  const view = rows(EN);
  assert.equal(view["grok-4.7"]?.description, "SpaceXAI's latest frontier model");
  assert.equal(view["grok-4.7-build-fast"]?.description, "Fast variant. 2x the price.");
  const catalog = freezeGrokModelCatalog({
    models: [
      { id: "grok-5-preview", name: "Grok 5 Preview", description: "Early access model", reasoningEfforts: [{ id: "high", label: "High", isDefault: true }], contextWindows: [256000] },
      { id: "grok-5-bare", name: "Grok 5 Bare", reasoningEfforts: [], contextWindows: [] },
    ],
    runtimeDefaultModelId: "grok-5-preview",
  });
  const zh = rows(ZH, catalog);
  assert.equal(zh["grok-5-preview"]?.description, "Early access model");
  assert.equal(zh["grok-5-bare"]?.description, undefined, "no official text and no known id: no description");
});

test("the price tag still follows the runtime's own statement, not the translation", () => {
  const view = rows(ZH);
  assert.equal(view["grok-4.7-build-fast"]?.priceMultiplier, "2");
  assert.equal(view["grok-4.7"]?.priceMultiplier, undefined);
  assert.equal(view["grok-4.6"]?.priceMultiplier, undefined);
});

test("if the runtime states a different premium, the official text wins over our fixed '2 倍'", () => {
  assert.equal(zhModelDescription("grok-4.7-build-fast", "Fast variant. 3x the price."), "Fast variant. 3x the price.");
  assert.equal(zhModelDescription("grok-4.7-build-fast", "Fast variant. 2x the price."), "回得更快，额度消耗约 2 倍");
  assert.equal(zhModelDescription("grok-4.7-build-fast", undefined), "回得更快，额度消耗约 2 倍");
  assert.equal(zhModelDescription("constructor", "official"), "official", "prototype keys are not model ids");
});

test("only the translation table names model ids, and only the message catalog uses it", async () => {
  const directory = new URL("../src/", import.meta.url);
  const sources = (await readdir(directory)).filter((name) => /\.(?:ts|tsx)$/u.test(name) && !/\.(?:test|fixture)\.(?:ts|tsx)$/u.test(name));
  const naming: string[] = [];
  const importers: string[] = [];
  for (const name of sources) {
    const source = await readFile(new URL(name, directory), "utf8");
    if (/grok-\d/u.test(source)) naming.push(name);
    if (/from "\.\/model-descriptions\.js"/u.test(source)) importers.push(name);
  }
  assert.deepEqual(naming, ["model-descriptions.ts"]);
  assert.deepEqual(importers, ["change-messages.ts"]);
});
