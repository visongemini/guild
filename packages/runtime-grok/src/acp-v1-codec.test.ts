import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtimePayloadDigest } from "@guild/contracts";
import {
  ACP_V1_CODEC_LIMITS,
  AcpV1CodecError,
  decodeAuthenticateResult,
  decodeInitializeResult,
  decodeLoadSessionResult,
  decodeNewSessionResult,
  decodeOfficialBillingResult,
  decodePermissionRequest,
  decodePromptResult,
  decodeResumeSessionResult,
  decodeSessionSelectorResult,
  decodeSessionUpdate,
  encodeAuthenticateParams,
  encodeBillingParams,
  encodeCancelledPermissionResult,
  encodeCancelParams,
  encodeInitializeParams,
  encodeLoadSessionParams,
  encodeNewSessionParams,
  encodePromptParams,
  encodeResumeSessionParams,
  encodeSetSessionConfigOptionParams,
  encodeSetSessionModeParams,
  encodeSetSessionModelParams,
  encodeSelectedPermissionResult,
  encodeTextPromptParams,
} from "./acp-v1-codec.js";

const received = {
  wallClockIso: "2026-08-27T11:22:33.444Z",
  monotonicMs: 123.75,
};

function notification(update: Record<string, unknown>, sessionId = "session-1"): unknown {
  return { sessionId, update };
}

function decodeUpdate(update: Record<string, unknown>) {
  return decodeSessionUpdate(notification(update), "session-1", received);
}

function permissionParams(overrides: Record<string, unknown> = {}): unknown {
  return {
    sessionId: "session-1",
    toolCall: { toolCallId: "tool-1", title: "Read settings" },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

function hasCodecCode(code: AcpV1CodecError["code"]): (cause: unknown) => boolean {
  return (cause) => cause instanceof AcpV1CodecError && cause.code === code;
}

describe("ACP v1 request encoders", () => {
  it("encodes the exact minimal initialize and explicit text prompt", () => {
    assert.deepEqual(encodeInitializeParams(), {
      protocolVersion: 1,
      clientCapabilities: {
        session: { configOptions: { boolean: {} } },
      },
      clientInfo: { name: "guild", title: "Guild", version: "2.0.31" },
    });
    assert.deepEqual(encodeTextPromptParams("session-1", "Do the task"), {
      sessionId: "session-1",
      prompt: [{ type: "text", text: "Do the task" }],
    });
    assert.deepEqual(encodePromptParams("session-1", "Review these files", [{
      name: "README.md",
      uri: "file:///tmp/project/README.md",
      mimeType: "text/markdown",
      size: 42,
    }]), {
      sessionId: "session-1",
      prompt: [
        { type: "text", text: "Review these files" },
        {
          type: "resource_link",
          name: "README.md",
          uri: "file:///tmp/project/README.md",
          mimeType: "text/markdown",
          size: 42,
        },
      ],
    });
  });

  it("encodes auth, canonical new/resume/load parameters, and ID-free cancel params", () => {
    const initializeResult = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [{ id: "cached-token", name: "Cached token" }],
    });
    assert.deepEqual(
      encodeAuthenticateParams(initializeResult, "cached-token"),
      { methodId: "cached-token" },
    );
    assert.deepEqual(encodeBillingParams(), {});
    assert.equal(Object.isFrozen(encodeBillingParams()), true);
    assert.deepEqual(encodeNewSessionParams("/tmp/project"), {
      cwd: "/tmp/project",
      mcpServers: [],
    });
    assert.deepEqual(encodeResumeSessionParams("session-1", "/tmp/project"), {
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
    assert.deepEqual(encodeLoadSessionParams("session-1", "/tmp/project"), {
      sessionId: "session-1",
      cwd: "/tmp/project",
      mcpServers: [],
    });
    assert.deepEqual(encodeCancelParams("session-1"), { sessionId: "session-1" });
    assert.equal(Object.hasOwn(encodeCancelParams("session-1"), "id"), false);
    assert.deepEqual(encodeSetSessionModelParams("session-1", "grok-4.5"), {
      sessionId: "session-1",
      modelId: "grok-4.5",
    });
    assert.deepEqual(encodeSetSessionModeParams("session-1", "medium"), {
      sessionId: "session-1",
      modeId: "medium",
    });
    assert.deepEqual(
      encodeSetSessionConfigOptionParams("session-1", "web-search", true),
      { sessionId: "session-1", configId: "web-search", type: "boolean", value: true },
    );
    assert.equal(decodeSessionSelectorResult({}), undefined);
    assert.equal(
      decodeSessionSelectorResult({ _meta: { model: { Ok: { modelId: "grok-4.5" } } } }),
      undefined,
    );
  });

  it("rejects empty session IDs and non-absolute or lexically non-canonical cwd", () => {
    assert.throws(() => encodeResumeSessionParams("", "/tmp/project"), hasCodecCode("invalid_type"));
    assert.throws(() => encodeNewSessionParams("relative/project"), hasCodecCode("invalid_value"));
    assert.throws(() => encodeLoadSessionParams("session-1", "/tmp/a/../project"), hasCodecCode("invalid_value"));
  });

  it("binds authenticate to this decoded initialize advertisement and fails closed", () => {
    const initializeResult = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [{ id: "cached-token", name: "Cached token" }],
    });
    const otherInitializeResult = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [{ id: "other-token", name: "Other token" }],
    });
    assert.throws(
      () => encodeAuthenticateParams(initializeResult, "not-advertised"),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () =>
        encodeAuthenticateParams({
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            resumeSession: false,
            prompt: { image: false, audio: false, embeddedContext: false },
          },
          authMethods: [{ id: "forged", name: "Forged", type: "agent" }],
        }, "forged"),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () => encodeAuthenticateParams({ ...initializeResult }, "cached-token"),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () =>
        encodeAuthenticateParams({
          ...initializeResult,
          authMethods: [{ id: "injected", name: "Injected", type: "agent" }],
        }, "injected"),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () => encodeAuthenticateParams(initializeResult, otherInitializeResult.authMethods[0]!.id),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () => (encodeAuthenticateParams as (result: unknown) => unknown)("cached-token"),
      hasCodecCode("unadvertised_auth_capability"),
    );
  });
});

