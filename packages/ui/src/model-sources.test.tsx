import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ModelSourceProjection } from "@guild/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { messagesFor } from "./locales.js";
import { ModelSourcesSettings } from "./ModelSourcesSettings.js";
import {
  draftFromForm,
  emptySourceForm,
  formFromSource,
  newSourceId,
  sourceHost,
  sourceStatus,
  validateSourceForm,
  type SourceForm,
} from "./model-sources-form.js";

const EN = messagesFor("en-US");
const ZH = messagesFor("zh-CN");

const online = (patch: Partial<ModelSourceProjection> = {}): ModelSourceProjection => Object.freeze({
  id: "deepseek",
  kind: "online",
  label: "DeepSeek",
  baseUrl: "https://api.example.com/anthropic",
  keyFile: null,
  keyVariable: "EXAMPLE_API_KEY",
  models: Object.freeze([{ id: "model-a", label: "Model A", contextWindow: 128000, supportsImages: true }, { id: "model-b", label: "Model B" }]),
  enabled: true,
  confirmedHost: "api.example.com",
  ...patch,
});
const local = (patch: Partial<ModelSourceProjection> = {}) => online({
  id: "llama", kind: "local", label: "llama.cpp", baseUrl: "http://127.0.0.1:8080", keyVariable: null, confirmedHost: null,
  models: Object.freeze([{ id: "local-a", label: "Local A" }]), ...patch,
});

