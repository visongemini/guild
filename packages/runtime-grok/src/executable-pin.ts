import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

export type ExecutablePinFailureCode =
  | "executable_changed"
  | "hash_mismatch"
  | "not_executable"
  | "not_macho"
  | "not_regular_file"
  | "path_not_absolute"
  | "preflight_io_failure"
  | "staging_root_not_absolute";

export class ExecutablePinError extends Error {
  readonly code: ExecutablePinFailureCode;

  constructor(code: ExecutablePinFailureCode, message: string) {
    super(message);
    this.name = "ExecutablePinError";
    this.code = code;
  }
}

export type PinnedExecutable = {
  readonly resolvedExecutablePath: string;
  readonly stagedExecutablePath: string;
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  verifyForSpawn(): Promise<void>;
  cleanup(): Promise<PinnedExecutableCleanup>;
};

export type PinnedExecutableCleanup = {
  readonly stageHandleClosed: boolean;
  readonly stagingDirectoryRemoved: boolean;
  readonly failure: "none" | "stage_handle_close_failed" | "staging_directory_remove_failed" | "stage_handle_close_and_staging_directory_remove_failed";
};

type ExecutablePinTestHooks = {
  readonly afterDescriptorCopy?: () => void | Promise<void>;
};

type PinFailureCleanupStep =
  | "source_handle_close_failed"
  | "stage_handle_close_failed"
  | "staging_directory_remove_failed"
  | "writer_handle_close_failed";

type PinFailureCleanupEvidence = {
  readonly failedSteps: readonly PinFailureCleanupStep[];
};

/**
 * Creates an independently copied, verified executable for one owned process group.
 * PC-SEC-001 / ADR D-008. Node cannot execute an open descriptor (`fexecve`), but
 * later mutation or pathname replacement of the source cannot affect this copy.
 */
export async function pinExecutable(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
): Promise<PinnedExecutable> {
  return pinExecutableInternal(executablePath, stagingRoot, expectedSha256);
}

const SHARED_STAGE_PREFIX = ".grok-pin-";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const STALE_PRIVATE_STAGE_AGE_MS = 60 * 60 * 1000;

type SharedStage = {
  readonly key: string;
  readonly directory: string;
  readonly directoryIdentity: BigIntStats;
  readonly stagedExecutablePath: string;
  readonly sha256: string;
  readonly handle: FileHandle;
  readonly snapshot: BigIntStats;
  readonly verifyForSpawn: () => Promise<void>;
};

/** Process-wide stages keyed by staging root and SHA-256. A settled entry has been proven intact. */
const sharedStages = new Map<string, Promise<SharedStage>>();

/**
 * Evidence for a lease on a shared stage. The lease owns no descriptor and no directory: the
 * stage belongs to the process-wide cache and is deliberately kept for the next spawn.
 */
const SHARED_LEASE_CLEANUP: PinnedExecutableCleanup = Object.freeze({
  stageHandleClosed: true,
  stagingDirectoryRemoved: true,
  failure: "none",
});

/**
 * Leases the one verified staged copy for this SHA-256, creating it on first use. The copy lives
 * in a deterministic `.grok-pin-<sha256>` directory and is reused while its identity (device,
 * inode, size, mtime, ctime, mode 0500, owner, link count) is unchanged; a missing or altered
 * copy is replaced. A copy left by an earlier process is adopted only after it hashes to the pin.
 * The staged bytes always equal the pin, so a hit never needs to touch the (large) source again.
 */
export async function pinExecutableShared(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
): Promise<PinnedExecutable> {
  return pinExecutableSharedInternal(executablePath, stagingRoot, expectedSha256);
}

