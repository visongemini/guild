// D-046: verified local snapshots and a crash-recoverable, allowlisted restore.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openGuildPersistence, SCHEMA_VERSION } from "@guild/persistence";

const ITEMS = ["guild.sqlite3", "media", "diagnostics"] as const;
const JOURNAL = "restore-journal.json";
type FileEntry = { path: string; size: number; sha256: string };
type Manifest = { format: "guild-local-backup-v2"; schemaVersion: number; appVersion: string; createdAt: string; files: FileEntry[] };
type Journal = { version: 1; directory: string; phase: "swapping" | "installed" | "booting"; oldItems: string[] };
const fail = () => { throw new Error("invalid_local_backup"); };
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function syncDirectory(path: string) {
  const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); }
}
async function durableJson(path: string, data: unknown) {
  const temp = path + ".tmp";
  const handle = await open(temp, "w", 0o600);
  try { await handle.writeFile(JSON.stringify(data, null, 2)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, path); await syncDirectory(dirname(path));
}
async function hashFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 ** 3) fail();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest("hex");
  } finally { await handle.close(); }
}
function allowed(path: string) {
  return path === "guild.sqlite3" ||
    /^media\/[0-9a-f-]{36}\.(png|jpe?g|webp|gif|svg|mp3|wav|ogg|mp4|webm|pdf|bin)$/u.test(path) ||
    /^diagnostics\/[A-Za-z0-9._-]+$/u.test(path);
}
async function inventory(root: string): Promise<FileEntry[]> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail();
  const files: FileEntry[] = [];
  let bytes = 0;
  async function walk(directory: string) {
    for (const name of (await readdir(directory)).sort()) {
      const full = join(directory, name);
      const path = relative(root, full).replaceAll("\\\\", "/");
      const info = await lstat(full);
      if (info.isSymbolicLink()) fail();
      if (info.isDirectory()) {
        if (path !== "media" && path !== "diagnostics") fail();
        await walk(full);
      } else {
        if (path === "manifest.json") { if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 ** 2) fail(); continue; }
        if (!info.isFile() || info.nlink !== 1 || !allowed(path)) fail();
        bytes += info.size;
        if (files.length >= 100_000 || bytes > 8 * 1024 ** 3) fail();
        files.push({ path, size: info.size, sha256: await hashFile(full) });
      }
    }
  }
  await walk(root);
  if (!files.some((file) => file.path === "guild.sqlite3")) fail();
  return files;
}
export async function sealBackup(root: string, appVersion: string): Promise<void> {
  for (const item of await inventory(root)) await chmod(join(root, item.path), 0o600);
  const files = await inventory(root);
  const manifest: Manifest = { format: "guild-local-backup-v2", schemaVersion: SCHEMA_VERSION, appVersion, createdAt: new Date().toISOString(), files };
  await durableJson(join(root, "manifest.json"), manifest);
  await validateBackup(root);
}
export async function validateBackup(root: string): Promise<Manifest> {
  const details = await lstat(join(root, "manifest.json"));
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 || details.size > 8 * 1024 ** 2) fail();
  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as Manifest;
  if (manifest?.format !== "guild-local-backup-v2" || manifest.schemaVersion !== SCHEMA_VERSION ||
    typeof manifest.appVersion !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files)) fail();
  const files = await inventory(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) fail();
  await validateDatabase(join(root, "guild.sqlite3"), files);
  return manifest;
}
export async function validateDatabase(path: string, files?: readonly FileEntry[]): Promise<void> {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    for (const pragma of ["quick_check", "integrity_check"]) {
      const rows = database.prepare("PRAGMA " + pragma).all();
      if (rows.length !== 1 || Object.values(rows[0]!)[0] !== "ok") fail();
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) fail();
    const version = database.prepare("SELECT max(version) AS version FROM schema_migrations").get();
    if (version?.version !== SCHEMA_VERSION) fail();
    // No backup may silently resume a queued or unfinished operation after restore.
    if (database.prepare("SELECT 1 FROM queued_turns LIMIT 1").get() ||
      database.prepare("SELECT 1 FROM continuous_tasks WHERE status = 'active' LIMIT 1").get() ||
      database.prepare("SELECT 1 FROM permission_outbox WHERE lifecycle <> 'completed' LIMIT 1").get()) fail();
    for (const row of database.prepare("SELECT snapshot_json FROM runs").all()) {
      const run = JSON.parse(String(row.snapshot_json));
      if (!["completed", "failed", "cancelled", "interrupted"].includes(run.state)) fail();
    }
    if (files !== undefined) {
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (const row of database.prepare("SELECT kind, metadata_json FROM conversation_entries").all()) {
        const metadata = JSON.parse(String(row.metadata_json));
        const references = mediaReferences(metadata);
        if (row.kind === "media" && references.length !== 1) fail();
        for (const reference of references) {
          const filename = reference.grantUrl.slice("guild-media://media/".length);
          const file = byPath.get("media/" + filename);
          if (file === undefined || (reference.mediaSha256 !== undefined && file.sha256 !== reference.mediaSha256)) fail();
        }
      }
      const profile = database.prepare("SELECT avatar_filename FROM app_settings LIMIT 1").get();
      if (profile?.avatar_filename && !byPath.has("media/" + String(profile.avatar_filename))) fail();
    }
  } finally { database.close(); }
  // The existing persistence decoder verifies every domain snapshot and digest.
  const checkRoot = join(dirname(path), ".validation-" + randomUUID());
  await mkdir(checkRoot, { mode: 0o700 });
  try {
    const copy = join(checkRoot, "guild.sqlite3");
    await copyFile(path, copy); await chmod(copy, 0o600);
    const store = openGuildPersistence({ path: copy });
    try { store.verifyIntegrity(); } finally { store.close(); }
  } finally { await rm(checkRoot, { recursive: true, force: true }); }
}

