import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalModelSourceBaseUrl,
  looksLikeSecret,
  modelSourceHost,
  parseModelSourceDraft,
  parseModelSourceId,
  parseModelSourceKeyFile,
  parseModelSourceKeyVariable,
} from "./model-sources.js";

const online = {
  id: "deepseek",
  kind: "online",
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  keyFile: null,
  keyVariable: "DEEPSEEK_API_KEY",
  models: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 128_000, supportsImages: false },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
  ],
  enabled: true,
};

const local = {
  id: "workstation",
  kind: "local",
  label: "Workstation llama.cpp",
  baseUrl: "http://127.0.0.1:8081",
  keyFile: null,
  keyVariable: null,
  models: [{ id: "local-27b-model", label: "Local 27B" }],
  enabled: true,
};

const rejects = (patch: Record<string, unknown>, base: Record<string, unknown> = online) =>
  assert.throws(() => parseModelSourceDraft({ ...base, ...patch }), TypeError, JSON.stringify(patch));

test("an Online and a Local source parse into a frozen canonical draft", () => {
  const parsed = parseModelSourceDraft(online);
  assert.deepEqual(parsed, online);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.models), true);
  assert.equal(Object.isFrozen(parsed.models[0]), true);
  assert.deepEqual(parseModelSourceDraft(local), local);
  assert.equal(
    parseModelSourceDraft({ ...online, keyFile: "/Users/owner/.config/guild/keys.env" }).keyFile,
    "/Users/owner/.config/guild/keys.env",
  );
  assert.equal(parseModelSourceDraft({ ...online, label: "  Padded  " }).label, "Padded");
});

test("a request can name no key value, no confirmed host and no extra field (PC-ROUTE-002)", () => {
  for (const extra of [
    { apiKey: "x" },
    { key: "y" },
    { token: "z" },
    { confirmedHost: "api.deepseek.com" },
    { headers: {} },
    { revision: 1 },
  ]) rejects(extra);
  assert.throws(() => parseModelSourceDraft({ ...online, models: [{ id: "deepseek-v4-flash", label: "x", apiKey: "k" }] }), TypeError);
  const { enabled: _enabled, ...withoutEnabled } = online;
  assert.throws(() => parseModelSourceDraft(withoutEnabled), TypeError);
  for (const notObject of [null, undefined, "deepseek", [online], 7]) {
    assert.throws(() => parseModelSourceDraft(notObject), TypeError);
  }
});

test("an Online base URL is https; a Local one is http or https; nothing carries user info, a query or a fragment", () => {
  assert.equal(canonicalModelSourceBaseUrl("online", "https://api.deepseek.com/anthropic/"), "https://api.deepseek.com/anthropic");
  assert.equal(canonicalModelSourceBaseUrl("online", "https://API.Example.com:443/v1"), "https://api.example.com/v1");
  assert.equal(canonicalModelSourceBaseUrl("local", "http://127.0.0.1:8081/"), "http://127.0.0.1:8081");
  assert.equal(canonicalModelSourceBaseUrl("local", "https://workstation.tailnet.ts.net:8443/"), "https://workstation.tailnet.ts.net:8443");
  assert.equal(canonicalModelSourceBaseUrl("local", "http://[::1]:11434"), "http://[::1]:11434");
  for (const bad of [
    "http://api.deepseek.com/anthropic",
    "ftp://api.deepseek.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "api.deepseek.com",
    "//api.deepseek.com",
    "https://",
    "https://user:pass@api.deepseek.com",
    "https://user@api.deepseek.com",
    "https://api.deepseek.com/anthropic?key=abc",
    "https://api.deepseek.com/anthropic#frag",
    "https://api.deepseek.com/@scope/anthropic",
    "https://api.deepseek.com/\n",
    `https://example.com/${"a".repeat(2_048)}`,
    "https://api.anthropic.com",
    "https://API.Anthropic.com./v1",
    "https://claude.ai/api",
    "https://gateway.claude.com",
    "",
    7,
    null,
  ]) {
    assert.throws(() => canonicalModelSourceBaseUrl("online", bad), /invalid_model_source_base_url/u, String(bad));
  }
  for (const bad of ["ws://127.0.0.1:8081", "http://user:pw@127.0.0.1", "http://127.0.0.1?x=1"]) {
    assert.throws(() => canonicalModelSourceBaseUrl("local", bad), /invalid_model_source_base_url/u, bad);
  }
  rejects({ baseUrl: "http://api.deepseek.com" });
  assert.equal(modelSourceHost("https://api.deepseek.com/anthropic"), "api.deepseek.com");
  assert.equal(modelSourceHost("http://127.0.0.1:8081"), "127.0.0.1:8081");
});

