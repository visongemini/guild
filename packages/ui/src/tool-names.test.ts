import assert from "node:assert/strict";
import test from "node:test";
import { messagesFor } from "./locales.js";
import { classifyToolName } from "./tool-names.js";

test("the runtime's tool names map to what they do, whatever their spelling", () => {
  for (const name of ["Read", "read_file", "ReadFile", "view"]) assert.equal(classifyToolName(name), "read", name);
  for (const name of ["Bash", "run_terminal_command", "run-terminal-command", "shell"]) assert.equal(classifyToolName(name), "execute", name);
  for (const name of ["edit", "Edit", "write", "write_file", "MultiEdit", "apply_patch"]) assert.equal(classifyToolName(name), "edit", name);
  for (const name of ["search", "grep", "Grep", "glob", "Glob", "web_search"]) assert.equal(classifyToolName(name), "search", name);
  assert.equal(classifyToolName("web_fetch"), "fetch");
});

test("an unknown or missing name stays unclassified", () => {
  assert.equal(classifyToolName("mcp__figma__get_design"), undefined);
  assert.equal(classifyToolName("constructor"), undefined, "prototype keys are not tool names");
  assert.equal(classifyToolName("__proto__"), undefined);
  assert.equal(classifyToolName(undefined), undefined);
  assert.equal(classifyToolName(""), undefined);
});

test("phase labels say what the tool does in Chinese, and stay generic for an unknown tool", () => {
  const zh = messagesFor("zh-CN");
  assert.equal(zh.runPhaseRunningTool("Read"), "正在读取");
  assert.equal(zh.runPhaseRunningTool("run_terminal_command"), "正在运行命令");
  assert.equal(zh.runPhaseRunningTool("edit"), "正在修改");
  assert.equal(zh.runPhaseRunningTool("write"), "正在修改");
  assert.equal(zh.runPhaseRunningTool("search"), "正在搜索");
  assert.equal(zh.runPhaseRunningTool("grep"), "正在搜索");
  assert.equal(zh.runPhaseRunningTool("glob"), "正在搜索");
  assert.equal(zh.runPhaseRunningTool("figma_get_design"), "正在运行工具");
  assert.equal(zh.runPhaseRunningTool(undefined), "正在运行工具");
  assert.equal(zh.runPhasePreparingTool("Read"), "准备读取");
  assert.equal(zh.runPhasePreparingTool("Bash"), "准备运行命令");
  assert.equal(zh.runPhasePreparingTool("figma_get_design"), "正在准备工具");
  assert.equal(zh.runPhasePreparingTool(undefined), "正在准备工具");
});

test("the English labels keep the runtime's own tool name", () => {
  const en = messagesFor("en-US");
  assert.equal(en.runPhaseRunningTool("Bash"), "Running Bash");
  assert.equal(en.runPhasePreparingTool("Read"), "Preparing tool Read");
});