const valid = (patch: Partial<SourceForm> = {}): SourceForm => Object.freeze({
  ...emptySourceForm("online"),
  label: "DeepSeek",
  baseUrl: "https://api.example.com/anthropic",
  keyVariable: "EXAMPLE_API_KEY",
  models: Object.freeze([{ id: "model-a", label: "Model A", contextWindow: "", supportsImages: false }]),
  ...patch,
});
const problems = (form: SourceForm) => validateSourceForm(form).map((issue) => `${issue.field}${issue.row === undefined ? "" : `#${issue.row}`}:${issue.problem}`);

test("a source is confirmed only while the confirmed host is the host of its address, and disabled beats both", () => {
  assert.equal(sourceStatus(online()), "confirmed");
  assert.equal(sourceStatus(online({ confirmedHost: null })), "needs_confirmation");
  assert.equal(sourceStatus(online({ baseUrl: "https://other.example.com/x" })), "needs_confirmation");
  assert.equal(sourceStatus(online({ enabled: false })), "disabled");
  assert.equal(sourceStatus(online({ enabled: false, confirmedHost: null })), "disabled");
  assert.equal(sourceHost("http://127.0.0.1:8080/v1"), "127.0.0.1:8080");
  assert.equal(sourceHost("not a url"), undefined);
  assert.equal(sourceStatus(local({ confirmedHost: "127.0.0.1:8080" })), "confirmed");
});

test("a complete form passes; its draft has trimmed fields, null for the default key file, and no secret anywhere", () => {
  assert.deepEqual(validateSourceForm(valid()), []);
  const draft = draftFromForm(valid({ label: "  DeepSeek  ", keyFile: "  ", models: [
    { id: " model-a ", label: " Model A ", contextWindow: "128000", supportsImages: true },
    { id: "", label: "", contextWindow: "", supportsImages: false },
  ] }), []);
  assert.deepEqual(draft, {
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.example.com/anthropic",
    keyFile: null,
    keyVariable: "EXAMPLE_API_KEY",
    models: [{ id: "model-a", label: "Model A", contextWindow: 128000, supportsImages: true }],
    enabled: true,
  });
  assert.deepEqual(Object.keys(draft).sort(), ["baseUrl", "enabled", "id", "keyFile", "keyVariable", "kind", "label", "models"]);
  assert.equal(draftFromForm(valid({ keyFile: "/Users/me/keys.env" }), []).keyFile, "/Users/me/keys.env");
  assert.equal(draftFromForm(valid({ id: "kept-id" }), ["kept-id"]).id, "kept-id", "an edit keeps its id");
});

test("an Online source needs https; a Local one may use http; credentials, queries and fragments are refused", () => {
  assert.deepEqual(problems(valid({ baseUrl: "http://api.example.com" })), ["baseUrl:base_url_https"]);
  assert.deepEqual(problems(valid({ kind: "local", baseUrl: "http://127.0.0.1:8080", keyVariable: "" })), []);
  assert.deepEqual(problems(valid({ baseUrl: "" })), ["baseUrl:base_url"]);
  assert.deepEqual(problems(valid({ baseUrl: "api.example.com" })), ["baseUrl:base_url"]);
  assert.deepEqual(problems(valid({ baseUrl: "ftp://api.example.com" })), ["baseUrl:base_url"]);
  assert.deepEqual(problems(valid({ baseUrl: "https://user:pw@api.example.com" })), ["baseUrl:base_url"]);
  assert.deepEqual(problems(valid({ baseUrl: "https://api.example.com/x?key=1" })), ["baseUrl:base_url"]);
  assert.deepEqual(problems(valid({ baseUrl: "https://api.example.com/x#frag" })), ["baseUrl:base_url"]);
});

test("the key designation is a variable name and an absolute file path, never a key", () => {
  assert.deepEqual(problems(valid({ keyVariable: "" })), ["keyVariable:key_variable"]);
  assert.deepEqual(problems(valid({ kind: "local", baseUrl: "http://127.0.0.1:1", keyVariable: "", keyFile: "/a/keys.env" })), ["keyVariable:key_variable"]);
  assert.deepEqual(problems(valid({ keyVariable: "lowercase" })), ["keyVariable:key_variable"]);
  assert.deepEqual(problems(valid({ keyVariable: "sk-abcdef0123456789" })), ["keyVariable:key_variable_secret"]);
  assert.deepEqual(problems(valid({ keyVariable: "Bearer abcdefgh12345678" })), ["keyVariable:key_variable_secret"]);
  assert.deepEqual(problems(valid({ keyVariable: "A".repeat(65) })), ["keyVariable:key_variable_secret"]);
  assert.deepEqual(problems(valid({ keyFile: "~/.config/guild/keys.env" })), ["keyFile:key_file"]);
  assert.deepEqual(problems(valid({ keyFile: "relative/keys.env" })), ["keyFile:key_file"]);
  assert.deepEqual(problems(valid({ keyFile: "/a/../b/keys.env" })), ["keyFile:key_file"]);
  assert.deepEqual(problems(valid({ keyFile: "/Users/me/.config/keys.env" })), []);
});

test("models need unique ids in the Claude grammar, a name, and an optional positive context window; blank rows are ignored", () => {
  assert.deepEqual(problems(valid({ models: [] })), ["models:models"]);
  assert.deepEqual(problems(valid({ models: [{ id: "", label: "", contextWindow: "", supportsImages: false }] })), ["models:models"]);
  const rows = (...ids: string[]) => ids.map((id) => ({ id, label: id === "" ? "" : "Name", contextWindow: "", supportsImages: false }));
  assert.deepEqual(problems(valid({ models: rows("a", "a") })), ["modelId#1:model_duplicate"]);
  assert.deepEqual(problems(valid({ models: rows("bad id") })), ["modelId#0:model_id"]);
  assert.deepEqual(problems(valid({ models: rows("a/b") })), ["modelId#0:model_id"]);
  assert.deepEqual(problems(valid({ models: [{ id: "a", label: "", contextWindow: "", supportsImages: false }] })), ["modelLabel#0:model_label"]);
  for (const bad of ["0", "-5", "1.5", "abc", "1e3", "100000001"]) {
    assert.deepEqual(problems(valid({ models: [{ id: "a", label: "A", contextWindow: bad, supportsImages: false }] })), ["modelContext#0:model_context"], bad);
  }
  assert.deepEqual(problems(valid({ models: [{ id: "claude-x[1m]", label: "A", contextWindow: "1000000", supportsImages: true }] })), []);
});

test("a new source gets an id from its name that is unique among the existing ones", () => {
  assert.equal(newSourceId("DeepSeek", []), "deepseek");
  assert.equal(newSourceId("DeepSeek", ["deepseek"]), "deepseek-2");
  assert.equal(newSourceId("DeepSeek", ["deepseek", "deepseek-2"]), "deepseek-3");
  assert.equal(newSourceId("My Local llama.cpp!", []), "my-local-llama.cpp");
  assert.equal(newSourceId("本地模型", []), "source");
  assert.equal(newSourceId("---", ["source"]), "source-2");
  assert.match(newSourceId("x".repeat(100), []), /^[a-z0-9][a-z0-9._-]{0,63}$/u);
});

test("editing starts from the stored source: empty strings for the unset key fields, the same id", () => {
  const form = formFromSource(online());
  assert.equal(form.id, "deepseek");
  assert.equal(form.keyFile, "");
  assert.equal(form.models[0]?.contextWindow, "128000");
  assert.equal(form.models[0]?.supportsImages, true);
  assert.equal(form.models[1]?.contextWindow, "");
  assert.deepEqual(validateSourceForm(form), []);
  assert.deepEqual(draftFromForm(form, ["deepseek"]).models, online().models);
});

const noopApi = {
  listModelSources: async () => ({ sources: [] }),
  upsertModelSource: async () => { throw new Error("not called"); },
  deleteModelSource: async () => { throw new Error("not called"); },
  confirmModelSource: async () => { throw new Error("not called"); },
};
const render = (props: Partial<Parameters<typeof ModelSourcesSettings>[0]> = {}, messages = EN) => renderToStaticMarkup(
  <ModelSourcesSettings messages={messages} api={noopApi as never} onChanged={() => undefined} {...props} />,
);

test("the list shows each source with its type and status chip, its host and model count, and the right actions", () => {
  const markup = render({ initialSources: [online(), local(), online({ id: "off", label: "Parked", enabled: false })] });
  assert.match(markup, /Online and Local models appear in the picker of Claude conversations\./u);
  assert.equal(markup.match(/class="guild-source-row"/gu)?.length, 3);
  assert.match(markup, /<strong>DeepSeek<\/strong><span class="guild-source-chip kind online">Online<\/span><span class="guild-source-chip status confirmed">Confirmed<\/span>/u);
  assert.match(markup, /<strong>llama\.cpp<\/strong><span class="guild-source-chip kind local">Local<\/span><span class="guild-source-chip status needs_confirmation">Needs confirmation<\/span>/u);
  assert.match(markup, /<strong>Parked<\/strong>[^]*?guild-source-chip status disabled">Disabled</u);
  assert.match(markup, /<code title="https:\/\/api\.example\.com\/anthropic">api\.example\.com<\/code><span>2 models<\/span>/u);
  assert.match(markup, /<code title="http:\/\/127\.0\.0\.1:8080">127\.0\.0\.1:8080<\/code><span>1 model<\/span>/u);
  // Only the source that needs it offers Confirm, with the host and (when there is one) the variable named.
  assert.equal(markup.match(/>Confirm<\/button>/gu)?.length, 1);
  assert.match(markup, /Guild will open a system window asking you to confirm that requests may be sent to 127\.0\.0\.1:8080\./u);
  assert.equal(markup.match(/>Edit<\/button>/gu)?.length, 3);
  assert.equal(markup.match(/>Delete<\/button>/gu)?.length, 3);
  assert.match(markup, /Add model source<\/button>/u);
  assert.doesNotMatch(markup, /<input/u);
});

test("an Online source that needs confirmation names the key variable and the host", () => {
  const markup = render({ initialSources: [online({ confirmedHost: null })] });
  assert.match(markup, /confirm that the key in EXAMPLE_API_KEY may be sent to api\.example\.com\./u);
});

test("empty and loading states are stated", () => {
  assert.match(render({ initialSources: [] }), /No model sources yet\./u);
  assert.match(render(), /role="status"><svg[^>]*>.*Loading model sources/u);
  assert.match(render({ initialSources: [] }, ZH), /还没有模型源/u);
});

test("the add form has every field, explains where keys live, and takes no key value", () => {
  const markup = render({ initialSources: [], initialForm: emptySourceForm("online") });
  assert.match(markup, /Add model source/u);
  for (const label of ["Type", "Name", "Base URL", "Key file", "Key variable", "Models", "Enabled"]) {
    assert.ok(markup.includes(`>${label}</`), `${label} field`);
  }
  assert.match(markup, /role="radiogroup"[^>]*>.*?aria-checked="true"[^>]*>Online</u);
  assert.match(markup, /Online sources must use https\./u);
  assert.match(markup, /placeholder="~\/\.config\/guild\/keys\.env"/u);
  assert.match(markup, /Leave empty to use the default file\./u);
  assert.match(markup, /Guild reads its value from the key file in the background and never shows or saves it\. Enter only the name of the key variable, never the key itself\./u);
  for (const column of ["Model ID", "Display name", "Context window", "Images"]) assert.ok(markup.includes(`>${column}</span>`), column);
  assert.match(markup, />Add model<\/button>/u);
  assert.match(markup, /aria-label="Enabled" aria-pressed="true"/u);
  assert.match(markup, />Cancel<\/button>/u);
  assert.match(markup, />Save<\/button>/u);
  // No password, secret or API-key input exists anywhere in the tab.
  assert.doesNotMatch(markup, /type="password"|name="api[-_ ]?key"|placeholder="sk-/iu);
  // Four fields plus the id, name and context window of the one model row; nothing else takes text.
  assert.equal(markup.match(/type="text"/gu)?.length, 4 + 3);
});

test("a Local source form changes the address hint and the placeholder", () => {
  const markup = render({ initialSources: [], initialForm: emptySourceForm("local") });
  assert.match(markup, /Local sources may use http or https and must be on this Mac or your Tailscale network\./u);
  assert.match(markup, /placeholder="http:\/\/127\.0\.0\.1:8080"/u);
});

test("problems are shown next to the field they belong to", () => {
  const form = valid({ baseUrl: "http://api.example.com", keyVariable: "sk-abcdef0123456789", models: [{ id: "bad id", label: "", contextWindow: "x", supportsImages: false }] });
  const markup = render({ initialSources: [], initialForm: form, initialIssues: validateSourceForm(form) });
  assert.match(markup, /<p class="guild-source-error" id="[^"]+-url-error" role="alert">Online sources must use https\.<\/p>/u);
  assert.match(markup, /Enter the name of the variable, not the key itself\./u);
  assert.match(markup, /A model ID may contain letters, digits and \. _ : \[ \] - and starts with a letter or digit\./u);
  assert.match(markup, /aria-invalid="true"/u);
});

test("a notice after saving asks for the confirmation, and the confirmation outcomes are worded", () => {
  assert.match(render({ initialSources: [online({ confirmedHost: null })], initialNotice: { kind: "needs_confirmation", label: "DeepSeek" } }),
    /role="status">“DeepSeek” is saved\. Confirm its address and key variable before it can be used\./u);
  assert.match(render({ initialSources: [], initialNotice: { kind: "confirmed" } }), /guild-setting-help success" role="status">Confirmed\./u);
  assert.match(render({ initialSources: [], initialNotice: { kind: "cancelled" } }), /guild-setting-help blocked" role="status">Not confirmed\. The source cannot be used yet\./u);
});

test("saving, confirming and deleting call the matching API, and a source needing confirmation is confirmed through main", async () => {
  const source = await readFile(new URL("../src/ModelSourcesSettings.tsx", import.meta.url), "utf8");
  assert.match(source, /api\.upsertModelSource\(draftFromForm\(form, \(sources \?\? \[\]\)\.map\(\(source\) => source\.id\)\)\)/u);
  assert.match(source, /response\.needsConfirmation\s*\n\s*\? Object\.freeze\(\{ kind: "needs_confirmation", label: response\.source\.label \}\)/u);
  assert.match(source, /api\.confirmModelSource\(\{ id: source\.id \}\)/u);
  assert.match(source, /api\.deleteModelSource\(\{ id: source\.id \}\)/u);
  assert.match(source, /api\.listModelSources\(\)/u);
  // Validation runs before anything is sent, and a confirmation is never started on the person's behalf.
  assert.ok(source.indexOf("validateSourceForm(form)") < source.indexOf("api.upsertModelSource("));
  assert.doesNotMatch(source.slice(source.indexOf("async function save()"), source.indexOf("async function confirm(")), /confirmModelSource/u);
  // The form never holds a key value.
  assert.doesNotMatch(source, /type="password"|apiKey/iu);
});
