import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCompat } from "./compat.js";
import type { JsonObject, JsonValue } from "./json.js";

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function messagesOf(result: { body: JsonObject }): JsonObject[] {
  return result.body.messages as JsonObject[];
}

function reminder(text: string): JsonObject {
  return { type: "text", text: `<system-reminder>\n${text}\n</system-reminder>` };
}

const toolUse: JsonObject = { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } };
const toolResult: JsonObject = { type: "tool_result", tool_use_id: "toolu_1", content: "file body" };

describe("compat layer: system-role messages", () => {
  it("removes system messages and inserts one reminder after the tool_result blocks", () => {
    const body: JsonObject = {
      model: "m",
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [toolUse] },
        { role: "system", content: "Remember rule A" },
        { role: "user", content: [{ type: "text", text: "extra context" }, toolResult] },
      ],
    };
    const result = applyCompat(body);
    const messages = messagesOf(result);
    assert.equal(messages.length, 3);
    assert.equal(result.stats.systemMessages, 1);
    assert.deepEqual(messages[2]?.content, [
      toolResult,
      reminder("Remember rule A"),
      { type: "text", text: "extra context" },
    ]);
    assert.equal(messages.some((message) => message.role === "system"), false);
  });

  it("puts the reminder before a plain string user message", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "question" },
      ],
    });
    assert.deepEqual(messagesOf(result), [
      { role: "user", content: [reminder("S"), { type: "text", text: "question" }] },
    ]);
  });

  it("joins several queued system messages into a single reminder and skips assistant turns", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "system", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
        { role: "assistant", content: [{ type: "text", text: "hm" }] },
        { role: "system", content: "three" },
        { role: "user", content: "go" },
      ],
    });
    const messages = messagesOf(result);
    assert.equal(result.stats.systemMessages, 2);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1]?.content, [reminder("one\ntwo\n\nthree"), { type: "text", text: "go" }]);
  });

  it("appends a trailing user message when no user message follows", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "a" }] },
        { role: "system", content: "late note" },
      ],
    });
    const messages = messagesOf(result);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[2], { role: "user", content: [reminder("late note")] });
  });

  it("merges a trailing reminder into the preceding tool_result user message in order", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [toolResult] },
        { role: "system", content: "after results" },
      ],
    });
    const messages = messagesOf(result);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1]?.content, [toolResult, reminder("after results")]);
  });

  it("does not insert an empty reminder", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "hi" },
      ],
    });
    assert.deepEqual(messagesOf(result), [{ role: "user", content: "hi" }]);
  });
});