/** @internal Used only by the non-root package test entry. */
export async function pinExecutableSharedInternal(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
  testHooks?: ExecutablePinTestHooks,
): Promise<PinnedExecutable> {
  if (!isAbsolute(executablePath)) {
    throw failure("path_not_absolute", "executable path must be absolute");
  }
  if (!isAbsolute(stagingRoot)) {
    throw failure("staging_root_not_absolute", "staging root must be absolute");
  }
  const sha256 = expectedSha256.toLowerCase();
  if (!SHA256_HEX.test(sha256)) {
    throw failure("hash_mismatch", "executable SHA-256 pin is malformed");
  }
  const resolvedStagingRoot = await resolveDirectory(stagingRoot);
  const resolvedExecutablePath = await resolvePath(executablePath, "executable metadata could not be read");
  const key = `${resolvedStagingRoot}\0${sha256}`;
  const create = (): Promise<SharedStage> =>
    createSharedStage(key, resolvedStagingRoot, resolvedExecutablePath, sha256, testHooks);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let pending = sharedStages.get(key);
    if (pending === undefined) {
      pending = registerSharedStage(key, create());
    } else {
      await preflightSource(resolvedExecutablePath);
    }
    const entry = await pending;
    if (await sharedStageIntact(entry)) {
      return Object.freeze({
        resolvedExecutablePath,
        stagedExecutablePath: entry.stagedExecutablePath,
        sha256: entry.sha256,
        dev: entry.snapshot.dev,
        ino: entry.snapshot.ino,
        verifyForSpawn: entry.verifyForSpawn,
        cleanup: Object.freeze(once(async () => SHARED_LEASE_CLEANUP)),
      });
    }
    // Replace the broken copy exactly once; concurrent callers join the replacement.
    if (sharedStages.get(key) === pending) {
      registerSharedStage(key, discardSharedStage(entry).then(create));
    }
  }
  throw failure("executable_changed", "shared staged executable could not be re-established");
}

/**
 * Removes staging leftovers: shared copies of other SHA-256 values, and private stages orphaned
 * by a crashed process (older than one hour, so a live stage is never touched). Entries that are
 * not directories named like pins are ignored. Returns the number of removed directories.
 */
export async function pruneStalePinnedExecutables(
  stagingRoot: string,
  keepSha256: string,
  nowMs: number = Date.now(),
): Promise<number> {
  if (!isAbsolute(stagingRoot)) return 0;
  const keep = keepSha256.toLowerCase();
  let names: string[];
  try {
    names = await readdir(stagingRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(SHARED_STAGE_PREFIX)) continue;
    const suffix = name.slice(SHARED_STAGE_PREFIX.length);
    const directory = join(stagingRoot, name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory()) continue;
      const stale = SHA256_HEX.test(suffix)
        ? suffix !== keep
        : nowMs - info.mtimeMs >= STALE_PRIVATE_STAGE_AGE_MS;
      if (!stale) continue;
      await rm(directory, { recursive: true, force: true, maxRetries: 0 });
      removed += 1;
    } catch {
      // Best effort: a leftover that cannot be removed now is retried at the next start.
    }
  }
  return removed;
}

/**
 * @internal Test hook: drops this process's view of shared stages without touching the disk,
 * as if the process had exited, so adoption of a leftover copy can be exercised.
 */
export async function forgetSharedStagesInternal(): Promise<void> {
  const pending = [...sharedStages.values()];
  sharedStages.clear();
  await Promise.allSettled(pending.map(async (entry) => closeQuietly((await entry).handle)));
}

function registerSharedStage(key: string, creation: Promise<SharedStage>): Promise<SharedStage> {
  sharedStages.set(key, creation);
  // A failed creation must not poison later attempts.
  creation.catch(() => {
    if (sharedStages.get(key) === creation) sharedStages.delete(key);
  });
  return creation;
}

async function createSharedStage(
  key: string,
  resolvedStagingRoot: string,
  resolvedExecutablePath: string,
  sha256: string,
  testHooks: ExecutablePinTestHooks | undefined,
): Promise<SharedStage> {
  await preflightSource(resolvedExecutablePath);
  const directory = join(resolvedStagingRoot, `${SHARED_STAGE_PREFIX}${sha256}`);
  const name = basename(resolvedExecutablePath);
  const adopted = await adoptSharedStage(key, directory, name, sha256);
  if (adopted !== undefined) return adopted;

  const staged = await stageVerifiedCopy(resolvedExecutablePath, resolvedStagingRoot, sha256, testHooks);
  let published = false;
  try {
    try {
      await rename(staged.stagingDirectory, directory);
      published = true;
    } catch (cause) {
      const code = nodeErrorCode(cause);
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        // Another process published first. Use its copy only if it proves itself.
        const winner = await adoptSharedStage(key, directory, name, sha256);
        if (winner !== undefined) {
          await discardStagedCopy(staged);
          return winner;
        }
      }
      throw failure("preflight_io_failure", "shared staged executable could not be published");
    }
    return await describeSharedStage(
      key,
      directory,
      join(directory, basename(staged.stagedExecutablePath)),
      sha256,
      staged.retainedStage,
      staged.verifiedStageSnapshot,
    );
  } catch (cause) {
    if (published) {
      await closeQuietly(staged.retainedStage);
      await rm(directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined);
    } else {
      await discardStagedCopy(staged);
    }
    throw cause;
  }
}

