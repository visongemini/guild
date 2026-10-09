/**
 * Structural sharing for pushed projections. Every projection arrives as a fresh object
 * graph; returning the previous object wherever the content is equal lets React.memo and
 * useMemo recognise unchanged rows, tasks and workspaces by identity.
 */

export function replaceEqualDeep<T>(previous: unknown, next: T): T {
  if (previous === next) return previous as T;
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next;
    let equal = previous.length === next.length;
    const merged: unknown[] = new Array(next.length);
    for (let index = 0; index < next.length; index += 1) {
      const item = replaceEqualDeep(previous[index], next[index]);
      merged[index] = item;
      if (item !== previous[index]) equal = false;
    }
    return (equal ? previous : merged) as T;
  }
  if (isPlainRecord(next)) {
    if (!isPlainRecord(previous)) return next;
    const nextKeys = Object.keys(next);
    let equal = nextKeys.length === Object.keys(previous).length;
    const merged: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const item = replaceEqualDeep(previous[key], next[key]);
      merged[key] = item;
      if (item !== previous[key] || !Object.hasOwn(previous, key)) equal = false;
    }
    return (equal ? previous : merged) as T;
  }
  return next;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