test("the key variable is an upper-case name and a key file is an absolute path with a variable", () => {
  for (const good of ["DEEPSEEK_API_KEY", "_X", "K", "A1_B2", "A".repeat(64)]) {
    assert.equal(parseModelSourceKeyVariable(good), good);
  }
  for (const bad of [
    "", "deepseek_key", "Key", "1KEY", "KEY-NAME", "KEY NAME", "$KEY", "A".repeat(65),
    "sk-ant-api03-abcdefghijkl", "MY_sk-abcdefghij", "KEY=value", 3, null, undefined,
  ]) {
    assert.throws(() => parseModelSourceKeyVariable(bad), /invalid_model_source_key_variable/u, String(bad));
  }
  for (const good of ["/Users/owner/keys.env", "/etc/guild/keys.env", "C:\\Users\\owner\\keys.env", "D:/keys.env"]) {
    assert.equal(parseModelSourceKeyFile(good), good);
  }
  for (const bad of [
    "", "keys.env", "./keys.env", "~/.config/guild/keys.env", "../keys.env", "/a/../b",
    "/a\0b", "/a\nb", `/${"a".repeat(4_096)}`, "/Users/owner/sk-ant-api03-abcdefghijkl", 4, null,
  ]) {
    assert.throws(() => parseModelSourceKeyFile(bad), /invalid_model_source_key_file/u, String(bad));
  }
  // A key file without a variable names nothing to read.
  rejects({ keyFile: "/Users/owner/keys.env", keyVariable: null });
  rejects({ keyFile: "/Users/owner/keys.env", keyVariable: null }, local);
  rejects({ keyVariable: "sk-ant-api03-abcdefghijkl" });
});

test("an Online source must name its key variable; only a Local source may go without a key (PC-ROUTE-002)", () => {
  // A keyless Online source would send the conversation to a remote vendor with nothing to confirm.
  rejects({ keyVariable: null });
  rejects({ keyVariable: null, keyFile: null });
  assert.throws(() => parseModelSourceDraft({ ...online, keyVariable: null }), /invalid_model_source_key_variable/u);
  // The key file stays optional: null is the default key file.
  assert.equal(parseModelSourceDraft({ ...online, keyFile: null }).keyFile, null);
  assert.equal(parseModelSourceDraft({ ...online, keyFile: "/Users/owner/keys.env" }).keyVariable, "DEEPSEEK_API_KEY");
  // A Local source keeps both shapes: keyless, or keyed.
  assert.equal(parseModelSourceDraft(local).keyVariable, null);
  assert.equal(parseModelSourceDraft({ ...local, keyVariable: "WORKSTATION_KEY" }).keyVariable, "WORKSTATION_KEY");
  // The kind decides: the same draft is a valid Local source and an invalid Online one.
  assert.throws(() => parseModelSourceDraft({ ...local, kind: "online", baseUrl: "https://workstation.example.com" }), TypeError);
});

test("ids, labels and model lists are bounded and refuse anything that looks like a credential", () => {
  for (const good of ["a", "deepseek", "Local_1", "ds.v2", "x".repeat(64)]) assert.equal(parseModelSourceId(good), good);
  for (const bad of ["", "-x", ".x", "a b", "a/b", "x".repeat(65), "caf\u00e9", 1, null]) {
    assert.throws(() => parseModelSourceId(bad), /invalid_model_source_id/u, String(bad));
  }
  rejects({ id: "a/b" });
  rejects({ kind: "remote" });
  rejects({ label: "" });
  rejects({ label: "   " });
  rejects({ label: "x".repeat(81) });
  rejects({ label: "line\nbreak" });
  rejects({ label: "key sk-ant-api03-abcdefghijkl" });
  rejects({ enabled: "yes" });
  rejects({ models: [] });
  rejects({ models: "deepseek-v4-flash" });
  rejects({ models: Array.from({ length: 65 }, (_, i) => ({ id: `m-${i}`, label: `M ${i}` })) });
  assert.equal(
    parseModelSourceDraft({ ...online, models: Array.from({ length: 64 }, (_, i) => ({ id: `m-${i}`, label: `M ${i}` })) }).models.length,
    64,
  );
  for (const model of [
    { id: "", label: "x" },
    { id: "has space", label: "x" },
    { id: "a/b", label: "x" },
    { id: "x".repeat(129), label: "x" },
    { id: "sk-abcdefghijkl", label: "x" },
    { id: "ok", label: "" },
    { id: "ok", label: "x".repeat(129) },
    { id: "ok", label: "x", contextWindow: 0 },
    { id: "ok", label: "x", contextWindow: 1.5 },
    { id: "ok", label: "x", contextWindow: 100_000_001 },
    { id: "ok", label: "x", supportsImages: "no" },
  ]) {
    rejects({ models: [model] });
  }
  rejects({ models: [{ id: "dup", label: "a" }, { id: "dup", label: "b" }] });
});

test("the credential heuristic flags key-shaped text and leaves names and addresses alone", () => {
  for (const secret of [
    "sk-ant-api03-abcdefghijkl",
    "token sk-abcdef123456",
    "x:sk-proj_abcdef123456",
    "Bearer abcdefghijkl",
    "bearer   abcdefgh12345",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc",
  ]) {
    assert.equal(looksLikeSecret(secret), true, secret);
  }
  for (const fine of [
    "deepseek-v4-flash",
    "DEEPSEEK_API_KEY",
    "https://api.deepseek.com/anthropic",
    "/Users/owner/.config/guild/keys.env",
    "task-runner",
    "disk-cache",
    "Local 27B",
    "sk",
    "sk-",
    "sk-short",
  ]) {
    assert.equal(looksLikeSecret(fine), false, fine);
  }
});
