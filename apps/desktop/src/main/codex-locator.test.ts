import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { codexPlatformTarget } from "@guild/runtime-grok";
import {
  invalidateClaudeLocatorCache,
  resetClaudeLaunchPinsForTesting,
  type ClaudeLocatorOptions,
} from "./claude-locator.js";
import {
  CodexEngineIntegrityError,
  CodexLocatorError,
  locateCodexAdapter,
  locateCodexCore,
  locateCodexEngine,
  unexpectedCodexEngineChange,
  type CodexLocatorErrorCode,
  type CodexLocatorOptions,
  type LocatedCodexEngine,
} from "./codex-locator.js";

/*
 * PC-ENG-003: the Codex locator finds the user-installed pieces by reading them. Nothing here runs a real node,
 * adapter or Codex core: files carry only a Mach-O magic number (or a script line) and the node version probe is
 * answered by an injected function.
 */

const MACH_O_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const ADAPTER_NAME = "@agentclientprotocol/codex-acp";
const ADAPTER_LINK = "../lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js";
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

afterEach(() => {
  invalidateClaudeLocatorCache();
  resetClaudeLaunchPinsForTesting();
});

type Sandbox = Readonly<{
  root: string;
  home: string;
  bin: string;
  options: (execute?: ClaudeLocatorOptions["execute"], extraPath?: readonly string[]) => CodexLocatorOptions;
}>;

async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-codex-locator-")));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(home, ".npm-global", "bin"), { recursive: true });
  await mkdir(bin, { recursive: true });
  return {
    root,
    home,
    bin,
    options: (execute, extraPath = []) => ({
      environment: { PATH: [bin, ...extraPath].join(delimiter) },
      homeDirectory: home,
      fallbackDirectories: [],
      ...(execute === undefined ? {} : { execute }),
    }),
  };
}

async function writeMachO(path: string, payload = "payload"): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.concat([MACH_O_MAGIC, Buffer.from(payload)]));
  await chmod(path, 0o755);
}

function answers(table: Readonly<Record<string, string>>): NonNullable<ClaudeLocatorOptions["execute"]> {
  return async (file) => {
    const answer = table[file];
    if (answer === undefined) throw new Error("probe failed");
    return answer;
  };
}

async function writeAdapterPackage(prefix: string, version: string, name = ADAPTER_NAME): Promise<{ entry: string; packageRoot: string }> {
  const packageRoot = join(prefix, "lib", "node_modules", ...name.split("/"));
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
  const entry = join(packageRoot, "dist", "index.js");
  await writeFile(entry, "#!/usr/bin/env node\nconsole.log('adapter');\n");
  await chmod(entry, 0o755);
  return { entry, packageRoot };
}

async function installAdapter(prefix: string, version: string): Promise<{ entry: string; packageRoot: string }> {
  const installed = await writeAdapterPackage(prefix, version);
  await mkdir(join(prefix, "bin"), { recursive: true });
  await symlink(ADAPTER_LINK, join(prefix, "bin", "codex-acp"));
  return installed;
}

/** The platform package the way npm installs it inside the adapter. */
async function writeCore(packageRoot: string, version = "0.160.1", payload = "core"): Promise<string> {
  const target = codexPlatformTarget();
  assert.ok(target !== undefined, "these tests run on macOS");
  const vendor = join(packageRoot, "node_modules", ...target.packageName.split("/"), "vendor", target.triple);
  await mkdir(join(vendor, "bin"), { recursive: true });
  await writeFile(join(vendor, "codex-package.json"), JSON.stringify({ layoutVersion: 1, version, target: target.triple, entrypoint: "bin/codex" }));
  await writeMachO(join(vendor, "bin", "codex"), payload);
  return realpath(join(vendor, "bin", "codex"));
}

async function expectLocatorError(operation: Promise<unknown>, code: CodexLocatorErrorCode, foundVersion?: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.ok(cause instanceof CodexLocatorError, String(cause));
    assert.equal(cause.code, code);
    assert.equal(cause.foundVersion, foundVersion);
    return true;
  });
}

