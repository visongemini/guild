import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { RuntimeConfigOption } from "@guild/contracts";
import {
  AcpV1CodecError,
  decodeInitializeResult,
  decodeNewSessionResult,
  decodePromptResult,
  decodeSessionUpdate,
  deriveClaudeModelCatalog,
  encodeInitializeParams,
  encodeNewSessionParams,
  encodeResumeSessionParams,
  isClaudeModelId,
} from "./acp-v1-codec.js";
import {
  decodeClaudeAuthStatus,
  decodeClaudeSteeringResult,
  encodeClaudeSteeringParams,
} from "./claude-dialect.js";

type FixtureFrame = { readonly dir: "->" | "<-"; readonly msg: Record<string, unknown> };
const frames = (JSON.parse(
  readFileSync(new URL("../src/fixtures/claude-acp-0.89.1-session.json", import.meta.url), "utf8"),
) as { readonly frames: readonly FixtureFrame[] }).frames;
const inbound = (predicate: (message: Record<string, unknown>) => boolean): Record<string, unknown> => {
  const found = frames.find((frame) => frame.dir === "<-" && predicate(frame.msg));
  assert.ok(found !== undefined);
  return found.msg;
};
const initializeResult = inbound((message) => message["id"] === 1)["result"];
const sessionResult = inbound((message) => message["id"] === 2)["result"];
const promptResult = inbound((message) => message["id"] === 3)["result"];

const received = { wallClockIso: "2026-10-12T00:00:00.000Z", monotonicMs: 1 };

function select(
  id: string,
  category: string,
  currentValue: string,
  options: readonly Record<string, unknown>[],
): RuntimeConfigOption {
  return {
    id,
    name: id,
    category,
    type: "select",
    currentValue,
    choices: { form: "flat", options },
  } as unknown as RuntimeConfigOption;
}

describe("Claude dialect: initialize decoding", () => {
  it("decodes the recorded adapter result", () => {
    const decoded = decodeInitializeResult(initializeResult, "claude");
    assert.equal(decoded.agentCapabilities.loadSession, true);
    assert.equal(decoded.agentCapabilities.resumeSession, true);
    assert.deepEqual(decoded.agentCapabilities.prompt, { image: true, audio: false, embeddedContext: true });
    assert.deepEqual(decoded.authMethods, []);
    assert.deepEqual(decoded.mcpCapabilities, { http: true, sse: true });
    assert.deepEqual(decoded.steering, { supported: true });
    assert.equal(decoded.agentInfo?.version, "0.89.1");
    assert.equal(decoded.modelCatalog, undefined, "Claude has no _meta.modelState");
    assert.equal(decoded.unusableAuthMethodCount, undefined);
  });

  it("counts ignored non-agent auth methods and keeps agent ones", () => {
    const decoded = decodeInitializeResult({
      protocolVersion: 1,
      authMethods: [
        { id: "login", name: "Log in", type: "terminal", args: ["--cli"], env: { SECRET: "x" } },
        { id: "agent-method", name: "Agent method" },
        { id: "future", name: "Future", type: "env_var" },
      ],
    }, "claude");
    assert.deepEqual(decoded.authMethods.map((method) => method.id), ["agent-method"]);
    assert.equal(decoded.unusableAuthMethodCount, 2);
    assert.equal(JSON.stringify(decoded).includes("SECRET"), false);
  });

  it("still refuses a terminal auth method for the Grok dialect", () => {
    const input = { protocolVersion: 1, authMethods: [{ id: "login", name: "Log in", type: "terminal" }] };
    assert.throws(() => decodeInitializeResult(input), AcpV1CodecError);
    assert.throws(() => decodeInitializeResult(input, "grok"), AcpV1CodecError);
  });

  it("reads mcp and steering capabilities for either dialect only when advertised, tolerating bad shapes", () => {
    assert.equal(Object.hasOwn(decodeInitializeResult({ protocolVersion: 1 }), "mcpCapabilities"), false);
    assert.equal(Object.hasOwn(decodeInitializeResult({ protocolVersion: 1 }), "steering"), false);
    const grok = decodeInitializeResult({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: { http: true } },
    });
    assert.deepEqual(grok.mcpCapabilities, { http: true, sse: false });
    const malformed = decodeInitializeResult({
      protocolVersion: 1,
      agentCapabilities: { mcpCapabilities: "yes" },
      _meta: { steering: { supported: "yes" } },
    }, "claude");
    assert.equal(malformed.mcpCapabilities, undefined);
    assert.equal(malformed.steering, undefined);
  });

  it("sends no optional client capability for Claude and the Grok capabilities as before", () => {
    assert.deepEqual(encodeInitializeParams("claude").clientCapabilities, {});
    assert.deepEqual(encodeInitializeParams().clientCapabilities, { session: { configOptions: { boolean: {} } } });
    assert.deepEqual(encodeInitializeParams("grok"), encodeInitializeParams());
  });
});

