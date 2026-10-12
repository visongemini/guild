import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CLAUDE_CAPTURE_OFF_ENVIRONMENT,
  DEV_CLAUDE_CAPTURE_OFF_VARIABLE,
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
  // The variable names are not read directly in the main entry: the only gate is resolveDevHooks.
  assert.doesNotMatch(source, /GUILD_DEV_DATA_DIR|GUILD_DEV_CLAUDE_CAPTURE_OFF/u);
});

test("the capture variable reaches Claude spawns only through the live service option and the routed marker [PC-OV-001]", async () => {
  const live = await readFile(new URL("../../src/main/live-service.ts", import.meta.url), "utf8");
  assert.match(live, /const captureOff = options\.claudeCaptureOff === true \|\| store\.loadTaskMetadata\(taskId\)\.routedAtMs !== undefined;/u);
  assert.match(live, /controller\.engine === "claude" && captureOff/u);
  assert.doesNotMatch(live, /process\.env\["GUILD_DEV/u);
  const hooks = await readFile(new URL("../../src/main/dev-hooks.ts", import.meta.url), "utf8");
  assert.match(hooks, /if \(input\.isPackaged\) return/u);
});
