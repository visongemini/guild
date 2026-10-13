import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { EngineKeyBindingRecord } from "@guild/persistence";
import { effectiveEngineKeyBinding, readEngineApiKey } from "./engine-api-key.js";

const HOST = "generativelanguage.googleapis.com";
const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function keyFile(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "guild-engine-key-"));
  roots.push(root);
  const path = join(root, "keys.env");
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function binding(over: Partial<EngineKeyBindingRecord> = {}): EngineKeyBindingRecord {
  return Object.freeze({
    engine: "gemini",
    keyFile: null,
    keyVariable: "GEMINI_API_KEY",
    confirmedHost: HOST,
    revision: 2,
    updatedAtMs: 1,
    ...over,
  });
}

describe("engine API key reading [PC-ENG-004]", () => {
  it("means the default file and the engine's own variable until the user names others, unconfirmed", () => {
    assert.deepEqual({ ...effectiveEngineKeyBinding("gemini", undefined, "/home/me/keys.env")! }, {
      keyFile: "/home/me/keys.env", keyVariable: "GEMINI_API_KEY", confirmed: false,
    });
    assert.deepEqual({ ...effectiveEngineKeyBinding("gemini", binding({ keyFile: "/x/k.env", keyVariable: "MINE" }), "/home/me/keys.env")! }, {
      keyFile: "/x/k.env", keyVariable: "MINE", confirmed: true,
    });
    assert.equal(effectiveEngineKeyBinding("gemini", binding({ confirmedHost: null }), "/d")!.confirmed, false);
    assert.equal(effectiveEngineKeyBinding("gemini", binding({ confirmedHost: "evil.example" }), "/d")!.confirmed, false);
    assert.equal(effectiveEngineKeyBinding("codex", undefined, "/d"), undefined, "Codex has no key");
  });

  it("reads the confirmed variable from the confirmed file, now", async () => {
    const path = await keyFile("OTHER=nope\nGEMINI_API_KEY='AIzaSy-test-key-0123456789abcdef'\n");
    const reading = await readEngineApiKey({ engine: "gemini", binding: binding({ keyFile: path }), defaultKeyFile: "/nonexistent" });
    assert.deepEqual({ ...reading }, { status: "ready", key: "AIzaSy-test-key-0123456789abcdef" });
    // The default file is used when none is named.
    const fromDefault = await readEngineApiKey({ engine: "gemini", binding: binding(), defaultKeyFile: path });
    assert.equal(fromDefault.status, "ready");
    // A file edited later is read again: nothing is cached.
    await writeFile(path, "GEMINI_API_KEY=AIzaSy-second-key-0123456789abcdef\n");
    const again = await readEngineApiKey({ engine: "gemini", binding: binding(), defaultKeyFile: path });
    assert.equal(again.status === "ready" && again.key, "AIzaSy-second-key-0123456789abcdef");
  });

  it("is unconfirmed without a confirmed binding, and reads nothing then", async () => {
    const path = await keyFile("GEMINI_API_KEY=AIzaSy-test-key-0123456789abcdef\n");
    for (const stored of [undefined, binding({ confirmedHost: null }), binding({ confirmedHost: "evil.example" })]) {
      const reading = await readEngineApiKey({ engine: "gemini", binding: stored, defaultKeyFile: path });
      assert.deepEqual({ ...reading }, { status: "unconfirmed" });
    }
    assert.deepEqual({ ...(await readEngineApiKey({ engine: "codex", binding: undefined, defaultKeyFile: path })) }, { status: "unconfirmed" });
  });

  it("is unusable for a missing file, a missing or empty variable and a value that is not a plausible key", async () => {
    const path = await keyFile("GEMINI_API_KEY=\nOTHER=1\nSPACED=has space in it 123456789\nSHORT=abc\n");
    const unusable = async (stored: EngineKeyBindingRecord, file = path) =>
      (await readEngineApiKey({ engine: "gemini", binding: stored, defaultKeyFile: file })).status;
    assert.equal(await unusable(binding({ keyFile: path })), "unusable", "empty value");
    assert.equal(await unusable(binding({ keyFile: path, keyVariable: "MISSING" })), "unusable", "no such variable");
    assert.equal(await unusable(binding({ keyFile: path, keyVariable: "SHORT" })), "unusable", "too short to be a key");
    assert.equal(await unusable(binding({ keyFile: path, keyVariable: "SPACED" })), "unusable", "a space cannot be in a key");
    assert.equal(await unusable(binding({ keyFile: join(path, "..", "absent.env") })), "unusable", "no such file");
    assert.equal(await unusable(binding(), "/nonexistent/keys.env"), "unusable");
  });

  it("never puts the key or the path into a result other than the key itself", async () => {
    const path = await keyFile("GEMINI_API_KEY=AIzaSy-test-key-0123456789abcdef\n");
    const missing = await readEngineApiKey({ engine: "gemini", binding: binding({ keyFile: path, keyVariable: "NOPE" }), defaultKeyFile: path });
    assert.equal(JSON.stringify(missing).includes("AIza"), false);
    assert.equal(JSON.stringify(missing).includes(path), false);
  });
});
