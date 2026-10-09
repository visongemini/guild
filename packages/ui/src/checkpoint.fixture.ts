import type {
  RewindPlanProjection,
  RunCheckpointProjection,
  RunFileChangeProjection,
  RunId,
  TimelineItemProjection,
} from "@guild/contracts";

/** Test builders for the F2/F4 projections. Not production code; never imported by the app. */

export const runId = (value: string) => value as RunId;

export function file(path: string, status: RunFileChangeProjection["status"], adds: number | null, dels: number | null, oldPath?: string): RunFileChangeProjection {
  return { path, status, adds, dels, ...(oldPath === undefined ? {} : { oldPath }) };
}

export function checkpoint(patch: Partial<RunCheckpointProjection> & Pick<RunCheckpointProjection, "runId">): RunCheckpointProjection {
  const files = patch.files ?? [
    file("Assets/Scripts/World/StylizedWorldMeshFactory.cs", "M", 96, 41),
    file("Assets/Scripts/World/IslandLagoon.cs", "M", 31, 17),
    file("Tests/EditMode/CoastlineRingTests.cs", "A", 15, 0),
  ];
  return {
    ordinal: 1,
    status: "captured",
    rolledBack: false,
    filesChanged: files.length,
    adds: files.reduce((total, entry) => total + (entry.adds ?? 0), 0),
    dels: files.reduce((total, entry) => total + (entry.dels ?? 0), 0),
    files,
    filesTruncated: false,
    ...patch,
  };
}

export function entry(kind: TimelineItemProjection["kind"], id: string, patch: Record<string, unknown> = {}): TimelineItemProjection {
  const base = {
    entryId: id, taskId: "t", runId: "r1", sequence: 1, createdAtMs: 1_000, updatedAtMs: 2_000, status: "completed",
  };
  const body = kind === "user" || kind === "assistant" || kind === "notice" || kind === "error"
    ? { text: `${kind} ${id}` }
    : kind === "tool"
      ? { title: id, toolKind: "read", toolStatus: "completed", content: [], locations: [] }
      : kind === "thought"
        ? { text: "thinking", startedAtMs: 1_000, elapsedMs: 1_000 }
        : {};
  return { ...base, kind, ...body, ...patch } as unknown as TimelineItemProjection;
}

export function gitPlan(patch: Partial<Extract<RewindPlanProjection["files"], { kind: "git" }>> = {}, rest: Partial<RewindPlanProjection> = {}): RewindPlanProjection {
  return {
    runId: runId("r1"),
    scope: "conversation_and_files",
    conversation: { available: true, mode: "conversation_only", targetPromptIndex: 2, promptText: "make the coastline round" },
    rolledBackRuns: [runId("r1")],
    files: {
      kind: "git",
      restore: ["Assets/Scripts/World/IslandLagoon.cs", "Assets/Scripts/World/StylizedWorldMeshFactory.cs"],
      remove: ["Tests/EditMode/CoastlineRingTests.cs"],
      conflicts: [],
      truncated: false,
      ...patch,
    },
    cannotUndo: [
      { kind: "network_and_mcp_effects", text: "net" },
      { kind: "git_commits_and_pushes", text: "git" },
      { kind: "memory_writes", text: "mem" },
    ],
    ...rest,
  };
}
