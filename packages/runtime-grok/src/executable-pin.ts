import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rm, type FileHandle } from "node:fs/promises";
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

/** @internal Used only by the non-root package test entry. */
export async function pinExecutableInternal(
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
    const verifyForSpawn = Object.freeze(async (): Promise<void> => {
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
    await closeRequired(source, "source executable descriptor could not be closed");
    source = undefined;
    stage = undefined;
    return Object.freeze({
      resolvedExecutablePath,
      stagedExecutablePath,
      sha256,
      dev: stageAfterHash.dev,
      ino: stageAfterHash.ino,
      verifyForSpawn,
      cleanup,
    });
  } catch (cause) {
    const cleanup = await cleanupFailedPin(writer, stage, source, stagingDirectory);
    throw preservePinFailure(cause, cleanup);
  }
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
  const buffer = Buffer.allocUnsafe(64 * 1024);
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
  const buffer = Buffer.allocUnsafe(64 * 1024);
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
