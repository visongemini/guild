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