describe("Codex locator: adapter", () => {
  it("finds codex-acp through a bin symlink and pins its package", async () => {
    const box = await sandbox();
    const { entry, packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    const pin = await locateCodexAdapter(box.options());
    assert.equal(pin.packageRoot, packageRoot);
    assert.equal(pin.entryPath, entry);
    assert.equal(pin.version, "2.2.2");
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
  });

  it("also searches the user PATH and Homebrew-style locations", async () => {
    const box = await sandbox();
    const prefix = join(box.root, "homebrew");
    const { packageRoot } = await installAdapter(prefix, "2.7.0");
    assert.equal((await locateCodexAdapter(box.options(undefined, [join(prefix, "bin")]))).packageRoot, packageRoot);
    const viaFallback = { ...box.options(), environment: { PATH: "/nonexistent" }, fallbackDirectories: [join(prefix, "bin")] };
    assert.equal((await locateCodexAdapter(viaFallback)).packageRoot, packageRoot);
  });

  it("accepts major 2 only: names the unsupported version and still finds a supported install elsewhere", async () => {
    const box = await sandbox();
    const newer = join(box.home, ".npm-global");
    await installAdapter(newer, "3.0.0");
    await expectLocatorError(locateCodexAdapter(box.options()), "adapter_version_unsupported", "3.0.0");

    const olderBox = await sandbox();
    const older = join(olderBox.home, ".npm-global");
    await installAdapter(older, "1.9.9");
    await expectLocatorError(locateCodexAdapter(olderBox.options()), "adapter_version_unsupported", "1.9.9");

    const supported = join(box.root, "second");
    const { packageRoot } = await installAdapter(supported, "2.0.0");
    assert.equal((await locateCodexAdapter(box.options(undefined, [join(supported, "bin")]))).packageRoot, packageRoot);
  });

  it("is adapter_missing for absent, foreign or wrapped installs, and ignores the Claude adapter", async () => {
    const box = await sandbox();
    await expectLocatorError(locateCodexAdapter(box.options()), "adapter_missing");

    const foreign = join(box.root, "foreign");
    await writeAdapterPackage(foreign, "2.2.2", "some-other-cli");
    await mkdir(join(foreign, "bin"), { recursive: true });
    await symlink("../lib/node_modules/some-other-cli/dist/index.js", join(foreign, "bin", "codex-acp"));
    await expectLocatorError(locateCodexAdapter(box.options(undefined, [join(foreign, "bin")])), "adapter_missing");

    // The Claude adapter's package is another package; the Codex search never takes it for its own.
    const claude = join(box.root, "claude");
    await writeAdapterPackage(claude, "0.89.1", "@agentclientprotocol/claude-agent-acp");
    await mkdir(join(claude, "bin"), { recursive: true });
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(claude, "bin", "codex-acp"));
    await expectLocatorError(locateCodexAdapter(box.options(undefined, [join(claude, "bin")])), "adapter_missing");

    // A shell wrapper is not the package's own entry script.
    await mkdir(join(box.home, ".npm-global", "bin"), { recursive: true });
    await writeFile(join(box.home, ".npm-global", "bin", "codex-acp"), "#!/bin/sh\nexec node x\n");
    await chmod(join(box.home, ".npm-global", "bin", "codex-acp"), 0o755);
    await expectLocatorError(locateCodexAdapter(box.options()), "adapter_missing");
  });

  it("tries the dev-only extra roots first, and the pin still applies to them [GUILD_DEV_CODEX_ACP]", async () => {
    const box = await sandbox();
    const scratch = join(box.root, "scratch");
    const { packageRoot } = await writeAdapterPackage(scratch, "2.2.2");
    // Not on any search path: only the extra root finds it.
    await expectLocatorError(locateCodexAdapter(box.options()), "adapter_missing");
    const pin = await locateCodexAdapter({ ...box.options(), extraAdapterRoots: [packageRoot] });
    assert.equal(pin.packageRoot, packageRoot);
    // An unsupported version in the extra root is refused like any other.
    const unsupported = await writeAdapterPackage(join(box.root, "scratch3"), "3.1.0");
    await expectLocatorError(
      locateCodexAdapter({ ...box.options(), extraAdapterRoots: [unsupported.packageRoot] }),
      "adapter_version_unsupported",
      "3.1.0",
    );
    // A relative or missing root is skipped, not trusted.
    await expectLocatorError(locateCodexAdapter({ ...box.options(), extraAdapterRoots: ["relative/dir", join(box.root, "nope")] }), "adapter_missing");
    // The extra root wins over the user install when both are valid.
    const installed = await installAdapter(join(box.home, ".npm-global"), "2.5.0");
    assert.equal((await locateCodexAdapter({ ...box.options(), extraAdapterRoots: [packageRoot] })).packageRoot, packageRoot);
    assert.equal((await locateCodexAdapter(box.options())).packageRoot, installed.packageRoot);
  });

  it("re-pins by reading only: a new version is an update, the same version with other bytes is flagged, and nothing runs", async () => {
    const box = await sandbox();
    const prefix = join(box.home, ".npm-global");
    const { entry, packageRoot } = await installAdapter(prefix, "2.2.2");
    const executed: string[] = [];
    const options = box.options(async (file) => { executed.push(file); return ""; });
    const before = await locateCodexAdapter(options);

    await writeFile(entry, "#!/usr/bin/env node\nconsole.log('swapped');\n");
    const swapped = await locateCodexAdapter(options);
    assert.equal(swapped.version, before.version);
    assert.notEqual(swapped.fingerprintSha256, before.fingerprintSha256);

    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: ADAPTER_NAME, version: "2.3.0" }));
    const updated = await locateCodexAdapter(options);
    assert.equal(updated.version, "2.3.0");
    assert.deepEqual(executed, [], "the adapter's files were only read");

    const engine = (adapter: typeof before): LocatedCodexEngine => ({
      node: { executablePath: "/n", sha256: "a".repeat(64), version: "26.0.0" },
      adapter,
      core: { executablePath: "/c/codex", version: "0.160.1", sizeBytes: 10 },
    });
    assert.equal(unexpectedCodexEngineChange(engine(before), engine(swapped)), "adapter");
    assert.equal(unexpectedCodexEngineChange(engine(before), engine(updated)), undefined);
  });
});