describe("Claude dialect: session decoding and the model catalog", () => {
  it("decodes the recorded session/new result, deriving the catalog from config options", () => {
    const decoded = decodeNewSessionResult(sessionResult, "claude");
    assert.equal(decoded.sessionId, "b9b4ee19-8ea2-486a-ba0a-81f46577b4ef");
    assert.equal(decoded.modes?.availableModes.length, 5);
    assert.equal(decoded.configOptions?.length, 4);
    assert.equal(decoded.modelCatalog?.models.length, 12);
    assert.equal(decoded.modelCatalog?.runtimeDefaultModelId, "default");
    assert.equal(Object.isFrozen(decoded.modelCatalog), true);
    for (const model of decoded.modelCatalog?.models ?? []) {
      assert.equal(isClaudeModelId(model.id), true, model.id);
      assert.deepEqual(model.contextWindows, [], "the window comes from usage_update");
    }
  });

  it("leaves the Grok dialect untouched by a Claude-shaped result", () => {
    const decoded = decodeNewSessionResult(sessionResult, "grok");
    assert.equal(decoded.modelCatalog, undefined);
    assert.equal(decoded.contextWindowSize, undefined);
    assert.equal(decoded.configOptions?.length, 4);
  });

  it("attaches efforts to the selected model only and moves them when the selection moves", () => {
    const effort = select("effort", "thought_level", "high", [
      { value: "low", name: "Low" },
      { value: "high", name: "High", description: "More thinking" },
    ]);
    const models = [{ value: "opus", name: "Opus" }, { value: "haiku", name: "Haiku" }];
    const onOpus = deriveClaudeModelCatalog([select("model", "model", "opus", models), effort]);
    assert.deepEqual(onOpus?.models.map((model) => model.reasoningEfforts.length), [2, 0]);
    assert.equal(onOpus?.models[0]?.reasoningEfforts[1]?.description, "More thinking");
    const onHaiku = deriveClaudeModelCatalog([select("model", "model", "haiku", models)]);
    assert.deepEqual(onHaiku?.models.map((model) => model.reasoningEfforts.length), [0, 0]);
    assert.equal(onHaiku?.runtimeDefaultModelId, "haiku");
  });

  it("accepts routed ids with brackets, grouped choices, and skips unusable entries", () => {
    const grouped = {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "deepseek-v4[1m]",
      choices: {
        form: "grouped",
        groups: [
          { group: "claude", name: "Claude", options: [{ value: "opus", name: "Opus" }, { value: "opus", name: "Duplicate" }] },
          { group: "online", name: "Online", options: [{ value: "deepseek-v4[1m]", name: "DeepSeek V4" }, { value: "has space", name: "Bad" }, { value: "-bad", name: "Bad" }] },
        ],
      },
    } as unknown as RuntimeConfigOption;
    const catalog = deriveClaudeModelCatalog([grouped]);
    assert.deepEqual(catalog?.models.map((model) => model.id), ["opus", "deepseek-v4[1m]"]);
    assert.equal(catalog?.runtimeDefaultModelId, "deepseek-v4[1m]");
  });

  it("returns nothing without a usable model option and sanitizes display text", () => {
    assert.equal(deriveClaudeModelCatalog([]), undefined);
    assert.equal(deriveClaudeModelCatalog([select("effort", "thought_level", "low", [{ value: "low", name: "Low" }])]), undefined);
    assert.equal(deriveClaudeModelCatalog([select("model", "model", "x", [{ value: "bad id", name: "Bad" }])]), undefined);
    const odd = deriveClaudeModelCatalog([select("model", "model", "missing", [
      { value: "opus", name: "Opus\u0000\n5", description: "x".repeat(2_000) },
    ])]);
    assert.equal(odd?.models[0]?.name, "Opus  5");
    assert.equal(odd?.models[0]?.description?.length, 512);
    assert.equal(odd?.runtimeDefaultModelId, undefined, "a current value outside the list is not a default");
  });

  it("recognizes the Claude model id grammar", () => {
    for (const id of ["default", "opus", "claude-opus-4-8", "deepseek-v4[1m]", "a", "a".repeat(128), "Qwen3.8:27b"]) {
      assert.equal(isClaudeModelId(id), true, id);
    }
    for (const id of ["", "-x", "[x]", "a b", "a/b", "a".repeat(129), "a\nb"]) {
      assert.equal(isClaudeModelId(id), false, id);
    }
  });
});

