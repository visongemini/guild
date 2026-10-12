import type { GuildNewTaskWorkspaceMode } from "@guild/contracts";
import type { GuildMessages } from "./locales.js";

/**
 * What the composer says while no task is open. With a workspace on hand the only thing missing is a task, so it
 * says that; the workspace wording is for the one case where there is no workspace to start a task in.
 */
export function noTaskComposerPlaceholder(
  messages: Pick<GuildMessages, "createTaskFirst" | "selectWorkspaceFirst">,
  hasWorkspace: boolean,
): string {
  return hasWorkspace ? messages.createTaskFirst : messages.selectWorkspaceFirst;
}

/** Where "New task" starts a task when no workspace is named (D-064). */
export type NewTaskWorkspace =
  | { readonly kind: "workspace"; readonly workspaceId: string }
  /** Several workspaces and no remembered choice: the person is asked. */
  | { readonly kind: "ask" }
  /** No workspace at all: the person is asked for a project folder. */
  | { readonly kind: "none" };

/**
 * The workspace "New task" would use, from the setting and the workspaces that are not archived: the remembered
 * one under "use the last workspace" while it still exists, otherwise the only workspace, otherwise the choice
 * is open. The create action and the composer's workspace chip both read this, so the chip never names a
 * workspace the action would not use.
 */
export function newTaskWorkspace(
  mode: GuildNewTaskWorkspaceMode | undefined,
  lastWorkspaceId: string | undefined,
  activeWorkspaces: readonly { readonly workspaceId: string }[],
): NewTaskWorkspace {
  if (mode === "last" && lastWorkspaceId !== undefined && activeWorkspaces.some((workspace) => workspace.workspaceId === lastWorkspaceId)) {
    return { kind: "workspace", workspaceId: lastWorkspaceId };
  }
  if (activeWorkspaces.length > 1) return { kind: "ask" };
  const only = activeWorkspaces[0];
  return only === undefined ? { kind: "none" } : { kind: "workspace", workspaceId: only.workspaceId };
}

/** The workspace chip of the composer while no task is open: the workspace that is decided, else the open choice. */
export function noTaskWorkspaceChip(
  messages: Pick<GuildMessages, "chooseWorkspace">,
  decided: NewTaskWorkspace,
  activeWorkspaces: readonly { readonly workspaceId: string; readonly name: string }[],
): string {
  if (decided.kind !== "workspace") return messages.chooseWorkspace;
  return activeWorkspaces.find((workspace) => workspace.workspaceId === decided.workspaceId)?.name ?? messages.chooseWorkspace;
}