describe("Codex locator: core", () => {
  it("finds the platform package the adapter ships and reads its version without running it", async () => {
    const box = await sandbox();
    const { packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    const executable = await writeCore(packageRoot, "0.160.1", "core-bytes");
    const adapter = await locateCodexAdapter(box.options());
    const core = await locateCodexCore(adapter);
    assert.equal(core.executablePath, executable);
    assert.equal(core.version, "0.160.1");
    assert.equal(core.sizeBytes, 4 + "core-bytes".length);
    assert.equal(Object.isFrozen(core), true);
  });

  it("is core_missing when the adapter ships none, or ships something that is not a Mach-O executable", async () => {
    const box = await sandbox();
    const { packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    const adapter = await locateCodexAdapter(box.options());
    await expectLocatorError(locateCodexCore(adapter), "core_missing");
    const executable = await writeCore(packageRoot);
    await writeFile(executable, "#!/bin/sh\necho not the core\n");
    await expectLocatorError(locateCodexCore(adapter), "core_missing");
  });
});

describe("Codex locator: whole engine", () => {
  it("returns node, adapter and core together", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node);
    const { packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    const executable = await writeCore(packageRoot);
    const engine = await locateCodexEngine(box.options(answers({ [node]: "v26.8.1" })));
    assert.equal(engine.node.executablePath, node);
    assert.equal(engine.adapter.version, "2.2.2");
    assert.equal(engine.core.executablePath, executable);
    assert.equal(Object.isFrozen(engine), true);
  });

  it("reports the first missing piece in the order node, adapter, core, in Codex's own error type", async () => {
    const box = await sandbox();
    await expectLocatorError(locateCodexEngine(box.options(answers({}))), "node_missing");
    const node = join(box.bin, "node");
    await writeMachO(node);
    await expectLocatorError(locateCodexEngine(box.options(answers({ [node]: "v20.1.0" }))), "node_too_old", "20.1.0");
    const probe = answers({ [node]: "v26.8.1" });
    await expectLocatorError(locateCodexEngine(box.options(probe)), "adapter_missing");
    const { packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    await expectLocatorError(locateCodexEngine(box.options(probe)), "core_missing");
    await writeCore(packageRoot);
    assert.equal((await locateCodexEngine(box.options(probe))).node.version, "26.8.1");
  });

  it("holds the node to the launch's pin and raises the Codex integrity error when it changed", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    const { packageRoot } = await installAdapter(join(box.home, ".npm-global"), "2.2.2");
    await writeCore(packageRoot);
    const probe = answers({ [node]: "v26.8.1" });
    await locateCodexEngine(box.options(probe));
    // A different node at the same place after the cache was dropped is not the node this launch trusted.
    invalidateClaudeLocatorCache();
    await writeMachO(node, "swapped bytes");
    await assert.rejects(locateCodexEngine(box.options(probe)), (cause: unknown) => {
      assert.ok(cause instanceof CodexEngineIntegrityError);
      assert.equal(cause.message, "engine_integrity_changed");
      assert.equal(cause.component, "node");
      return true;
    });
  });
});

describe("Codex locator: what a re-locate may replace [PC-ENG-003]", () => {
  const base: LocatedCodexEngine = Object.freeze({
    node: Object.freeze({ executablePath: "/usr/local/bin/node", sha256: "a".repeat(64), version: "26.8.1" }),
    adapter: Object.freeze({
      packageRoot: "/opt/codex-acp",
      entryPath: "/opt/codex-acp/dist/index.js",
      version: "2.2.2",
      fingerprintSha256: "c".repeat(64),
    }),
    core: Object.freeze({ executablePath: "/opt/codex-acp/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex", version: "0.160.1", sizeBytes: 241_000_000 }),
  });
  const changed = (over: {
    node?: Partial<LocatedCodexEngine["node"]>;
    adapter?: Partial<LocatedCodexEngine["adapter"]>;
    core?: Partial<LocatedCodexEngine["core"]>;
  }): LocatedCodexEngine =>
    Object.freeze({
      node: Object.freeze({ ...base.node, ...over.node }),
      adapter: Object.freeze({ ...base.adapter, ...over.adapter }),
      core: Object.freeze({ ...base.core, ...over.core }),
    });

  it("accepts an identical result and an adapter update together with the core it ships", () => {
    assert.equal(unexpectedCodexEngineChange(base, changed({})), undefined);
    assert.equal(
      unexpectedCodexEngineChange(base, changed({
        adapter: { version: "2.3.0", fingerprintSha256: "d".repeat(64) },
        core: { executablePath: "/opt/codex-acp/other/bin/codex", version: "0.170.0", sizeBytes: 1 },
      })),
      undefined,
    );
  });

  it("refuses the same adapter version with other bytes or another core, naming the piece", () => {
    assert.equal(unexpectedCodexEngineChange(base, changed({ adapter: { fingerprintSha256: "d".repeat(64) } })), "adapter");
    assert.equal(unexpectedCodexEngineChange(base, changed({ core: { sizeBytes: 241_000_001 } })), "core");
    assert.equal(unexpectedCodexEngineChange(base, changed({ core: { version: "0.160.2" } })), "core");
    assert.equal(unexpectedCodexEngineChange(base, changed({ core: { executablePath: "/tmp/evil/codex" } })), "core");
  });

  it("never replaces the node, and reports node before adapter before core", () => {
    assert.equal(unexpectedCodexEngineChange(base, changed({ node: { sha256: "b".repeat(64) } })), "node");
    assert.equal(unexpectedCodexEngineChange(base, changed({ node: { executablePath: "/opt/node/bin/node" } })), "node");
    assert.equal(unexpectedCodexEngineChange(base, changed({ node: { version: "26.9.0" } })), undefined, "the version label alone is not a change");
    const all = changed({ node: { sha256: "b".repeat(64) }, adapter: { fingerprintSha256: "d".repeat(64) }, core: { sizeBytes: 1 } });
    assert.equal(unexpectedCodexEngineChange(base, all), "node");
    assert.equal(unexpectedCodexEngineChange(base, changed({ adapter: all.adapter, core: all.core })), "adapter");
  });
});
