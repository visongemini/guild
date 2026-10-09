import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("the renderer carries no model ids and none of the removed model constants", async () => {
  const directory = new URL("../src/", import.meta.url);
  const files = (await readdir(directory)).filter((name) =>
    /\.(?:ts|tsx|css)$/u.test(name) && !/\.(?:test|fixture)\.(?:ts|tsx)$/u.test(name));
  assert.ok(files.length > 20);
  for (const name of files) {
    const source = await readFile(new URL(name, directory), "utf8");
    assert.doesNotMatch(source, /grok-\d/u, `${name} hard-codes a model id`);
    assert.doesNotMatch(
      source,
      /GUILD_GROK_MODELS|GUILD_GROK_REASONING_EFFORTS|supportsGuildGrokReasoningEffort|availableModels|\bselectedModel\b/u,
      `${name} uses a removed model symbol`,
    );
  }
});
