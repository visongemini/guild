import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { AdapterPinError } from "./adapter-pin.js";

/**
 * PC-SEC-001, PC-ENG-002, PC-ENG-003: a packaged app runs some files of the user's engines where they are, not from a
 * verified staged copy: the `claude` binary, the adapter package that `node` loads (its `node_modules` included) and the
 * native Codex core with the helpers beside it. Their bytes are pinned, but a pin cannot stop somebody who can write the
 * file or one of its folders from swapping it between the check and the exec. So Guild also requires that no one but the
 * user (and root) can: the real path of each file and every folder above it, and every entry of an adapter package, must be
 * owned by the current user or root and must not be writable by group or others. There is no exemption for the macOS admin
 * group (a Homebrew prefix) or for sticky directories; `node` is the one piece that needs none, because it runs from a
 * verified staged copy.
 *
 * Owner and mode come through `PrivateInstallIo`, so the rules are testable without a second account. Access control lists
 * are not read: only owner and mode bits are judged, as in trusted-location.ts.
 */

export type PrivateInstallProblem =
  | "not_owned"
  | "group_writable"
  | "world_writable"
  | "linked"
  | "unreadable"
  | "too_many_entries";

export type PrivateInstallFinding = Readonly<{ problem: PrivateInstallProblem; path: string }>;

export type PrivateInstallStats = Readonly<{
  uid: number;
  mode: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}>;

export type PrivateInstallIo = Readonly<{
  /** The current user. Root is always an acceptable owner as well. */
  uid: number;
  /** Does not follow a link at the last component; rejects for a missing path. */
  lstat: (path: string) => Promise<PrivateInstallStats>;
  realpath: (path: string) => Promise<string>;
  /** The names in a directory. */
  readdir: (path: string) => Promise<readonly string[]>;
}>;

export const DEFAULT_PRIVATE_INSTALL_IO: PrivateInstallIo = Object.freeze({
  uid: process.getuid?.() ?? -1,
  lstat: async (path: string): Promise<PrivateInstallStats> => {
    const stats = await lstat(path);
    return Object.freeze({
      uid: stats.uid,
      mode: stats.mode,
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
    });
  },
  realpath: (path: string) => realpath(path),
  readdir: (path: string) => readdir(path),
});

/** What to prove private: single files (their folders above them too) and package trees (everything below them as well). */
export type PrivateInstallSubject = Readonly<{
  /** Real paths of files that are run in place, for example the `claude` binary or the Codex core. */
  files?: readonly string[];
  /** Real paths of directories whose whole content may be loaded, for example an adapter package. */
  trees?: readonly string[];
}>;

/** More entries than any real adapter has (the largest seen is about eight thousand); a runaway tree is refused. */
export const PRIVATE_INSTALL_ENTRY_LIMIT = 150_000;

const S_IWGRP = 0o020;
const S_IWOTH = 0o002;
const CHUNK = 48;
const MAX_DEPTH = 256;

export class InstallNotPrivateError extends AdapterPinError {
  /** The file or folder that someone other than the user may be able to change. */
  readonly path: string;
  readonly problem: PrivateInstallProblem;

  constructor(finding: PrivateInstallFinding) {
    super("install_not_private", `engine files are not private to this user: ${finding.problem}`);
    this.name = "InstallNotPrivateError";
    this.path = finding.path;
    this.problem = finding.problem;
  }
}

/** The pure rule for one entry: the owner, then who can write to it. */
export function privateInstallProblemOfStats(stats: PrivateInstallStats, uid: number): PrivateInstallProblem | undefined {
  if (stats.uid !== uid && stats.uid !== 0) return "not_owned";
  if ((stats.mode & S_IWOTH) !== 0) return "world_writable";
  if ((stats.mode & S_IWGRP) !== 0) return "group_writable";
  return undefined;
}

/**
 * The first reason `subject` is not private to the user, or undefined. Reads metadata only; nothing is opened or run.
 * Checks the whole subject before returning, in the order given (files, then trees).
 */
export async function findPrivateInstallProblem(
  subject: PrivateInstallSubject,
  io: PrivateInstallIo = DEFAULT_PRIVATE_INSTALL_IO,
  entryLimit: number = PRIVATE_INSTALL_ENTRY_LIMIT,
): Promise<PrivateInstallFinding | undefined> {
  const state: ScanState = { io, entryLimit, entries: 0, verifiedDirectories: new Set(), scannedRoots: [] };
  for (const file of subject.files ?? []) {
    const finding = await scanRoot(file, state, false);
    if (finding !== undefined) return finding;
  }
  for (const tree of subject.trees ?? []) {
    const finding = await scanRoot(tree, state, true);
    if (finding !== undefined) return finding;
  }
  return undefined;
}

