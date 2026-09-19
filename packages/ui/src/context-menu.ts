import type { TaskSummaryProjection, WorkspaceProjection } from "@guild/contracts";

export type ContextMenuSeed =
  | { readonly type: "workspace"; readonly workspace: WorkspaceProjection }
  | { readonly type: "task"; readonly task: TaskSummaryProjection };

/** Resolve a menu snapshot against the complete, current projection before acting on it. */
export function resolveContextMenuSeed(
  workspaces: readonly WorkspaceProjection[],
  seed: ContextMenuSeed,
): ContextMenuSeed {
  if (seed.type === "workspace") {
    const workspace = workspaces.find(
      (candidate) => candidate.workspaceId === seed.workspace.workspaceId,
    );
    return workspace === undefined ? seed : Object.freeze({ type: "workspace", workspace });
  }
  const task = workspaces
    .flatMap((workspace) => workspace.tasks)
    .find((candidate) => candidate.taskId === seed.task.taskId);
  return task === undefined ? seed : Object.freeze({ type: "task", task });
}
