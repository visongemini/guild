import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { findChainProblem, type PrivateInstallProblem } from "./private-install.js";

/**
 * PC-SEC-001, PC-ENG-002, PC-ENG-003: the directory the executables Guild runs are copied into (Grok, node, the probe copy of
 * `claude`). A copy is verified once and then executed from there, so whoever can put something in that directory, or swap
 * the directory itself, defeats the verification. The temp directory is normally the user's private one, but `/tmp` is a
 * shared place on other setups: another account could create `guild-v2-runtime` first, or replace it after a copy was
 * verified. So the root must be ours alone, and this is checked when it is created and again before every stage and spawn:
 *
 *  - the root itself is a real directory (not a link), owned by the current user, mode 0700. One that is ours but looser
 *    is tightened; one that is not ours is refused, and so is one that is a link or a file;
 *  - its parent (the real directory the link-free path leads through) and every directory above the parent up to `/` is owned
 *    by the current user or root and cannot be written by group or others, unless it has the sticky bit (as `/tmp` does),
 *    which keeps others from renaming or removing what is ours. Whoever can write any ancestor can rename it, and with it the
 *    root and the verified copies in it, between the check and the exec. The walk is the one the engine files use
 *    (private-install.ts `findChainProblem`) with the sticky allowance.
 *
 * Owner and mode come through `StagingRootIo`, so the checks are testable without a second account.
 */

export type StagingRootProblem =
  | "not_absolute"
  | "parent_missing"
  | "parent_not_directory"
  | "ancestor_not_ours"
  | "ancestor_writable"
  | "ancestor_linked"
  | "ancestor_unreadable"
  | "root_is_link"
  | "root_not_directory"
  | "root_not_ours"
  | "root_unreadable"
  | "root_cannot_be_created"
  | "root_cannot_be_tightened";

export class StagingRootError extends Error {
  readonly problem: StagingRootProblem;
  /** For the `ancestor_*` problems: the directory above the root that others may be able to rewrite. Not in the message. */
  readonly path: string | undefined;

  constructor(problem: StagingRootProblem, path?: string) {
    super(`staging root is not private: ${problem}`);
    this.name = "StagingRootError";
    this.problem = problem;
    this.path = path;
  }
}

function ancestorProblemOf(problem: PrivateInstallProblem): StagingRootProblem {
  switch (problem) {
    case "not_owned": return "ancestor_not_ours";
    case "group_writable":
    case "world_writable": return "ancestor_writable";
    case "linked": return "ancestor_linked";
    default: return "ancestor_unreadable";
  }
}

export type StagingRootStats = Readonly<{
  uid: number;
  mode: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}>;

export type StagingRootIo = Readonly<{
  /** The current user. */
  uid: number;
  /** Follows nothing at the last component; rejects with an `ENOENT` code for a missing path. */
  lstat: (path: string) => Promise<StagingRootStats>;
  realpath: (path: string) => Promise<string>;
  mkdir: (path: string, mode: number) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
}>;

export const DEFAULT_STAGING_ROOT_IO: StagingRootIo = Object.freeze({
  uid: process.getuid?.() ?? -1,
  lstat: async (path: string): Promise<StagingRootStats> => {
    const stats = await lstat(path);
    return Object.freeze({
      uid: stats.uid,
      mode: stats.mode,
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    });
  },
  realpath: (path: string) => realpath(path),
  mkdir: async (path: string, mode: number): Promise<void> => { await mkdir(path, { mode }); },
  chmod: (path: string, mode: number) => chmod(path, mode),
});

const PRIVATE_MODE = 0o700;

function codeOf(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null ? (cause as { code?: string }).code : undefined;
}

/**
 * Proves `stagingRoot` is private to the current user and returns its real path. With `create`, a missing root is made (mode
 * 0700, its parent must exist); without it a missing root is an error. Throws `StagingRootError`; nothing is changed except
 * the creation of a missing root and the tightening of one that is ours.
 */
export async function secureStagingRoot(
  stagingRoot: string,
  options: Readonly<{ create?: boolean; io?: StagingRootIo }> = {},
): Promise<string> {
  const io = options.io ?? DEFAULT_STAGING_ROOT_IO;
  if (!isAbsolute(stagingRoot) || stagingRoot.includes("\0")) throw new StagingRootError("not_absolute");
  const name = basename(stagingRoot);
  const parent = dirname(stagingRoot);
  if (name === "" || name === "." || name === ".." || parent === stagingRoot) throw new StagingRootError("not_absolute");

  let realParent: string;
  let parentStats: StagingRootStats;
  try {
    realParent = await io.realpath(parent);
    parentStats = await io.lstat(realParent);
  } catch {
    throw new StagingRootError("parent_missing");
  }
  if (!parentStats.isDirectory) throw new StagingRootError("parent_not_directory");
  // The parent and every ancestor up to `/`: one that others can write can be renamed away, root and verified copies with it.
  const ancestor = await findChainProblem(realParent, io, true);
  if (ancestor !== undefined) throw new StagingRootError(ancestorProblemOf(ancestor.problem), ancestor.path);

  const target = join(realParent, name);
  let stats = await lstatOrMissing(io, target);
  if (stats === undefined) {
    if (options.create !== true) throw new StagingRootError("root_unreadable");
    try {
      await io.mkdir(target, PRIVATE_MODE);
    } catch (cause) {
      // Somebody else made it a moment ago: it is judged below like any root that was there before.
      if (codeOf(cause) !== "EEXIST") throw new StagingRootError("root_cannot_be_created");
    }
    stats = await lstatOrMissing(io, target);
    if (stats === undefined) throw new StagingRootError("root_cannot_be_created");
  }
  if (stats.isSymbolicLink) throw new StagingRootError("root_is_link");
  if (!stats.isDirectory) throw new StagingRootError("root_not_directory");
  if (stats.uid !== io.uid) throw new StagingRootError("root_not_ours");
  if ((stats.mode & 0o777) !== PRIVATE_MODE) {
    try {
      await io.chmod(target, PRIVATE_MODE);
    } catch {
      throw new StagingRootError("root_cannot_be_tightened");
    }
    // The mode is read again: a chmod that did not take, or a root that was swapped meanwhile, must not pass.
    const after = await lstatOrMissing(io, target);
    if (after === undefined || after.isSymbolicLink || !after.isDirectory || after.uid !== io.uid || (after.mode & 0o777) !== PRIVATE_MODE) {
      throw new StagingRootError("root_cannot_be_tightened");
    }
  }
  return target;
}

async function lstatOrMissing(io: StagingRootIo, path: string): Promise<StagingRootStats | undefined> {
  try {
    return await io.lstat(path);
  } catch (cause) {
    if (codeOf(cause) === "ENOENT") return undefined;
    throw new StagingRootError("root_unreadable");
  }
}
