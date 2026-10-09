import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parseTaskId, parseWindowId, type Result } from "@guild/contracts";
import { openGuildPersistence } from "./index.js";

function must<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

function temporaryDatabase(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "guild-entry-stamps-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  return join(directory, "guild.sqlite3");
}

const taskId = must(parseTaskId("task-stamps"));
const windowId = must(parseWindowId("window-stamps"));

function seededStore(path: string) {
  const store = openGuildPersistence({ path });
  store.createWorkspace({
    workspaceId: "workspace-stamps",
    canonicalPath: "/tmp/guild-workspace-stamps",
    displayName: "Stamps",
  });
  store.createConversationTask({
    taskId,
    workspaceId: "workspace-stamps",
    title: "Stamps",
    owningWindowId: windowId,
  });
  return store;
}

describe("conversation entry stamps", () => {
  it("mirror the decoded recent window and change exactly when a row is written", (t) => {
    const store = seededStore(temporaryDatabase(t));
    for (let index = 0; index < 7; index += 1) {
      store.createConversationEntry({
        taskId,
        entryId: `entry-${index}`,
        kind: index % 2 === 0 ? "user" : "assistant",
        text: `text ${index}`,
        metadata: { index, nested: { value: "x".repeat(32) } },
        status: "complete",
      });
    }
    const streaming = store.createConversationEntry({
      taskId,
      entryId: "entry-stream",
      kind: "assistant",
      text: "a",
      status: "streaming",
    }).record;

    const decoded = store.listRecentConversationEntries({ taskId, limit: 5 });
    const stamps = store.listRecentConversationEntryStamps({ taskId, limit: 5 });
    assert.deepEqual(
      stamps,
      decoded.map(({ entryId, sequence, revision }) => ({ entryId, sequence, revision })),
    );
    assert.equal(stamps.length, 5);
    assert.deepEqual(stamps.map((stamp) => stamp.sequence), [4, 5, 6, 7, 8]);
    assert.equal(Object.isFrozen(stamps), true);

    const appended = store.appendConversationEntryText({
      taskId,
      entryId: streaming.entryId,
      expectedRevision: streaming.revision,
      text: "bc",
    });
    const afterAppend = store.listRecentConversationEntryStamps({ taskId, limit: 5 });
    assert.equal(afterAppend.at(-1)?.revision, appended.revision);
    assert.notEqual(afterAppend.at(-1)?.revision, stamps.at(-1)?.revision);
    assert.deepEqual(afterAppend.slice(0, -1), stamps.slice(0, -1), "untouched rows keep their stamp");

    const finalized = store.finalizeConversationEntry({
      taskId,
      entryId: streaming.entryId,
      expectedRevision: appended.revision,
      status: "complete",
    });
    assert.equal(store.listRecentConversationEntryStamps({ taskId, limit: 5 }).at(-1)?.revision, finalized.revision);
    assert.ok(finalized.revision > appended.revision);
    store.close();
  });

  it("applies the same bounds as the decoded listing and rejects unknown tasks", (t) => {
    const store = seededStore(temporaryDatabase(t));
    assert.deepEqual(store.listRecentConversationEntryStamps({ taskId }), []);
    assert.throws(() => store.listRecentConversationEntryStamps({ taskId, limit: 0 }));
    assert.throws(() => store.listRecentConversationEntryStamps({ taskId, limit: 501 }));
    assert.throws(() => store.listRecentConversationEntryStamps({ taskId, limit: 1.5 }));
    assert.throws(() => store.listRecentConversationEntryStamps({
      taskId: must(parseTaskId("task-missing")),
    }));
    store.close();
    assert.throws(() => store.listRecentConversationEntryStamps({ taskId }));
  });
});
