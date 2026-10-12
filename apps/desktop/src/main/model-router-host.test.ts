import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { openGuildPersistence, type GuildPersistence } from "@guild/persistence";
import type { ModelSourceDraft } from "@guild/contracts";
import { createModelRouterHost, type ModelRouterHost, type ModelRouterHostStore } from "./model-router-host.js";

// PC-ROUTE-001, PC-ROUTE-002: which sources the router serves, which key goes where, and that nothing
// secret is logged. Every upstream is a fake fetch, so no test touches the network or a real key file.

type Call = {
  readonly via: "proxied" | "direct";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
  readonly credentials: RequestInit["credentials"];
  readonly redirect: RequestInit["redirect"];
};

const ONLINE_URL = "https://api.vendor.test/anthropic";
const LOCAL_URL = "http://127.0.0.1:8081";

function jsonResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], ...extra }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type Harness = {
  readonly dir: string;
  readonly store: GuildPersistence;
  readonly calls: Call[];
  readonly logs: { readonly event: string; readonly fields: Record<string, string | number | boolean> }[];
  readonly defaultKeyFile: string;
  readonly host: ModelRouterHost;
  /** What the fake upstream answers; tests replace `respond`. */
  readonly state: { respond: (call: Call) => Response | Promise<Response> };
};

function harness(t: TestContext, wrapStore?: (store: GuildPersistence) => ModelRouterHostStore): Harness {
  const dir = mkdtempSync(join(tmpdir(), "guild-router-host-"));
  const store = openGuildPersistence({ path: join(dir, "guild.sqlite3") });
  const calls: Call[] = [];
  const logs: Harness["logs"][number][] = [];
  const defaultKeyFile = join(dir, "default-keys.env");
  const state = { respond: (_call: Call): Response | Promise<Response> => jsonResponse() };
  const transport = (via: Call["via"]): typeof fetch => async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const call: Call = {
      via,
      url: String(input),
      headers,
      body: JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as Record<string, unknown>,
      credentials: init?.credentials,
      redirect: init?.redirect,
    };
    calls.push(call);
    return state.respond(call);
  };
  const host = createModelRouterHost({
    store: wrapStore === undefined ? store : wrapStore(store),
    defaultKeyFile,
    fetchImpl: transport("proxied"),
    directFetchImpl: transport("direct"),
    log: (event, fields) => {
      logs.push({ event, fields });
    },
  });
  t.after(async () => {
    await host.close();
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });
  return { dir, store, calls, logs, defaultKeyFile, host, state };
}

function draft(over: Partial<ModelSourceDraft> = {}): ModelSourceDraft {
  return {
    id: "workstation",
    kind: "local",
    label: "Workstation",
    baseUrl: LOCAL_URL,
    keyFile: null,
    keyVariable: null,
    models: [{ id: "flash-local", label: "Flash local", contextWindow: 65536 }],
    enabled: true,
    ...over,
  };
}

function onlineDraft(over: Partial<ModelSourceDraft> = {}): ModelSourceDraft {
  return draft({
    id: "vendor",
    kind: "online",
    label: "Vendor",
    baseUrl: ONLINE_URL,
    keyVariable: "VENDOR_KEY",
    models: [{ id: "vendor-fast", label: "Vendor Fast", supportsImages: false }],
    ...over,
  });
}

function add(store: GuildPersistence, source: ModelSourceDraft, confirmed = true): void {
  const { source: created } = store.upsertModelSource(source);
  if (confirmed) store.confirmModelSource({ sourceId: created.id, expectedRevision: created.revision });
}

function writeEnv(h: Harness, name: string, lines: string): string {
  const path = join(h.dir, name);
  writeFileSync(path, lines);
  return path;
}

async function post(baseUrl: string, model: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-oauth-secret", ...headers },
    body: JSON.stringify({ model, max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
  });
}