/** Takes over a copy left by an earlier process, but only if it hashes to the pin. */
async function adoptSharedStage(
  key: string,
  directory: string,
  name: string,
  sha256: string,
): Promise<SharedStage | undefined> {
  try {
    await lstat(directory);
  } catch {
    return undefined;
  }
  const stagedExecutablePath = join(directory, name);
  let handle: FileHandle | undefined;
  try {
    handle = await open(stagedExecutablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    assertSharedStageFile(before);
    await assertMachO(handle);
    if ((await hashHandle(handle)) !== sha256) throw new Error("hash differs");
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(stagedExecutablePath, { bigint: true }),
    ]);
    if (!sameSnapshot(before, after) || !sameSnapshot(before, pathAfter)) throw new Error("changed");
    return await describeSharedStage(key, directory, stagedExecutablePath, sha256, handle, Object.freeze(after));
  } catch {
    await closeQuietly(handle);
    await rm(directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined);
    return undefined;
  }
}

/** Proves the published pathname still names the verified inode, then freezes the stage record. */
async function describeSharedStage(
  key: string,
  directory: string,
  stagedExecutablePath: string,
  sha256: string,
  handle: FileHandle,
  snapshot: BigIntStats,
): Promise<SharedStage> {
  const directoryIdentity = await lstat(directory, { bigint: true });
  if (!isOwnedPrivateDirectory(directoryIdentity)) {
    throw failure("executable_changed", "shared staging directory is not private");
  }
  const reopened = await openReadNoFollow(stagedExecutablePath);
  try {
    const reopenedStats = await reopened.stat({ bigint: true });
    if (!sameSnapshot(snapshot, reopenedStats)) {
      throw failure("executable_changed", "shared staged executable changed while it was published");
    }
  } finally {
    await closeQuietly(reopened);
  }
  return Object.freeze({
    key,
    directory,
    directoryIdentity,
    stagedExecutablePath,
    sha256,
    handle,
    snapshot,
    verifyForSpawn: createSpawnVerifier(stagedExecutablePath, handle, snapshot),
  });
}

async function sharedStageIntact(entry: SharedStage): Promise<boolean> {
  try {
    const [pathStats, handleStats, directoryStats] = await Promise.all([
      lstat(entry.stagedExecutablePath, { bigint: true }),
      entry.handle.stat({ bigint: true }),
      lstat(entry.directory, { bigint: true }),
    ]);
    return (
      sameSnapshot(entry.snapshot, pathStats) &&
      sameSnapshot(entry.snapshot, handleStats) &&
      pathStats.nlink === 1n &&
      pathStats.uid === entry.snapshot.uid &&
      directoryStats.dev === entry.directoryIdentity.dev &&
      directoryStats.ino === entry.directoryIdentity.ino &&
      isOwnedPrivateDirectory(directoryStats)
    );
  } catch {
    return false;
  }
}

async function discardSharedStage(entry: SharedStage): Promise<void> {
  await closeQuietly(entry.handle);
  await rm(entry.directory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined);
}

async function discardStagedCopy(staged: StagedCopy): Promise<void> {
  await closeQuietly(staged.retainedStage);
  await rm(staged.stagingDirectory, { recursive: true, force: true, maxRetries: 0 }).catch(() => undefined);
}

/** The cheap source checks every pin performs, without copying or hashing anything. */
async function preflightSource(resolvedExecutablePath: string): Promise<void> {
  const source = await openReadNoFollow(resolvedExecutablePath);
  try {
    assertRegularExecutable(await source.stat({ bigint: true }));
    await assertMachO(source);
  } finally {
    await closeQuietly(source);
  }
}

function assertSharedStageFile(stats: BigIntStats): void {
  if (
    !stats.isFile() ||
    (stats.mode & 0o7777n) !== 0o500n ||
    stats.nlink !== 1n ||
    !ownedByCurrentUser(stats)
  ) {
    throw failure("executable_changed", "shared staged executable is not a private read-only file");
  }
}

function isOwnedPrivateDirectory(stats: BigIntStats): boolean {
  return stats.isDirectory() && (stats.mode & 0o777n) === 0o700n && ownedByCurrentUser(stats);
}

