import { realpathSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

/**
 * PC-ENG-002, PC-ENG-003, PC-ENG-004: where a packaged app may take the programs it runs from. The user-installed engines
 * (`node`, the adapter or CLI package, `claude`) are executed with the user's credentials around them, so a packaged app
 * never lets the environment it was started in choose them: it does not read `PATH`, it looks only in a fixed list of
 * absolute directories (`trustedSearchDirectories`), and it uses only a file whose whole real path is owned by the
 * current user or root and cannot be rewritten by anybody else (`findPathTrustProblem`). A development run (an
 * unpackaged app, see `allowDevelopmentLocatorSearch`) keeps the old behaviour, which the QA scripts rely on.
 */

export type PathTrustProblem =
  | "linked"
  | "not_owned"
  | "group_writable"
  | "world_writable"
  | "temporary_location"
  | "unreadable";

export type PathTrustFinding = Readonly<{ problem: PathTrustProblem; path: string }>;

export type PathTrustPolicy = Readonly<{
  /** The current user. Root is always an acceptable owner as well. */
  currentUid: number;
  /**
   * macOS keeps a Homebrew prefix (`/opt/homebrew`, `/usr/local`) writable by the `admin` group. A directory (never a
   * file) that only that group can write is accepted; with `undefined` no group-writable directory is.
   */
  adminGid: number | undefined;
  /** Real paths below which nothing is trusted: the temporary directories. */
  rejectedRoots: readonly string[];
}>;

/** The group every administrator account belongs to on macOS. */
export const MACOS_ADMIN_GID = 80;

const MAX_DEPTH = 64;
const S_IWGRP = 0o020;
const S_IWOTH = 0o002;

const TEMPORARY_ROOTS = Object.freeze([
  "/tmp",
  "/private/tmp",
  "/var/tmp",
  "/private/var/tmp",
  "/var/folders",
  "/private/var/folders",
]);

let cachedPolicy: PathTrustPolicy | undefined;

/** The policy of this process: the current user, the macOS admin group and the real temporary directories. */
export function defaultPathTrustPolicy(): PathTrustPolicy {
  if (cachedPolicy !== undefined) return cachedPolicy;
  const roots = new Set<string>();
  for (const candidate of [...TEMPORARY_ROOTS, tmpdir(), process.env["TMPDIR"] ?? ""]) {
    if (candidate.length === 0 || !candidate.startsWith("/")) continue;
    roots.add(stripTrailingSeparator(candidate));
    try {
      roots.add(stripTrailingSeparator(realpathSync(candidate)));
    } catch {
      // A directory that does not exist has no real path to add.
    }
  }
  cachedPolicy = Object.freeze({
    currentUid: process.getuid?.() ?? -1,
    adminGid: process.platform === "darwin" ? MACOS_ADMIN_GID : undefined,
    rejectedRoots: Object.freeze([...roots]),
  });
  return cachedPolicy;
}

function stripTrailingSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

/** Whether `path` is one of the roots or inside one. */
export function isInsideRoot(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

type TrustStats = Readonly<{ uid: number; gid: number; mode: number }>;

/** The pure rule for one entry: the owner, then who can write to it. */
export function trustProblemOfStats(
  stats: TrustStats,
  isDirectory: boolean,
  policy: PathTrustPolicy,
): PathTrustProblem | undefined {
  if (stats.uid !== policy.currentUid && stats.uid !== 0) return "not_owned";
  if ((stats.mode & S_IWOTH) !== 0) return "world_writable";
  if ((stats.mode & S_IWGRP) !== 0) {
    if (isDirectory && policy.adminGid !== undefined && stats.gid === policy.adminGid) return undefined;
    return "group_writable";
  }
  return undefined;
}

/**
 * The first reason a real path (symbolic links already resolved by the caller) is not trustworthy, or undefined when it
 * is: inside a temporary directory; the file itself linked, owned by somebody else or writable by group or others; or a
 * directory on the way to `/` owned by somebody else or writable by others (by the group too, unless it is the admin
 * group of macOS). Nothing is read from the file and nothing is run.
 */
export async function findPathTrustProblem(
  realPath: string,
  policy: PathTrustPolicy = defaultPathTrustPolicy(),
): Promise<PathTrustFinding | undefined> {
  if (!realPath.startsWith("/") || realPath.includes("\0")) return Object.freeze({ problem: "unreadable", path: realPath });
  if (isInsideRoot(realPath, policy.rejectedRoots)) return Object.freeze({ problem: "temporary_location", path: realPath });
  let current = realPath;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let stats;
    try {
      stats = await lstat(current);
    } catch {
      return Object.freeze({ problem: "unreadable", path: current });
    }
    // The caller passes a real path, so a link anywhere on it means the file changed under the caller.
    if (stats.isSymbolicLink()) return Object.freeze({ problem: "linked", path: current });
    const problem = trustProblemOfStats(stats, current !== realPath, policy);
    if (problem !== undefined) return Object.freeze({ problem, path: current });
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return Object.freeze({ problem: "unreadable", path: realPath });
}

const VERSION_DIRECTORY_LIMIT = 3;

type VersionManagerLayout = Readonly<{
  /** Path below the home directory that holds one directory per installed version. */
  root: readonly string[];
  name: RegExp;
  /** Path from a version directory to the directory that holds `node` and the globally installed commands. */
  bin: readonly string[];
}>;

/**
 * Version managers that keep every release as a real directory with a real `node` in it. Their shims (`~/.volta/bin`,
 * `~/.asdf/shims`) are programs that choose a version from the current folder and the environment, so they are never used.
 */
const VERSION_MANAGERS: readonly VersionManagerLayout[] = Object.freeze([
  { root: [".nvm", "versions", "node"], name: /^v(\d+)\.(\d+)\.(\d+)$/u, bin: ["bin"] },
  { root: [".volta", "tools", "image", "node"], name: /^(\d+)\.(\d+)\.(\d+)$/u, bin: ["bin"] },
  { root: [".asdf", "installs", "nodejs"], name: /^(\d+)\.(\d+)\.(\d+)$/u, bin: ["bin"] },
  { root: ["Library", "Application Support", "fnm", "node-versions"], name: /^v(\d+)\.(\d+)\.(\d+)$/u, bin: ["installation", "bin"] },
  { root: [".local", "share", "fnm", "node-versions"], name: /^v(\d+)\.(\d+)\.(\d+)$/u, bin: ["installation", "bin"] },
  { root: [".local", "share", "mise", "installs", "node"], name: /^(\d+)\.(\d+)\.(\d+)$/u, bin: ["bin"] },
]);

/**
 * The `bin` directories of the newest releases of the supported version managers under `homeDirectory`, newest first.
 * Only a directory whose name is a version of at least `minimumMajor` is listed; nothing in them is run here.
 */
export async function versionManagerBinDirectories(
  homeDirectory: string,
  minimumMajor: number,
): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const layout of VERSION_MANAGERS) {
    const root = join(homeDirectory, ...layout.root);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    const versions = names
      .map((name) => ({ name, match: layout.name.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null && Number(entry.match[1]) >= minimumMajor)
      .sort((left, right) => compareVersions(right.match, left.match))
      .slice(0, VERSION_DIRECTORY_LIMIT);
    for (const { name } of versions) directories.push(join(root, name, ...layout.bin));
  }
  return Object.freeze(directories);
}

function compareVersions(left: RegExpExecArray, right: RegExpExecArray): number {
  for (const index of [1, 2, 3]) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}
