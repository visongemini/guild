import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Result } from "./ids.js";
import {
  createRuntimeTurnEvent,
  parseRuntimeTurnEvent,
  type RuntimeTurnEvent,
  type RuntimeTurnEventInput,
} from "./runtime-turn-event.js";

const received = {
  wallClockIso: "2026-08-27T12:00:00.000Z",
  monotonicMs: 100,
};

function must<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(result.reason);
  return result.value;
}

function baseInput(payload: RuntimeTurnEventInput["payload"]): RuntimeTurnEventInput {
  return {
    taskId: "task-1",
    runId: "run-1",
    adapterEpoch: 3,
    ingestMode: "live",
    receiveSequence: 1,
    idempotencyKey: "event-1",
    payload,
  };
}

function create(
  payload: RuntimeTurnEventInput["payload"],
  persistedOwningWindowId?: string,
): RuntimeTurnEvent {
  return must(
    createRuntimeTurnEvent({
      ...baseInput(payload),
      ...(persistedOwningWindowId === undefined ? {} : { persistedOwningWindowId }),
    }),
  );
}

describe("runtime turn event", () => {
  it("derives exact envelope kinds and identifiers for every turn payload", () => {
    const cases = [
      {
        payload: {
          type: "agent_text_chunk",
          sessionId: "session-1",
          received,
          messageId: "message-1",
          text: "hello",
        } as const,
        kind: "session_update",
        protocolMessageId: "message-1",
      },
      {
        payload: {
          type: "user_text_chunk",
          sessionId: "session-1",
          received,
          messageId: null,
          text: "question",
        } as const,
        kind: "session_update",
      },
      {
        payload: {
          type: "agent_thought_chunk",
          sessionId: "session-1",
          received,
          text: "thinking",
        } as const,
        kind: "session_update",
      },
      {
        payload: {
          type: "plan",
          sessionId: "session-1",
          received,
          entries: [{ content: "work", priority: "high", status: "pending" }],
        } as const,
        kind: "session_update",
      },
      {
        payload: {
          type: "tool_call_create",
          sessionId: "session-1",
          received,
          toolCallId: "tool-1",
          title: "Read",
        } as const,
        kind: "tool_call",
        toolCallId: "tool-1",
      },
      {
        payload: {
          type: "tool_call_update",
          sessionId: "session-1",
          received,
          toolCallId: "tool-2",
          status: "completed",
        } as const,
        kind: "tool_call",
        toolCallId: "tool-2",
      },
      {
        payload: {
          type: "permission_request",
          sessionId: "session-1",
          received,
          callbackRequestId: 7,
          toolCallId: "tool-3",
          title: "Write?",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        } as const,
        kind: "permission_request",
        toolCallId: "tool-3",
        windowId: "window-1",
      },
      {
        payload: {
          type: "prompt_terminal",
          sessionId: "session-1",
          received,
          stopReason: "end_turn",
          classification: "completed",
        } as const,
        kind: "terminal_success",
      },
      {
        payload: {
          type: "prompt_terminal",
          sessionId: "session-1",
          received,
          stopReason: "cancelled",
          classification: "cancelled",
        } as const,
        kind: "terminal_cancelled",
      },
    ] as const;

    for (const fixture of cases) {
      const event = create(
        fixture.payload,
        fixture.kind === "permission_request" ? "window-1" : undefined,
      );
      assert.equal(event.envelope.sessionId, "session-1");
      assert.equal(event.envelope.kind, fixture.kind);
      assert.equal(
        event.envelope.protocolMessageId,
        "protocolMessageId" in fixture ? fixture.protocolMessageId : undefined,
      );
      assert.equal(
        event.envelope.toolCallId,
        "toolCallId" in fixture ? fixture.toolCallId : undefined,
      );
      assert.equal(
        event.envelope.windowId,
        "windowId" in fixture ? fixture.windowId : undefined,
      );
    }
  });

  it("requires the authoritative persisted owner only for permissions", () => {
    const permission = {
      type: "permission_request",
      sessionId: "session-1",
      received,
      callbackRequestId: "callback-1",
      toolCallId: "tool-1",
      title: "Read?",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } as const;
    assert.deepEqual(createRuntimeTurnEvent(baseInput(permission)), {
      ok: false,
      reason: "permission_window_required",
    });
    assert.equal(create(permission, "window-authoritative").envelope.windowId, "window-authoritative");

    const text = {
      type: "agent_text_chunk",
      sessionId: "session-1",
      received,
      text: "hello",
    } as const;
    assert.deepEqual(
      createRuntimeTurnEvent({
        ...baseInput(text),
        persistedOwningWindowId: "window-forged",
      }),
      { ok: false, reason: "unexpected_permission_window" },
    );
  });

  it("rejects session context, malformed routing fields, and caller-derived fields", () => {
    const context = {
      type: "session_context",
      sessionId: "session-1",
      received,
      context: { kind: "mode", currentModeId: "default" },
    };
    assert.deepEqual(
      createRuntimeTurnEvent({ ...baseInput(context as never), payload: context as never }),
      { ok: false, reason: "session_context_not_turn_event" },
    );

    const text = {
      type: "agent_text_chunk",
      sessionId: "session-1",
      received,
      text: "hello",
    } as const;
    for (const override of [
      { taskId: "" },
      { runId: "" },
      { adapterEpoch: 0 },
      { ingestMode: "other" },
      { receiveSequence: 0 },
      { idempotencyKey: "" },
    ]) {
      assert.deepEqual(
        createRuntimeTurnEvent({ ...baseInput(text), ...override }),
        { ok: false, reason: "invalid_runtime_turn_event_routing" },
      );
    }

    type CallerDerivedKey = Extract<
      keyof RuntimeTurnEventInput,
      "kind" | "protocolMessageId" | "semanticPayloadDigest" | "sessionId" | "toolCallId"
    >;
    const noCallerDerivedKeys: CallerDerivedKey extends never ? true : false = true;
    assert.equal(noCallerDerivedKeys, true);
    for (const key of [
      "kind",
      "protocolMessageId",
      "semanticPayloadDigest",
      "sessionId",
      "toolCallId",
    ]) {
      assert.deepEqual(
        createRuntimeTurnEvent({
          ...baseInput(text),
          [key]: "caller-forged",
        } as unknown as RuntimeTurnEventInput),
        { ok: false, reason: "invalid_runtime_turn_event_input" },
      );
    }
    const hostile = new Proxy({}, {
      getPrototypeOf(): object | null {
        throw new Error("raw payload must not escape");
      },
    });
    assert.deepEqual(createRuntimeTurnEvent(hostile as unknown as RuntimeTurnEventInput), {
      ok: false,
      reason: "invalid_runtime_turn_event_input",
    });
  });

  it("preserves absent/null/string message semantics and derives only string protocol IDs", () => {
    const payload = (messageId: string | null | undefined) => ({
      type: "agent_text_chunk" as const,
      sessionId: "session-1",
      received,
      text: "same",
      ...(messageId === undefined ? {} : { messageId }),
    });
    const absent = create(payload(undefined));
    const nullable = create(payload(null));
    const identified = create(payload("message-1"));
    assert.equal(absent.envelope.protocolMessageId, undefined);
    assert.equal(nullable.envelope.protocolMessageId, undefined);
    assert.equal(identified.envelope.protocolMessageId, "message-1");
    assert.notEqual(
      absent.envelope.semanticPayloadDigest,
      nullable.envelope.semanticPayloadDigest,
    );
    assert.notEqual(
      nullable.envelope.semanticPayloadDigest,
      identified.envelope.semanticPayloadDigest,
    );
  });

  it("survives JSON round trips with optional envelope IDs absent or present", () => {
    const identifiedText = create({
      type: "agent_text_chunk",
      sessionId: "session-1",
      received,
      messageId: "message-1",
      text: "identified",
    });
    const absentText = create({
      type: "agent_text_chunk",
      sessionId: "session-1",
      received,
      text: "absent",
    });
    const tool = create({
      type: "tool_call_update",
      sessionId: "session-1",
      received,
      toolCallId: "tool-1",
      status: "completed",
    });
    const permission = create({
      type: "permission_request",
      sessionId: "session-1",
      received,
      callbackRequestId: "callback-1",
      toolCallId: "tool-2",
      title: "Read?",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }, "window-1");
    const terminal = create({
      type: "prompt_terminal",
      sessionId: "session-1",
      received,
      stopReason: "end_turn",
      classification: "completed",
    });
    const replay = must(createRuntimeTurnEvent({
      ...baseInput({
        type: "user_text_chunk",
        sessionId: "session-1",
        received,
        text: "history",
      }),
      ingestMode: "replay",
      adapterEpoch: 4,
    }));

    for (const event of [identifiedText, absentText, tool, permission, terminal, replay]) {
      const serialized = JSON.parse(JSON.stringify(event)) as unknown;
      assert.deepEqual(must(parseRuntimeTurnEvent(serialized)), event);
    }

    const serializedAbsent = JSON.parse(JSON.stringify(absentText)) as {
      payload: unknown;
      envelope: Record<string, unknown>;
    };
    for (const key of ["protocolMessageId", "toolCallId", "windowId"] as const) {
      assert.deepEqual(
        parseRuntimeTurnEvent({
          payload: serializedAbsent.payload,
          envelope: { ...serializedAbsent.envelope, [key]: null },
        }),
        { ok: false, reason: "invalid_runtime_turn_event" },
      );
      assert.deepEqual(
        parseRuntimeTurnEvent({
          payload: serializedAbsent.payload,
          envelope: { ...serializedAbsent.envelope, [key]: "forged" },
        }),
        { ok: false, reason: "invalid_runtime_turn_event" },
      );
    }
  });

  it("deeply freezes copies and rejects mismatched payload/envelope pairs", () => {
    const input = {
      type: "tool_call_create" as const,
      sessionId: "session-1",
      received: { ...received },
      toolCallId: "tool-1",
      title: "Read",
      content: [{ type: "text" as const, text: "original" }],
    };
    const event = create(input);
    assert.equal(Object.isFrozen(event), true);
    assert.equal(Object.isFrozen(event.envelope), true);
    assert.equal(Object.isFrozen(event.payload), true);
    assert.equal(Object.isFrozen(event.payload.received), true);
    if (event.payload.type !== "tool_call_create") assert.fail("wrong payload type");
    assert.equal(Object.isFrozen(event.payload.content), true);
    assert.equal(Object.isFrozen(event.payload.content?.[0]), true);
    input.title = "mutated";
    input.content[0]!.text = "mutated";
    assert.equal(event.payload.title, "Read");
    assert.deepEqual(event.payload.content?.[0], { type: "text", text: "original" });

    assert.equal(parseRuntimeTurnEvent(event).ok, true);
    for (const envelope of [
      { ...event.envelope, kind: "session_update" },
      { ...event.envelope, sessionId: "session-forged" },
      { ...event.envelope, semanticPayloadDigest: "forged" },
      { ...event.envelope, toolCallId: "tool-forged" },
    ]) {
      assert.deepEqual(parseRuntimeTurnEvent({ payload: event.payload, envelope }), {
        ok: false,
        reason: "invalid_runtime_turn_event",
      });
    }
  });
});
