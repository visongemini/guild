import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { RouterDiagnosticLog } from "./router-diagnostic-log.js";

function temporaryLog(t: TestContext): RouterDiagnosticLog {
  const dir = mkdtempSync(join(tmpdir(), "guild-router-log-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return new RouterDiagnosticLog(join(dir, "diagnostics"));
}

function lines(log: RouterDiagnosticLog): { event: string; fields: Record<string, unknown> }[] {
  return readFileSync(log.path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
}

describe("router diagnostic log [PC-ROUTE-002]", () => {
  it("writes one private JSON line per event with model, source and status fields", async (t) => {
    const log = temporaryLog(t);
    await log.append("router.request", { route: "messages", model: "deepseek-v4-flash", source: "deepseek", status: 200, authReplaced: true });
    const [entry] = lines(log);
    assert.equal(entry?.event, "router.request");
    assert.deepEqual(entry?.fields, { route: "messages", model: "deepseek-v4-flash", source: "deepseek", status: 200, authReplaced: true });
    assert.equal(statSync(log.path).mode & 0o777, 0o600);
  });

  it("never writes a credential-shaped value, a token-shaped value or a malformed name", async (t) => {
    const log = temporaryLog(t);
    const token = "0123456789abcdef0123456789abcdef";
    await log.append("router.request", {
      model: "sk-ant-oat-abcdefghijklmnop",
      path: `/${token}/v1/messages`,
      header: "Bearer abcdefghijklmnopqrstuvwxyz",
      note: "line one\nline two" + String.fromCharCode(0x2028) + "three",
      "bad name": "x",
      ok: 1,
      nan: Number.NaN,
    });
    await log.append("not an event", { ok: true });
    const [first, second] = lines(log);
    assert.deepEqual(first?.fields, {
      model: "[REDACTED]",
      path: "[REDACTED]",
      header: "[REDACTED]",
      note: "line one line two three",
      ok: 1,
      nan: 0,
    });
    assert.equal(second?.event, "router.invalid_event");
    assert.equal(readFileSync(log.path, "utf8").includes(token), false);
  });

  it("rotates before it grows past its bound", async (t) => {
    const log = temporaryLog(t);
    const filler = "m".repeat(120);
    for (let index = 0; index < 6000; index += 1) {
      await log.append("router.request", { model: filler, n: index });
    }
    assert.ok(existsSync(`${log.path}.1`), "a rotated generation exists");
    assert.ok(statSync(log.path).size <= 1024 * 1024);
    assert.equal(existsSync(`${log.path}.4`), false, "at most three old generations are kept");
  });
});
