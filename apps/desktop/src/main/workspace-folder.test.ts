import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MESSAGE_TOO_LONG,
  WORKSPACE_FOLDER_MISSING,
  SESSION_RECOVERY_CONTEXT_REQUIRED,
  assertWorkspaceFolderExists,
  toDesktopIpcFailure,
  workspaceFolderExists,
} from "./workspace-folder.js";

describe("workspace folder presence", () => {
  it("accepts an existing absolute directory and rejects a vanished path", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-workspace-folder-"));
    const folder = join(root, "project");
    await mkdir(folder);
    assert.equal(await workspaceFolderExists(folder), true);
    await assertWorkspaceFolderExists(folder);

    await rm(folder, { recursive: true, force: true });
    assert.equal(await workspaceFolderExists(folder), false);
    await assert.rejects(assertWorkspaceFolderExists(folder), (cause: unknown) => {
      assert.equal(cause instanceof Error && cause.message, WORKSPACE_FOLDER_MISSING);
      return true;
    });
  });

  it("keeps a vanished-folder IPC failure truthful", () => {
    assert.equal(toDesktopIpcFailure(new Error(WORKSPACE_FOLDER_MISSING)).message, WORKSPACE_FOLDER_MISSING);
    assert.equal(
      toDesktopIpcFailure(new Error(SESSION_RECOVERY_CONTEXT_REQUIRED)).message,
      SESSION_RECOVERY_CONTEXT_REQUIRED,
    );
    assert.equal(toDesktopIpcFailure(new Error(MESSAGE_TOO_LONG)).message, MESSAGE_TOO_LONG);
    assert.equal(toDesktopIpcFailure(new Error("runtime_start_process_start:preflight")).message, "guild_operation_failed");
    assert.equal(toDesktopIpcFailure("unknown").message, "guild_operation_failed");
  });

  it("rejects a relative path and a regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-workspace-folder-file-"));
    const file = join(root, "notes.txt");
    await writeFile(file, "not a workspace");
    assert.equal(await workspaceFolderExists("relative/project"), false);
    assert.equal(await workspaceFolderExists(file), false);
  });
});