describe("ACP v1 initialize and session result decoders", () => {
  it("accepts the official unauthenticated shape with a null default auth method", () => {
    assert.deepEqual(
      decodeInitializeResult({
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [{ id: "grok.com", name: "Grok", description: "Sign in with Grok" }],
        _meta: { defaultAuthMethodId: null },
      }),
      {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          resumeSession: false,
          prompt: { image: false, audio: false, embeddedContext: false },
        },
        authMethods: [{
          id: "grok.com",
          name: "Grok",
          description: "Sign in with Grok",
          type: "agent",
        }],
      },
    );
  });
  it("accepts only the exact empty v1 authenticate success result", () => {
    const result = decodeAuthenticateResult({});

    assert.deepEqual(result, {});
    assert.equal(Object.isFrozen(result), true);
    assert.equal(decodeAuthenticateResult({}), result);
    assert.equal(
      decodeAuthenticateResult({ _meta: { extension: "discarded" } }),
      result,
    );
    assert.throws(
      () => ((result as Record<string, unknown>)["extension"] = true),
      TypeError,
    );

    for (const malformed of [null, [], "", 0, false, { _meta: null }]) {
      assert.throws(
        () => decodeAuthenticateResult(malformed),
        hasCodecCode("invalid_type"),
      );
    }
  });

  it("rejects every authenticate result key without echoing it or its value", () => {
    const sensitiveKey = "sensitive-auth-extension-key";
    const sensitiveValue = "sensitive-auth-extension-value";

    assert.throws(
      () => decodeAuthenticateResult({ [sensitiveKey]: sensitiveValue }),
      (cause) =>
        cause instanceof AcpV1CodecError &&
        cause.code === "invalid_value" &&
        cause.path === "$" &&
        !cause.message.includes(sensitiveKey) &&
        !cause.message.includes(sensitiveValue),
    );
    assert.throws(
      () => decodeAuthenticateResult({ extension: undefined }),
      hasCodecCode("invalid_value"),
    );

    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "hidden", { value: true });
    assert.throws(
      () => decodeAuthenticateResult(nonEnumerable),
      hasCodecCode("invalid_value"),
    );
  });

  it("retains only bounded official billing usage and reset fields", () => {
    const result = decodeOfficialBillingResult({
      config: {
        creditUsagePercent: 4,
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-08-25T01:00:29.066410+00:00",
          end: "2026-09-01T01:00:29.066410+00:00",
          privateExtension: "discarded",
        },
        monthlyLimit: { val: 10_000 },
        used: { val: 400 },
        history: [{ private: "discarded" }],
      },
      subscriptionTier: "SuperGrok Heavy",
      onDemandEnabled: true,
      auth: "discarded",
    });
    assert.deepEqual(result, {
      creditUsagePercent: 4,
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodStartIso: "2026-08-25T01:00:29.066410+00:00",
      periodEndIso: "2026-09-01T01:00:29.066410+00:00",
      monthlyLimitCents: 10_000,
      usedCents: 400,
      subscriptionTier: "SuperGrok Heavy",
    });
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(decodeOfficialBillingResult({ config: null }), {});
    assert.deepEqual(
      decodeOfficialBillingResult({ config: { monthlyLimit: {} } }),
      {},
    );
    for (const malformed of [
      { config: { creditUsagePercent: -1 } },
      { config: { creditUsagePercent: 101 } },
      { config: { currentPeriod: { end: "not-a-date" } } },
      { config: { used: { val: -1 } } },
    ]) {
      assert.throws(() => decodeOfficialBillingResult(malformed), AcpV1CodecError);
    }
  });

  it("accepts absent or empty auth methods", () => {
    assert.deepEqual(decodeInitializeResult({ protocolVersion: 1 }), {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        resumeSession: false,
        prompt: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
    });
    assert.deepEqual(decodeInitializeResult({ protocolVersion: 1, authMethods: [] }).authMethods, []);
  });

  it("parses one or multiple agent auth methods without selecting one", () => {
    const one = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [{ id: "cached", name: "Cached token", description: null, extension: true }],
    });
    assert.deepEqual(one.authMethods, [
      { id: "cached", name: "Cached token", description: null, type: "agent" },
    ]);

    const multiple = decodeInitializeResult({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      authMethods: [
        { id: "cached", name: "Cached" },
        { id: "login", name: "Agent login", description: "Handled by the agent" },
      ],
      agentInfo: { name: "grok", version: "1.2.3", title: "Grok", extra: "ignored" },
    });
    assert.deepEqual(multiple.authMethods, [
      { id: "cached", name: "Cached", type: "agent" },
      {
        id: "login",
        name: "Agent login",
        description: "Handled by the agent",
        type: "agent",
      },
    ]);
    assert.deepEqual(multiple.agentCapabilities, {
      loadSession: true,
      resumeSession: true,
      prompt: { image: true, audio: false, embeddedContext: true },
    });
    assert.deepEqual(multiple.agentInfo, { name: "grok", version: "1.2.3", title: "Grok" });
  });

  it("admits only an advertised agent-owned default authentication method", () => {
    const initialized = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [
        { id: "cached", name: "Cached" },
        { id: "login", name: "Login" },
      ],
      _meta: { defaultAuthMethodId: "cached", extension: true },
    });
    assert.equal(initialized.defaultAuthMethodId, "cached");
    assert.throws(
      () => decodeInitializeResult({
        protocolVersion: 1,
        authMethods: [{ id: "cached", name: "Cached" }],
        _meta: { defaultAuthMethodId: "login" },
      }),
      hasCodecCode("unadvertised_auth_capability"),
    );
  });

  it("rejects malformed known auth entries and unsupported protocol versions", () => {
    for (const authMethods of [
      [{ name: "Missing id" }],
      [{ id: "missing-name" }],
      [{ id: "bad-type", name: "Bad", type: "oauth" }],
    ]) {
      assert.throws(() => decodeInitializeResult({ protocolVersion: 1, authMethods }), AcpV1CodecError);
    }
    assert.throws(
      () => decodeInitializeResult({ protocolVersion: 2 }),
      hasCodecCode("unsupported_protocol_version"),
    );
    assert.throws(
      () =>
        decodeInitializeResult({
          protocolVersion: 1,
          authMethods: [
            {
              id: "terminal",
              name: "Terminal login",
              type: "terminal",
              args: ["login"],
              env: { TOKEN: "not echoed" },
            },
          ],
        }),
      hasCodecCode("unadvertised_auth_capability"),
    );
    assert.throws(
      () =>
        decodeInitializeResult({
          protocolVersion: 1,
          authMethods: [
            { id: "same", name: "First" },
            { id: "same", name: "Second" },
          ],
        }),
      hasCodecCode("duplicate_auth_method_id"),
    );
  });

  it("decodes new, resume, and load success while enforcing v1 session-ID rules", () => {
    assert.deepEqual(decodeNewSessionResult({ sessionId: "opaque", extension: 1 }), {
      sessionId: "opaque",
    });
    assert.deepEqual(
      decodeNewSessionResult({ sessionId: "opaque", modes: null, configOptions: null }),
      { sessionId: "opaque", modes: null, configOptions: null },
    );
    assert.deepEqual(decodeNewSessionResult({
      sessionId: "opaque",
      models: {
        currentModelId: "grok-4.6",
        availableModels: [
          { modelId: "grok-4.5", _meta: { totalContextTokens: 400_000 } },
          { modelId: "grok-4.6", _meta: { totalContextTokens: 500_000 } },
        ],
      },
    }), {
      sessionId: "opaque",
      contextWindowSize: 500_000,
    });
    assert.deepEqual(decodeResumeSessionResult({
      models: {
        currentModelId: "grok-4.6",
        availableModels: [{ modelId: "grok-4.6", _meta: { totalContextTokens: 500_000 } }],
      },
    }), { contextWindowSize: 500_000 });
    assert.deepEqual(decodeNewSessionResult({
      sessionId: "opaque",
      models: { currentModelId: "grok-4.6", availableModels: [] },
    }), { sessionId: "opaque" });
    assert.throws(() => decodeNewSessionResult({}), hasCodecCode("missing_field"));
    assert.throws(() => decodeNewSessionResult({ sessionId: 1 }), hasCodecCode("invalid_type"));
    assert.throws(() => decodeNewSessionResult({ sessionId: "" }), hasCodecCode("invalid_type"));

    const state = {
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default", extra: true }],
      },
      configOptions: [
        { id: "thinking", name: "Thinking", type: "boolean", currentValue: true },
      ],
      extension: "ignored",
    };
    const normalizedState = {
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
      configOptions: [
        { id: "thinking", name: "Thinking", type: "boolean", currentValue: true },
      ],
    };
    assert.deepEqual(decodeNewSessionResult({ sessionId: "opaque", ...state }), {
      sessionId: "opaque",
      ...normalizedState,
    });
    assert.deepEqual(decodeResumeSessionResult(state), normalizedState);
    assert.deepEqual(decodeLoadSessionResult({}), {});
    assert.deepEqual(decodeLoadSessionResult(state), decodeResumeSessionResult(state));

    for (const malformed of [
      { sessionId: "opaque", modes: {} },
      { sessionId: "opaque", modes: { currentModeId: "default", availableModes: [null] } },
      { sessionId: "opaque", configOptions: {} },
      {
        sessionId: "opaque",
        configOptions: [{ id: "thinking", name: "Thinking", type: "boolean" }],
      },
    ]) {
      assert.throws(() => decodeNewSessionResult(malformed), AcpV1CodecError);
    }
  });

  it("preserves flat/grouped config choices and rejects duplicate or inconsistent IDs", () => {
    const decoded = decodeLoadSessionResult({
      configOptions: [
        {
          id: "flat",
          name: "Flat",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: "Fast", description: null },
            { value: "deep", name: "Deep" },
          ],
        },
        {
          id: "grouped",
          name: "Grouped",
          type: "select",
          currentValue: "pro",
          options: [
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
      ],
    });
    assert.deepEqual(decoded.configOptions, [
      {
        id: "flat",
        name: "Flat",
        type: "select",
        currentValue: "fast",
        choices: {
          form: "flat",
          options: [
            { value: "fast", name: "Fast", description: null },
            { value: "deep", name: "Deep" },
          ],
        },
      },
      {
        id: "grouped",
        name: "Grouped",
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
    ]);

    const invalidStates = [
      {
        modes: {
          currentModeId: "missing",
          availableModes: [{ id: "default", name: "Default" }],
        },
      },
      {
        modes: {
          currentModeId: "same",
          availableModes: [
            { id: "same", name: "One" },
            { id: "same", name: "Two" },
          ],
        },
      },
      {
        configOptions: [
          { id: "same", name: "One", type: "boolean", currentValue: true },
          { id: "same", name: "Two", type: "boolean", currentValue: false },
        ],
      },
      {
        configOptions: [
          {
            id: "select",
            name: "Select",
            type: "select",
            currentValue: "missing",
            options: [{ value: "present", name: "Present" }],
          },
        ],
      },
      {
        configOptions: [
          {
            id: "select",
            name: "Select",
            type: "select",
            currentValue: "same",
            options: [
              { value: "same", name: "One" },
              { value: "same", name: "Two" },
            ],
          },
        ],
      },
      {
        configOptions: [
          {
            id: "select",
            name: "Select",
            type: "select",
            currentValue: "value",
            options: [
              { group: "same", name: "One", options: [{ value: "value", name: "Value" }] },
              { group: "same", name: "Two", options: [{ value: "other", name: "Other" }] },
            ],
          },
        ],
      },
    ];
    for (const state of invalidStates) {
      assert.throws(() => decodeLoadSessionResult(state), AcpV1CodecError);
    }
  });

  it("caps grouped select choices across all groups", () => {
    const groupedOptions = (count: number) => [
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
    const state = (count: number) => ({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "first-0",
          options: groupedOptions(count),
        },
      ],
    });

    const bounded = decodeLoadSessionResult(state(128));
    const option = bounded.configOptions?.[0];
    assert.equal(option?.type, "select");
    if (option?.type === "select" && option.choices.form === "grouped") {
      assert.equal(
        option.choices.groups.reduce((total, group) => total + group.options.length, 0),
        128,
      );
    }
    assert.throws(
      () => decodeLoadSessionResult(state(129)),
      hasCodecCode("collection_limit_exceeded"),
    );
  });
});

