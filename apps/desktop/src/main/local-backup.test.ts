import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { test, type TestContext } from "node:test";
import { parseTaskId, parseWindowId, parseWorkspaceId, type Result } from "@guild/contracts";
import { openGuildPersistence } from "@guild/persistence";
import { finishRestoreShutdown, applyStagedBackup, finishLocalRestore, recoverLocalRestore, sealBackup, stageBackup, validateBackup } from "./local-backup.js";
async function root(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), "guild-restore-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function must<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}
async function snapshot(path: string, nickname: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const store = openGuildPersistence({ path: join(path, "source.sqlite3") });
  const settings = store.loadAppSettings();
  store.updateAppSettings({ expectedRevision: settings.revision, nickname });
  store.backupTo(join(path, "guild.sqlite3")); store.close();
  for (const file of await import("node:fs/promises").then((fs) => fs.readdir(path))) {
    if (file !== "guild.sqlite3") await rm(join(path, file), { recursive: true, force: true });
  }
  await sealBackup(path, "2.1.0-test");
}
function nickname(path: string) {
  const store = openGuildPersistence({ path: join(path, "guild.sqlite3") });
  try { return store.loadAppSettings().nickname; } finally { store.close(); }
}
test("verified backup restore preserves data, private permissions, and one rollback generation", async (t) => {
  const base = await root(t), source = join(base, "backup"), live = join(base, "live");
  await snapshot(source, "Backup"); await snapshot(live, "Current");
  const staged = await stageBackup(source, live);
  await applyStagedBackup(staged, live);
  assert.equal(await recoverLocalRestore(live), true);
  assert.equal(nickname(live), "Backup");
  await finishLocalRestore(live);
  assert.equal(await recoverLocalRestore(live), false);
  assert.equal(nickname(join(staged, "rollback")), "Current");
  assert.equal((await stat(join(live, "guild.sqlite3"))).mode & 0o777, 0o600);
});
test("tampered files, legacy manifests, symlinks, unknown paths, and broken SQLite are rejected", async (t) => {
  const base = await root(t);
  for (const kind of ["hash", "legacy", "symlink", "unknown", "sqlite"]) {
    const source = join(base, kind); await snapshot(source, "Original");
    if (kind === "hash") await writeFile(join(source, "guild.sqlite3"), "corrupt");
    if (kind === "legacy") await writeFile(join(source, "manifest.json"), '{"format":"guild-local-backup-v1"}');
    if (kind === "symlink") await symlink(join(source, "guild.sqlite3"), join(source, "link"));
    if (kind === "unknown") await writeFile(join(source, "extra"), "not allowed");
    if (kind === "sqlite") {
      await writeFile(join(source, "guild.sqlite3"), "not a database");
      await assert.rejects(sealBackup(source, "2.1.0"));
    } else await assert.rejects(validateBackup(source));
  }
});
test("tool image grants nested in timeline metadata are sealed and verified", async (t) => {
  const source = join(await root(t), "backup");
  const media = Buffer.from("tool image evidence");
  const filename = "00000000-0000-4000-8000-000000000051.png";
  const digest = createHash("sha256").update(media).digest("hex");
  await mkdir(join(source, "media"), { recursive: true, mode: 0o700 });
  await writeFile(join(source, "media", filename), media);
  const store = openGuildPersistence({ path: join(source, "guild.sqlite3") });
  const workspaceId = must(parseWorkspaceId("workspace-tool-media"));
  const taskId = must(parseTaskId("task-tool-media"));
  store.createWorkspace({
    workspaceId,
    canonicalPath: "/tmp/guild-tool-media",
    displayName: "Tool media",
  });
  store.createConversationTask({
    taskId,
    workspaceId,
    title: "Tool media",
    owningWindowId: must(parseWindowId("window-tool-media")),
  });
  store.createConversationEntry({
    taskId,
    entryId: "entry-tool-media",
    kind: "tool",
    text: "Viewed image",
    metadata: {
      content: [{
        type: "media",
        mediaType: "image",
        mimeType: "image/png",
        grantUrl: `guild-media://media/${filename}`,
        alt: "viewed.png",
        mediaSha256: digest,
      }],
    },
    status: "complete",
  });
  store.close();
  for (const file of await readdir(source)) {
    if (file !== "guild.sqlite3" && file !== "media") {
      await rm(join(source, file), { recursive: true, force: true });
    }
  }
  await sealBackup(source, "2.1.4-test");
  await rm(join(source, "guild.sqlite3-wal"), { force: true });
  await rm(join(source, "guild.sqlite3-shm"), { force: true });
  await validateBackup(source);
  await rm(join(source, "guild.sqlite3-wal"), { force: true });
  await rm(join(source, "guild.sqlite3-shm"), { force: true });
  await writeFile(join(source, "media", filename), "tampered");
  await assert.rejects(validateBackup(source));
});
test("an interrupted exchange restores the original database before any startup", async (t) => {
  const base = await root(t), source = join(base, "backup"), live = join(base, "live");
  await snapshot(source, "Backup"); await snapshot(live, "Current");
  const staged = await stageBackup(source, live);
  await mkdir(join(staged, "rollback"));
  await writeFile(join(live, "restore-journal.json"), JSON.stringify({
    version: 1, directory: basename(staged), phase: "swapping", oldItems: ["guild.sqlite3"],
  }));
  await rename(join(live, "guild.sqlite3"), join(staged, "rollback", "guild.sqlite3"));
  await rename(join(staged, "candidate", "guild.sqlite3"), join(live, "guild.sqlite3"));
  assert.equal(await recoverLocalRestore(live), false);
  assert.equal(nickname(live), "Current");
});
test("a failed first boot rolls back exactly once instead of repeatedly opening broken data", async (t) => {
  const base = await root(t), source = join(base, "backup"), live = join(base, "live");
  await snapshot(source, "Backup"); await snapshot(live, "Current");
  const staged = await stageBackup(source, live); await applyStagedBackup(staged, live);
  assert.equal(await recoverLocalRestore(live), true);
  await writeFile(join(live, "guild.sqlite3-wal"), "candidate WAL after crash");
  await writeFile(join(live, "guild.sqlite3-shm"), "candidate SHM after crash");
  assert.equal(await recoverLocalRestore(live), false);
  await assert.rejects(stat(join(live, "guild.sqlite3-wal")));
  await assert.rejects(stat(join(live, "guild.sqlite3-shm")));
  assert.equal(nickname(live), "Current");
  assert.equal(await recoverLocalRestore(live), false);
});

test("failed storage shutdown cancels restoration, removes its stage, and keeps live data unchanged", async (t) => {
  const base = await root(t), source = join(base, "backup"), live = join(base, "live");
  await snapshot(source, "Backup"); await snapshot(live, "Current");
  const staged = await stageBackup(source, live);
  assert.equal(await finishRestoreShutdown(staged, live, false), "cancelled");
  assert.equal(nickname(live), "Current");
  await assert.rejects(stat(staged));
  await assert.rejects(stat(join(live, "restore-journal.json")));
  assert.equal(await finishRestoreShutdown(await stageBackup(source, live), live, true), "restored");
  assert.equal(nickname(live), "Backup");
});
test("exchange failure is explicit and leaves the original generation available", async (t) => {
  const base = await root(t), source = join(base, "backup"), live = join(base, "live");
  await snapshot(source, "Backup"); await snapshot(live, "Current");
  const staged = await stageBackup(source, live);
  await writeFile(join(staged, "candidate", "guild.sqlite3"), "changed after staging");
  assert.equal(await finishRestoreShutdown(staged, live, true), "exchange_failed");
  assert.equal(nickname(live), "Current");
  await assert.rejects(finishRestoreShutdown(live, live, false));
  assert.equal(nickname(live), "Current");
});
