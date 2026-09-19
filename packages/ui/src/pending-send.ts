export type PendingSendState = Readonly<{
  taskId: string;
  text: string;
  submittedAtMs: number;
}>;

export function setPendingSendForTask(
  current: ReadonlyMap<string, PendingSendState>,
  pending: PendingSendState,
): ReadonlyMap<string, PendingSendState> {
  const next = new Map(current);
  next.set(pending.taskId, pending);
  return next;
}

export function claimSendInFlight(
  current: ReadonlySet<string>,
  taskId: string,
): ReadonlySet<string> | undefined {
  if (current.has(taskId)) return undefined;
  const next = new Set(current);
  next.add(taskId);
  return next;
}

export function releaseSendInFlight(
  current: ReadonlySet<string>,
  taskId: string,
): ReadonlySet<string> {
  if (!current.has(taskId)) return current;
  const next = new Set(current);
  next.delete(taskId);
  return next;
}

export function clearPendingSendForTask(
  current: ReadonlyMap<string, PendingSendState>,
  taskId: string,
  submittedAtMs: number,
): ReadonlyMap<string, PendingSendState> {
  if (current.get(taskId)?.submittedAtMs !== submittedAtMs) return current;
  const next = new Map(current);
  next.delete(taskId);
  return next;
}
