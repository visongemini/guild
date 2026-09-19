import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Implements PC-DATA-001's single-writer boundary with two complementary
 * SQLite locks: a private sidecar protects the configured path while the
 * authoritative connection protects the database inode and is handed to the
 * store for every read and write. Filesystem owner records supply durable
 * crash evidence. None of these surfaces is exported to renderer code.
 */

const OWNER_FILE_NAME = "owner.json";
const OWNER_VERSION = 2;
const LEASE_BUSY_TIMEOUT_MS = 500;
const MAX_OWNER_BYTES = 4_096;
const MAX_ACQUIRE_RACES = 16;
const OWNER_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const OWNER_KEYS = [
  "canonicalDatabasePath",
  "createdAtEpochMs",
  "ownerPid",
  "ownerToken",
  "version",
] as const;

interface LeaseOwner {
  readonly canonicalDatabasePath: string;
  readonly createdAtEpochMs: number;
  readonly ownerPid: number;
  readonly ownerToken: string;
  readonly version: typeof OWNER_VERSION;
}

const ACTIVE_DATABASE_IDENTITIES_KEY = Symbol.for(
  "@guild/persistence.active-database-identities.v1",
);
const guardGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
const existingGuardRegistry = guardGlobal[ACTIVE_DATABASE_IDENTITIES_KEY];
if (
  existingGuardRegistry !== undefined &&
  !(existingGuardRegistry instanceof Set)
) {
  throw new Error("invalid Guild persistence guard registry");
}
if (existingGuardRegistry === undefined) {
  Object.defineProperty(guardGlobal, ACTIVE_DATABASE_IDENTITIES_KEY, {
    configurable: false,
    enumerable: false,
    value: new Set<string>(),
    writable: false,
  });
}
const activeDatabaseIdentities = guardGlobal[
  ACTIVE_DATABASE_IDENTITIES_KEY
] as Set<string>;
const ACTIVE_GUARD_PATHS_KEY = Symbol.for(
  "@guild/persistence.active-guard-paths.v2",
);
const existingGuardPathRegistry = guardGlobal[ACTIVE_GUARD_PATHS_KEY];
if (
  existingGuardPathRegistry !== undefined &&
  !(existingGuardPathRegistry instanceof Set)
) {
  throw new Error("invalid Guild persistence guard path registry");
}
if (existingGuardPathRegistry === undefined) {
  Object.defineProperty(guardGlobal, ACTIVE_GUARD_PATHS_KEY, {
    configurable: false,
    enumerable: false,
    value: new Set<string>(),
    writable: false,
  });
}
const activeGuardPaths = guardGlobal[ACTIVE_GUARD_PATHS_KEY] as Set<string>;

export type DatabaseLeaseErrorCode =
  | "database_path_invalid"
  | "database_lease_held"
  | "database_lease_corrupt"
  | "database_lease_io_failed";

export class DatabaseLeaseError extends Error {
  readonly code: DatabaseLeaseErrorCode;

  constructor(code: DatabaseLeaseErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "DatabaseLeaseError";
    this.code = code;
  }
}

export interface DatabaseLease {
  readonly canonicalDatabasePath: string;
  /** Internal authoritative connection. The package root does not export it. */
  readonly database: DatabaseSync;
  readonly recoveredStaleOwner: boolean;

  /** Returns true only for the call that actually relinquishes this lease. */
  release(options?: DatabaseLeaseReleaseOptions): boolean;
}

export type DatabaseLeaseReleaseOptions = {
  readonly preserveRecoveryEvidence?: boolean;
};

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function leaseError(
  code: DatabaseLeaseErrorCode,
  cause?: unknown,
): DatabaseLeaseError {
  return new DatabaseLeaseError(
    code,
    cause === undefined ? undefined : { cause },
  );
}