describe("Claude dialect: session start encoding", () => {
  it("keeps Grok's session/new byte-for-byte and adds mcpServers only when given", () => {
    assert.deepEqual(encodeNewSessionParams("/tmp/project"), { cwd: "/tmp/project", mcpServers: [] });
    assert.deepEqual(
      encodeNewSessionParams("/tmp/project", { reasoningEffort: "high" }),
      { cwd: "/tmp/project", mcpServers: [], _meta: { reasoningEffort: "high" } },
    );
    assert.deepEqual(
      encodeResumeSessionParams("s-1", "/tmp/project", { reasoningEffort: "low" }),
      { sessionId: "s-1", cwd: "/tmp/project", mcpServers: [], _meta: { reasoningEffort: "low" } },
    );
    assert.throws(() => encodeNewSessionParams("/tmp/project", { claudeCodeOptions: {} }), AcpV1CodecError);
  });

  it("encodes claudeCodeOptions as _meta.claudeCode.options and drops reasoningEffort for Claude", () => {
    const options = { settings: { modelPicker: { options: [{ model: "m", label: "M" }] } } };
    assert.deepEqual(
      encodeNewSessionParams("/tmp/project", { claudeCodeOptions: options, reasoningEffort: "high" }, "claude"),
      { cwd: "/tmp/project", mcpServers: [], _meta: { claudeCode: { options } } },
    );
    assert.deepEqual(
      encodeResumeSessionParams("s-1", "/tmp/project", undefined, "claude"),
      { sessionId: "s-1", cwd: "/tmp/project", mcpServers: [] },
    );
    assert.throws(
      () => encodeNewSessionParams("/tmp/project", { claudeCodeOptions: { n: Number.NaN } }, "claude"),
      AcpV1CodecError,
    );
  });

  it("validates MCP servers: http(s) only, bounded, with named headers", () => {
    const server = { type: "http" as const, name: "guild-browser", url: "http://127.0.0.1:1234/t/mcp", headers: [{ name: "X-Test", value: "1" }] };
    assert.deepEqual(
      (encodeNewSessionParams("/tmp/project", { mcpServers: [server] }, "claude") as { mcpServers: unknown }).mcpServers,
      [server],
    );
    for (const bad of [
      { ...server, type: "stdio" },
      { ...server, url: "ftp://example.com/" },
      { ...server, url: "not a url" },
      { ...server, name: "" },
      { ...server, headers: [{ name: "X" }] },
    ]) {
      assert.throws(
        () => encodeNewSessionParams("/tmp/project", { mcpServers: [bad as unknown as typeof server] }, "claude"),
        AcpV1CodecError,
        JSON.stringify(bad),
      );
    }
    assert.throws(
      () => encodeNewSessionParams("/tmp/project", { mcpServers: Array.from({ length: 17 }, () => server) }, "claude"),
      AcpV1CodecError,
    );
  });
});

