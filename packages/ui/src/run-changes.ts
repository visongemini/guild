import type {
  GuildCheckpointUnavailableReason,
  RewindAvailabilityProjection,
  RunCheckpointProjection,
  RunFileChangeStatus,
  RunId,
  TimelineItemProjection,
} from "@guild/contracts";

/*
 * Pure view logic of the per-run changed-files card (F2). The card is derived only from the
 * checkpoint projection the main process owns; nothing here reads git or the file system.
 */

export type RunFileView = Readonly<{
  path: string;
  /** Directory part including the trailing slash, dimmed in the row; empty for a top-level file. */
  dir: string;
  base: string;
  status: RunFileChangeStatus;
  oldPath: string | undefined;
  /** `null` counts mean a binary file. */
  binary: boolean;
  adds: number;
  dels: number;
}>;

export type RunCardView =
  | Readonly<{ kind: "capturing" }>
  | Readonly<{ kind: "unavailable"; reason: GuildCheckpointUnavailableReason | undefined }>
  | Readonly<{
      kind: "files";
      runId: RunId;
      rolledBack: boolean;
      filesChanged: number;
      adds: number;
      dels: number;
      files: readonly RunFileView[];
      /** The projection capped the list; `filesChanged` still counts every file. */
      filesTruncated: boolean;
    }>;

export function splitPath(path: string): Readonly<{ dir: string; base: string }> {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? Object.freeze({ dir: "", base: path })
    : Object.freeze({ dir: path.slice(0, slash + 1), base: path.slice(slash + 1) });
}

/**
 * What a run's card shows, or undefined when it shows nothing. A run that is still live shows no card
 * at all (the numbers are not final and the answer is still streaming), a run without file changes
 * shows nothing, and a failed capture shows one faint line saying why.
 */
export function runCardView(checkpoint: RunCheckpointProjection, runIsLive: boolean): RunCardView | undefined {
  if (runIsLive) return undefined;
  if (checkpoint.status === "capturing") return Object.freeze({ kind: "capturing" });
  if (checkpoint.status === "unavailable") {
    return Object.freeze({ kind: "unavailable", reason: checkpoint.detail });
  }
  if (checkpoint.filesChanged <= 0) return undefined;
  return Object.freeze({
    kind: "files",
    runId: checkpoint.runId,
    rolledBack: checkpoint.rolledBack || checkpoint.status === "rolled_back",
    filesChanged: checkpoint.filesChanged,
    adds: checkpoint.adds,
    dels: checkpoint.dels,
    files: Object.freeze(checkpoint.files.map((file): RunFileView => {
      const { dir, base } = splitPath(file.path);
      return Object.freeze({
        path: file.path,
        dir,
        base,
        status: file.status,
        oldPath: file.oldPath,
        binary: file.adds === null || file.dels === null,
        adds: file.adds ?? 0,
        dels: file.dels ?? 0,
      });
    })),
    filesTruncated: checkpoint.filesTruncated || checkpoint.files.length < checkpoint.filesChanged,
  });
}

/**
 * The run the topbar summary points at: the newest finished run that changed files and was not
 * rewound. Highest ordinal wins.
 */
export function latestChangedRun(
  checkpoints: readonly RunCheckpointProjection[] | undefined,
): RunCheckpointProjection | undefined {
  let latest: RunCheckpointProjection | undefined;
  for (const checkpoint of checkpoints ?? []) {
    if (checkpoint.status !== "captured" || checkpoint.rolledBack || checkpoint.filesChanged <= 0) continue;
    if (latest === undefined || checkpoint.ordinal > latest.ordinal) latest = checkpoint;
  }
  return latest;
}

/**
 * Which timeline entry each run's card hangs under: the last answer of the run, or, for a run that
 * produced no answer, its last activity entry. Entries are matched by id so a row can find its card.
 */
export function cardAnchors(
  items: readonly TimelineItemProjection[],
  checkpoints: readonly RunCheckpointProjection[] | undefined,
): ReadonlyMap<string, RunCheckpointProjection> {
  const anchors = new Map<string, RunCheckpointProjection>();
  if (checkpoints === undefined || checkpoints.length === 0) return anchors;
  const byRun = new Map(checkpoints.map((checkpoint) => [checkpoint.runId as string, checkpoint]));
  const lastAnswer = new Map<string, string>();
  const lastActivity = new Map<string, string>();
  for (const item of items) {
    if (item.runId === undefined || !byRun.has(item.runId)) continue;
    if (item.kind === "assistant") lastAnswer.set(item.runId, item.entryId);
    else if (item.kind === "tool" || item.kind === "thought") lastActivity.set(item.runId, item.entryId);
  }
  for (const [runId, checkpoint] of byRun) {
    const entryId = lastAnswer.get(runId) ?? lastActivity.get(runId);
    if (entryId !== undefined) anchors.set(entryId, checkpoint);
  }
  return anchors;
}

/**
 * Whether the "latest result" strip under the conversation would only repeat a card that is already on
 * screen. A completed run whose changed-files card is shown says the same thing (how many files, one way
 * to look at the diff), so the strip is left out; a run without that card (nothing tracked, a failed
 * capture, no file changes) and a run that did not complete keep it, because it is then the only place
 * that says how the turn ended.
 */
export function resultSummaryRepeatsChangeCard(
  recentResult: Readonly<{ runId: RunId; state: string }> | undefined,
  items: readonly TimelineItemProjection[],
  checkpoints: readonly RunCheckpointProjection[] | undefined,
): boolean {
  if (recentResult === undefined || recentResult.state !== "completed") return false;
  for (const checkpoint of cardAnchors(items, checkpoints).values()) {
    if (checkpoint.runId === recentResult.runId) return runCardView(checkpoint, false)?.kind === "files";
  }
  return false;
}

export function rewindDisabledReason(
  rewind: RewindAvailabilityProjection | undefined,
): Extract<RewindAvailabilityProjection, { readonly available: false }>["reason"] | undefined {
  if (rewind === undefined) return "runtime_unavailable";
  return rewind.available ? undefined : rewind.reason;
}

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";
export type DiffLineView = Readonly<{ kind: DiffLineKind; text: string }>;

const HIDDEN_HEADER = /^(?:diff --git |index |--- |\+\+\+ )/u;

/**
 * Lines of a git unified diff, classified for coloring. The path headers repeat what the card
 * already says, so they are dropped; mode, rename and similarity lines stay as quiet meta lines.
 * After the first hunk header every line is content, even one that starts with `---`.
 */
export function parseUnifiedDiff(diff: string): readonly DiffLineView[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const views: DiffLineView[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      views.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      if (!HIDDEN_HEADER.test(line)) views.push({ kind: "meta", text: line });
    } else if (line.startsWith("+")) {
      views.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      views.push({ kind: "del", text: line });
    } else if (line.startsWith("\\")) {
      views.push({ kind: "meta", text: line });
    } else {
      views.push({ kind: "ctx", text: line });
    }
  }
  return Object.freeze(views.map((view) => Object.freeze(view)));
}
