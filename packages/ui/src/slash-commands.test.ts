import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bundledSlashCommands,
  matchingSlashCommands,
  slashCommandCatalogue,
  slashCommandQuery,
  slashCommandText,
} from "./slash-commands.js";

const commands = Object.freeze([
  Object.freeze({ name: "context", description: "Show context" }),
  Object.freeze({ name: "compact", description: "Compact history" }),
  Object.freeze({ name: "plan", description: "Create a plan", inputHint: "topic" }),
]);

describe("slash command composer", () => {
  it("opens only for a slash command at the start of the draft", () => {
    assert.equal(slashCommandQuery("/"), "");
    assert.equal(slashCommandQuery("/CON"), "con");
    assert.equal(slashCommandQuery(" /con"), undefined);
    assert.equal(slashCommandQuery("/plan topic"), undefined);
    assert.equal(slashCommandQuery("question /context"), undefined);
  });

  it("filters the official command list without inventing commands", () => {
    assert.deepEqual(matchingSlashCommands(commands, "/con"), [commands[0]]);
    assert.deepEqual(matchingSlashCommands(commands, "/co"), [commands[0], commands[1]]);
    assert.deepEqual(matchingSlashCommands(commands, "/unknown"), []);
  });

  it("executes argument-free commands and leaves an input slot when requested", () => {
    assert.equal(slashCommandText(commands[0]!), "/context");
    assert.equal(slashCommandText(commands[2]!), "/plan ");
  });

  it("shows the bundled core catalogue immediately until ACP returns the live list", () => {
    const bundled = bundledSlashCommands("zh-CN");
    assert.ok(bundled.length >= 15);
    assert.equal(bundled.find((command) => command.name === "goal")?.inputHint,
      "目标 | status | pause | resume | clear");
    assert.equal(slashCommandCatalogue([], "zh-CN"), bundledSlashCommands("zh-CN"));
    assert.equal(slashCommandCatalogue(commands, "zh-CN"), commands);
    assert.equal(bundled.some((command) => command.name === "ai-kids-lesson"), false);
  });
});
