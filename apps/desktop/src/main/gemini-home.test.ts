import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { geminiSettings, geminiSettingsPath, prepareGeminiHome } from "./gemini-home.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-home-")));
  roots.push(root);
  return join(root, "engines", "gemini-home");
}

describe("Gemini home and settings [PC-ENG-004]", () => {
  it("signs in with the API key, turns usage statistics and self-update off, and names the task's model", () => {
    assert.deepEqual(geminiSettings("gemini-3.5-flash-lite"), {
      security: { auth: { selectedType: "gemini-api-key" } },
      privacy: { usageStatisticsEnabled: false },
      general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
      model: { name: "gemini-3.5-flash-lite" },
    });
    for (const model of [undefined, "auto", "", "gemini 3", "x/y", "x".repeat(129)]) {
      assert.equal("model" in geminiSettings(model), false, String(model));
    }
    // Never another sign-in method, never telemetry, whatever the model is.
    const text = JSON.stringify(geminiSettings("gemini-2.5-pro"));
    for (const forbidden of ["oauth", "vertex", "gateway", "baseUrl", "apiKey", "AIza"]) assert.equal(text.includes(forbidden), false, forbidden);
  });

  it("creates the private home and replaces the settings file atomically, mode 0600", async () => {
    const home = await freshHome();
    await prepareGeminiHome(home, "gemini-3.5-flash-lite");
    const path = geminiSettingsPath(home);
    assert.equal(path, join(home, ".gemini", "settings.json"));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).model, { name: "gemini-3.5-flash-lite" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    // A later start with another model replaces it and leaves no temporary file behind.
    await prepareGeminiHome(home, "gemini-3.1-pro-preview");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).model, { name: "gemini-3.1-pro-preview" });
    await prepareGeminiHome(home, undefined);
    assert.equal("model" in JSON.parse(await readFile(path, "utf8")), false);
    assert.deepEqual(await readdir(join(home, ".gemini")), ["settings.json"]);
  });

  it("overwrites a settings file somebody else left, so the sign-in method can never be another one", async () => {
    const home = await freshHome();
    await prepareGeminiHome(home, undefined);
    await writeFile(geminiSettingsPath(home), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    await prepareGeminiHome(home, "gemini-3.5-flash-lite");
    assert.equal(JSON.parse(await readFile(geminiSettingsPath(home), "utf8")).security.auth.selectedType, "gemini-api-key");
  });

  it("refuses a home that is not an absolute path, and never touches the owner's own", async () => {
    for (const bad of ["relative/home", "", "~/.gemini", "/tmp/ho\0me"]) {
      await assert.rejects(prepareGeminiHome(bad, undefined), TypeError, JSON.stringify(bad));
    }
    // The path Guild uses is under its own data, never the owner's home folder's .gemini.
    assert.notEqual(await freshHome(), join(homedir(), ".gemini"));
  });
});