function ownedByCurrentUser(stats: BigIntStats): boolean {
  return typeof process.getuid !== "function" || stats.uid === BigInt(process.getuid());
}

/** @internal Used only by the non-root package test entry. */
export async function pinExecutableInternal(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
  testHooks?: ExecutablePinTestHooks,
): Promise<PinnedExecutable> {
  const staged = await stageVerifiedCopy(executablePath, stagingRoot, expectedSha256, testHooks);
  const { retainedStage, stagingDirectory, stagedExecutablePath, verifiedStageSnapshot } = staged;
  const verifyForSpawn = createSpawnVerifier(stagedExecutablePath, retainedStage, verifiedStageSnapshot);
  const cleanup = Object.freeze(once(async () => {
    let stageHandleClosed = true;
    try {
      await retainedStage.close();
    } catch {
      stageHandleClosed = false;
    }
    let stagingDirectoryRemoved = true;
    try {
      await removePrivateDirectoryStrict(stagingDirectory);
    } catch {
      stagingDirectoryRemoved = false;
    }
    return Object.freeze({
      stageHandleClosed,
      stagingDirectoryRemoved,
      failure: cleanupFailure(stageHandleClosed, stagingDirectoryRemoved),
    });
  }));
  return Object.freeze({
    resolvedExecutablePath: staged.resolvedExecutablePath,
    stagedExecutablePath,
    sha256: staged.sha256,
    dev: verifiedStageSnapshot.dev,
    ino: verifiedStageSnapshot.ino,
    verifyForSpawn,
    cleanup,
  });
}

type StagedCopy = {
  readonly resolvedExecutablePath: string;
  readonly stagingDirectory: string;
  readonly stagedExecutablePath: string;
  readonly sha256: string;
  /** Open descriptor of the verified copy; the caller owns closing it. */
  readonly retainedStage: FileHandle;
  readonly verifiedStageSnapshot: BigIntStats;
};

/**
 * Copies the executable into a fresh private directory and proves the copy: regular file, Mach-O,
 * independent inode, not writable, SHA-256 equal to the pin, source unchanged during the copy.
 * Any failure removes everything this call created.
 */
async function stageVerifiedCopy(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
  testHooks?: ExecutablePinTestHooks,
): Promise<StagedCopy> {
  if (!isAbsolute(executablePath)) {
    throw failure("path_not_absolute", "executable path must be absolute");
  }
  if (!isAbsolute(stagingRoot)) {
    throw failure("staging_root_not_absolute", "staging root must be absolute");
  }

  const resolvedStagingRoot = await resolveDirectory(stagingRoot);
  const resolvedExecutablePath = await resolvePath(executablePath, "executable metadata could not be read");
  let source: FileHandle | undefined;
  let writer: FileHandle | undefined;
  let stage: FileHandle | undefined;
  let stagingDirectory: string | undefined;

  try {
    source = await openReadNoFollow(resolvedExecutablePath);
    const sourceBeforeCopy = await source.stat({ bigint: true });
    assertRegularExecutable(sourceBeforeCopy);
    await assertMachO(source);

    stagingDirectory = await createPrivateDirectory(resolvedStagingRoot);
    // The caller owns the pathname before any fallible post-mkdir operation.
    await chmod(stagingDirectory, 0o700);
    const stagedExecutablePath = join(stagingDirectory, basename(resolvedExecutablePath));
    writer = await openStageWriter(stagedExecutablePath);
    await copyHandle(source, writer);
    await writer.sync();
    await closeRequired(writer, "staged executable writer could not be closed");
    writer = undefined;
    await testHooks?.afterDescriptorCopy?.();
    await chmod(stagedExecutablePath, 0o500);

    const [sourceAfterCopy, sourcePathAfterCopy] = await Promise.all([
      source.stat({ bigint: true }),
      lstat(resolvedExecutablePath, { bigint: true }),
    ]);
    if (!sameSnapshot(sourceBeforeCopy, sourceAfterCopy) || !sameSnapshot(sourceBeforeCopy, sourcePathAfterCopy)) {
      throw failure("executable_changed", "executable changed during independent copy");
    }

    stage = await openReadNoFollow(stagedExecutablePath);
    const stageBeforeHash = await stage.stat({ bigint: true });
    assertRegularExecutable(stageBeforeHash);
    if ((stageBeforeHash.mode & 0o222n) !== 0n) {
      throw failure("executable_changed", "staged executable is writable");
    }
    if (sameIdentity(sourceBeforeCopy, stageBeforeHash)) {
      throw failure("executable_changed", "staged executable must have an independent inode");
    }
    await assertMachO(stage);
    const sha256 = await hashHandle(stage);
    if (sha256 !== expectedSha256) {
      throw failure("hash_mismatch", "executable SHA-256 does not match the pin");
    }

    const [sourceAfterHash, sourcePathAfterHash, stageAfterHash] = await Promise.all([
      source.stat({ bigint: true }),
      lstat(resolvedExecutablePath, { bigint: true }),
      stage.stat({ bigint: true }),
    ]);
    if (
      !sameSnapshot(sourceBeforeCopy, sourceAfterHash) ||
      !sameSnapshot(sourceBeforeCopy, sourcePathAfterHash) ||
      !sameSnapshot(stageBeforeHash, stageAfterHash) ||
      sameIdentity(sourceAfterHash, stageAfterHash)
    ) {
      throw failure("executable_changed", "executable changed during verification");
    }

    const retainedStage = stage;
    const verifiedStageSnapshot = Object.freeze(stageAfterHash);
    await closeRequired(source, "source executable descriptor could not be closed");
    source = undefined;
    stage = undefined;
    return Object.freeze({
      resolvedExecutablePath,
      stagingDirectory,
      stagedExecutablePath,
      sha256,
      retainedStage,
      verifiedStageSnapshot,
    });
  } catch (cause) {
    const cleanup = await cleanupFailedPin(writer, stage, source, stagingDirectory);
    throw preservePinFailure(cause, cleanup);
  }
}