function canonicalizeDatabasePath(databasePath: string): string {
  if (
    typeof databasePath !== "string" ||
    databasePath.length === 0 ||
    databasePath.includes("\0")
  ) {
    throw leaseError("database_path_invalid");
  }

  const absolutePath = resolve(databasePath);
  let finalComponentExists = false;
  try {
    lstatSync(absolutePath);
    finalComponentExists = true;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw leaseError("database_path_invalid", error);
    }
  }

  if (finalComponentExists) {
    try {
      const canonicalPath = realpathSync.native(absolutePath);
      const canonicalStat = statSync(canonicalPath);
      if (!canonicalStat.isFile() || canonicalStat.nlink !== 1) {
        throw leaseError("database_path_invalid");
      }
      return canonicalPath;
    } catch (error) {
      if (error instanceof DatabaseLeaseError) throw error;
      throw leaseError("database_path_invalid", error);
    }
  }

  try {
    const canonicalParent = realpathSync.native(dirname(absolutePath));
    if (!statSync(canonicalParent).isDirectory()) {
      throw leaseError("database_path_invalid");
    }
    return join(canonicalParent, basename(absolutePath));
  } catch (error) {
    if (error instanceof DatabaseLeaseError) throw error;
    throw leaseError("database_path_invalid", error);
  }
}

function leaseDirectoryPath(canonicalDatabasePath: string): string {
  return `${canonicalDatabasePath}.guild-writer-lease`;
}

function guardDatabasePath(canonicalDatabasePath: string): string {
  return `${canonicalDatabasePath}.guild-writer-guard.sqlite3`;
}

function staleLeaseDirectoryPrefix(lockPath: string): string {
  return `${basename(lockPath)}.stale-`;
}

function staleRecoveryDirectories(lockPath: string): readonly string[] {
  const parentPath = dirname(lockPath);
  const prefix = staleLeaseDirectoryPrefix(lockPath);
  try {
    return Object.freeze(
      readdirSync(parentPath, { withFileTypes: true })
        .filter((entry) => {
          if (!entry.isDirectory() || !entry.name.startsWith(prefix)) {
            return false;
          }
          return OWNER_TOKEN_PATTERN.test(entry.name.slice(prefix.length));
        })
        .map((entry) => join(parentPath, entry.name)),
    );
  } catch (error) {
    throw leaseError("database_lease_io_failed", error);
  }
}

function clearRecoveryDirectories(paths: readonly string[]): unknown | undefined {
  let firstFailure: unknown;
  for (const path of paths) {
    try {
      rmSync(path, { force: true, recursive: true });
    } catch (cause: unknown) {
      firstFailure ??= cause;
      // Preserve conservative recovery evidence if private cleanup fails.
    }
  }
  return firstFailure;
}

function hasExactOwnerKeys(value: Record<string, unknown>): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...OWNER_KEYS].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function parseOwner(
  text: string,
  expectedCanonicalDatabasePath: string,
): LeaseOwner {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw leaseError("database_lease_corrupt", error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !hasExactOwnerKeys(value as Record<string, unknown>)
  ) {
    throw leaseError("database_lease_corrupt");
  }

  const owner = value as Record<string, unknown>;
  if (
    owner["version"] !== OWNER_VERSION ||
    owner["canonicalDatabasePath"] !== expectedCanonicalDatabasePath ||
    typeof owner["ownerToken"] !== "string" ||
    !OWNER_TOKEN_PATTERN.test(owner["ownerToken"]) ||
    typeof owner["ownerPid"] !== "number" ||
    !Number.isSafeInteger(owner["ownerPid"]) ||
    owner["ownerPid"] <= 0 ||
    typeof owner["createdAtEpochMs"] !== "number" ||
    !Number.isSafeInteger(owner["createdAtEpochMs"]) ||
    owner["createdAtEpochMs"] < 0
  ) {
    throw leaseError("database_lease_corrupt");
  }

  return Object.freeze({
    version: OWNER_VERSION,
    canonicalDatabasePath: expectedCanonicalDatabasePath,
    ownerToken: owner["ownerToken"],
    ownerPid: owner["ownerPid"],
    createdAtEpochMs: owner["createdAtEpochMs"],
  });
}

