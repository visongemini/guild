import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parseWorkspaceId, type GuildLocale, type ModelSourceDraft, type WorkspaceId } from "@guild/contracts";
import { openGuildPersistence, type GuildPersistence } from "@guild/persistence";
import {
  createModelSourcesService,
  type HostConfirmationPrompt,
  type ModelSourcesService,
} from "./model-sources-service.js";

// PC-ROUTE-002 (host binding by native confirmation), PC-MODEL-001, PC-PRIV-001.

const DEFAULT_KEY_FILE = "/Users/tester/.config/guild/keys.env";

type Harness = {
  readonly store: GuildPersistence;
  readonly service: ModelSourcesService;
  readonly prompts: HostConfirmationPrompt[];
  readonly changes: { count: number };
  readonly dialog: { answer: boolean; during?: () => Promise<void> };
  readonly locale: { value: GuildLocale };
};

function harness(t: TestContext): Harness {
  const dir = mkdtempSync(join(tmpdir(), "guild-model-sources-"));
  const store = openGuildPersistence({ path: join(dir, "guild.sqlite3") });
  t.after(() => {
    store.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const prompts: HostConfirmationPrompt[] = [];
  const changes = { count: 0 };
  const dialog: Harness["dialog"] = { answer: true };
  const locale = { value: "en-US" as GuildLocale };
  const service = createModelSourcesService({
    store,
    defaultKeyFile: DEFAULT_KEY_FILE,
    getLocale: async () => locale.value,
    confirmHost: async (prompt) => {
      prompts.push(prompt);
      await dialog.during?.();
      return dialog.answer;
    },
    onChanged: () => {
      changes.count += 1;
    },
  });
  return { store, service, prompts, changes, dialog, locale };
}

function online(over: Partial<ModelSourceDraft> = {}): ModelSourceDraft {
  return {
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyFile: null,
    keyVariable: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 128000, supportsImages: false }],
    enabled: true,
    ...over,
  };
}

function local(over: Partial<ModelSourceDraft> = {}): ModelSourceDraft {
  return {
    id: "workstation",
    kind: "local",
    label: "Workstation",
    baseUrl: "http://127.0.0.1:8081",
    keyFile: null,
    keyVariable: null,
    models: [{ id: "flash-local", label: "Flash local" }],
    enabled: true,
    ...over,
  };
}

async function refusal(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "not an error";
  }
  return "no failure";
}