describe("model router host: which sources are routable", () => {
  it("lists only enabled, confirmed sources whose key can be read, and keyless Local sources [PC-ROUTE-002]", async (t) => {
    const h = harness(t);
    const keys = writeEnv(h, "keys.env", "VENDOR_KEY=sk-test-vendor-key\nOTHER_KEY=other\n");
    add(h.store, onlineDraft({ keyFile: keys }));
    add(h.store, draft());
    add(h.store, onlineDraft({ id: "unconfirmed", baseUrl: "https://unconfirmed.vendor.test", keyFile: keys, models: [{ id: "unconfirmed-model", label: "U" }] }), false);
    add(h.store, onlineDraft({ id: "disabled", baseUrl: "https://disabled.vendor.test", keyFile: keys, enabled: false, models: [{ id: "disabled-model", label: "D" }] }));
    add(h.store, onlineDraft({ id: "no-file", baseUrl: "https://nofile.vendor.test", keyFile: join(h.dir, "absent.env"), models: [{ id: "no-file-model", label: "N" }] }));
    add(h.store, onlineDraft({ id: "no-variable", baseUrl: "https://novar.vendor.test", keyFile: keys, keyVariable: "ABSENT_KEY", models: [{ id: "no-variable-model", label: "V" }] }));
    add(h.store, draft({ id: "keyed-local", baseUrl: "http://127.0.0.1:9000", keyFile: join(h.dir, "absent.env"), keyVariable: "LOCAL_KEY", models: [{ id: "keyed-local-model", label: "L" }] }));
    add(h.store, onlineDraft({ id: "unreadable", baseUrl: "https://unreadable.vendor.test", keyFile: h.dir + "/", models: [{ id: "unreadable-model", label: "R" }] }));

    await h.host.refresh();
    assert.deepEqual(h.host.listRoutedModels(), [
      { id: "vendor-fast", label: "Vendor Fast", group: "online", sourceId: "vendor", sourceLabel: "Vendor", supportsImages: false },
      { id: "flash-local", label: "Flash local", group: "local", sourceId: "workstation", sourceLabel: "Workstation", contextWindow: 65536 },
    ]);
    // Nothing the log carries names a key.
    assert.equal(JSON.stringify(h.logs).includes("sk-test-vendor-key"), false);
    assert.ok(h.logs.some((entry) => entry.event === "router_host.key_unreadable" && entry.fields["sourceId"] === "unreadable"));
  });

  it("reads the default key file for a source that names none", async (t) => {
    const h = harness(t);
    writeFileSync(h.defaultKeyFile, "export VENDOR_KEY=\"sk-default-file-key\"\n");
    add(h.store, onlineDraft());
    await h.host.refresh();
    assert.deepEqual(h.host.listRoutedModels().map((model) => model.id), ["vendor-fast"]);
    const { baseUrl } = await h.host.ensureStarted();
    const response = await post(baseUrl, "vendor-fast");
    assert.equal(response.status, 200);
    assert.equal(h.calls[0]?.headers["x-api-key"], "sk-default-file-key");
  });

  it("skips models and sources that could shadow Claude or break the router registry", async (t) => {
    const h = harness(t);
    const keys = writeEnv(h, "keys.env", "VENDOR_KEY=sk-test-vendor-key\n");
    // The store accepts these (Claude-engine grammar); the host must not route them.
    add(h.store, onlineDraft({ keyFile: keys, models: [{ id: "claude-opus-4", label: "Shadow" }, { id: "vendor-fast", label: "Fast" }] }));
    add(h.store, onlineDraft({ id: "Anthropic", baseUrl: "https://impostor.vendor.test", keyFile: keys, models: [{ id: "impostor-model", label: "I" }] }));
    add(h.store, onlineDraft({ id: "only-reserved", baseUrl: "https://reserved.vendor.test", keyFile: keys, models: [{ id: "sonnet", label: "S" }] }));
    await h.host.refresh();
    assert.deepEqual(h.host.listRoutedModels().map((model) => model.id), ["vendor-fast"]);

    const { baseUrl } = await h.host.ensureStarted();
    const shadow = await post(baseUrl, "claude-opus-4");
    assert.equal(shadow.status, 200);
    assert.equal(h.calls.at(-1)?.url, "https://api.anthropic.com/v1/messages", "a Claude id always goes to Anthropic");
    assert.equal(h.calls.at(-1)?.via, "proxied");
  });

  it("primes itself on the first listing and tells listeners once the list is known", async (t) => {
    const h = harness(t);
    add(h.store, draft());
    const changed = new Promise<void>((resolve) => {
      h.host.onChange(resolve);
    });
    assert.deepEqual(h.host.listRoutedModels(), [], "the first read is synchronous and empty");
    await changed;
    assert.deepEqual(h.host.listRoutedModels().map((model) => model.id), ["flash-local"]);
  });
});