function readOwner(
  directoryPath: string,
  expectedCanonicalDatabasePath: string,
): LeaseOwner | undefined {
  let directoryStat;
  try {
    directoryStat = lstatSync(directoryPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") return undefined;
    throw leaseError("database_lease_io_failed", error);
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw leaseError("database_lease_corrupt");
  }

  const ownerPath = join(directoryPath, OWNER_FILE_NAME);
  let ownerStat;
  try {
    ownerStat = lstatSync(ownerPath);
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      try {
        lstatSync(directoryPath);
      } catch (directoryError) {
        if (
          isErrnoException(directoryError) &&
          directoryError.code === "ENOENT"
        ) {
          return undefined;
        }
        throw leaseError("database_lease_io_failed", directoryError);
      }
      throw leaseError("database_lease_corrupt", error);
    }
    throw leaseError("database_lease_io_failed", error);
  }
  if (
    !ownerStat.isFile() ||
    ownerStat.isSymbolicLink() ||
    ownerStat.size <= 0 ||
    ownerStat.size > MAX_OWNER_BYTES
  ) {
    throw leaseError("database_lease_corrupt");
  }

  try {
    return parseOwner(
      readFileSync(ownerPath, "utf8"),
      expectedCanonicalDatabasePath,
    );
  } catch (error) {
    if (error instanceof DatabaseLeaseError) throw error;
    if (isErrnoException(error) && error.code === "ENOENT") {
      return readOwner(directoryPath, expectedCanonicalDatabasePath);
    }
    throw leaseError("database_lease_io_failed", error);
  }
}

function writeCandidateOwner(directoryPath: string, owner: LeaseOwner): void {
  try {
    mkdirSync(directoryPath, { mode: 0o700 });
    const ownerPath = join(directoryPath, OWNER_FILE_NAME);
    const descriptor = openSync(ownerPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    try {
      rmSync(directoryPath, { force: true, recursive: true });
    } catch {
      // The original failure is the useful diagnostic.
    }
    throw leaseError("database_lease_io_failed", error);
  }
}

function sqliteErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errcode" in error)) {
    return undefined;
  }
  const value = error.errcode;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function ensurePrivateAuthoritativeDatabase(path: string): string {
  let createdDescriptor: number | undefined;
  try {
    createdDescriptor = openSync(path, "ax", 0o600);
    fsyncSync(createdDescriptor);
  } catch (cause: unknown) {
    if (!isErrnoException(cause) || cause.code !== "EEXIST") {
      throw leaseError("database_lease_io_failed", cause);
    }
  } finally {
    if (createdDescriptor !== undefined) closeSync(createdDescriptor);
  }

  let databaseStat;
  try {
    databaseStat = lstatSync(path);
  } catch (cause: unknown) {
    throw leaseError("database_lease_io_failed", cause);
  }
  if (
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    databaseStat.nlink !== 1
  ) {
    throw leaseError("database_lease_corrupt");
  }
  if (process.platform !== "win32" && (databaseStat.mode & 0o077) !== 0) {
    throw leaseError("database_lease_corrupt");
  }

  try {
    const identity = statSync(path, { bigint: true });
    return `${identity.dev.toString(16)}:${identity.ino.toString(16)}`;
  } catch (cause: unknown) {
    throw leaseError("database_lease_io_failed", cause);
  }
}

function ensurePrivateGuardDatabase(path: string): void {
  let createdDescriptor: number | undefined;
  try {
    createdDescriptor = openSync(path, "ax", 0o600);
    fsyncSync(createdDescriptor);
  } catch (cause: unknown) {
    if (!isErrnoException(cause) || cause.code !== "EEXIST") {
      throw leaseError("database_lease_io_failed", cause);
    }
  } finally {
    if (createdDescriptor !== undefined) closeSync(createdDescriptor);
  }

  let guardStat;
  try {
    guardStat = lstatSync(path);
  } catch (cause: unknown) {
    throw leaseError("database_lease_io_failed", cause);
  }
  if (
    !guardStat.isFile() ||
    guardStat.isSymbolicLink() ||
    guardStat.nlink !== 1
  ) {
    throw leaseError("database_lease_corrupt");
  }
  if (process.platform !== "win32" && (guardStat.mode & 0o077) !== 0) {
    throw leaseError("database_lease_corrupt");
  }
}

type GuardDatabase = {
  readonly database: DatabaseSync;
  readonly path: string;
};

