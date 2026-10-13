import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { GeminiEnvironmentError } from "./gemini-env-guard.js";
import {
  GEMINI_FORBIDDEN_WORKSPACE_SETTINGS,
  MAX_SETTINGS_FILE_BYTES,
  assertNoForbiddenWorkspaceSetting,
  findForbiddenSetting,
  findForbiddenSettingInText,
  findForbiddenWorkspaceSetting,
  stripJsonComments,
} from "./gemini-workspace-guard.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<{ root: string; folder: string; settings: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-workspace-")));
  roots.push(root);
  const folder = join(root, "project");
  await mkdir(join(folder, ".gemini"), { recursive: true });
  return { root, folder, settings: join(folder, ".gemini", "settings.json") };
}

describe("Gemini workspace settings guard [PC-ENG-004]", () => {
  it("reads comments the way the CLI's JSON reader does", () => {
    const text = '{\n  // line\n  "a": "x//y", /* block\n comment */ "b": "he said \\"hi\\" // not a comment",\n  "c": 1 // trailing\n}';
    assert.deepEqual(JSON.parse(stripJsonComments(text)), { a: "x//y", b: 'he said "hi" // not a comment', c: 1 });
    assert.equal(stripJsonComments("{} /* never closed"), `{} ${" ".repeat(15)}`, "an unterminated comment runs to the end");
    assert.deepEqual(JSON.parse(stripJsonComments('{"url":"http://example.invalid/*not*/"}')), { url: "http://example.invalid/*not*/" });
  });

  it("refuses a folder that sets the sign-in method, in every form, and names the setting", () => {
    for (const [settings, expected] of [
      [{ security: { auth: { selectedType: "oauth-personal" } } }, "security.auth.selectedType"],
      [{ security: { auth: { enforcedType: "oauth-personal" } } }, "security.auth.enforcedType"],
      [{ security: { auth: { useExternal: true } } }, "security.auth.useExternal"],
      [{ security: { auth: "oauth-personal" } }, "security.auth"],
      [{ security: { auth: null } }, "security.auth"],
      [{ security: { auth: { anything: 1 } } }, "security.auth.anything"],
      [{ telemetry: { enabled: true, otlpEndpoint: "https://collector.invalid" } }, "telemetry.otlpEndpoint"],
      [{ telemetry: { target: "gcp" } }, "telemetry.target"],
      [{ experimental: { gemmaModelRouter: { enabled: true } } }, "experimental.gemmaModelRouter.enabled"],
    ] as const) {
      assert.equal(findForbiddenSetting(settings), expected, expected);
    }
    for (const path of GEMINI_FORBIDDEN_WORKSPACE_SETTINGS) assert.ok(path.length >= 2, path.join("."));
  });

  it("lets everything else through, including the settings that run code, which --skip-trust accepts knowingly", () => {
    for (const settings of [
      {},
      { ui: { theme: "dark" }, general: { vimMode: true }, model: { name: "gemini-2.5-pro" } },
      { security: {}, telemetry: { enabled: false }, experimental: {} },
      { security: { auth: {} }, security2: 1 },
      { security: { folderTrust: { enabled: false }, disableYoloMode: true } },
      { mcpServers: { x: { command: "node" } }, hooks: { BeforeTool: [] }, privacy: { usageStatisticsEnabled: true } },
      [],
      null,
      "text",
    ]) {
      assert.equal(findForbiddenSetting(settings), undefined, JSON.stringify(settings));
    }
  });

  it("finds a setting in the text of a file with comments or a byte-order mark, and falls back to key names when it cannot parse", () => {
    assert.equal(findForbiddenSettingInText('// project settings\n{\n  /* sign in */ "security": { "auth": { "selectedType": "oauth-personal" } }\n}\n'), "security.auth.selectedType");
    assert.equal(findForbiddenSettingInText('﻿{"security":{"auth":{"selectedType":"oauth-personal"}}}'), "security.auth.selectedType");
    // A mention in a value, or in a comment, is not a setting.
    assert.equal(findForbiddenSettingInText('{"note":"\\"selectedType\\": oauth-personal"} // "selectedType": 1'), undefined);
    // A file the CLI cannot parse stops the CLI itself; Guild does not rely on that and looks for the names.
    assert.equal(findForbiddenSettingInText('{ "security": { "auth": { "selectedType": "oauth-personal", } } '), "selectedType");
    assert.equal(findForbiddenSettingInText("{ 'enforcedType' : 'oauth-personal' "), "enforcedType");
    assert.equal(findForbiddenSettingInText("{ not json at all"), undefined);
    assert.equal(findForbiddenSettingInText(""), undefined);
  });

  it("reads the folder's own .gemini/settings.json, names the file and the setting, and never a value", async () => {
    const { folder, settings } = await project();
    assert.equal(await findForbiddenWorkspaceSetting(folder), undefined, "no settings file is fine");
    await writeFile(settings, JSON.stringify({ ui: { theme: "dark" } }));
    assert.equal(await findForbiddenWorkspaceSetting(folder), undefined);
    await writeFile(settings, '{"security":{"auth":{"selectedType":"oauth-personal"}}}');
    assert.deepEqual({ ...(await findForbiddenWorkspaceSetting(folder)) }, { path: settings, variable: "security.auth.selectedType", source: "settings_file", reason: "forbidden" });
    await assert.rejects(assertNoForbiddenWorkspaceSetting(folder), (cause: unknown) => {
      assert.ok(cause instanceof GeminiEnvironmentError);
      assert.equal(cause.message, "gemini_env_file_unsafe");
      assert.equal(cause.problem.variable, "security.auth.selectedType");
      assert.equal(JSON.stringify(cause).includes("oauth-personal"), false, "no value");
      return true;
    });
    await writeFile(settings, "{}");
    await assert.doesNotReject(assertNoForbiddenWorkspaceSetting(folder));
  });

  it("looks at the real path of a linked folder, skips a directory, and refuses a file too large to check", async () => {
    const { root, folder, settings } = await project();
    await writeFile(settings, '{"security":{"auth":{"enforcedType":"oauth-personal"}}}');
    await mkdir(join(root, "links"), { recursive: true });
    await symlink(folder, join(root, "links", "proj"));
    assert.equal((await findForbiddenWorkspaceSetting(join(root, "links", "proj")))?.variable, "security.auth.enforcedType");
    await rm(settings);
    await mkdir(settings);
    assert.equal(await findForbiddenWorkspaceSetting(folder), undefined, "a directory named settings.json is not a file");
    await rm(settings, { recursive: true });
    await writeFile(settings, `{"padding":"${"x".repeat(MAX_SETTINGS_FILE_BYTES)}","security":{"auth":{"selectedType":"oauth-personal"}}}`);
    assert.deepEqual({ ...(await findForbiddenWorkspaceSetting(folder)) }, { path: settings, variable: "", source: "settings_file", reason: "uncheckable" });
  });
});
