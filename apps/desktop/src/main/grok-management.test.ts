import assert from "node:assert/strict";
import test from "node:test";
import type { RunGrokManagementRequest } from "@guild/contracts";
import {
  buildGrokManagementCommand,
  sanitizeManagementOutput,
} from "./grok-management.js";

test("management actions map to literal official argv without a shell or transport escape", () => {
  const command = buildGrokManagementCommand({
    action: "mcp_add",
    confirmed: true,
    parameters: {
      name: "sentry",
      transport: "http",
      scope: "project",
      endpoint: "https://mcp.example.test/mcp",
      env: ["LOCAL_MODE=1"],
      headers: ["Authorization: Bearer private-value"],
    },
  });
  assert.deepEqual(command.args, [
    "mcp", "add", "--transport", "http", "--scope", "project",
    "--env", "LOCAL_MODE=1",
    "--header", "Authorization: Bearer private-value",
    "sentry", "https://mcp.example.test/mcp",
  ]);
  assert.equal(command.mutating, true);
  assert.equal(command.requiresConfirmation, true);
  assert.deepEqual(command.redactValues, ["Bearer private-value"]);
  for (const forbidden of ["serve", "headless", "--xai-api-base-url", "--cli-chat-proxy-base-url", "--leader-socket", "--debug-file"]) {
    assert.equal(command.args.includes(forbidden), false, forbidden);
  }
});

test("each action rejects parameters outside its typed GUI contract", () => {
  assert.throws(() => buildGrokManagementCommand({
    action: "version",
    parameters: { argv: ["agent", "serve"] },
  }), /unexpected_grok_management_parameter_argv/u);
  assert.throws(() => buildGrokManagementCommand({
    action: "clone",
    parameters: { url: "--help" },
  }), /invalid_grok_management_url/u);
  assert.throws(() => buildGrokManagementCommand({
    action: "session_export",
    parameters: {
      sessionId: "12345678-abcd-4abc-8abc-1234567890ab",
      output: "relative/session.md",
    },
  }), /invalid_grok_management_output/u);
  assert.throws(() => buildGrokManagementCommand({
    action: "sessions_search",
    parameters: { query: "--help" },
  }), /invalid_grok_management_query/u);
  assert.throws(() => buildGrokManagementCommand({
    action: "marketplace_update",
    parameters: { name: "--force" },
  }), /invalid_grok_management_name/u);
});

test("destructive official operations require a second explicit confirmation", () => {
  assert.throws(() => buildGrokManagementCommand({
    action: "session_delete",
    parameters: { sessionId: "12345678-abcd-4abc-8abc-1234567890ab" },
  }), /confirmation_required/u);
  const confirmed = buildGrokManagementCommand({
    action: "session_delete",
    confirmed: true,
    parameters: { sessionId: "12345678-abcd-4abc-8abc-1234567890ab" },
  });
  assert.deepEqual(confirmed.args, ["sessions", "delete", "12345678-abcd-4abc-8abc-1234567890ab"]);
  assert.equal(confirmed.requiresConfirmation, true);
});

test("listing doctor fixes is read-only while applying one is explicit", () => {
  const listing = buildGrokManagementCommand({ action: "doctor_fixes" });
  assert.deepEqual(listing.args, ["doctor", "fix"]);
  assert.equal(listing.mutating, false);
  assert.throws(() => buildGrokManagementCommand({
    action: "doctor_fix",
    parameters: { id: "terminal" },
  }), /confirmation_required/u);
});

test("representative actions cover runtime, plugins, sessions, worktrees, diagnostics, and clone", () => {
  const requests: readonly RunGrokManagementRequest[] = [
    { action: "version" },
    { action: "update_check" },
    { action: "plugin_details", parameters: { name: "example-plugin" } },
    { action: "sessions_search", parameters: { query: "release", limit: 20 } },
    { action: "session_export", parameters: { sessionId: "12345678-abcd-4abc-8abc-1234567890ab", output: "/tmp/session.md" } },
    { action: "worktree_gc_preview", parameters: { maxAge: "7d" } },
    { action: "worktree_salvage", confirmed: true, parameters: { id: "wt-1", output: "/tmp/salvage" } },
    { action: "doctor" },
    { action: "setup_preview" },
    { action: "clone", parameters: { url: "https://example.test/repo.git", directory: "/tmp/repo", cones: ["src", "docs"] } },
  ];
  const commands = requests.map((request) => buildGrokManagementCommand(request));
  assert.deepEqual(commands.map((command) => command.args[0]), [
    "--version", "update", "plugin", "sessions", "export", "worktree", "worktree", "doctor", "setup", "clone",
  ]);
  assert.deepEqual(commands[9]?.args, ["clone", "--cone", "src", "--cone", "docs", "https://example.test/repo.git", "/tmp/repo"]);
});

test("management output redacts MCP environment and credential material", () => {
  const output = sanitizeManagementOutput("mcp_list", JSON.stringify([{
    name: "database",
    command: "npx",
    env: { DATABASE_URL: "postgres://secret@host/db", MODE: "dev" },
    authorization: "Bearer abc",
  }]));
  assert.match(output, /"DATABASE_URL": "<configured>"/u);
  assert.match(output, /"authorization": "<redacted>"/u);
  assert.equal(output.includes("postgres://secret"), false);
  assert.equal(output.includes("Bearer abc"), false);
  assert.equal(sanitizeManagementOutput("mcp_list", '{"authorization":"Bearer partial'), "");
  assert.equal(
    sanitizeManagementOutput("version", '"Authorization": "Bearer visible"'),
    '"Authorization": "<redacted>"',
  );
});

test("model management never reintroduces excluded external providers", () => {
  const output = sanitizeManagementOutput("models", [
    "You are logged in with grok.com.",
    "2026-08-30 WARN Settings fetch network error: retry",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
    "  - MiniMax-M3",
    "  - ornith-1.5-35b-a3b-unc",
  ].join("\n"));
  assert.match(output, /grok-4\.6/u);
  assert.match(output, /grok-4\.5/u);
  assert.equal(output.includes("MiniMax"), false);
  assert.equal(output.includes("ornith"), false);
  assert.equal(output.includes("Settings fetch"), false);
});
