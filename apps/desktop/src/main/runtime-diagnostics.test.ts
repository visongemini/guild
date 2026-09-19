import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RuntimeDiagnosticLog } from "./runtime-diagnostics.js";

describe("private runtime diagnostics", () => {
  it("serializes bounded structured evidence with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-runtime-log-"));
    try {
      const log = new RuntimeDiagnosticLog(join(root, "diagnostics"));
      await Promise.all([
        log.append({
          schemaVersion: 1,
          occurredAtIso: "2026-08-30T13:00:00.000Z",
          category: "transport",
          event: "interrupted",
          taskId: "task-1",
          incidentId: "incident-1",
          exitCode: 9,
          signal: null,
          reason: "prompt contents at /Users/example/private-project",
          faultCode: "missing_field",
          faultPath: "$.update.content",
          faultStage: "session_update",
          updateKind: "agent_message_chunk api_key=secret-update-kind",
          stderrTail: Object.freeze(["redacted diagnostic api_key=secret-value"]),
          stderrCapturedBytes: 19,
          stderrDroppedBytes: 0,
        }),
        log.append({
          schemaVersion: 1,
          occurredAtIso: "2026-08-30T13:00:01.000Z",
          category: "recovery",
          event: "restored",
          taskId: "task-1",
          sessionId: "/Users/example/private-session api_key=session-secret",
          auxiliarySessionId: "private auxiliary prompt",
        }),
        log.append({
          schemaVersion: 1,
          occurredAtIso: "2026-08-30T13:00:02.000Z",
          category: "runtime",
          event: "fault",
          reason: "rawprompt",
          faultCode: "secretvalue",
          faultPath: "$.sk_test_ABC123",
          faultStage: "privateproject",
          updateKind: "secretupdatekind",
        }),
      ]);
      await log.flush();
      const lines = (await readFile(log.path, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(lines.map((line) => line.event), ["interrupted", "restored", "fault"]);
      assert.equal(lines[0]?.exitCode, 9);
      assert.equal(lines[0]?.incidentId, "incident-1");
      assert.equal(lines[0]?.faultCode, "missing_field");
      assert.equal(lines[0]?.faultPath, "$.update.content");
      assert.equal(lines[0]?.faultStage, "session_update");
      assert.equal(lines[0]?.reason, "[REDACTED]");
      assert.equal(lines[0]?.updateKind, "[REDACTED]");
      assert.equal(lines[0]?.stderrTail[0], "[STDERR REDACTED]");
      assert.match(lines[1]?.sessionId, /^session:sha256:[a-f0-9]{24}$/u);
      assert.match(lines[1]?.auxiliarySessionId, /^auxiliary:sha256:[a-f0-9]{24}$/u);
      assert.deepEqual(
        [lines[2]?.reason, lines[2]?.faultCode, lines[2]?.faultPath,
          lines[2]?.faultStage, lines[2]?.updateKind],
        ["[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]"],
      );
      assert.doesNotMatch(
        await readFile(log.path, "utf8"),
        /secret-value|secret-update-kind|private-project|prompt contents|rawprompt|secretvalue|sk_test_ABC123|privateproject|secretupdatekind|private-session|session-secret|private auxiliary prompt/u,
      );
      assert.equal((await stat(log.path)).mode & 0o777, 0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rehydrates valid recent records while ignoring corrupt JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "guild-runtime-log-read-"));
    try {
      const log = new RuntimeDiagnosticLog(join(root, "diagnostics"));
      await log.append({
        schemaVersion: 1,
        occurredAtIso: "2026-08-30T13:00:00.000Z",
        category: "transport",
        event: "interrupted",
        taskId: "task-1",
        incidentId: "incident-1",
        reason: "process_fault",
      });
      await appendFile(log.path, "not-json\n{\"schemaVersion\":2}\n", "utf8");
      await log.append({
        schemaVersion: 1,
        occurredAtIso: "2026-08-30T13:00:01.000Z",
        category: "recovery",
        event: "restored",
        taskId: "task-1",
        incidentId: "incident-1",
      });
      assert.deepEqual(
        (await log.readRecent()).map((record) => record.event),
        ["interrupted", "restored"],
      );
      assert.deepEqual(
        (await log.readRecent(1)).map((record) => record.event),
        ["restored"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
