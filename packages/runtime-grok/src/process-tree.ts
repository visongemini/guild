import { execFile } from "node:child_process";

/*
 * PC-ENG-001: an engine process can start helpers of its own (Grok's MCP servers, Claude's plugins
 * and connectors). Some of them leave the engine's process group (setsid, or a group of their own),
 * so the group signal of the process host cannot reach them and they outlive a graceful quit.
 *
 * At stop time, while the engine is still alive, the host takes this snapshot of the engine's
 * descendants that sit outside its group; after the group is gone it ends exactly those processes.
 * Only descendants of the engine process Guild started are ever considered: the engine is identified
 * by its pid and start time, read right after it was spawned, and the snapshot is discarded unless the
 * very table it was read from shows the root with that same start time (an engine that exited and
 * whose pid was reused is not a root). A process is signalled only if its pid, group and start time
 * still match the snapshot (a reused pid is left alone).
 */

export type ProcessTableRow = Readonly<{
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps` start-time text; with the pid it identifies one process for its lifetime. */
  startedAt: string;
}>;

export type DescendantRecord = ProcessTableRow;

/** One process for its lifetime: its pid and `ps` start time. */
export type ProcessIdentity = Readonly<{
  pid: number;
  startedAt: string;
}>;

export type DescendantSnapshot = Readonly<{
  /**
   * False when the table did not show the root with the recorded start time (it is missing, or the pid
   * now belongs to another process) or could not be read: nothing is attributed to the engine then.
   */
  rootVerified: boolean;
  records: readonly DescendantRecord[];
}>;

const PS_PATH = "/bin/ps";
const PS_COLUMNS = "pid=,ppid=,pgid=,lstart=";
const PS_TIMEOUT_MS = 1_000;
const PS_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
/** More descendants than this is not an engine's helper set; nothing is signalled then. */
export const MAX_DESCENDANTS = 256;
const POLL_MS = 25;
const TERM_GRACE_MS = 1_000;
const KILL_GRACE_MS = 500;

export function parseProcessTable(text: string): readonly ProcessTableRow[] {
  const rows: ProcessTableRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const pgid = Number(match[3]);
    if (![pid, ppid, pgid].every((value) => Number.isSafeInteger(value))) continue;
    rows.push(Object.freeze({ pid, ppid, pgid, startedAt: match[4]! }));
  }
  return Object.freeze(rows);
}

const NO_RECORDS: readonly DescendantRecord[] = Object.freeze([]);
const UNVERIFIED_ROOT: DescendantSnapshot = Object.freeze({ rootVerified: false, records: NO_RECORDS });

function verified(records: readonly DescendantRecord[]): DescendantSnapshot {
  return Object.freeze({ rootVerified: true, records });
}

/**
 * The descendants of `root` (children, their children, ...) that are outside the engine's own process
 * group. Members of that group are the host's group signal's business. Unverified (and empty) when this
 * table does not contain the root with the recorded start time: the engine is already gone and its
 * helpers have been re-parented, or its pid was reused, so nothing can be attributed to it. Verified
 * but empty when the set is implausibly large.
 */
export function descendantsOutsideGroup(
  rows: readonly ProcessTableRow[],
  root: ProcessIdentity,
  rootGroupId: number,
): DescendantSnapshot {
  const rootPid = root.pid;
  const rootRow = rows.find((row) => row.pid === rootPid);
  if (!Number.isSafeInteger(rootPid) || rootPid <= 1 || rootRow === undefined || rootRow.startedAt !== root.startedAt) {
    return UNVERIFIED_ROOT;
  }
  const childrenOf = new Map<number, ProcessTableRow[]>();
  for (const row of rows) {
    const siblings = childrenOf.get(row.ppid);
    if (siblings === undefined) childrenOf.set(row.ppid, [row]);
    else siblings.push(row);
  }
  const found: ProcessTableRow[] = [];
  const seen = new Set<number>([rootPid]);
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const child of childrenOf.get(parent) ?? []) {
      if (seen.has(child.pid) || child.pid <= 1 || child.pid === process.pid) continue;
      seen.add(child.pid);
      queue.push(child.pid);
      if (child.pgid !== rootGroupId) found.push(child);
      if (seen.size > MAX_DESCENDANTS * 4) return verified(NO_RECORDS);
    }
  }
  return verified(found.length > MAX_DESCENDANTS ? NO_RECORDS : Object.freeze(found));
}

function readProcessTable(pids?: readonly number[]): Promise<readonly ProcessTableRow[] | undefined> {
  const args = pids === undefined ? ["-axo", PS_COLUMNS] : ["-p", pids.join(","), "-o", PS_COLUMNS];
  return new Promise((resolve) => {
    try {
      execFile(
        PS_PATH,
        args,
        { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES, windowsHide: true },
        (error, stdout) => {
          // `ps -p` exits 1 when none of the pids exists; its (empty) output is still the answer.
          if (error !== null && pids === undefined) resolve(undefined);
          else resolve(parseProcessTable(typeof stdout === "string" ? stdout : ""));
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * The identity of a process this one has just spawned. Undefined unless the row shows this process as
 * its parent, so the identity is of Guild's own child and never of a pid that was recycled meanwhile.
 */
export async function readChildIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  if (process.platform === "win32" || !Number.isSafeInteger(pid) || pid <= 1) return undefined;
  const rows = await readProcessTable([pid]);
  const row = rows?.find((entry) => entry.pid === pid && entry.ppid === process.pid);
  return row === undefined ? undefined : Object.freeze({ pid, startedAt: row.startedAt });
}

/**
 * Snapshot of the engine's descendants outside its group, read from one process table that must show
 * the engine with its recorded start time; unverified and empty when it does not or cannot be read.
 */
export async function snapshotDescendants(root: ProcessIdentity, rootGroupId: number): Promise<DescendantSnapshot> {
  if (process.platform === "win32") return UNVERIFIED_ROOT;
  const rows = await readProcessTable();
  return rows === undefined ? UNVERIFIED_ROOT : descendantsOutsideGroup(rows, root, rootGroupId);
}

/** The records whose process still exists with the same pid, group and start time. */
async function stillSame(records: readonly DescendantRecord[]): Promise<readonly DescendantRecord[]> {
  if (records.length === 0) return records;
  const rows = await readProcessTable(records.map((record) => record.pid));
  if (rows === undefined) return Object.freeze([]);
  const current = new Map(rows.map((row) => [row.pid, row]));
  return Object.freeze(records.filter((record) => {
    const row = current.get(record.pid);
    return row !== undefined && row.pgid === record.pgid && row.startedAt === record.startedAt;
  }));
}

function signalProcess(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal: nothing more to do for this pid.
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntilGone(records: readonly DescendantRecord[], milliseconds: number): Promise<readonly DescendantRecord[]> {
  const deadline = Date.now() + milliseconds;
  let remaining = records;
  while (remaining.length > 0) {
    remaining = await stillSame(remaining);
    if (remaining.length === 0 || Date.now() >= deadline) break;
    await pause(POLL_MS);
  }
  return remaining;
}

/**
 * Ends the snapshot's processes that are still alive and unchanged: TERM, a short grace, then KILL.
 * Bounded (about 1.5 s) and never throws. Returns how many had to be signalled.
 */
export async function terminateDescendants(records: readonly DescendantRecord[]): Promise<number> {
  try {
    const alive = await stillSame(records);
    if (alive.length === 0) return 0;
    for (const record of alive) signalProcess(record.pid, "SIGTERM");
    const stubborn = await waitUntilGone(alive, TERM_GRACE_MS);
    for (const record of stubborn) signalProcess(record.pid, "SIGKILL");
    await waitUntilGone(stubborn, KILL_GRACE_MS);
    return alive.length;
  } catch {
    return 0;
  }
}