describe("ACP v1 session updates", () => {
  it("preserves absent, null, and string message IDs and rejects empty/malformed values", () => {
    const absent = decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
    });
    const nullable = decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
      messageId: null,
    });
    const identified = decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "a" },
      messageId: "message-1",
    });
    assert.equal(absent.type, "turn");
    assert.equal(nullable.type, "turn");
    assert.equal(identified.type, "turn");
    if (absent.type !== "turn" || nullable.type !== "turn" || identified.type !== "turn") return;
    assert.equal(Object.hasOwn(absent.payload, "messageId"), false);
    assert.equal(nullable.payload.type, "agent_text_chunk");
    if (nullable.payload.type === "agent_text_chunk") assert.equal(nullable.payload.messageId, null);
    assert.equal(identified.payload.type, "agent_text_chunk");
    if (identified.payload.type === "agent_text_chunk") assert.equal(identified.payload.messageId, "message-1");
    assert.notEqual(runtimePayloadDigest(absent.payload), runtimePayloadDigest(nullable.payload));

    for (const messageId of ["", 1, false, {}]) {
      assert.throws(
        () =>
          decodeUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "a" },
            messageId,
          }),
        AcpV1CodecError,
      );
    }
  });

  it("decodes user text, agent text, agent thought, and strips extensions", () => {
    const cases = [
      ["user_message_chunk", "user_text_chunk"],
      ["agent_message_chunk", "agent_text_chunk"],
      ["agent_thought_chunk", "agent_thought_chunk"],
    ] as const;
    for (const [sessionUpdate, expectedType] of cases) {
      const decoded = decodeUpdate({
        sessionUpdate,
        content: { type: "text", text: "hello", _meta: { secret: true }, extra: "ignored" },
        _meta: { ignored: true },
        extension: { ignored: true },
      });
      assert.equal(decoded.type, "turn");
      if (decoded.type !== "turn") continue;
      assert.equal(decoded.payload.type, expectedType);
      assert.equal(Object.hasOwn(decoded.payload, "_meta"), false);
      assert.equal(Object.hasOwn(decoded.payload, "extension"), false);
    }
  });

  it("returns nonfatal redacted results for every legal non-text chunk kind and role", () => {
    const contentBlocks = [
      {
        contentType: "resource_link",
        block: {
          type: "resource_link",
          name: "Reference",
          uri: "file:///tmp/reference",
          description: null,
          mimeType: "text/plain",
          size: 12,
        },
      },
      {
        contentType: "resource",
        block: {
          type: "resource",
          resource: {
            uri: "file:///tmp/blob",
            mimeType: "application/octet-stream",
            blob: "BLOB_BODY_MUST_NOT_SURVIVE",
          },
        },
      },
    ] as const;
    const roles = [
      { discriminator: "user_message_chunk", message: {} },
      { discriminator: "agent_message_chunk", message: { messageId: null } },
      { discriminator: "agent_thought_chunk", message: { messageId: "thought-1" } },
    ] as const;

    for (const { contentType, block } of contentBlocks) {
      for (const { discriminator, message } of roles) {
        const decoded = decodeUpdate({
          sessionUpdate: discriminator,
          content: block,
          ...message,
          _meta: { secret: "ignored" },
        });
        assert.deepEqual(decoded, {
          type: "unsupported_content",
          sessionId: "session-1",
          discriminator,
          contentType,
          ...message,
        });
        assert.equal(Object.isFrozen(decoded), true);
        const normalized = JSON.stringify(decoded);
        assert.equal(normalized.includes("BASE64_"), false);
        assert.equal(normalized.includes("BLOB_BODY"), false);
        assert.equal(normalized.includes("file:///tmp"), false);
      }
    }
  });

  it("retains bounded canonical image and audio chunks for the visible conversation", () => {
    assert.deepEqual(
      decodeUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "image-1",
        content: {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
          uri: null,
        },
      }),
      {
        type: "media_content",
        sessionId: "session-1",
        discriminator: "agent_message_chunk",
        mediaType: "image",
        mimeType: "image/png",
        base64Data: "AQID",
        messageId: "image-1",
      },
    );
    assert.deepEqual(
      decodeUpdate({
        sessionUpdate: "user_message_chunk",
        content: {
          type: "audio",
          data: "AAEC",
          mimeType: "audio/mpeg",
        },
      }),
      {
        type: "media_content",
        sessionId: "session-1",
        discriminator: "user_message_chunk",
        mediaType: "audio",
        mimeType: "audio/mpeg",
        base64Data: "AAEC",
      },
    );
    assert.deepEqual(
      decodeUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "image",
          data: "AQID",
          mimeType: "image/png",
        },
      }),
      {
        type: "unsupported_content",
        sessionId: "session-1",
        discriminator: "agent_thought_chunk",
        contentType: "image",
      },
    );
    for (const data of ["", "not-base64", "AQI", "AQI="]) {
      if (data === "AQI=") continue;
      assert.throws(() => decodeUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data, mimeType: "image/png" },
      }), AcpV1CodecError);
    }
    assert.throws(() => decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "AQID", mimeType: "image/svg+xml" },
    }), AcpV1CodecError);
  });

  it("rejects malformed known non-text content blocks", () => {
    const malformed = [
      { type: "image", data: "base64" },
      { type: "audio", data: 1, mimeType: "audio/wav" },
      { type: "resource_link", name: "Missing URI" },
      { type: "resource", resource: { uri: "file:///tmp/empty" } },
      { type: "resource", resource: { uri: "file:///tmp/body", text: 1 } },
    ];
    for (const content of malformed) {
      assert.throws(
        () =>
          decodeUpdate({
            sessionUpdate: "agent_message_chunk",
            content,
          }),
        AcpV1CodecError,
      );
    }
  });

  it("decodes tool create/update safe display fields without raw input/output", () => {
    const created = decodeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Edit file",
      kind: "edit",
      status: "in_progress",
      content: [
        { type: "content", content: { type: "text", text: "working" } },
        { type: "diff", path: "/tmp/a", oldText: null, newText: "new" },
        { type: "terminal", terminalId: "terminal-1" },
      ],
      locations: [{ path: "/tmp/a", line: 2 }],
      rawInput: { token: "secret" },
      rawOutput: "secret",
      _meta: { secret: true },
    });
    assert.equal(created.type, "turn");
    if (created.type !== "turn") return;
    assert.deepEqual(created.payload, {
      type: "tool_call_create",
      sessionId: "session-1",
      received,
      toolCallId: "tool-1",
      title: "Edit file",
      kind: "edit",
      status: "in_progress",
      content: [
        { type: "text", text: "working" },
        { type: "diff", path: "/tmp/a", oldText: null, newText: "new" },
        { type: "terminal", terminalId: "terminal-1" },
      ],
      locations: [{ path: "/tmp/a", line: 2 }],
      replayProofUnavailable: true,
    });

    const updated = decodeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: null,
      kind: null,
      status: "completed",
      content: null,
      locations: null,
      rawOutput: { secret: true },
    });
    assert.equal(updated.type, "turn");
    if (updated.type !== "turn") return;
    assert.deepEqual(updated.payload, {
      type: "tool_call_update",
      sessionId: "session-1",
      received,
      toolCallId: "tool-1",
      title: null,
      kind: null,
      status: "completed",
      content: null,
      locations: null,
      replayProofUnavailable: true,
    });
  });

  it("bounds oversized tool display fields without faulting the ACP session", () => {
    const oversized = "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength + 256);
    const decoded = decodeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-large-output",
      title: oversized,
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: oversized } },
        { type: "diff", path: "/tmp/a", oldText: oversized, newText: oversized },
      ],
    });

    assert.equal(decoded.type, "turn");
    if (decoded.type !== "turn" || decoded.payload.type !== "tool_call_update") return;
    assert.equal(decoded.payload.replayProofUnavailable, true);
    assert.equal(decoded.payload.title?.length, ACP_V1_CODEC_LIMITS.maxStringLength);
    assert.equal(decoded.payload.title?.endsWith("\n…"), true);
    const [text, diff] = decoded.payload.content ?? [];
    assert.equal(text?.type, "text");
    if (text?.type === "text") {
      assert.equal(text.text.length, ACP_V1_CODEC_LIMITS.maxStringLength);
      assert.equal(text.text.endsWith("\n…"), true);
    }
    assert.equal(diff?.type, "diff");
    if (diff?.type === "diff") {
      assert.equal(diff.oldText?.length, ACP_V1_CODEC_LIMITS.maxStringLength);
      assert.equal(diff.newText.length, ACP_V1_CODEC_LIMITS.maxStringLength);
    }
  });

  it("keeps oversized ACP routing identity fatal", () => {
    assert.throws(
      () => decodeUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength + 1),
        status: "completed",
      }),
      hasCodecCode("string_limit_exceeded"),
    );
  });

  it("rejects unpaired UTF-16 surrogates before runtime persistence", () => {
    for (const toolCallId of ["\ud800", "\ud801", "\udc00"]) {
      assert.throws(
        () => decodeUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Read package",
        }),
        hasCodecCode("invalid_value"),
      );
    }
    assert.doesNotThrow(() => decodeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "emoji-\ud83d\ude80",
      title: "Read package",
    }));
  });

  it("keeps mixed tool content order, admits bounded images and redacts other non-text blocks", () => {
    const decoded = decodeUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tool-mixed",
      title: "Mixed output",
      content: [
        { type: "content", content: { type: "text", text: "before" } },
        {
          type: "content",
          content: {
            type: "image",
            data: "AQID",
            mimeType: "image/png",
            uri: "file:///tmp/preview.png",
          },
        },
        {
          type: "content",
          content: {
            type: "audio",
            data: "AUDIO_SECRET",
            mimeType: "audio/wav",
          },
        },
        {
          type: "content",
          content: {
            type: "resource_link",
            name: "Link",
            uri: "file:///tmp/link-secret",
          },
        },
        {
          type: "content",
          content: {
            type: "resource",
            resource: {
              uri: "file:///tmp/text-secret",
              text: "RAW_RESOURCE_BODY",
            },
          },
        },
        { type: "diff", path: "/tmp/a", newText: "after" },
        { type: "terminal", terminalId: "terminal-1" },
      ],
    });
    assert.equal(decoded.type, "turn");
    if (decoded.type !== "turn" || decoded.payload.type !== "tool_call_create") return;
    assert.deepEqual(decoded.payload.content, [
      { type: "text", text: "before" },
      {
        type: "media",
        mediaType: "image",
        mimeType: "image/png",
        base64Data: "AQID",
        uri: "file:///tmp/preview.png",
      },
      { type: "unsupported", contentType: "audio" },
      { type: "unsupported", contentType: "resource_link" },
      { type: "unsupported", contentType: "resource" },
      { type: "diff", path: "/tmp/a", newText: "after" },
      { type: "terminal", terminalId: "terminal-1" },
    ]);
    assert.equal(decoded.payload.replayProofUnavailable, true);
    const normalized = JSON.stringify(decoded.payload);
    for (const secret of [
      "AUDIO_SECRET",
      "link-secret",
      "text-secret",
      "RAW_RESOURCE_BODY",
    ]) {
      assert.equal(normalized.includes(secret), false);
    }
    assert.equal(normalized.includes("AQID"), true);
    for (const data of ["AQID", "BAUG"]) {
      const image = decodeUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tool-image",
        title: "Image",
        content: [{
          type: "content",
          content: { type: "image", data, mimeType: "image/png" },
        }],
      });
      assert.equal(image.type === "turn" && image.payload.type === "tool_call_create"
        ? image.payload.replayProofUnavailable === true
        : true, false);
      assert.equal(JSON.stringify(image).includes(data), true);
    }
    assert.throws(
      () =>
        decodeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tool-bad",
          title: "Malformed",
          content: [{ type: "content", content: { type: "image", mimeType: "image/png" } }],
        }),
      hasCodecCode("missing_field"),
    );
  });

  it("requires absolute lexically canonical diff and location paths", () => {
    for (const update of [
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-relative-diff",
        title: "Bad diff",
        content: [{ type: "diff", path: "relative.txt", newText: "x" }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-parent-diff",
        title: "Bad diff",
        content: [{ type: "diff", path: "/tmp/a/../b", newText: "x" }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-relative-location",
        title: "Bad location",
        locations: [{ path: "relative.txt" }],
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-parent-location",
        title: "Bad location",
        locations: [{ path: "/tmp/a/../b" }],
      },
    ]) {
      assert.throws(() => decodeUpdate(update), hasCodecCode("invalid_value"));
    }
  });

  it("classifies all five session-context update families outside the turn timeline", () => {
    const updates = [
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
      },
      { sessionUpdate: "current_mode_update", currentModeId: "default" },
      {
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "thinking", name: "Thinking", type: "boolean", currentValue: true },
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "fast",
            options: [{ value: "fast", name: "Fast" }],
          },
        ],
      },
      { sessionUpdate: "session_info_update", title: "Task", updatedAt: null },
      {
        sessionUpdate: "usage_update",
        used: 10,
        size: 100,
        cost: { amount: 0.25, currency: "USD" },
      },
    ];
    const kinds = ["commands", "mode", "config", "info", "usage"];
    updates.forEach((update, index) => {
      const decoded = decodeUpdate(update);
      assert.equal(decoded.type, "session_context");
      if (decoded.type !== "session_context") return;
      assert.equal(decoded.payload.context.kind, kinds[index]);
      assert.equal(Object.isFrozen(decoded.payload.context), true);
      if (decoded.payload.context.kind === "commands") {
        assert.deepEqual(decoded.payload.context.commands, [
          { name: "plan", description: "Create a plan", inputHint: "topic" },
        ]);
      }
      if (decoded.payload.context.kind === "usage") {
        assert.equal(decoded.payload.context.scope, "session_context_window_and_cost");
        assert.equal(Object.hasOwn(decoded.payload.context, "allowance"), false);
        assert.equal(Object.hasOwn(decoded.payload.context, "reset"), false);
      }
    });
  });

  it("returns ignored_extension for unknown discriminators but rejects malformed known updates", () => {
    assert.deepEqual(
      decodeUpdate({ sessionUpdate: "vendor/progress", arbitrary: { safeToIgnore: true } }),
      { type: "ignored_extension", sessionId: "session-1", discriminator: "vendor/progress" },
    );
    assert.deepEqual(
      decodeUpdate({
        sessionUpdate: "plan",
        entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
      }),
      {
        type: "turn",
        payload: {
          type: "plan",
          sessionId: "session-1",
          received,
          entries: [{ content: "Inspect", priority: "high", status: "in_progress" }],
        },
      },
    );
    assert.throws(
      () => decodeUpdate({ sessionUpdate: "plan", entries: [{ content: "Inspect" }] }),
      hasCodecCode("missing_field"),
    );
    assert.throws(
      () => decodeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text" } }),
      hasCodecCode("missing_field"),
    );
    assert.throws(
      () => decodeUpdate({ sessionUpdate: "usage_update", used: "10", size: 100 }),
      AcpV1CodecError,
    );
  });

  it("rejects missing or wrong session IDs", () => {
    assert.throws(
      () =>
        decodeSessionUpdate(
          { update: { sessionUpdate: "current_mode_update", currentModeId: "default" } },
          "session-1",
          received,
        ),
      hasCodecCode("missing_field"),
    );
    assert.throws(
      () =>
        decodeSessionUpdate(
          notification({ sessionUpdate: "current_mode_update", currentModeId: "default" }, "session-2"),
          "session-1",
          received,
        ),
      hasCodecCode("session_id_mismatch"),
    );
  });
});