describe("Claude dialect: turn decoding", () => {
  it("decodes the recorded prompt result without a context token count", () => {
    const terminal = decodePromptResult(promptResult, "b9b4ee19-8ea2-486a-ba0a-81f46577b4ef", received);
    assert.equal(terminal.stopReason, "end_turn");
    assert.equal(terminal.classification, "completed");
    assert.equal(Object.hasOwn(terminal, "contextTokensUsed"), false);
  });

  it("decodes the recorded usage and title updates", () => {
    const usage = decodeSessionUpdate(
      inbound((message) => (message["params"] as { update?: { sessionUpdate?: string; cost?: unknown } } | undefined)?.update?.cost !== undefined)["params"],
      "b9b4ee19-8ea2-486a-ba0a-81f46577b4ef",
      received,
    );
    assert.ok(usage.type === "session_context" && usage.payload.context.kind === "usage");
    assert.equal(usage.payload.context.size, 1_000_000);
    assert.deepEqual(usage.payload.context.cost, { amount: 0.2111584, currency: "USD" });
    const info = decodeSessionUpdate(
      inbound((message) => (message["params"] as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === "session_info_update")["params"],
      "b9b4ee19-8ea2-486a-ba0a-81f46577b4ef",
      received,
    );
    assert.ok(info.type === "session_context" && info.payload.context.kind === "info");
    assert.equal(info.payload.context.title, "Fixture OK");
  });
});

describe("Claude dialect: account summary and steering wire", () => {
  it("keeps only kind, label and plan of _auth/status_update", () => {
    const recorded = inbound((message) => message["method"] === "_auth/status_update")["params"];
    assert.deepEqual(decodeClaudeAuthStatus(recorded), { kind: "account", label: "Claude Max", plan: "max" });
    const serialized = JSON.stringify(decodeClaudeAuthStatus(recorded));
    assert.equal(serialized.includes("example.com"), false);
    assert.equal(serialized.includes("Organization"), false);
    assert.deepEqual(decodeClaudeAuthStatus({ authStatus: { kind: "api key!" } }), { kind: "api_key_" });
    assert.deepEqual(
      decodeClaudeAuthStatus({ authStatus: { kind: "account", label: "  \u0007Pro\n ", account: { plan: 3 } } }),
      { kind: "account", label: "Pro" },
    );
    for (const bad of [undefined, null, "x", [], {}, { authStatus: null }, { authStatus: {} }, { authStatus: { kind: "" } }, { authStatus: { kind: 3 } }]) {
      assert.equal(decodeClaudeAuthStatus(bad), undefined, JSON.stringify(bad));
    }
    assert.equal(decodeClaudeAuthStatus({ authStatus: { kind: "account", label: "x".repeat(500) } })?.label?.length, 64);
  });

  it("encodes the steering request and decodes only known outcomes", () => {
    assert.deepEqual(encodeClaudeSteeringParams("s-1", "go left"), {
      sessionId: "s-1",
      prompt: [{ type: "text", text: "go left" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    });
    for (const outcome of ["injected", "promptRequired", "startedNewTurn"]) {
      assert.equal(decodeClaudeSteeringResult({ outcome }), outcome);
    }
    for (const bad of [undefined, null, {}, { outcome: "other" }, { outcome: 1 }, "injected", []]) {
      assert.equal(decodeClaudeSteeringResult(bad), undefined, JSON.stringify(bad));
    }
  });
});