describe("model sources service: what the renderer can see and submit", () => {
  it("returns secret-free projections with exactly the documented fields", async (t) => {
    const h = harness(t);
    const created = await h.service.upsert(online({ keyFile: "/Users/tester/keys.env" }));
    assert.equal(created.needsConfirmation, true);
    assert.deepEqual(Object.keys(created.source).sort(), [
      "baseUrl", "confirmedHost", "enabled", "id", "keyFile", "keyVariable", "kind", "label", "models",
    ]);
    assert.equal(created.source.confirmedHost, null);
    assert.equal(created.source.keyVariable, "DEEPSEEK_API_KEY");
    assert.deepEqual(created.source.models[0], { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 128000, supportsImages: false });
    assert.equal(Object.isFrozen(created.source), true);
    const listed = await h.service.list();
    assert.deepEqual(listed.sources, [created.source]);
    assert.equal(h.changes.count, 1);
  });

  it("refuses model ids and source ids that would shadow the Claude subscription route [PC-ROUTE-001]", async (t) => {
    const h = harness(t);
    for (const id of ["claude-opus-4-8", "Claude-Haiku", "default", "opus", "Sonnet", "haiku", "fable", "best", "opusplan", "opus[1m]"]) {
      assert.equal(
        await refusal(h.service.upsert(online({ models: [{ id, label: "Shadow" }] }))),
        "model_source_reserved_model",
        id,
      );
    }
    assert.equal(await refusal(h.service.upsert(online({ id: "anthropic" }))), "model_source_reserved_id");
    assert.equal(await refusal(h.service.upsert(online({ id: "Anthropic" }))), "model_source_reserved_id");
    // Only the exact grammar of Claude ids is reserved: a vendor id that merely contains the word is fine.
    assert.equal((await h.service.upsert(online({ models: [{ id: "my-claude-compatible", label: "Mine" }] }))).source.id, "deepseek");
    assert.deepEqual(await h.service.list().then((listed) => listed.sources.length), 1);
    assert.equal(h.changes.count, 1, "refusals change nothing");
  });

  it("refuses a duplicate model id, the 33rd source, and values that look invalid or spoofed", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    assert.equal(
      await refusal(h.service.upsert(local({ models: [{ id: "deepseek-v4-flash", label: "Impostor" }] }))),
      "model_source_duplicate_model",
    );
    // The same source may keep its own model ids when edited.
    assert.equal((await h.service.upsert(online({ label: "DeepSeek (work)" }))).source.label, "DeepSeek (work)");

    assert.equal(await refusal(h.service.upsert({ ...local(), confirmedHost: "evil.example" } as never)), "model_source_invalid", "a request can never set the confirmed host");
    assert.equal(await refusal(h.service.upsert(local({ baseUrl: "http://user:pw@127.0.0.1:8081" }))), "model_source_invalid");
    assert.equal(await refusal(h.service.upsert(online({ baseUrl: "http://api.deepseek.com" }))), "model_source_invalid", "Online is https only");
    assert.equal(await refusal(h.service.upsert(local({ label: "sk-live-abcdef123456" }))), "model_source_invalid", "a key pasted as a label is refused");
    assert.equal(await refusal(h.service.upsert(local({ keyFile: "relative/keys.env", keyVariable: "K" }))), "model_source_invalid");
    // A right-to-left override or zero-width character could make the confirmation dialog say something else.
    assert.equal(await refusal(h.service.upsert(local({ label: "Workstation " + String.fromCharCode(0x202e) + "gnp" }))), "model_source_invalid");
    assert.equal(await refusal(h.service.upsert(local({ keyFile: "/Users/tester/keys" + String.fromCharCode(0x200b) + ".env", keyVariable: "K" }))), "model_source_invalid");
    assert.equal(await refusal(h.service.upsert(local({ models: [{ id: "flash-local", label: "Flash" + String.fromCharCode(0x2066) }] }))), "model_source_invalid");

    for (let index = 1; index < 32; index += 1) {
      await h.service.upsert(local({ id: `source-${index}`, baseUrl: `http://127.0.0.1:${9000 + index}`, models: [{ id: `model-${index}`, label: `Model ${index}` }] }));
    }
    assert.equal((await h.service.list()).sources.length, 32);
    assert.equal(await refusal(h.service.upsert(local({ id: "one-too-many", models: [{ id: "model-extra", label: "Extra" }] }))), "model_source_limit");
    assert.equal((await h.service.upsert(local({ id: "source-1", baseUrl: "http://127.0.0.1:9001", label: "Renamed", models: [{ id: "model-1", label: "Model 1" }] }))).source.label, "Renamed", "editing an existing source is not blocked by the limit");
  });

  it("deletes a source and reports one that does not exist", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    await h.service.remove("deepseek");
    assert.deepEqual((await h.service.list()).sources, []);
    assert.equal(await refusal(h.service.remove("deepseek")), "model_source_not_found");
    assert.equal(h.changes.count, 2);
  });
});

