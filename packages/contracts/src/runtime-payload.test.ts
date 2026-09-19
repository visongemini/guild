import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACP_PERMISSION_OPTION_KINDS,
  ACP_PLAN_PRIORITIES,
  ACP_PLAN_STATUSES,
  ACP_PROMPT_STOP_REASONS,
  ACP_TOOL_KINDS,
  ACP_TOOL_STATUSES,
  canonicalSerializeRuntimePayload,
  freezeRuntimePayload,
  RUNTIME_PAYLOAD_LIMITS,
  RUNTIME_UNSUPPORTED_CONTENT_TYPES,
  RuntimePayloadError,
  runtimePayloadDigest,
  semanticRuntimePayloadDigest,
  type RuntimePayload,
} from "./runtime-payload.js";

const received = {
  wallClockIso: "2026-08-27T10:11:12.345Z",
  monotonicMs: 42.5,
};

function agentText(messageId: string | null | undefined, text = "hello"): unknown {
  return {
    type: "agent_text_chunk",
    sessionId: "session-1",
    received,
    text,
    ...(messageId === undefined ? {} : { messageId }),
  };
}

function hasPayloadCode(code: RuntimePayloadError["code"]): (cause: unknown) => boolean {
  return (cause) => cause instanceof RuntimePayloadError && cause.code === code;
}

