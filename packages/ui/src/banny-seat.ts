import type { TaskId, WorkspaceProjection } from "@guild/contracts";

export const BANNY_DRAG_MIME = "application/x-guild-banny";
export const BANNY_PLACEMENT_STORAGE_KEY = "guild:banny-placement-v1";
export const BANNY_SEAT_STORAGE_KEY = "guild:banny-seat-task-id";

export type BannyPlacement =
  | { readonly kind: "home" }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "free"; readonly x: number; readonly y: number };

type BannyPlacementStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type RectLike = Readonly<{
  left: number;
  top: number;
  width: number;
  height: number;
}>;

const HOME_PLACEMENT = Object.freeze({ kind: "home" }) as BannyPlacement;

export function readBannyPlacement(storage: BannyPlacementStorage): BannyPlacement {
  try {
    const parsed = parsePlacement(storage.getItem(BANNY_PLACEMENT_STORAGE_KEY));
    if (parsed !== undefined) return parsed;
    const legacyTaskId = storage.getItem(BANNY_SEAT_STORAGE_KEY);
    return legacyTaskId === null
      ? HOME_PLACEMENT
      : Object.freeze({ kind: "task", taskId: legacyTaskId });
  } catch {
    return HOME_PLACEMENT;
  }
}

export function writeBannyPlacement(
  storage: BannyPlacementStorage,
  placement: BannyPlacement,
): void {
  try {
    storage.setItem(BANNY_PLACEMENT_STORAGE_KEY, JSON.stringify(placement));
    storage.removeItem(BANNY_SEAT_STORAGE_KEY);
  } catch {
    // This is a decorative preference. Storage failure must not affect task use.
  }
}

export function resolveBannySeatTaskId(
  workspaces: readonly WorkspaceProjection[],
  placement: BannyPlacement,
): TaskId | undefined {
  if (placement.kind !== "task") return undefined;
  for (const workspace of workspaces) {
    if (workspace.archived) continue;
    const task = workspace.tasks.find((item) => !item.archived && item.taskId === placement.taskId);
    if (task !== undefined) return task.taskId;
  }
  return undefined;
}

export function bannyPlacementFromDrop(
  shell: RectLike,
  homeRegion: RectLike,
  clientX: number,
  clientY: number,
): BannyPlacement {
  if (![shell.left, shell.top, shell.width, shell.height, homeRegion.left, homeRegion.top,
    homeRegion.width, homeRegion.height, clientX, clientY].every(Number.isFinite) ||
    shell.width <= 0 || shell.height <= 0 || homeRegion.width <= 0 || homeRegion.height <= 0) {
    return HOME_PLACEMENT;
  }

  const homeX = homeRegion.left + homeRegion.width / 2;
  const homeY = homeRegion.top + homeRegion.height / 2;
  const snapHalfWidth = Math.min(150, Math.max(72, homeRegion.width * 0.16));
  const snapHalfHeight = Math.min(110, Math.max(64, homeRegion.height * 0.14));
  if (Math.abs(clientX - homeX) <= snapHalfWidth && Math.abs(clientY - homeY) <= snapHalfHeight) {
    return HOME_PLACEMENT;
  }

  return Object.freeze({
    kind: "free",
    x: clamp((clientX - shell.left) / shell.width, 0.04, 0.96),
    y: clamp((clientY - shell.top) / shell.height, 0.05, 0.95),
  });
}

function parsePlacement(value: string | null): BannyPlacement | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record["kind"] === "home") return HOME_PLACEMENT;
    if (record["kind"] === "task" && typeof record["taskId"] === "string" && record["taskId"].length > 0) {
      return Object.freeze({ kind: "task", taskId: record["taskId"] });
    }
    if (record["kind"] === "free" && typeof record["x"] === "number" && Number.isFinite(record["x"]) &&
      typeof record["y"] === "number" && Number.isFinite(record["y"])) {
      return Object.freeze({
        kind: "free",
        x: clamp(record["x"], 0.04, 0.96),
        y: clamp(record["y"], 0.05, 0.95),
      });
    }
  } catch {
    // Ignore malformed decorative state and fall back to the legacy seat or home.
  }
  return undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
