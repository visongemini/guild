import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationEntryRecord } from "@guild/persistence";
import {
  allConversationEntries,
  buildTaskWorkbench,
  conversationSnippet,
  conversationMatches,
  exportConversation,
  latestToolEntries,
  workspaceResource,
} from "./task-artifacts.js";

function entry(
  sequence: number,
  kind: ConversationEntryRecord["kind"],
  text: string,
  metadata: ConversationEntryRecord["metadata"] = Object.freeze({}),
): ConversationEntryRecord {
  return Object.freeze({
    taskId: "task-artifact" as ConversationEntryRecord["taskId"],
    entryId: `entry-${sequence}`,
    sequence,
    kind,
    runId: undefined,
    text,
    metadata,
    status: "complete",
    revision: 1,
    createdAtMs: 1_700_000_000_000 + sequence,
    updatedAtMs: 1_700_000_000_000 + sequence,
  });
}

describe("task-owned artifacts", () => {
  it("loads every bounded conversation page without skipping the 500-entry boundary", () => {
    const records = Array.from({ length: 502 }, (_, index) => entry(index + 1, "assistant", `row ${index + 1}`));
    const loaded = allConversationEntries((afterSequence, limit) =>
      records.filter((record) => record.sequence > afterSequence).slice(0, limit));
    assert.equal(loaded.length, 502);
    assert.equal(loaded[0]?.sequence, 1);
    assert.equal(loaded.at(-1)?.sequence, 502);
  });

  it("keeps files and diffs inside the workspace and records observed terminal use", () => {
    const workbench = buildTaskWorkbench("/tmp/guild-workspace", [entry(1, "tool", "Edit", {
      locations: [{ path: "/tmp/guild-workspace/src/app.ts", line: 14 }],
      content: [
        { type: "terminal", terminalId: "terminal-1" },
        { type: "diff", path: "/tmp/guild-workspace/src/app.ts", oldText: "old", newText: "new" },
        { type: "diff", path: "/tmp/outside.ts", newText: "blocked" },
      ],
    })]);
    assert.deepEqual(workbench.files, [{
      path: "/tmp/guild-workspace/src/app.ts",
      displayPath: "src/app.ts",
      line: 14,
    }]);
    assert.deepEqual(workbench.diffs, [{
      path: "/tmp/guild-workspace/src/app.ts",
      displayPath: "src/app.ts",
      oldText: "old",
      newText: "new",
    }]);
    assert.equal(workbench.terminalObserved, true);
    assert.equal(workspaceResource("/tmp/guild-workspace", "../outside.ts"), undefined);
    assert.equal(workspaceResource("/tmp/guild-workspace", "/tmp/outside.ts"), undefined);
  });

  it("exports only visible conversation material and finds local transcript snippets", () => {
    const entries = [
      entry(1, "user", "请检查 BananaFit 的保存逻辑"),
      entry(2, "thought", "hidden chain", { hidden: true }),
      entry(3, "assistant", "BananaFit saves locally."),
      entry(4, "permission", "secret permission"),
    ];
    const markdown = exportConversation("markdown", {
      title: "BananaFit review",
      workspaceName: "Cowork",
      createdAtMs: 1_700_000_000_000,
      entries,
    });
    assert.match(markdown, /# BananaFit review/u);
    assert.match(markdown, /BananaFit saves locally\./u);
    assert.doesNotMatch(markdown, /hidden chain|secret permission/u);
    assert.match(conversationSnippet(entries, "bananafit", "en-US") ?? "", /BananaFit/u);

    const json = JSON.parse(exportConversation("json", {
      title: "BananaFit review",
      workspaceName: "Cowork",
      createdAtMs: 1_700_000_000_000,
      entries,
    })) as { entries: readonly unknown[] };
    assert.equal(json.entries.length, 2);
  });

  it("exports only the latest projection for each logical tool call", () => {
    const entries = [
      entry(1, "tool", "Read pending", { toolCallId: "read-1", toolStatus: "in_progress" }),
      entry(2, "assistant", "Between tools"),
      entry(3, "tool", "Read complete", { toolCallId: "read-1", toolStatus: "completed" }),
    ];
    assert.deepEqual(latestToolEntries(entries).map((item) => item.sequence), [2, 3]);
    const markdown = exportConversation("markdown", {
      title: "Tool projection",
      workspaceName: "Cowork",
      createdAtMs: 1_700_000_000_000,
      entries,
    });
    assert.doesNotMatch(markdown, /Read pending/u);
    assert.match(markdown, /Read complete/u);
  });
});

it("message search returns each visible persisted anchor and skips hidden activity", () => {
  const matches = conversationMatches([
    entry(1, "user", "Needle first"), entry(2, "thought", "needle"), entry(3, "assistant", "needle second"),
    entry(4, "assistant", "needle hidden", { hidden: true }), entry(5, "tool", "needle"),
  ], "needle", "en-US");
  assert.deepEqual(matches.map((match) => match.sequence), [1, 3]);
  assert.deepEqual(conversationMatches([entry(1, "user", "a")], " ", "en-US"), []);
});