describe("model router host: isAnthropicModel and credentials", () => {
  it("sends claude-* and noted ids to Anthropic with the client credential, never an id a source claims", async (t) => {
    const h = harness(t);
    add(h.store, draft());
    await h.host.refresh();
    h.host.noteAnthropicModels(["haiku", "flash-local", "x".repeat(200)]);
    const { baseUrl } = await h.host.ensureStarted();

    assert.equal((await post(baseUrl, "claude-sonnet-5")).status, 200);
    assert.equal((await post(baseUrl, "haiku")).status, 200);
    for (const call of h.calls) {
      assert.equal(call.url, "https://api.anthropic.com/v1/messages");
      assert.equal(call.via, "proxied");
      assert.equal(call.headers["authorization"], "Bearer client-oauth-secret");
    }

    h.calls.length = 0;
    // A source's id wins over a noted Claude id (the adapter lists routed models too), and the OAuth credential never reaches it.
    assert.equal((await post(baseUrl, "flash-local")).status, 200);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.url, `${LOCAL_URL}/v1/messages`);
    assert.equal(h.calls[0]?.via, "direct", "a Local source never goes through the system proxy");
    assert.equal(h.calls[0]?.headers["authorization"], undefined);
    assert.equal(h.calls[0]?.headers["x-api-key"], undefined, "keyless: no credential at all");

    // Unknown or overlong ids are never forwarded.
    h.calls.length = 0;
    assert.equal((await post(baseUrl, "mystery-model")).status, 404);
    assert.equal((await post(baseUrl, "x".repeat(200))).status, 404);
    assert.equal(h.calls.length, 0);
  });

  it("picks the direct or proxied transport from the source kind alone, not from the URL [PC-ROUTE-002]", async (t) => {
    const h = harness(t);
    const keys = writeEnv(h, "keys.env", "VENDOR_KEY='sk-vendor-key-123456'\n");
    // Same origin for a Local and an Online source: a URL lookup cannot tell them apart.
    add(h.store, draft({ baseUrl: "https://127.0.0.1:8443", models: [{ id: "flash-local", label: "Flash local" }] }));
    add(h.store, onlineDraft({ baseUrl: "https://127.0.0.1:8443/anthropic", keyFile: keys }));
    await h.host.refresh();
    const { baseUrl } = await h.host.ensureStarted();

    assert.equal((await post(baseUrl, "vendor-fast")).status, 200);
    assert.equal((await post(baseUrl, "flash-local")).status, 200);
    assert.deepEqual(h.calls.map((call) => call.via), ["proxied", "direct"]);
  });

  it("a Local source reached through a hostname still uses the direct transport after address pinning [PC-ROUTE-002]", async (t) => {
    const h = harness(t);
    add(h.store, draft({ baseUrl: "http://localhost:8081" }));
    await h.host.refresh();
    const { baseUrl } = await h.host.ensureStarted();
    assert.equal((await post(baseUrl, "flash-local")).status, 200);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0]?.url ?? "", /^http:\/\/(?:127\.0\.0\.1|\[::1\]):8081\/v1\/messages$/u, "the router sends the validated IP literal");
    assert.equal(h.calls[0]?.via, "direct");
  });

  it("replaces the client credential with the source key for the confirmed host only [PC-ROUTE-002]", async (t) => {
    const h = harness(t);
    const keys = writeEnv(h, "keys.env", "VENDOR_KEY='sk-vendor-key-123456'\n");
    add(h.store, onlineDraft({ keyFile: keys }));
    await h.host.refresh();
    const { baseUrl } = await h.host.ensureStarted();
    const response = await post(baseUrl, "vendor-fast", { "anthropic-beta": "tools-2026" });
    assert.equal(response.status, 200);
    const call = h.calls[0];
    assert.equal(call?.url, `${ONLINE_URL}/v1/messages`);
    assert.equal(call?.via, "proxied");
    assert.equal(call?.headers["x-api-key"], "sk-vendor-key-123456");
    assert.equal(call?.headers["authorization"], "Bearer sk-vendor-key-123456");
    assert.equal(call?.headers["anthropic-beta"], undefined);
    assert.equal(call?.redirect, "manual");
    assert.equal(call?.credentials, "omit", "no cookie jar is used for vendor traffic");
    assert.equal(JSON.stringify(h.logs).includes("sk-vendor-key-123456"), false);
    assert.equal(JSON.stringify(h.logs).includes("client-oauth-secret"), false);
  });

  it("an upstream redirect is refused and reported as a redirect, not an outage", async (t) => {
    const h = harness(t);
    add(h.store, draft());
    await h.host.refresh();
    h.state.respond = () => Promise.reject(new Error("Redirect was cancelled"));
    const { baseUrl } = await h.host.ensureStarted();
    const response = await post(baseUrl, "flash-local");
    assert.equal(response.status, 502);
    assert.match(await response.text(), /redirect refused/u);
    assert.equal(h.logs.find((entry) => entry.event === "router.request")?.fields["outcome"], "upstream_redirect");
  });

  it("writes thinking provenance to the store and survives a failing store [D-058]", async (t) => {
    const h = harness(t);
    add(h.store, draft());
    await h.host.refresh();
    h.state.respond = () => jsonResponse({ content: [{ type: "thinking", thinking: "hmm", signature: "sig-from-workstation" }, { type: "text", text: "ok" }] });
    const { baseUrl } = await h.host.ensureStarted();
    const recorded = await post(baseUrl, "flash-local");
    assert.equal(recorded.status, 200);
    await recorded.text();
    const hash = createHash("sha256").update("sig-from-workstation", "utf8").digest("hex").slice(0, 32);
    assert.equal(h.store.loadThinkingProvenance(hash), "workstation");

    const broken = harness(t, (store) => ({
      listModelSources: () => store.listModelSources(),
      loadThinkingProvenance: () => {
        throw new Error("store closed");
      },
      saveThinkingProvenance: () => {
        throw new Error("store closed");
      },
      pruneThinkingProvenance: () => {
        throw new Error("store closed");
      },
    }));
    add(broken.store, draft());
    await broken.host.refresh();
    broken.state.respond = () => jsonResponse({ content: [{ type: "thinking", thinking: "hmm", signature: "sig-lost" }] });
    const started = await broken.host.ensureStarted();
    const survived = await post(started.baseUrl, "flash-local");
    assert.equal(survived.status, 200, "a provenance fault never fails the request");
    await survived.text();
    assert.ok(broken.logs.some((entry) => entry.event === "router_host.provenance_error"));
  });
});