/** Throws `InstallNotPrivateError` naming the first path that someone other than the user may be able to change. */
export async function assertPrivateInstall(
  subject: PrivateInstallSubject,
  io: PrivateInstallIo = DEFAULT_PRIVATE_INSTALL_IO,
  entryLimit: number = PRIVATE_INSTALL_ENTRY_LIMIT,
): Promise<void> {
  const finding = await findPrivateInstallProblem(subject, io, entryLimit);
  if (finding !== undefined) throw new InstallNotPrivateError(finding);
}

type ScanState = {
  readonly io: PrivateInstallIo;
  readonly entryLimit: number;
  entries: number;
  /** Folders on a checked chain; each is judged once per call. */
  readonly verifiedDirectories: Set<string>;
  /** Real roots whose content is (or will be) walked, so a link into one is not walked twice. */
  readonly scannedRoots: string[];
};

async function scanRoot(
  path: string,
  state: ScanState,
  tree: boolean,
): Promise<PrivateInstallFinding | undefined> {
  const { io } = state;
  let real: string;
  try {
    real = await io.realpath(path);
  } catch {
    return { problem: "unreadable", path };
  }
  // Inside a tree that is already being walked: its entries and the chain above it are judged there.
  if (tree && state.scannedRoots.some((root) => real === root || real.startsWith(`${root}${sep}`))) return undefined;
  const chain = await checkChain(real, state);
  if (chain !== undefined) return chain;
  if (!tree) return undefined;
  state.scannedRoots.push(real);
  const pending: string[] = [real];
  const links: string[] = [];
  while (pending.length > 0) {
    const finding = await scanDirectory(pending.pop()!, state, pending, links);
    if (finding !== undefined) return finding;
  }
  // A link that leaves the tree leads to code the tree can load: it is part of the tree.
  for (const link of links) {
    let target: string;
    try {
      target = await io.realpath(link);
    } catch {
      // Dangling: nothing to load, and no one who could not write the tree could have made it.
      continue;
    }
    const finding = await scanRoot(target, state, true);
    if (finding !== undefined) return finding;
  }
  return undefined;
}

/** `real` and every folder above it: owned by the user or root, writable by neither group nor others. */
async function checkChain(real: string, state: ScanState): Promise<PrivateInstallFinding | undefined> {
  const { io } = state;
  let current = real;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const isRoot = current === real;
    if (!isRoot && state.verifiedDirectories.has(current)) return undefined;
    let stats: PrivateInstallStats;
    try {
      stats = await io.lstat(current);
    } catch {
      return { problem: "unreadable", path: current };
    }
    // The caller passes a real path, so a link on it means the tree changed under the caller.
    if (stats.isSymbolicLink) return { problem: "linked", path: current };
    const problem = privateInstallProblemOfStats(stats, io.uid);
    if (problem !== undefined) return { problem, path: current };
    if (!isRoot) state.verifiedDirectories.add(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return { problem: "unreadable", path: real };
}

async function scanDirectory(
  directory: string,
  state: ScanState,
  pending: string[],
  links: string[],
): Promise<PrivateInstallFinding | undefined> {
  const { io } = state;
  let names: readonly string[];
  try {
    names = [...(await io.readdir(directory))].sort();
  } catch {
    return { problem: "unreadable", path: directory };
  }
  state.entries += names.length;
  if (state.entries > state.entryLimit) return { problem: "too_many_entries", path: directory };
  for (let start = 0; start < names.length; start += CHUNK) {
    const chunk = names.slice(start, start + CHUNK).map((name) => join(directory, name));
    const stats = await Promise.all(chunk.map((child) => io.lstat(child).catch(() => undefined)));
    for (let index = 0; index < chunk.length; index += 1) {
      const child = chunk[index]!;
      const entry = stats[index];
      if (entry === undefined) return { problem: "unreadable", path: child };
      if (entry.isSymbolicLink) {
        links.push(child);
        continue;
      }
      const problem = privateInstallProblemOfStats(entry, io.uid);
      if (problem !== undefined) return { problem, path: child };
      if (entry.isDirectory) pending.push(child);
    }
  }
  return undefined;
}