function mediaReferences(value: unknown): readonly Readonly<{
  readonly grantUrl: string;
  readonly mediaSha256?: string;
}>[] {
  const result: { grantUrl: string; mediaSha256?: string }[] = [];
  const visit = (candidate: unknown) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    if (typeof record["grantUrl"] === "string" && record["grantUrl"].startsWith("guild-media://media/")) {
      result.push({
        grantUrl: record["grantUrl"],
        ...(typeof record["mediaSha256"] === "string" ? { mediaSha256: record["mediaSha256"] } : {}),
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return Object.freeze(result.map((item) => Object.freeze(item)));
}
export async function stageBackup(source: string, userData: string): Promise<string> {
  const manifest = await validateBackup(source);
  const root = join(userData, "restore-" + randomUUID());
  await mkdir(root, { mode: 0o700 });
  const candidate = join(root, "candidate");
  await mkdir(candidate, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const destination = join(candidate, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(source, file.path), destination, constants.COPYFILE_EXCL);
      await chmod(destination, 0o600);
      const handle = await open(destination, "r"); try { await handle.sync(); } finally { await handle.close(); }
    }
    await durableJson(join(candidate, "manifest.json"), manifest);
    await validateBackup(candidate);
    return root;
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
async function readJournal(userData: string): Promise<Journal | undefined> {
  if (!await exists(join(userData, JOURNAL))) return undefined;
  const value = JSON.parse(await readFile(join(userData, JOURNAL), "utf8")) as Journal;
  if (value.version !== 1 || !/^restore-[0-9a-f-]{36}$/u.test(value.directory) ||
    !["swapping", "installed", "booting"].includes(value.phase) ||
    !Array.isArray(value.oldItems) || value.oldItems.some((item) => !(ITEMS as readonly string[]).includes(item))) fail();
  return value;
}
async function discardRestoreWal(userData: string) {
  // Called only with the app single-instance lock and no open persistence.
  // The old generation was checkpointed before the exchange. Sidecars left
  // after a failed first boot belong to the candidate, never the rollback DB.
  for (const suffix of ["-wal", "-shm"]) {
    const path = join(userData, "guild.sqlite3" + suffix);
    if (!await exists(path)) continue;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail();
    await rm(path);
  }
}
async function rollback(userData: string, journal: Journal) {
  await discardRestoreWal(userData);
  const rollbackRoot = join(userData, journal.directory, "rollback");
  for (const item of ITEMS) {
    const old = join(rollbackRoot, item), live = join(userData, item);
    if (await exists(old)) {
      await rm(live, { recursive: true, force: true });
      await rename(old, live);
    } else if (!journal.oldItems.includes(item)) await rm(live, { recursive: true, force: true });
  }
  await syncDirectory(userData);
  await rm(join(userData, JOURNAL)); await syncDirectory(userData);
}
export async function applyStagedBackup(root: string, userData: string): Promise<void> {
  if (dirname(root) !== userData || !/^restore-[0-9a-f-]{36}$/u.test(basename(root))) fail();
  const candidate = join(root, "candidate");
  await validateBackup(candidate);
  await validateDatabase(join(userData, "guild.sqlite3"));
  const wal = join(userData, "guild.sqlite3-wal");
  if (await exists(wal) && (await lstat(wal)).size !== 0) throw new Error("restore_requires_checkpoint");
  await discardRestoreWal(userData);
  const rollbackRoot = join(root, "rollback");
  await mkdir(rollbackRoot, { mode: 0o700 });
  const oldItems: string[] = [];
  for (const item of ITEMS) if (await exists(join(userData, item))) oldItems.push(item);
  const journal: Journal = { version: 1, directory: basename(root), phase: "swapping", oldItems };
  await durableJson(join(userData, JOURNAL), journal);
  try {
    for (const item of ITEMS) {
      if (oldItems.includes(item)) await rename(join(userData, item), join(rollbackRoot, item));
      if (await exists(join(candidate, item))) await rename(join(candidate, item), join(userData, item));
      await syncDirectory(userData); await syncDirectory(rollbackRoot); await syncDirectory(candidate);
    }
    journal.phase = "installed";
    await durableJson(join(userData, JOURNAL), journal);
  } catch (error) { await rollback(userData, journal); throw error; }
}
export async function recoverLocalRestore(userData: string): Promise<boolean> {
  const journal = await readJournal(userData);
  if (journal === undefined) return false;
  if (journal.phase !== "installed") { await rollback(userData, journal); return false; }
  try { await validateDatabase(join(userData, "guild.sqlite3")); }
  catch { await rollback(userData, journal); return false; }
  journal.phase = "booting"; await durableJson(join(userData, JOURNAL), journal);
  return true;
}
export async function finishLocalRestore(userData: string) {
  const journal = await readJournal(userData);
  if (journal?.phase !== "booting") return;
  // Retain the previous generation for manual recovery; never delete it on startup.
  await rm(join(userData, JOURNAL)); await syncDirectory(userData);
}

// A failed shutdown must never exchange databases or appear to have restored data.
export async function finishRestoreShutdown(root: string, userData: string, clean: boolean):
  Promise<"cancelled" | "restored" | "exchange_failed"> {
  if (dirname(root) !== userData || !/^restore-[0-9a-f-]{36}$/u.test(basename(root))) fail();
  if (!clean) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    return "cancelled";
  }
  try {
    await applyStagedBackup(root, userData);
    return "restored";
  } catch {
    // Keep the journal and rollback generation for startup recovery if needed.
    return "exchange_failed";
  }
}
