import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  XAI_SESSION_NOTIFICATION_SUBTYPES,
  XAI_SIGNAL_NOTIFICATIONS,
} from "@guild/contracts";
import { JsonRpcRemoteError } from "./json-rpc-peer.js";
import {
  XAI_EXTENSION_METHOD_PATTERN,
  XAI_NOTIFICATION_PARSERS,
  isMethodNotFound,
  parseXaiNotification,
} from "./xai-extensions.js";

const parse = (method: string, params: unknown) => parseXaiNotification(method, params, 5);
const sessionUpdate = (update: unknown) =>
  parse("_x.ai/session_notification", { sessionId: "s-1", update });

describe("_x.ai extension layer", () => {
  it("accepts exactly the contract allowlist and nothing else", () => {
    assert.deepEqual(
      Object.keys(XAI_NOTIFICATION_PARSERS).sort(),
      [...XAI_SIGNAL_NOTIFICATIONS].sort(),
    );
    const accepted = XAI_SESSION_NOTIFICATION_SUBTYPES.filter((subtype) =>
      sessionUpdate({
        sessionUpdate: subtype,
        event_name: "stop",
        count: 1,
        name: "tool",
        kind: "permission",
        attempt: 1,
        max_retries: 2,
        model_id: "grok-4.7",
        runs: [],
      }) !== undefined);
    assert.deepEqual(accepted, [...XAI_SESSION_NOTIFICATION_SUBTYPES]);
    for (const dropped of [
      "_x.ai/mcp/servers_updated", "_x.ai/mcp/server_status", "_x.ai/mcp_initialized",
      "_x.ai/settings/update", "_x.ai/announcements/update", "_x.ai/session/interjection",
      "_x.ai/billing", "x.ai/queue/changed", "queue/changed", "__proto__", "constructor", "toString", "",
    ]) {
      assert.equal(parse(dropped, { sessionId: "s-1", entries: [] }), undefined, dropped);
    }
    for (const subtype of [
      "session_summary_generated", "usage_update", "future", "__proto__", "constructor", "hasOwnProperty",
    ]) {
      assert.equal(sessionUpdate({ sessionUpdate: subtype }), undefined, subtype);
    }
  });

  it("never throws on hostile or malformed payloads", () => {
    for (const params of [undefined, null, 1, "x", [], [1], true]) {
      for (const method of Object.keys(XAI_NOTIFICATION_PARSERS)) {
        assert.doesNotThrow(() => parse(method, params), `${method} ${String(params)}`);
        assert.equal(parse(method, params), undefined);
      }
    }
    const hostile = { get entries(): never { throw new Error("getter"); }, sessionId: "s" };
    assert.equal(parse("_x.ai/queue/changed", hostile), undefined);
    assert.equal(sessionUpdate({ sessionUpdate: "hook_run_started", event_name: 5, count: "x" }), undefined);
    assert.equal(sessionUpdate({ sessionUpdate: "retry_state", attempt: "1", max_retries: 3 }), undefined);
    assert.equal(sessionUpdate("hook_run_started"), undefined);
  });

  it("bounds identifiers and counts and replaces unsafe characters", () => {
    const longName = `tool_${"x".repeat(200)}`;
    const delta = sessionUpdate({ sessionUpdate: "tool_call_delta_chunk", name: longName });
    assert.equal(delta?.signal.kind === "tool_call_delta_chunk" && delta.signal.toolName.length, 64);
    const odd = sessionUpdate({ sessionUpdate: "tool_call_delta_chunk", name: "mcp tool; rm -rf /" });
    assert.equal(odd?.signal.kind === "tool_call_delta_chunk" && odd.signal.toolName, "mcp_tool__rm_-rf__");
    assert.equal(sessionUpdate({ sessionUpdate: "tool_call_delta_chunk", name: "!!!" })?.signal.kind, undefined);
    const huge = sessionUpdate({ sessionUpdate: "hook_run_started", event_name: "stop", count: 1e12 });
    assert.equal(huge?.signal.kind === "hook_run_started" && huge.signal.count, 1_000_000);
    const queue = parse("_x.ai/queue/changed", {
      sessionId: "s-1",
      entries: Array.from({ length: 500 }, (_, index) => ({ position: index + 1, text: "T" })),
    });
    assert.deepEqual(queue?.signal, { kind: "queue_changed", queued: 500, firstPosition: 1, running: false });
    const sessions = parse("_x.ai/sessions/changed", {
      upserted: Array.from({ length: 100 }, (_, index) => ({ sessionId: `s-${index}`, activity: index % 2 === 0 ? "working" : "paused" })),
    });
    assert.equal(sessions?.signal.kind === "sessions_changed" && sessions.signal.sessions.length, 32);
    assert.equal(sessions?.signal.kind === "sessions_changed" && sessions.signal.sessions[1]?.activity, "other");
  });

  it("distinguishes an active retry from one the runtime reports as ended", () => {
    const active = sessionUpdate({ sessionUpdate: "retry_state", type: "retrying", attempt: 2, max_retries: 15, reason: "R" });
    assert.deepEqual(active?.signal, { kind: "retry_state", active: true, attempt: 2, maxRetries: 15 });
    const ended = sessionUpdate({ sessionUpdate: "retry_state", type: "recovered", attempt: 2, max_retries: 15 });
    assert.deepEqual(ended?.signal, { kind: "retry_state", active: false, attempt: 2, maxRetries: 15 });
  });

  it("reports no queue position when nothing waits and uses the lowest waiting position", () => {
    assert.deepEqual(
      parse("_x.ai/queue/changed", { sessionId: "s-1", entries: [], runningPromptId: "p-1" })?.signal,
      { kind: "queue_changed", queued: 0, running: true },
    );
    assert.deepEqual(
      parse("_x.ai/queue/changed", { sessionId: "s-1", entries: [{ position: 3 }, { position: 2 }] })?.signal,
      { kind: "queue_changed", queued: 2, firstPosition: 2, running: false },
    );
  });

  it("ignores a model list that has no official model and keeps the session id out of session-less notices", () => {
    assert.equal(
      parse("_x.ai/models/update", { currentModelId: "MiniMax-M3", availableModels: [{ modelId: "MiniMax-M3", name: "M" }] }),
      undefined,
    );
    const update = parse("_x.ai/models/update", {
      sessionId: "ignored",
      currentModelId: "grok-4.7",
      availableModels: [{ modelId: "grok-4.7", name: "Grok 4.7" }],
    });
    assert.equal(update?.sessionId, null);
    assert.equal(parse("_x.ai/sessions/changed", { upserted: [] })?.sessionId, null);
    assert.equal(parse("_x.ai/session/setup", { phase: "auth", sessionId: null })?.sessionId, null);
    assert.equal(parse("_x.ai/session/setup", { phase: "auth", sessionId: "s-9" })?.sessionId, "s-9");
  });

  it("validates outbound extension method names and recognises method-not-found", () => {
    for (const good of [
      "_x.ai/interject", "_x.ai/rewind/points", "_x.ai/rewind/execute", "_x.ai/git/worktree/create",
      "_x.ai/billing", "_x.ai/hunk-tracker/get-files",
    ]) {
      assert.match(good, XAI_EXTENSION_METHOD_PATTERN);
    }
    for (const bad of [
      "x.ai/interject", "_x.ai", "_x.ai/", "_x.ai/Interject", "_x.ai/a..b", "_x.ai/a/", "_x.ai/ a",
      "_x.ai/a/b/c/d/e", "session/prompt", "_x.aiX/interject", " _x.ai/interject", "_x.ai/interject\n",
    ]) {
      assert.doesNotMatch(bad, XAI_EXTENSION_METHOD_PATTERN, bad);
    }
    assert.equal(isMethodNotFound(new JsonRpcRemoteError({ code: -32601, message: "Method not found" })), true);
    assert.equal(isMethodNotFound(new JsonRpcRemoteError({ code: -32602, message: "Invalid params" })), false);
    assert.equal(isMethodNotFound(new Error("-32601")), false);
  });
});