describe("ACP v1 prompt terminal and permission callbacks", () => {
  it("maps all five prompt stop reasons truthfully", () => {
    const expected = {
      end_turn: "completed",
      max_tokens: "truncated",
      max_turn_requests: "truncated",
      refusal: "refused",
      cancelled: "cancelled",
    } as const;
    for (const [stopReason, classification] of Object.entries(expected)) {
      const terminal = decodePromptResult({ stopReason, extension: true }, "session-1", received);
      assert.equal(terminal.stopReason, stopReason);
      assert.equal(terminal.classification, classification);
    }
    assert.throws(
      () => decodePromptResult({ stopReason: "finished" }, "session-1", received),
      hasCodecCode("invalid_value"),
    );
  });

  it("admits exact official Grok prompt metadata without requiring a window-size estimate", () => {
    const terminal = decodePromptResult({
      stopReason: "end_turn",
      _meta: {
        totalTokens: 25_523,
        inputTokens: 25_477,
        outputTokens: 44,
        usage: { totalTokens: 25_521, modelCalls: 1 },
      },
    }, "session-1", received);
    assert.equal(terminal.contextTokensUsed, 25_523);
    assert.equal(Object.hasOwn(decodePromptResult({
      stopReason: "end_turn",
      _meta: { totalTokens: "25523" },
    }, "session-1", received), "contextTokensUsed"), false);
    assert.equal(Object.hasOwn(decodePromptResult({
      stopReason: "end_turn",
      _meta: { usage: { totalTokens: 25_521 } },
    }, "session-1", received), "contextTokensUsed"), false);
  });

  it("preserves string, safe integer, and null callback IDs", () => {
    const ids = ["callback-1", 7, 0, -2, null] as const;
    for (const id of ids) {
      const request = decodePermissionRequest(id, permissionParams(), "session-1", received);
      assert.equal(request.callbackRequestId, id);
    }
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, true, {}]) {
      assert.throws(
        () => decodePermissionRequest(id, permissionParams(), "session-1", received),
        hasCodecCode("invalid_request_id"),
      );
    }
  });

  it("accepts all four option kinds and freezes exact options", () => {
    const request = decodePermissionRequest(
      "callback-1",
      permissionParams({
        options: [
          { optionId: "once", name: "Once", kind: "allow_once" },
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
          { optionId: "never", name: "Never", kind: "reject_always" },
        ],
        _meta: { ignored: true },
      }),
      "session-1",
      received,
    );
    assert.deepEqual(
      request.options.map((option) => option.kind),
      ["allow_once", "allow_always", "reject_once", "reject_always"],
    );
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.options), true);
    assert.equal(Object.isFrozen(request.options[0]), true);
    assert.equal(Object.hasOwn(request, "_meta"), false);
  });

  it("rejects duplicate/empty option IDs and malformed known option fields", () => {
    assert.throws(
      () =>
        decodePermissionRequest(
          1,
          permissionParams({
            options: [
              { optionId: "same", name: "One", kind: "allow_once" },
              { optionId: "same", name: "Two", kind: "reject_once" },
            ],
          }),
          "session-1",
          received,
        ),
      hasCodecCode("duplicate_option_id"),
    );
    for (const option of [
      { optionId: "", name: "Empty", kind: "allow_once" },
      { optionId: "id", kind: "allow_once" },
      { optionId: "id", name: "Bad", kind: "allow" },
    ]) {
      assert.throws(
        () =>
          decodePermissionRequest(
            1,
            permissionParams({ options: [option] }),
            "session-1",
            received,
          ),
        AcpV1CodecError,
      );
    }
  });

  it("encodes only an exact advertised selection or the standard cancelled outcome", () => {
    const request = decodePermissionRequest(1, permissionParams(), "session-1", received);
    assert.deepEqual(encodeSelectedPermissionResult(request, "allow"), {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    assert.throws(
      () => encodeSelectedPermissionResult(request, "invented"),
      hasCodecCode("option_not_advertised"),
    );
    assert.deepEqual(encodeCancelledPermissionResult(), { outcome: { outcome: "cancelled" } });
  });

  it("rejects a permission callback for a different or missing session", () => {
    assert.throws(
      () =>
        decodePermissionRequest(
          1,
          permissionParams({ sessionId: "session-2" }),
          "session-1",
          received,
        ),
      hasCodecCode("session_id_mismatch"),
    );
    const missing = permissionParams() as Record<string, unknown>;
    delete missing["sessionId"];
    assert.throws(
      () => decodePermissionRequest(1, missing, "session-1", received),
      hasCodecCode("missing_field"),
    );
  });
});