describe("normalized runtime payload", () => {
  it("runtime-freezes every production parser allowlist", () => {
    const allowlists = [
      ACP_PERMISSION_OPTION_KINDS,
      ACP_TOOL_KINDS,
      ACP_TOOL_STATUSES,
      ACP_PROMPT_STOP_REASONS,
      RUNTIME_UNSUPPORTED_CONTENT_TYPES,
      ACP_PLAN_PRIORITIES,
      ACP_PLAN_STATUSES,
    ] as const;
    for (const allowlist of allowlists) {
      assert.equal(Object.isFrozen(allowlist), true);
      assert.throws(() => {
        (allowlist as unknown as string[]).push("forged");
      }, TypeError);
    }

    const forged = [
      {
        type: "permission_request",
        sessionId: "session-1",
        received,
        callbackRequestId: 1,
        toolCallId: "tool-1",
        title: null,
        options: [{ optionId: "bad", name: "Bad", kind: "forged" }],
      },
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Bad tool",
        kind: "forged",
      },
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Bad status",
        status: "forged",
      },
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Bad content",
        content: [{ type: "unsupported", contentType: "forged" }],
      },
      {
        type: "plan",
        sessionId: "session-1",
        received,
        entries: [{ content: "Bad", priority: "forged", status: "pending" }],
      },
      {
        type: "plan",
        sessionId: "session-1",
        received,
        entries: [{ content: "Bad", priority: "high", status: "forged" }],
      },
    ];
    for (const candidate of forged) {
      assert.throws(() => freezeRuntimePayload(candidate), RuntimePayloadError);
    }
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "prompt_terminal",
          sessionId: "session-1",
          received,
          stopReason: "forged",
          classification: "completed",
        }),
      RuntimePayloadError,
    );
    assert.equal(
      freezeRuntimePayload({
        type: "prompt_terminal",
        sessionId: "session-1",
        received,
        stopReason: "end_turn",
        classification: "completed",
        contextTokensUsed: 25_523,
      }).type,
      "prompt_terminal",
    );
    assert.throws(() => freezeRuntimePayload({
      type: "prompt_terminal",
      sessionId: "session-1",
      received,
      stopReason: "end_turn",
      classification: "completed",
      contextTokensUsed: -1,
    }), RuntimePayloadError);
  });

  it("preserves absent, null, and string message IDs", () => {
    const absent = freezeRuntimePayload(agentText(undefined));
    const nullable = freezeRuntimePayload(agentText(null));
    const identified = freezeRuntimePayload(agentText("message-1"));
    assert.equal(Object.hasOwn(absent, "messageId"), false);
    assert.equal(nullable.type, "agent_text_chunk");
    if (nullable.type === "agent_text_chunk") assert.equal(nullable.messageId, null);
    assert.equal(identified.type, "agent_text_chunk");
    if (identified.type === "agent_text_chunk") assert.equal(identified.messageId, "message-1");
    assert.notEqual(runtimePayloadDigest(absent), runtimePayloadDigest(nullable));
    assert.notEqual(runtimePayloadDigest(nullable), runtimePayloadDigest(identified));
  });

  it("rejects unpaired UTF-16 surrogates before hashing or persistence", () => {
    for (const toolCallId of ["\ud800", "\ud801", "\udc00"]) {
      assert.throws(() => freezeRuntimePayload({
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId,
        title: "Read package",
      }), RuntimePayloadError);
    }
    assert.doesNotThrow(() => freezeRuntimePayload({
      type: "tool_call_create",
      sessionId: "session-1",
      received,
      toolCallId: "emoji-\ud83d\ude80",
      title: "Read package",
    }));
  });

  it("deeply freezes copied payloads and does not retain caller objects", () => {
    const input = {
      type: "permission_request",
      sessionId: "session-1",
      received: { ...received },
      callbackRequestId: "callback-1",
      toolCallId: "tool-1",
      title: "Read file",
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    };
    const payload = freezeRuntimePayload(input);
    assert.equal(Object.isFrozen(payload), true);
    assert.equal(Object.isFrozen(payload.received), true);
    assert.equal(payload.type, "permission_request");
    if (payload.type !== "permission_request") return;
    assert.equal(Object.isFrozen(payload.options), true);
    assert.equal(Object.isFrozen(payload.options[0]), true);
    input.options[0]!.name = "changed outside";
    assert.equal(payload.options[0]!.name, "Allow");
  });

  it("uses stable key-order serialization and semantic SHA-256 digests", () => {
    const left = freezeRuntimePayload(agentText("message-1", "same"));
    const right = freezeRuntimePayload({
      text: "same",
      received: { monotonicMs: 42.5, wallClockIso: "2026-08-27T10:11:12.345Z" },
      messageId: "message-1",
      sessionId: "session-1",
      type: "agent_text_chunk",
    });
    assert.equal(canonicalSerializeRuntimePayload(left), canonicalSerializeRuntimePayload(right));
    assert.equal(runtimePayloadDigest(left), runtimePayloadDigest(right));
    assert.match(runtimePayloadDigest(left), /^[a-f0-9]{64}$/);

    const changed = freezeRuntimePayload(agentText("message-1", "different"));
    assert.notEqual(runtimePayloadDigest(left), runtimePayloadDigest(changed));
  });

  it("separates full-record integrity from timestamp-independent semantic digests", () => {
    const first = freezeRuntimePayload(agentText("message-1", "same"));
    const later = freezeRuntimePayload({
      ...agentText("message-1", "same") as object,
      received: {
        wallClockIso: "2026-08-27T10:11:13.345Z",
        monotonicMs: 43.5,
      },
    });
    assert.notEqual(runtimePayloadDigest(first), runtimePayloadDigest(later));
    assert.equal(
      semanticRuntimePayloadDigest(first),
      semanticRuntimePayloadDigest(later),
    );

    const absent = freezeRuntimePayload(agentText(undefined));
    const nullable = freezeRuntimePayload(agentText(null));
    const identified = freezeRuntimePayload(agentText("message-1"));
    assert.notEqual(
      semanticRuntimePayloadDigest(absent),
      semanticRuntimePayloadDigest(nullable),
    );
    assert.notEqual(
      semanticRuntimePayloadDigest(nullable),
      semanticRuntimePayloadDigest(identified),
    );
  });

  it("rejects caller-supplied digests, non-finite values, and false terminal classification", () => {
    assert.throws(
      () => freezeRuntimePayload({ ...(agentText(undefined) as object), semanticPayloadDigest: "caller" }),
      hasPayloadCode("unexpected_field"),
    );
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "session_context",
          sessionId: "session-1",
          received,
          context: {
            kind: "usage",
            scope: "session_context_window_and_cost",
            used: 1,
            size: 2,
            cost: { amount: Number.POSITIVE_INFINITY, currency: "USD" },
          },
        }),
      hasPayloadCode("invalid_number"),
    );
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "prompt_terminal",
          sessionId: "session-1",
          received,
          stopReason: "max_tokens",
          classification: "completed",
        }),
      hasPayloadCode("invalid_value"),
    );
  });

  it("enforces all contract collection and string bounds", () => {
    assert.throws(
      () => freezeRuntimePayload(agentText(undefined, "x".repeat(RUNTIME_PAYLOAD_LIMITS.maxStringLength + 1))),
      hasPayloadCode("string_too_long"),
    );
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "tool_call_create",
          sessionId: "session-1",
          received,
          toolCallId: "tool-1",
          title: "Bounded",
          content: Array.from({ length: RUNTIME_PAYLOAD_LIMITS.maxContentItems + 1 }, () => ({
            type: "text",
            text: "x",
          })),
        }),
      hasPayloadCode("collection_too_large"),
    );
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "permission_request",
          sessionId: "session-1",
          received,
          callbackRequestId: null,
          toolCallId: "tool-1",
          title: null,
          options: Array.from({ length: RUNTIME_PAYLOAD_LIMITS.maxOptions + 1 }, (_, index) => ({
            optionId: `option-${index}`,
            name: "Option",
            kind: "reject_once",
          })),
        }),
      hasPayloadCode("collection_too_large"),
    );
  });

  it("rejects invalid receive clocks and duplicate permission identities", () => {
    assert.throws(
      () => freezeRuntimePayload({ ...(agentText(undefined) as object), received: { ...received, monotonicMs: -1 } }),
      hasPayloadCode("invalid_number"),
    );
    assert.throws(
      () => freezeRuntimePayload({ ...(agentText(undefined) as object), received: { ...received, wallClockIso: "today" } }),
      hasPayloadCode("invalid_timestamp"),
    );
    assert.throws(
      () =>
        freezeRuntimePayload({
          type: "permission_request",
          sessionId: "session-1",
          received,
          callbackRequestId: 1,
          toolCallId: "tool-1",
          title: null,
          options: [
            { optionId: "same", name: "Once", kind: "allow_once" },
            { optionId: "same", name: "Never", kind: "reject_always" },
          ],
        }),
      hasPayloadCode("duplicate_id"),
    );
  });

  it("canonical helpers revalidate typed-looking runtime values", () => {
    const forged = {
      ...(agentText(undefined) as object),
      rawOutput: "must not persist",
    } as unknown as RuntimePayload;
    assert.throws(() => canonicalSerializeRuntimePayload(forged), hasPayloadCode("unexpected_field"));
    assert.throws(() => runtimePayloadDigest(forged), hasPayloadCode("unexpected_field"));
  });

  it("rejects sparse arrays across normalized collections and never hashes them as empty", () => {
    const sparse = new Array<unknown>(1);
    const cases = [
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Sparse content",
        content: sparse,
      },
      {
        type: "permission_request",
        sessionId: "session-1",
        received,
        callbackRequestId: 1,
        toolCallId: "tool-1",
        title: null,
        options: sparse,
      },
      {
        type: "session_context",
        sessionId: "session-1",
        received,
        context: { kind: "commands", commands: sparse },
      },
      {
        type: "session_context",
        sessionId: "session-1",
        received,
        context: { kind: "config", options: sparse },
      },
    ];
    for (const candidate of cases) {
      assert.throws(() => freezeRuntimePayload(candidate), hasPayloadCode("sparse_array"));
    }

    const empty = freezeRuntimePayload({
      type: "tool_call_create",
      sessionId: "session-1",
      received,
      toolCallId: "tool-1",
      title: "Sparse content",
      content: [],
    });
    const forgedSparse = cases[0] as unknown as RuntimePayload;
    assert.match(runtimePayloadDigest(empty), /^[a-f0-9]{64}$/);
    assert.throws(() => runtimePayloadDigest(forgedSparse), hasPayloadCode("sparse_array"));
  });

  it("preserves the optional input hint for official slash commands", () => {
    const payload = freezeRuntimePayload({
      type: "session_context",
      sessionId: "session-1",
      received,
      context: {
        kind: "commands",
        commands: [{ name: "plan", description: "Create a plan", inputHint: "topic" }],
      },
    });
    assert.equal(payload.type, "session_context");
    if (payload.type !== "session_context" || payload.context.kind !== "commands") return;
    assert.deepEqual(payload.context.commands, [
      { name: "plan", description: "Create a plan", inputHint: "topic" },
    ]);
    assert.equal(Object.isFrozen(payload.context.commands[0]), true);
  });

  it("normalizes plans and complete select choices with strict relational IDs", () => {
    const plan = freezeRuntimePayload({
      type: "plan",
      sessionId: "session-1",
      received,
      entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
    });
    assert.equal(plan.type, "plan");
    assert.equal(Object.isFrozen(plan), true);
    if (plan.type === "plan") assert.equal(Object.isFrozen(plan.entries[0]), true);

    const config = freezeRuntimePayload({
      type: "session_context",
      sessionId: "session-1",
      received,
      context: {
        kind: "config",
        options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "pro",
            choices: {
              form: "grouped",
              groups: [
                {
                  group: "models",
                  name: "Models",
                  options: [
                    { value: "lite", name: "Lite" },
                    { value: "pro", name: "Pro" },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    assert.equal(config.type, "session_context");
    if (config.type === "session_context" && config.context.kind === "config") {
      const option = config.context.options[0];
      assert.equal(option?.type, "select");
      if (option?.type === "select") assert.equal(option.choices.form, "grouped");
    }

    for (const options of [
      [
        { id: "same", name: "One", type: "boolean", currentValue: true },
        { id: "same", name: "Two", type: "boolean", currentValue: false },
      ],
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "missing",
          choices: {
            form: "flat",
            options: [{ value: "present", name: "Present" }],
          },
        },
      ],
    ]) {
      assert.throws(
        () =>
          freezeRuntimePayload({
            type: "session_context",
            sessionId: "session-1",
            received,
            context: { kind: "config", options },
          }),
        RuntimePayloadError,
      );
    }
  });

  it("requires canonical absolute paths in normalized diffs and locations", () => {
    for (const candidate of [
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Relative diff",
        content: [{ type: "diff", path: "relative.txt", newText: "x" }],
      },
      {
        type: "tool_call_create",
        sessionId: "session-1",
        received,
        toolCallId: "tool-1",
        title: "Noncanonical location",
        locations: [{ path: "/tmp/a/../b" }],
      },
    ]) {
      assert.throws(() => freezeRuntimePayload(candidate), hasPayloadCode("invalid_value"));
    }
  });

  it("admits only canonical bounded image bytes in normalized tool content", () => {
    const payload = freezeRuntimePayload({
      type: "tool_call_create",
      sessionId: "session-1",
      received,
      toolCallId: "tool-image",
      title: "View image",
      content: [{
        type: "media",
        mediaType: "image",
        mimeType: "image/png",
        base64Data: "AQID",
        uri: "file:///tmp/preview.png",
      }],
    });
    assert.equal(payload.type, "tool_call_create");
    assert.deepEqual(payload.type === "tool_call_create" ? payload.content : undefined, [{
      type: "media",
      mediaType: "image",
      mimeType: "image/png",
      base64Data: "AQID",
      uri: "file:///tmp/preview.png",
    }]);
    assert.throws(() => freezeRuntimePayload({
      type: "tool_call_create",
      sessionId: "session-1",
      received,
      toolCallId: "tool-image-bad",
      title: "View image",
      content: [{
        type: "media",
        mediaType: "image",
        mimeType: "image/png",
        base64Data: "not-base64",
      }],
    }), hasPayloadCode("invalid_string"));
  });

  it("caps grouped select choices across all groups", () => {
    const groups = (count: number) => [
      {
        group: "first",
        name: "First",
        options: Array.from({ length: 64 }, (_, index) => ({
          value: `first-${index}`,
          name: `First ${index}`,
        })),
      },
      {
        group: "second",
        name: "Second",
        options: Array.from({ length: count - 64 }, (_, index) => ({
          value: `second-${index}`,
          name: `Second ${index}`,
        })),
      },
    ];
    const payload = (count: number) => ({
      type: "session_context",
      sessionId: "session-1",
      received,
      context: {
        kind: "config",
        options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "first-0",
            choices: { form: "grouped", groups: groups(count) },
          },
        ],
      },
    });

    const bounded = freezeRuntimePayload(payload(128));
    assert.equal(bounded.type, "session_context");
    if (bounded.type === "session_context" && bounded.context.kind === "config") {
      const option = bounded.context.options[0];
      assert.equal(option?.type, "select");
      if (option?.type === "select" && option.choices.form === "grouped") {
        assert.equal(
          option.choices.groups.reduce((total, group) => total + group.options.length, 0),
          128,
        );
      }
    }
    assert.throws(
      () => freezeRuntimePayload(payload(129)),
      hasPayloadCode("collection_too_large"),
    );
  });
});