describe("compat layer: tools", () => {
  const readTool = { name: "Read", description: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } };
  const bashTool = { name: "Bash", description: "bash", input_schema: { type: "object" }, defer_loading: true };

  it("moves tool_addition definitions into tools, deduping against non-deferred tools only", () => {
    const body: JsonObject = {
      model: "m",
      tools: [readTool, bashTool],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Read", description: "dup", input_schema: {} } } },
            { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Bash", description: "bash2", input_schema: { type: "object" }, defer_loading: true } } },
            { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Grep", description: "grep", input_schema: { type: "object" } } } },
            { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Grep", description: "again", input_schema: {} } } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "tool_addition", tool: { definition: { name: "Glob", input_schema: { type: "object" } } } },
            { type: "text", text: "ok" },
          ],
        },
      ],
    };
    const result = applyCompat(body);
    assert.deepEqual(
      (result.body.tools as JsonObject[]).map((tool) => tool.name),
      ["Read", "Bash", "Grep", "Glob"],
    );
    assert.equal(result.stats.toolAdditions, 3);
    assert.equal(result.stats.deferredDropped, 1);
    assert.deepEqual(messagesOf(result)[0]?.content, [{ type: "text", text: "hi" }]);
    assert.deepEqual(messagesOf(result)[1]?.content, [{ type: "text", text: "ok" }]);
    const bash = (result.body.tools as JsonObject[])[1];
    assert.deepEqual(bash, { name: "Bash", description: "bash2", input_schema: { type: "object" } });
  });

  it("collects tool_addition blocks carried by system messages", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "note" },
            { type: "tool_addition", tool: { definition: { name: "Edit", description: "e", input_schema: {} } } },
          ],
        },
        { role: "user", content: "go" },
      ],
    });
    assert.deepEqual((result.body.tools as JsonObject[]).map((tool) => tool.name), ["Edit"]);
  });

  it("drops deferred tools and keeps only name, description, input_schema and a non-custom type", () => {
    const result = applyCompat({
      model: "m",
      tools: [
        readTool,
        bashTool,
        { type: "custom", name: "Custom", description: "c", input_schema: {}, strict: true },
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    assert.deepEqual(result.body.tools, [
      { name: "Read", description: "read", input_schema: { type: "object" } },
      { name: "Custom", description: "c", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    assert.equal(result.stats.deferredDropped, 1);
  });

  it("removes the tools field when nothing remains", () => {
    const result = applyCompat({ model: "m", tools: [bashTool], messages: [{ role: "user", content: "hi" }] });
    assert.equal(Object.hasOwn(result.body, "tools"), false);
    const none = applyCompat({ model: "m", messages: [{ role: "user", content: "hi" }] });
    assert.equal(Object.hasOwn(none.body, "tools"), false);
  });
});

describe("compat layer: top-level fields, merging and empty content", () => {
  it("removes context_management and output_config and keeps everything else", () => {
    const result = applyCompat({
      model: "m",
      max_tokens: 64,
      stream: true,
      system: [{ type: "text", text: "sys" }],
      thinking: { type: "enabled", budget_tokens: 1024 },
      context_management: { edits: [] },
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(Object.hasOwn(result.body, "context_management"), false);
    assert.equal(Object.hasOwn(result.body, "output_config"), false);
    assert.equal(result.body.max_tokens, 64);
    assert.equal(result.body.stream, true);
    assert.deepEqual(result.body.system, [{ type: "text", text: "sys" }]);
    assert.deepEqual(result.body.thinking, { type: "enabled", budget_tokens: 1024 });
  });

  it("merges consecutive same-role messages and puts tool_result blocks first in user messages", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "assistant", content: [toolUse] },
        { role: "user", content: [{ type: "text", text: "note" }] },
        { role: "user", content: "string part" },
        { role: "user", content: [toolResult] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
      ],
    });
    const messages = messagesOf(result);
    assert.equal(messages.length, 3);
    assert.equal(result.stats.mergedMessages, 3);
    assert.deepEqual(messages[1]?.content, [
      toolResult,
      { type: "text", text: "note" },
      { type: "text", text: "string part" },
    ]);
    assert.deepEqual(messages[2]?.content, [
      { type: "text", text: "a1" },
      { type: "text", text: "a2" },
    ]);
  });

  it("orders tool_result first even in a single user message", () => {
    const result = applyCompat({
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "t" }, toolResult] }],
    });
    assert.deepEqual(messagesOf(result)[0]?.content, [toolResult, { type: "text", text: "t" }]);
  });

  it("turns empty content into an (empty) text block", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "user", content: [] },
        { role: "assistant", content: "" },
        { role: "user", content: [{ type: "tool_addition", tool: { definition: { name: "X", input_schema: {} } } }] },
      ],
    });
    const empty = [{ type: "text", text: "(empty)" }];
    assert.deepEqual(messagesOf(result).map((message) => message.content), [empty, empty, empty]);
    assert.equal(result.stats.emptyFilled, 3);
  });

  it("does not turn a message emptied by tool_addition removal into text when it merges", () => {
    const result = applyCompat({
      model: "m",
      messages: [
        { role: "user", content: "before" },
        { role: "user", content: [{ type: "tool_addition", tool: { definition: { name: "X", input_schema: {} } } }] },
      ],
    });
    assert.deepEqual(messagesOf(result), [{ role: "user", content: [{ type: "text", text: "before" }] }]);
    assert.equal(result.stats.emptyFilled, 0);
  });

  it("never mutates its input", () => {
    const body: JsonObject = {
      model: "m",
      tools: [{ name: "A", description: "a", input_schema: {}, defer_loading: true }],
      context_management: {},
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: [{ type: "tool_addition", tool: { definition: { name: "B", input_schema: {} } } }, toolResult] },
        { role: "user", content: "again" },
      ],
    };
    const before = clone(body);
    applyCompat(body);
    assert.deepEqual(body, before);
  });
});