function acquireGuardDatabase(
  canonicalDatabasePath: string,
): GuardDatabase {
  const path = guardDatabasePath(canonicalDatabasePath);
  if (activeGuardPaths.has(path)) {
    throw leaseError("database_lease_held");
  }
  activeGuardPaths.add(path);

  let database: DatabaseSync;
  try {
    ensurePrivateGuardDatabase(path);
    database = new DatabaseSync(path, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: false,
      returnArrays: false,
      timeout: LEASE_BUSY_TIMEOUT_MS,
    });
  } catch (cause: unknown) {
    activeGuardPaths.delete(path);
    if (cause instanceof DatabaseLeaseError) throw cause;
    throw leaseError("database_lease_io_failed", cause);
  }

  try {
    const lockingMode = database
      .prepare("PRAGMA locking_mode = EXCLUSIVE")
      .get();
    if (lockingMode?.["locking_mode"] !== "exclusive") {
      throw leaseError("database_lease_corrupt");
    }
    database.exec("BEGIN EXCLUSIVE; COMMIT");
    const journalMode = database.prepare("PRAGMA journal_mode").get();
    if (journalMode?.["journal_mode"] !== "delete") {
      throw leaseError("database_lease_corrupt");
    }
    return Object.freeze({ database, path });
  } catch (cause: unknown) {
    let closeFailed = false;
    try {
      database.close();
    } catch {
      closeFailed = true;
    }
    if (!closeFailed) activeGuardPaths.delete(path);
    const code = sqliteErrorCode(cause);
    if (code === 5 || code === 6) {
      throw leaseError("database_lease_held", cause);
    }
    if (code === 11 || code === 26 || cause instanceof DatabaseLeaseError) {
      throw cause instanceof DatabaseLeaseError
        ? cause
        : leaseError("database_lease_corrupt", cause);
    }
    throw leaseError("database_lease_io_failed", cause);
  }
}

function closeGuardDatabase(guard: GuardDatabase): void {
  guard.database.close();
  activeGuardPaths.delete(guard.path);
}

type AuthoritativeDatabase = {
  readonly database: DatabaseSync;
  readonly identity: string;
};

function acquireAuthoritativeDatabase(
  canonicalDatabasePath: string,
): AuthoritativeDatabase {
  // A Worker has a different global registry but shares process-wide POSIX
  // advisory locks. Reject it before any raw descriptor can be opened and
  // closed around a main-realm SQLite lock.
  if (!isMainThread) {
    throw leaseError("database_lease_io_failed");
  }

  const identity = ensurePrivateAuthoritativeDatabase(
    canonicalDatabasePath,
  );
  if (activeDatabaseIdentities.has(identity)) {
    throw leaseError("database_lease_held");
  }
  activeDatabaseIdentities.add(identity);

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(canonicalDatabasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      readBigInts: false,
      returnArrays: false,
      timeout: LEASE_BUSY_TIMEOUT_MS,
    });
  } catch (cause: unknown) {
    activeDatabaseIdentities.delete(identity);
    if (cause instanceof DatabaseLeaseError) throw cause;
    throw leaseError("database_lease_io_failed", cause);
  }

  try {
    const lockingMode = database
      .prepare("PRAGMA locking_mode = EXCLUSIVE")
      .get();
    if (lockingMode?.["locking_mode"] !== "exclusive") {
      throw leaseError("database_lease_corrupt");
    }
    // This transaction takes the authoritative database inode's OS-backed
    // lock. SQLite retains it after COMMIT because locking_mode is EXCLUSIVE;
    // the kernel releases it if the process dies.
    database.exec("BEGIN EXCLUSIVE; COMMIT");
    if (
      ensurePrivateAuthoritativeDatabase(canonicalDatabasePath) !== identity
    ) {
      throw leaseError("database_lease_corrupt");
    }
    return Object.freeze({ database, identity });
  } catch (cause: unknown) {
    let closeFailed = false;
    try {
      database.close();
    } catch {
      closeFailed = true;
      // Retain the in-process reservation because the connection may still
      // own a process-wide POSIX advisory lock.
    }
    if (!closeFailed) activeDatabaseIdentities.delete(identity);
    const code = sqliteErrorCode(cause);
    if (code === 5 || code === 6) {
      throw leaseError("database_lease_held", cause);
    }
    if (code === 11 || code === 26 || cause instanceof DatabaseLeaseError) {
      throw cause instanceof DatabaseLeaseError
        ? cause
        : leaseError("database_lease_corrupt", cause);
    }
    throw leaseError("database_lease_io_failed", cause);
  }
}

function closeAuthoritativeDatabase(
  database: DatabaseSync,
  identity: string,
): void {
  database.close();
  activeDatabaseIdentities.delete(identity);
}

function closeLeaseDatabases(
  authoritative: AuthoritativeDatabase,
  guard: GuardDatabase,
): void {
  // Keep the path guard held unless the authoritative connection definitely
  // closed. This is the fail-closed order for an uncertain SQLite close.
  closeAuthoritativeDatabase(authoritative.database, authoritative.identity);
  closeGuardDatabase(guard);
}