/**
 * Re-proves, immediately before spawn, that the staged pathname still names the verified inode
 * and that none of its identity fields changed.
 */
function createSpawnVerifier(
  stagedExecutablePath: string,
  retainedStage: FileHandle,
  verifiedStageSnapshot: BigIntStats,
): () => Promise<void> {
  return Object.freeze(async (): Promise<void> => {
    let reopened: FileHandle | undefined;
    try {
      reopened = await open(stagedExecutablePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [retainedStats, reopenedStats] = await Promise.all([
        retainedStage.stat({ bigint: true }),
        reopened.stat({ bigint: true }),
      ]);
      assertSpawnSafe(retainedStats);
      assertSpawnSafe(reopenedStats);
      if (
        !sameSnapshot(verifiedStageSnapshot, retainedStats) ||
        !sameSnapshot(verifiedStageSnapshot, reopenedStats) ||
        !sameSnapshot(retainedStats, reopenedStats)
      ) {
        throw failure("executable_changed", "staged executable changed before spawn");
      }
    } catch (cause) {
      if (cause instanceof ExecutablePinError && cause.code === "executable_changed") {
        throw cause;
      }
      throw failure("executable_changed", "staged executable could not be revalidated before spawn");
    } finally {
      await closeQuietly(reopened);
    }
  });
}

async function resolvePath(path: string, message: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw failure("preflight_io_failure", message);
  }
}

async function resolveDirectory(path: string): Promise<string> {
  const resolved = await resolvePath(path, "staging root must name a directory");
  try {
    if (!(await lstat(resolved)).isDirectory()) {
      throw new Error("not a directory");
    }
    return resolved;
  } catch {
    throw failure("preflight_io_failure", "staging root must name a directory");
  }
}

async function createPrivateDirectory(stagingRoot: string): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const directory = join(stagingRoot, `.grok-pin-${randomBytes(18).toString("hex")}`);
    try {
      await mkdir(directory, { mode: 0o700 });
      return directory;
    } catch (cause) {
      if (nodeErrorCode(cause) === "EEXIST") {
        continue;
      }
      break;
    }
  }
  throw failure("preflight_io_failure", "private staging directory could not be created");
}

async function openReadNoFollow(path: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw failure("preflight_io_failure", "executable could not be opened without following links");
  }
}

async function openStageWriter(path: string): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o500,
    );
  } catch {
    throw failure("preflight_io_failure", "staged executable could not be created safely");
  }
}

function assertRegularExecutable(stats: BigIntStats): void {
  if (!stats.isFile()) {
    throw failure("not_regular_file", "executable path must name a regular file");
  }
  if ((stats.mode & 0o111n) === 0n) {
    throw failure("not_executable", "executable file lacks execute permission");
  }
}