describe("ACP v1 parser bounds", () => {
  it("tolerates bounded empty extension keys without retaining them", () => {
    assert.deepEqual(
      decodeNewSessionResult({ sessionId: "session-1", _meta: { "": 1 } }),
      { sessionId: "session-1" },
    );
  });

  it("enforces the exported string bound", () => {
    assert.throws(
      () => encodeTextPromptParams("session-1", "x".repeat(ACP_V1_CODEC_LIMITS.maxStringLength + 1)),
      hasCodecCode("string_limit_exceeded"),
    );
  });

  it("separates the retained-text and bounded wire-media ceilings", () => {
    assert.ok(
      ACP_V1_CODEC_LIMITS.maxWireStringLength >= Math.ceil((8 * 1024 * 1024) / 3) * 4,
    );
    const legalWireData = Buffer
      .alloc(Math.ceil((ACP_V1_CODEC_LIMITS.maxStringLength + 1) * 3 / 4), 0)
      .toString("base64");
    const decoded = decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: legalWireData, mimeType: "image/png" },
    });
    assert.deepEqual(decoded, {
      type: "media_content",
      sessionId: "session-1",
      discriminator: "agent_message_chunk",
      mediaType: "image",
      mimeType: "image/png",
      base64Data: legalWireData,
    });

    const atDecodedLimit = Buffer.alloc(ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes, 0)
      .toString("base64");
    assert.equal(decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: atDecodedLimit, mimeType: "image/png" },
    }).type, "media_content");

    const aboveDecodedLimit = Buffer.alloc(ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes + 1, 0)
      .toString("base64");
    assert.deepEqual(decodeUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: "oversized-image",
      content: { type: "image", data: aboveDecodedLimit, mimeType: "image/png" },
    }), {
      type: "unsupported_content",
      sessionId: "session-1",
      discriminator: "agent_message_chunk",
      contentType: "image",
      messageId: "oversized-image",
    });

    assert.throws(
      () =>
        decodeUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            data: "x".repeat(ACP_V1_CODEC_LIMITS.maxWireStringLength + 1),
            mimeType: "image/png",
          },
        }),
      hasCodecCode("wire_string_limit_exceeded"),
    );
  });

  it("enforces the exported permission-option bound", () => {
    assert.throws(
      () =>
        decodePermissionRequest(
          1,
          permissionParams({
            options: Array.from({ length: ACP_V1_CODEC_LIMITS.maxPermissionOptions + 1 }, (_, index) => ({
              optionId: `option-${index}`,
              name: "Option",
              kind: "allow_once",
            })),
          }),
          "session-1",
          received,
        ),
      hasCodecCode("collection_limit_exceeded"),
    );
  });

  it("enforces the exported content-collection bound", () => {
    assert.throws(
      () =>
        decodeUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Large",
          content: Array.from(
            { length: ACP_V1_CODEC_LIMITS.maxContentCollectionItems + 1 },
            () => ({ type: "content", content: { type: "text", text: "x" } }),
          ),
        }),
      hasCodecCode("collection_limit_exceeded"),
    );
  });

  it("discards oversized raw tool extensions before applying normalized payload bounds", () => {
    const rawOutput: Record<string, number> = {};
    for (let index = 0; index <= ACP_V1_CODEC_LIMITS.maxAggregateValues; index += 1) {
      rawOutput[`raw-${index}`] = index;
    }
    const decoded = decodeUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
      _meta: { rawOutput },
    });
    assert.equal(decoded.type, "turn");
    if (decoded.type !== "turn") assert.fail("tool update was not a turn");
    assert.deepEqual(decoded.payload, {
      type: "tool_call_update",
      sessionId: "session-1",
      received,
      toolCallId: "tool-1",
      status: "completed",
    });
  });

  it("enforces the exported nesting bound on extension data", () => {
    let nested: unknown = null;
    for (let index = 0; index <= ACP_V1_CODEC_LIMITS.maxNestingDepth; index += 1) {
      nested = { child: nested };
    }
    assert.throws(
      () => decodeNewSessionResult({ sessionId: "session-1", extension: nested }),
      hasCodecCode("nesting_limit_exceeded"),
    );
  });

  it("enforces the exported aggregate-value bound on extension data", () => {
    const extension: Record<string, number> = {};
    for (let index = 0; index < ACP_V1_CODEC_LIMITS.maxAggregateValues; index += 1) {
      extension[`key-${index}`] = index;
    }
    assert.throws(
      () => decodeNewSessionResult({ sessionId: "session-1", extension }),
      hasCodecCode("aggregate_limit_exceeded"),
    );
  });

  it("rejects non-finite numbers without echoing raw extension values", () => {
    const secret = "sensitive-extension-value";
    assert.throws(
      () => decodeNewSessionResult({ sessionId: "session-1", extension: { [secret]: Number.NaN } }),
      (cause) =>
        cause instanceof AcpV1CodecError &&
        cause.code === "invalid_value" &&
        !cause.message.includes(secret),
    );
  });
});