function tryRename(source: string, destination: string): boolean {
  try {
    renameSync(source, destination);
    return true;
  } catch (error) {
    if (
      isErrnoException(error) &&
      ["EACCES", "EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(
        error.code ?? "",
      )
    ) {
      return false;
    }
    throw leaseError("database_lease_io_failed", error);
  }
}

function currentProcessOwner(
  canonicalDatabasePath: string,
  ownerToken: string,
): LeaseOwner {
  const now = Date.now();
  return Object.freeze({
    version: OWNER_VERSION,
    canonicalDatabasePath,
    ownerToken,
    ownerPid: process.pid,
    createdAtEpochMs: now,
  });
}

/**
 * Acquires the exclusive writer lease for one canonical database path.
 *
 * Candidate metadata is fully written and fsynced before an atomic directory
 * rename publishes it. Recovery renames a dead owner's non-empty directory to
 * a token-addressed tombstone. Keeping that tombstone prevents a delayed second
 * reaper from renaming a newly acquired live lease into the same destination.
 */
export function acquireDatabaseLease(databasePath: string): DatabaseLease {
  if (!isMainThread) {
    throw leaseError("database_lease_io_failed");
  }
  const canonicalDatabasePath = canonicalizeDatabasePath(databasePath);
  const guard = acquireGuardDatabase(canonicalDatabasePath);
  let authoritative: AuthoritativeDatabase;
  try {
    authoritative = acquireAuthoritativeDatabase(canonicalDatabasePath);
  } catch (cause: unknown) {
    try {
      closeGuardDatabase(guard);
    } catch {
      // Preserve the authoritative acquisition failure.
    }
    throw cause;
  }
  const lockPath = leaseDirectoryPath(canonicalDatabasePath);
  const ownerToken = randomUUID();
  const candidatePath = `${lockPath}.candidate-${ownerToken}`;
  const owner = currentProcessOwner(canonicalDatabasePath, ownerToken);
  let acquired = false;
  let ownsPublishedLock = false;

  try {
    writeCandidateOwner(candidatePath, owner);
    for (let attempt = 0; attempt < MAX_ACQUIRE_RACES; attempt += 1) {
      if (tryRename(candidatePath, lockPath)) {
        ownsPublishedLock = true;
        const publishedOwner = readOwner(lockPath, canonicalDatabasePath);
        if (publishedOwner?.ownerToken !== ownerToken) {
          throw leaseError("database_lease_corrupt");
        }
        acquired = true;
        break;
      }

      const existingOwner = readOwner(lockPath, canonicalDatabasePath);
      if (existingOwner === undefined) continue;

      const stalePath = `${lockPath}.stale-${existingOwner.ownerToken}`;
      if (tryRename(lockPath, stalePath)) continue;

      const ownerAfterRace = readOwner(lockPath, canonicalDatabasePath);
      if (ownerAfterRace === undefined) continue;
      if (ownerAfterRace.ownerToken !== existingOwner.ownerToken) continue;
      throw leaseError("database_lease_io_failed");
    }

    if (!acquired) throw leaseError("database_lease_io_failed");
  } catch (cause: unknown) {
    if (ownsPublishedLock) {
      try {
        tryRename(lockPath, `${lockPath}.stale-${ownerToken}`);
      } catch {
        // Preserve the original acquisition failure.
      }
    } else {
      try {
        rmSync(candidatePath, { force: true, recursive: true });
      } catch {
        // A failed acquisition must never disturb the published lease.
      }
    }
    try {
      closeLeaseDatabases(authoritative, guard);
    } catch {
      // Preserve the original acquisition failure.
    }
    throw cause;
  }

  let inheritedRecoveryDirectories: readonly string[];
  try {
    inheritedRecoveryDirectories = staleRecoveryDirectories(lockPath);
  } catch (cause: unknown) {
    const failedAcquisitionPath = `${lockPath}.stale-${ownerToken}`;
    let relinquishFailed = false;
    try {
      if (!tryRename(lockPath, failedAcquisitionPath)) {
        const publishedOwner = readOwner(lockPath, canonicalDatabasePath);
        if (publishedOwner?.ownerToken === ownerToken) {
          relinquishFailed = true;
        }
      }
    } catch {
      // Closing the OS guard still prevents this failed caller from self-locking
      // indefinitely; the next owner will recover any fixed owner directory.
      relinquishFailed = true;
    }
    try {
      closeLeaseDatabases(authoritative, guard);
    } catch {
      // Preserve the recovery-scan failure and the in-process reservation.
    }
    if (relinquishFailed) {
      throw leaseError("database_lease_io_failed", cause);
    }
    throw cause;
  }
  const recoveredStaleOwner = inheritedRecoveryDirectories.length > 0;
  let released = false;
  return Object.freeze({
    canonicalDatabasePath,
    database: authoritative.database,
    recoveredStaleOwner,
    release(options: DatabaseLeaseReleaseOptions = {}): boolean {
      if (released) return false;

      const abandonMetadataAndClose = (cause?: unknown): false => {
        released = true;
        try {
          closeLeaseDatabases(authoritative, guard);
        } catch (closeCause: unknown) {
          if (cause === undefined) {
            throw leaseError("database_lease_io_failed", closeCause);
          }
          // Preserve the metadata diagnostic. The registries remain fail-closed
          // for any connection whose close result is uncertain.
        }
        if (cause !== undefined) throw cause;
        return false;
      };

      let publishedOwner: LeaseOwner | undefined;
      try {
        publishedOwner = readOwner(lockPath, canonicalDatabasePath);
      } catch (cause: unknown) {
        return abandonMetadataAndClose(cause);
      }
      if (publishedOwner?.ownerToken !== ownerToken) {
        // Never mutate another generation's metadata, but do close the two
        // connections this lease certainly owns. A closed store must not retain
        // process resources until application exit.
        return abandonMetadataAndClose();
      }

      const preserveRecoveryEvidence =
        options.preserveRecoveryEvidence === true;
      if (!preserveRecoveryEvidence) {
        const cleanupFailure = clearRecoveryDirectories(
          inheritedRecoveryDirectories,
        );
        if (cleanupFailure !== undefined) {
          try {
            tryRename(lockPath, `${lockPath}.stale-${ownerToken}`);
          } catch {
            // The fixed owner directory itself remains recovery evidence once
            // the OS guard closes.
          }
          released = true;
          try {
            closeLeaseDatabases(authoritative, guard);
          } catch {
            // The cleanup failure remains the primary diagnostic.
          }
          throw leaseError("database_lease_io_failed", cleanupFailure);
        }
      }
      const relinquishedPath = preserveRecoveryEvidence
        ? `${lockPath}.stale-${ownerToken}`
        : `${lockPath}.released-${ownerToken}`;
      let relinquished = false;
      try {
        relinquished = tryRename(lockPath, relinquishedPath);
      } catch (cause: unknown) {
        return abandonMetadataAndClose(cause);
      }
      if (!relinquished) {
        let ownerAfterRace: LeaseOwner | undefined;
        try {
          ownerAfterRace = readOwner(lockPath, canonicalDatabasePath);
        } catch (cause: unknown) {
          return abandonMetadataAndClose(cause);
        }
        if (ownerAfterRace?.ownerToken !== ownerToken) {
          return abandonMetadataAndClose();
        }
        return abandonMetadataAndClose(
          leaseError("database_lease_io_failed"),
        );
      }

      let movedOwner: LeaseOwner | undefined;
      try {
        movedOwner = readOwner(relinquishedPath, canonicalDatabasePath);
      } catch (cause: unknown) {
        return abandonMetadataAndClose(cause);
      }
      if (movedOwner?.ownerToken !== ownerToken) {
        return abandonMetadataAndClose(
          leaseError("database_lease_corrupt"),
        );
      }
      released = true;
      try {
        closeLeaseDatabases(authoritative, guard);
      } catch (cause: unknown) {
        if (!preserveRecoveryEvidence) {
          try {
            tryRename(
              relinquishedPath,
              `${lockPath}.stale-${ownerToken}`,
            );
          } catch {
            // Keep the released directory as conservative evidence if the
            // database close result is uncertain.
          }
        }
        throw leaseError("database_lease_io_failed", cause);
      }
      if (!preserveRecoveryEvidence) {
        try {
          rmSync(relinquishedPath, { force: true, recursive: true });
        } catch {
          // The fixed lease path is already free; a private cleanup failure does
          // not make it safe to report that this owner still holds the lease.
        }
      }
      return true;
    },
  });
}