describe("model sources service: native confirmation of the host [PC-ROUTE-002]", () => {
  it("names the key variable, the key file and the host, and binds the key to that host only on Allow", async (t) => {
    const h = harness(t);
    await h.service.upsert(online({ keyFile: "/Users/tester/keys.env" }));
    const confirmed = await h.service.confirm("deepseek");
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.source.confirmedHost, "api.deepseek.com");
    assert.equal(h.prompts.length, 1);
    const prompt = h.prompts[0];
    assert.equal(prompt?.message, "Allow Guild to send DEEPSEEK_API_KEY from /Users/tester/keys.env to api.deepseek.com?");
    assert.match(prompt?.detail ?? "", /stays in memory and is only sent to api\.deepseek\.com/u);
    assert.deepEqual([prompt?.cancelLabel, prompt?.allowLabel], ["Cancel", "Allow"]);
    assert.equal(h.changes.count, 2, "upsert and confirmation both reach the router host");
  });

  it("shows the default key file when the source names none, and speaks the user's language", async (t) => {
    const h = harness(t);
    h.locale.value = "zh-CN";
    await h.service.upsert(online());
    await h.service.confirm("deepseek");
    assert.equal(h.prompts[0]?.message, `允许 Guild 把 ${DEFAULT_KEY_FILE} 中的 DEEPSEEK_API_KEY 发送到 api.deepseek.com 吗？`);
    assert.deepEqual([h.prompts[0]?.cancelLabel, h.prompts[0]?.allowLabel], ["取消", "允许"]);
  });

  it("asks about conversations, not a key, for a key-less Local source and names its port", async (t) => {
    const h = harness(t);
    await h.service.upsert(local());
    await h.service.confirm("workstation");
    assert.equal(h.prompts[0]?.message, "Allow Guild to send Claude task conversations to 127.0.0.1:8081?");
    h.locale.value = "zh-CN";
    await h.service.upsert(local({ id: "second", baseUrl: "http://127.0.0.1:8082", models: [{ id: "flash-two", label: "Two" }] }));
    await h.service.confirm("second");
    assert.equal(h.prompts[1]?.message, "允许 Guild 把 Claude 任务的对话发送到 127.0.0.1:8082 吗？");
  });

  it("Cancel confirms nothing and leaves the source unconfirmed", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    h.dialog.answer = false;
    const answer = await h.service.confirm("deepseek");
    assert.equal(answer.status, "cancelled");
    assert.equal(answer.source.confirmedHost, null);
    assert.equal(h.store.loadModelSource("deepseek")?.confirmedHost, null);
    assert.equal(h.changes.count, 1, "no change was made, so the router host is not told");
  });

  it("does not ask again for a source that is already bound to its host", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    await h.service.confirm("deepseek");
    const again = await h.service.confirm("deepseek");
    assert.equal(again.status, "confirmed");
    assert.equal(h.prompts.length, 1);
    // Renaming keeps the binding; moving the address or the key designation voids it and needs a new answer.
    assert.equal((await h.service.upsert(online({ label: "DeepSeek renamed" }))).needsConfirmation, false);
    assert.equal((await h.service.upsert(online({ baseUrl: "https://api.other-vendor.test/anthropic" }))).needsConfirmation, true);
    assert.equal((await h.service.upsert(online({ baseUrl: "https://api.other-vendor.test/anthropic", keyVariable: "OTHER_KEY" }))).source.confirmedHost, null);
  });

  it("a source edited while the dialog is open cannot be confirmed by the stale answer", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    h.dialog.during = async () => {
      await h.service.upsert(online({ baseUrl: "https://api.attacker.test/anthropic" }));
    };
    assert.equal(await refusal(h.service.confirm("deepseek")), "model_source_changed");
    assert.equal(h.store.loadModelSource("deepseek")?.confirmedHost, null, "the user allowed api.deepseek.com, not the new address");
    assert.equal(h.store.loadModelSource("deepseek")?.baseUrl, "https://api.attacker.test/anthropic");
  });

  it("a source deleted while the dialog is open reports not found", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    h.dialog.during = async () => {
      await h.service.remove("deepseek");
    };
    assert.equal(await refusal(h.service.confirm("deepseek")), "model_source_not_found");
    assert.equal(await refusal(h.service.confirm("never-existed")), "model_source_not_found");
  });

  it("joins a second request for the same source onto the open dialog", async (t) => {
    const h = harness(t);
    await h.service.upsert(online());
    let release: () => void = () => undefined;
    h.dialog.during = () => new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = h.service.confirm("deepseek");
    const second = h.service.confirm("deepseek");
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, "confirmed");
    assert.equal(b.status, "confirmed");
    assert.equal(h.prompts.length, 1, "one dialog, not a stack of them");
  });

  it("shortens a very long key file path so the host and variable stay readable", async (t) => {
    const h = harness(t);
    const longPath = "/Users/tester/" + "nested/".repeat(120) + "keys.env";
    await h.service.upsert(online({ keyFile: longPath }));
    await h.service.confirm("deepseek");
    const message = h.prompts[0]?.message ?? "";
    assert.ok(message.length < 300, String(message.length));
    assert.match(message, /^Allow Guild to send DEEPSEEK_API_KEY from \/Users\/tester\/nested.*\.\.\..*keys\.env to api\.deepseek\.com\?$/u);
  });
});

describe("model sources service: workspace preferences [PC-PRIV-001]", () => {
  it("defaults to reminding, remembers the opt-out per workspace, and refuses an unknown workspace", async (t) => {
    const h = harness(t);
    const parse = (value: string): WorkspaceId => {
      const parsed = parseWorkspaceId(value);
      if (!parsed.ok) assert.fail("bad workspace id");
      return parsed.value;
    };
    const one = parse("workspace-1");
    const two = parse("workspace-2");
    h.store.createWorkspace({ workspaceId: one, canonicalPath: "/tmp/one", displayName: "one" });
    h.store.createWorkspace({ workspaceId: two, canonicalPath: "/tmp/two", displayName: "two" });

    assert.deepEqual(await h.service.getWorkspacePrefs({ workspaceId: one }), { workspaceId: one, onlineReminderDismissed: false });
    assert.deepEqual(await h.service.setWorkspacePrefs({ workspaceId: one, onlineReminderDismissed: true }), { workspaceId: one, onlineReminderDismissed: true });
    assert.equal((await h.service.getWorkspacePrefs({ workspaceId: one })).onlineReminderDismissed, true);
    assert.equal((await h.service.getWorkspacePrefs({ workspaceId: two })).onlineReminderDismissed, false);
    await assert.rejects(h.service.getWorkspacePrefs({ workspaceId: parse("workspace-9") }));
  });
});
