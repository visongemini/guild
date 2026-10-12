/** Storage keys of the removed draggable Banny placement. Nothing reads them any more. */
export const LEGACY_BANNY_STORAGE_KEYS: readonly string[] = Object.freeze([
  "guild:banny-placement-v1",
  "guild:banny-seat-task-id",
]);

/** Drops the stale saved placement. Storage failure is harmless: the values are ignored anyway. */
export function removeLegacyBannyPlacement(storage: Pick<Storage, "removeItem">): void {
  try {
    for (const key of LEGACY_BANNY_STORAGE_KEYS) storage.removeItem(key);
  } catch {
    // Decorative leftovers only.
  }
}