describe("model router host: changes and lifetime", () => {
  it("tells listeners about add, confirm, edit, disable and delete, and updates the running router", async (t) => {
    const h = harness(t);
    const { baseUrl } = await h.host.ensureStarted();
    let notified = 0;
    const stop = h.host.onChange(() => {
      notified += 1;
    });

    assert.equal((await post(baseUrl, "flash-local")).status, 404, "nothing is routable yet");
    const { source } = h.store.upsertModelSource(draft());
    await h.host.refresh();
    assert.equal(notified, 0, "an unconfirmed source changes nothing a user can pick");
    h.store.confirmModelSource({ sourceId: "workstation", expectedRevision: source.revision });
    await h.host.refresh();
    assert.equal(notified, 1);
    assert.equal((await post(baseUrl, "flash-local")).status, 200, "the running router picked the source up");

    await h.host.refresh();
    assert.equal(notified, 1, "a refresh that changes nothing is silent");

    h.store.upsertModelSource(draft({ label: "Workstation renamed" }));
    await h.host.refresh();
    assert.equal(notified, 2);
    assert.equal(h.host.listRoutedModels()[0]?.sourceLabel, "Workstation renamed");

    h.store.upsertModelSource(draft({ label: "Workstation renamed", enabled: false }));
    await h.host.refresh();
    assert.equal(notified, 3);
    assert.equal((await post(baseUrl, "flash-local")).status, 404, "a disabled source is no longer served");

    h.store.upsertModelSource(draft({ label: "Workstation renamed", enabled: true }));
    await h.host.refresh();
    assert.equal(notified, 4);
    h.store.deleteModelSource("workstation");
    await h.host.refresh();
    assert.equal(notified, 5);
    assert.equal((await post(baseUrl, "flash-local")).status, 404);

    stop();
    add(h.store, draft());
    await h.host.refresh();
    assert.equal(notified, 5, "an unsubscribed listener hears nothing");
  });

  it("a changed base URL voids the confirmation and the source stops being routable until confirmed again", async (t) => {
    const h = harness(t);
    add(h.store, draft());
    await h.host.refresh();
    const { baseUrl } = await h.host.ensureStarted();
    assert.equal((await post(baseUrl, "flash-local")).status, 200);
    h.store.upsertModelSource(draft({ baseUrl: "http://127.0.0.1:9999" }));
    await h.host.refresh();
    assert.deepEqual(h.host.listRoutedModels(), []);
    assert.equal((await post(baseUrl, "flash-local")).status, 404);
  });

  it("starts once, returns the same loopback URL, and refuses to start after close", async (t) => {
    const h = harness(t);
    const [first, second] = await Promise.all([h.host.ensureStarted(), h.host.ensureStarted()]);
    assert.equal(first.baseUrl, second.baseUrl);
    assert.match(first.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/u);
    assert.equal(JSON.stringify(h.logs).includes(first.baseUrl.split("/")[3] ?? "missing"), false, "the token is never logged");
    assert.equal(JSON.stringify(h.logs).includes("127.0.0.1:"), false, "the URL is never logged");

    await h.host.close();
    await h.host.close();
    await assert.rejects(h.host.ensureStarted(), /model_router_closed/u);
    await assert.rejects(fetch(first.baseUrl + "v1/models"), "the listener is gone");
  });
});
