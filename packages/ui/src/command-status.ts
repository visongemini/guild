import type { AcpToolKind, GuildTaskActivity, RunState, TimelineItemProjection } from "@guild/contracts";

export type SlashCommandStatus = {
  readonly commandName: string;
  readonly runState: RunState;
  readonly hasRuntimeActivity: boolean;
  readonly latestToolTitle?: string;
  readonly latestToolKind?: AcpToolKind;
  readonly liveActivity?: GuildTaskActivity;
  readonly liveToolKinds?: readonly AcpToolKind[];
  readonly workerCount?: number;
};

const SLASH_COMMAND = /^\/([\p{L}\p{N}_-]+)(?:\s|$)/u;

/**
 * PC-CONV-001 / D-022: a slash command with no authored response still gets a
 * truthful UI lifecycle derived from the persisted user entry and Run state.
 */
export function slashCommandStatus(
  items: readonly TimelineItemProjection[],
  runState: RunState | undefined,
  auxiliary?: Readonly<{
    activity: GuildTaskActivity;
    workerCount: number;
    toolKinds: readonly AcpToolKind[];
  }>,
): SlashCommandStatus | undefined {
  if (runState === undefined) return undefined;
  const commandCandidate = [...items].reverse().find(
    (item) => item.kind === "user" && SLASH_COMMAND.test(item.text.trim()),
  );
  if (commandCandidate === undefined || commandCandidate.kind !== "user") return undefined;
  const command = commandCandidate;

  const laterItems = items.filter((item) => item.sequence > command.sequence);
  if (laterItems.some((item) => item.kind === "user")) return undefined;
  const hasAuthoredResponse = laterItems.some((item) =>
    item.kind === "assistant" ||
    item.kind === "notice" ||
    item.kind === "error" ||
    item.kind === "media",
  );
  if (hasAuthoredResponse && isTerminal(runState)) return undefined;

  const match = SLASH_COMMAND.exec(command.text.trim());
  if (match?.[1] === undefined) return undefined;
  const tools = laterItems.filter(
    (item): item is Extract<TimelineItemProjection, { readonly kind: "tool" }> =>
      item.kind === "tool",
  );
  const latestTool = [...tools].reverse().find((item) => item.runtimeReplayKind !== "plan")
    ?? tools.at(-1);
  return Object.freeze({
    commandName: match[1],
    runState,
    hasRuntimeActivity:
      laterItems.some((item) => item.kind === "thought" || item.kind === "tool") ||
      auxiliary !== undefined,
    ...(auxiliary === undefined
      ? {}
      : {
          liveActivity: auxiliary.activity,
          liveToolKinds: auxiliary.toolKinds,
          workerCount: auxiliary.workerCount,
        }),
    ...(latestTool === undefined
      ? {}
      : { latestToolTitle: latestTool.title, latestToolKind: latestTool.toolKind }),
  });
}

function isTerminal(state: RunState): boolean {
  return state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "interrupted";
}
