import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("the renderer carries no model ids and none of the removed model constants", async () => {
  const directory = new URL("../src/", import.meta.url);
  // The one exception: model-descriptions.ts translates descriptions of ids the catalog lists. It decides
  // nothing about which models exist, and model-descriptions.test.ts pins who may import it.
  const TRANSLATION_TABLE = "model-descriptions.ts";
  const files = (await readdir(directory)).filter((name) =>
    /\.(?:ts|tsx|css)$/u.test(name) && !/\.(?:test|fixture)\.(?:ts|tsx)$/u.test(name));
  assert.ok(files.length > 20);
  assert.ok(files.includes(TRANSLATION_TABLE));
  for (const name of files) {
    const source = await readFile(new URL(name, directory), "utf8");
    if (name !== TRANSLATION_TABLE) assert.doesNotMatch(source, /grok-\d/u, `${name} hard-codes a model id`);
    // Guild 3.0: the Claude catalog and the model sources are data too. Group names are fine; ids are not.
    assert.doesNotMatch(
      source,
      /\bclaude-(?:opus|sonnet|haiku|fable|\d)|\b(?:deepseek|localmodel|qwen|llama)-[a-z]*\d|"(?:opus|sonnet|haiku|fable)"/iu,
      `${name} hard-codes a Claude, Online or Local model id`,
    );
    assert.doesNotMatch(
      source,
      /GUILD_GROK_MODELS|GUILD_GROK_REASONING_EFFORTS|supportsGuildGrokReasoningEffort|availableModels|\bselectedModel\b/u,
      `${name} uses a removed model symbol`,
    );
  }
});
