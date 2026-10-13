import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLAUDE_CAPTURE_OFF_ENVIRONMENT,
  DEV_CLAUDE_CAPTURE_OFF_VARIABLE,
  DEV_CODEX_ACP_VARIABLE,
  DEV_DATA_DIR_VARIABLE,
  resolveDevHooks,
} from "./dev-hooks.js";

const ENV = {
  [DEV_DATA_DIR_VARIABLE]: "/tmp/guild3-qa-data-1",
  [DEV_CLAUDE_CAPTURE_OFF_VARIABLE]: "1",
} as const;

test("an unpackaged app honours the data directory and the capture switch [PC-ENG-001, PC-OV-001]", () => {
  const hooks = resolveDevHooks({ isPackaged: false, env: ENV });
  assert.equal(hooks.userDataDir, "/tmp/guild3-qa-data-1");
  assert.equal(hooks.claudeCaptureOff, true);
  assert.deepEqual(CLAUDE_CAPTURE_OFF_ENVIRONMENT, { OPENVIKING_AUTO_CAPTURE: "false" });

  const none = resolveDevHooks({ isPackaged: false, env: {} });
  assert.equal(none.userDataDir, undefined);
  assert.equal(none.claudeCaptureOff, false);
  assert.equal(resolveDevHooks({ isPackaged: false, env: { [DEV_CLAUDE_CAPTURE_OFF_VARIABLE]: "true" } }).claudeCaptureOff, false);
  assert.equal(resolveDevHooks({ isPackaged: false, env: { [DEV_DATA_DIR_VARIABLE]: "" } }).userDataDir, undefined);
});

test("a packaged app ignores both hooks, even a malformed data directory [PC-ENG-001]", () => {
  const hooks = resolveDevHooks({ isPackaged: true, env: ENV });
  assert.equal(hooks.userDataDir, undefined);
  assert.equal(hooks.claudeCaptureOff, false);
  assert.doesNotThrow(() => resolveDevHooks({ isPackaged: true, env: { [DEV_DATA_DIR_VARIABLE]: "relative/../path" } }));
});

test("the data directory must be an absolute, normalized path [PC-ENG-001]", () => {
  for (const bad of ["relative/dir", "/tmp/a/../b", "/tmp//double", "/tmp/with\0nul", "~/guild"]) {
    assert.throws(
      () => resolveDevHooks({ isPackaged: false, env: { [DEV_DATA_DIR_VARIABLE]: bad } }),
      /dev_data_dir_invalid/u,
      bad,
    );
  }
});

test("index.ts reads the hooks through resolveDevHooks with app.isPackaged and nowhere else [PC-ENG-001]", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  assert.match(source, /resolveDevHooks\(\{ isPackaged: app\.isPackaged, env: process\.env \}\)/u);
  assert.match(source, /devHooks\.userDataDir \?\? join\(app\.getPath\("appData"\), "Guild-v2"\)/u);
  assert.match(source, /claudeCaptureOff: devHooks\.claudeCaptureOff/u);
  assert.match(source, /codexAdapterRoot: devHooks\.codexAdapterRoot/u);
  // The variable names are not read directly in the main entry: the only gate is resolveDevHooks.
  assert.doesNotMatch(source, /GUILD_DEV_DATA_DIR|GUILD_DEV_CLAUDE_CAPTURE_OFF|GUILD_DEV_CODEX_ACP/u);
});

test("the capture variable reaches Claude spawns only through the live service option and the routed marker [PC-OV-001]", async () => {
  const live = await readFile(new URL("../../src/main/live-service.ts", import.meta.url), "utf8");
  assert.match(live, /const captureOff = options\.claudeCaptureOff === true \|\| store\.loadTaskMetadata\(taskId\)\.routedAtMs !== undefined;/u);
  assert.match(live, /controller\.engine === "claude" && captureOff/u);
  assert.doesNotMatch(live, /process\.env\["GUILD_DEV/u);
  const hooks = await readFile(new URL("../../src/main/dev-hooks.ts", import.meta.url), "utf8");
  assert.match(hooks, /if \(input\.isPackaged\) return/u);
});

test("an unpackaged app takes a scratch Codex adapter directory; a packaged app ignores it [PC-ENG-003]", () => {
  assert.equal(DEV_CODEX_ACP_VARIABLE, "GUILD_DEV_CODEX_ACP");
  const hooks = resolveDevHooks({ isPackaged: false, env: { [DEV_CODEX_ACP_VARIABLE]: "/tmp/guild31-qa/codex-acp/node_modules/@agentclientprotocol/codex-acp" } });
  assert.equal(hooks.codexAdapterRoot, "/tmp/guild31-qa/codex-acp/node_modules/@agentclientprotocol/codex-acp");
  assert.equal(resolveDevHooks({ isPackaged: false, env: {} }).codexAdapterRoot, undefined);
  assert.equal(resolveDevHooks({ isPackaged: false, env: { [DEV_CODEX_ACP_VARIABLE]: "" } }).codexAdapterRoot, undefined);
  // Packaged: not read at all, so even a malformed value cannot change the production lookup or fail the launch.
  assert.equal(resolveDevHooks({ isPackaged: true, env: { [DEV_CODEX_ACP_VARIABLE]: "/tmp/x/codex-acp" } }).codexAdapterRoot, undefined);
  assert.doesNotThrow(() => resolveDevHooks({ isPackaged: true, env: { [DEV_CODEX_ACP_VARIABLE]: "relative" } }));
  for (const bad of ["relative/dir", "/tmp/a/../b", "/tmp//double", "/tmp/with\0nul", "~/codex"]) {
    assert.throws(
      () => resolveDevHooks({ isPackaged: false, env: { [DEV_CODEX_ACP_VARIABLE]: bad } }),
      /dev_codex_acp_invalid/u,
      bad,
    );
  }
});

test("the Codex hook only adds a search root: the locator still pins what it finds [PC-ENG-003]", async () => {
  const live = await readFile(new URL("../../src/main/live-service.ts", import.meta.url), "utf8");
  assert.match(live, /extraAdapterRoots: \[options\.codexAdapterRoot\]/u);
  assert.doesNotMatch(live, /process\.env\["GUILD_DEV/u);
  const locator = await readFile(new URL("../../src/main/codex-locator.ts", import.meta.url), "utf8");
  assert.match(locator, /await pinCodexAdapter\(root\)/u);
});