function assertSpawnSafe(stats: BigIntStats): void {
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n || (stats.mode & 0o222n) !== 0n) {
    throw failure("executable_changed", "staged executable is not spawn-safe");
  }
}

async function assertMachO(handle: FileHandle): Promise<void> {
  const header = Buffer.alloc(4);
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !MACH_O_MAGICS.has(header.readUInt32BE(0))) {
      throw failure("not_macho", "executable must be a Mach-O binary, not a script");
    }
  } catch (cause) {
    if (cause instanceof ExecutablePinError) {
      throw cause;
    }
    throw failure("preflight_io_failure", "executable format could not be read");
  }
}

/** Large reads keep a 160+ MB copy or hash to a few hundred awaited syscalls. */
const COPY_CHUNK_BYTES = 1024 * 1024;

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
]);

async function copyHandle(source: FileHandle, destination: FileHandle): Promise<void> {
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return;
    }
    let written = 0;
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written);
      if (result.bytesWritten === 0) {
        throw failure("preflight_io_failure", "staged executable copy stopped unexpectedly");
      }
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
}

async function hashHandle(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      return hash.digest("hex");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
  try {
    await handle?.close();
  } catch {
    // The primary verification or ownership outcome remains authoritative.
  }
}

async function closeRequired(handle: FileHandle, message: string): Promise<void> {
  try {
    await handle.close();
  } catch {
    throw failure("preflight_io_failure", message);
  }
}

async function cleanupFailedPin(
  writer: FileHandle | undefined,
  stage: FileHandle | undefined,
  source: FileHandle | undefined,
  directory: string | undefined,
): Promise<PinFailureCleanupEvidence> {
  const handles: readonly { readonly handle: FileHandle | undefined; readonly step: PinFailureCleanupStep }[] = [
    { handle: writer, step: "writer_handle_close_failed" },
    { handle: stage, step: "stage_handle_close_failed" },
    { handle: source, step: "source_handle_close_failed" },
  ];
  const attempted = handles.filter((entry): entry is { readonly handle: FileHandle; readonly step: PinFailureCleanupStep } => entry.handle !== undefined);
  const results = await Promise.allSettled(attempted.map((entry) => Promise.resolve().then(() => entry.handle.close())));
  const failedSteps = results.flatMap((result, index): PinFailureCleanupStep[] =>
    result.status === "rejected" ? [attempted[index]?.step ?? "source_handle_close_failed"] : []);
  if (directory !== undefined) {
    try {
      await removePrivateDirectoryStrict(directory);
    } catch {
      failedSteps.push("staging_directory_remove_failed");
    }
  }
  return Object.freeze({ failedSteps: Object.freeze(failedSteps) });
}

function preservePinFailure(cause: unknown, cleanup: PinFailureCleanupEvidence): ExecutablePinError {
  const primary = cause instanceof ExecutablePinError
    ? cause
    : failure("preflight_io_failure", "executable verification failed");
  if (cleanup.failedSteps.length !== 0) {
    primary.message = `${primary.message}; pin failure cleanup incomplete: ${cleanup.failedSteps.join(",")}`;
  }
  return primary;
}

async function removePrivateDirectoryStrict(directory: string | undefined): Promise<void> {
  if (directory !== undefined) {
    // `directory` is generated above; this never targets the caller's root or siblings.
    await rm(directory, { recursive: true, force: true, maxRetries: 0 });
  }
}

function cleanupFailure(stageHandleClosed: boolean, stagingDirectoryRemoved: boolean): PinnedExecutableCleanup["failure"] {
  if (stageHandleClosed && stagingDirectoryRemoved) {
    return "none";
  }
  if (!stageHandleClosed && !stagingDirectoryRemoved) {
    return "stage_handle_close_and_staging_directory_remove_failed";
  }
  return stageHandleClosed ? "staging_directory_remove_failed" : "stage_handle_close_failed";
}

function once<T>(operation: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => {
    result ??= operation();
    return result;
  };
}

function nodeErrorCode(cause: unknown): string | undefined {
  return cause !== null && typeof cause === "object"
    ? (cause as { readonly code?: unknown }).code as string | undefined
    : undefined;
}

function failure(code: ExecutablePinFailureCode, message: string): ExecutablePinError {
  return new ExecutablePinError(code, message);
}
