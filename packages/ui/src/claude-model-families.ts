/*
 * The Claude group of the model picker (PC-MODEL-001). The adapter lists every model Claude Code knows, a dozen
 * rows with English descriptions. The picker shows the Default row and the newest model of each family, puts the
 * rest under "Older models", and describes a family in Chinese instead of repeating the adapter's text. All of
 * it reads the names and ids the adapter reported; nothing here decides which models exist, and a family or a
 * name this module does not recognize is simply shown as the adapter gave it. It names families, never a model id.
 */

/** The adapter's own alias for "whatever Claude Code picks": the Default row of the Claude group. */
export const CLAUDE_DEFAULT_ROW_ID = "default";

const KNOWN_FAMILY = /^(?:opus|sonnet|haiku|fable)$/u;
/** "Opus 5.5", "Haiku 4.5 (1M context)": a family name, then a version. */
const NAME_WITH_VERSION = /^\s*([A-Za-z][A-Za-z-]*)\s+v?(\d+(?:\.\d+)*)(?![\d.])/u;
const NAME_ONLY = /^\s*([A-Za-z][A-Za-z-]*)\s*$/u;
/** An id such as claude-<family>-5-5, claude-<family>-5-1[1m] or claude-<family>-4-5-<date>: family, major, then an optional minor. */
const ID_WITH_VERSION = /(?:^|-)([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|[-[])/u;
/** What a model name looks like as a plain description: capitalized words, a version, maybe a short note. */
const MODEL_NAME_TEXT = /^[A-Z][A-Za-z-]*(?: [A-Z][A-Za-z-]*){0,2} \d+(?:\.\d+)*(?: \([^()]{1,32}\))?$/u;

export type ClaudeModelIdentity = Readonly<{
  /** Lower-case family when it is one of the known ones; undefined for anything else (always shown). */
  family: string | undefined;
  /** Undefined when the name and id carry no version. */
  version: readonly number[] | undefined;
}>;

function numbers(text: string): number[] {
  return text.split(".").map(Number);
}

export function claudeModelIdentity(model: Readonly<{ id: string; name: string }>): ClaudeModelIdentity {
  const named = NAME_WITH_VERSION.exec(model.name);
  if (named !== null) {
    const family = named[1]!.toLowerCase();
    return Object.freeze({
      family: KNOWN_FAMILY.test(family) ? family : undefined,
      version: Object.freeze(numbers(named[2]!)),
    });
  }
  const bare = NAME_ONLY.exec(model.name);
  const fromId = ID_WITH_VERSION.exec(model.id.toLowerCase());
  const family = (bare?.[1] ?? fromId?.[1])?.toLowerCase();
  if (family === undefined || !KNOWN_FAMILY.test(family)) return Object.freeze({ family: undefined, version: undefined });
  const version = fromId !== null && fromId[1] === family
    ? Object.freeze(fromId[3] === undefined ? [Number(fromId[2])] : [Number(fromId[2]), Number(fromId[3])])
    : undefined;
  return Object.freeze({ family, version });
}

/** Negative when `a` is the older version; a missing version is older than any version, and a missing part counts as 0. */
export function compareVersions(a: readonly number[] | undefined, b: readonly number[] | undefined): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Splits the rows of the Claude group into the ones always shown and the older ones. Shown: rows `keep` names (the
 * Default row), rows of an unknown family, and for each known family the rows of its newest version (a tie keeps
 * every row, so a variant of the newest model is not hidden). Order is the adapter's, in both lists.
 */
export function splitOlderClaudeModels<T extends Readonly<{ id: string; name: string }>>(
  rows: readonly T[],
  keep: (row: T) => boolean,
): Readonly<{ shown: readonly T[]; older: readonly T[] }> {
  const identities = rows.map((row) => claudeModelIdentity(row));
  const newest = new Map<string, readonly number[] | undefined>();
  rows.forEach((row, index) => {
    const { family, version } = identities[index]!;
    if (family === undefined || keep(row)) return;
    if (!newest.has(family) || compareVersions(version, newest.get(family)) > 0) newest.set(family, version);
  });
  const shown: T[] = [];
  const older: T[] = [];
  rows.forEach((row, index) => {
    const { family, version } = identities[index]!;
    const current = family === undefined || keep(row) || compareVersions(version, newest.get(family)) === 0;
    (current ? shown : older).push(row);
  });
  return Object.freeze({ shown: Object.freeze(shown), older: Object.freeze(older) });
}

/** The adapter's description of the Default row when it reads like a model name ("Opus 5.5"), else undefined. */
export function modelNameFromDescription(description: string | undefined): string | undefined {
  const text = description?.trim();
  return text !== undefined && text.length <= 48 && MODEL_NAME_TEXT.test(text) ? text : undefined;
}

const ZH_FAMILY_DESCRIPTION: Readonly<Record<string, string>> = Object.freeze({
  opus: "复杂任务和日常主力",
  sonnet: "速度和能力平衡",
  haiku: "最快，适合简单快速的任务",
  fable: "最难、最长的任务",
});

/** The Chinese description of a family; any other family keeps the adapter's own text. */
export function zhClaudeFamilyDescription(
  family: string | undefined,
  officialDescription: string | undefined,
): string | undefined {
  return family !== undefined && Object.hasOwn(ZH_FAMILY_DESCRIPTION, family)
    ? ZH_FAMILY_DESCRIPTION[family]
    : officialDescription;
}
