import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  invalidateClaudeLocatorCache,
  resetClaudeLaunchPinsForTesting,
  type ClaudeLocatorOptions,
} from "./claude-locator.js";
import {
  GeminiEngineIntegrityError,
  GeminiLocatorError,
  geminiPackageRoot,
  locateGeminiCli,
  locateGeminiEngine,
  probeGeminiCli,
  unexpectedGeminiEngineChange,
  type GeminiLocatorErrorCode,
  type GeminiLocatorOptions,
  type LocatedGeminiEngine,
} from "./gemini-locator.js";

/*
 * PC-ENG-004: the Gemini locator finds the user-installed pieces by reading them. Nothing here runs a real node or CLI:
 * files carry only a Mach-O magic number (or a script line) and the node version probe is answered by an injected function.
 */

const MACH_O_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const PACKAGE_NAME = "@google/gemini-cli";
const LINK = "../lib/node_modules/@google/gemini-cli/bundle/gemini.js";
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
  options: (execute?: ClaudeLocatorOptions["execute"], extraPath?: readonly string[]) => GeminiLocatorOptions;
}>;

async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-locator-")));
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

async function writeCliPackage(prefix: string, version: string, name = PACKAGE_NAME): Promise<{ entry: string; packageRoot: string }> {
  const packageRoot = join(prefix, "lib", "node_modules", ...name.split("/"));
  await mkdir(join(packageRoot, "bundle", "docs"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
  const entry = join(packageRoot, "bundle", "gemini.js");
  await writeFile(entry, "#!/usr/bin/env node\nconsole.log('gemini');\n");
  await writeFile(join(packageRoot, "bundle", "chunk-AAAA.js"), "export const a = 1;\n");
  await writeFile(join(packageRoot, "bundle", "docs", "readme.md"), "# docs\n");
  await chmod(entry, 0o755);
  return { entry, packageRoot };
}

async function installCli(prefix: string, version: string): Promise<{ entry: string; packageRoot: string }> {
  const installed = await writeCliPackage(prefix, version);
  await mkdir(join(prefix, "bin"), { recursive: true });
  await symlink(LINK, join(prefix, "bin", "gemini"));
  return installed;
}

async function expectLocatorError(operation: Promise<unknown>, code: GeminiLocatorErrorCode, foundVersion?: string): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.ok(cause instanceof GeminiLocatorError, String(cause));
    assert.equal(cause.code, code);
    assert.equal(cause.foundVersion, foundVersion);
    return true;
  });
}

describe("Gemini locator: the package", () => {
  it("finds gemini through a bin symlink and pins its package", async () => {
    const box = await sandbox();
    const { entry, packageRoot } = await installCli(join(box.home, ".npm-global"), "0.63.0");
    const pin = await locateGeminiCli(box.options());
    assert.equal(pin.packageRoot, packageRoot);
    assert.equal(pin.entryPath, entry);
    assert.equal(pin.version, "0.63.0");
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
  });

  it("also searches the user PATH and Homebrew-style locations", async () => {
    const box = await sandbox();
    const prefix = join(box.root, "homebrew");
    const { packageRoot } = await installCli(prefix, "0.65.2");
    assert.equal((await locateGeminiCli(box.options(undefined, [join(prefix, "bin")]))).packageRoot, packageRoot);
    const viaFallback = { ...box.options(), environment: { PATH: "/nonexistent" }, fallbackDirectories: [join(prefix, "bin")] };
    assert.equal((await locateGeminiCli(viaFallback)).packageRoot, packageRoot);
  });

  it("accepts 0.63 up to 0.69 only: names the unsupported version and still finds a supported install elsewhere", async () => {
    const box = await sandbox();
    await installCli(join(box.home, ".npm-global"), "0.70.0");
    await expectLocatorError(locateGeminiCli(box.options()), "cli_version_unsupported", "0.70.0");
    const olderBox = await sandbox();
    await installCli(join(olderBox.home, ".npm-global"), "0.62.9");
    await expectLocatorError(locateGeminiCli(olderBox.options()), "cli_version_unsupported", "0.62.9");
    const supported = join(box.root, "second");
    const { packageRoot } = await installCli(supported, "0.69.1");
    assert.equal((await locateGeminiCli(box.options(undefined, [join(supported, "bin")]))).packageRoot, packageRoot);
  });

  it("is cli_missing for absent, foreign or wrapped installs", async () => {
    const box = await sandbox();
    await expectLocatorError(locateGeminiCli(box.options()), "cli_missing");
    const foreign = join(box.root, "foreign");
    await writeCliPackage(foreign, "0.63.0", "some-other-cli");
    await mkdir(join(foreign, "bin"), { recursive: true });
    await symlink("../lib/node_modules/some-other-cli/bundle/gemini.js", join(foreign, "bin", "gemini"));
    await expectLocatorError(locateGeminiCli(box.options(undefined, [join(foreign, "bin")])), "cli_missing");
    // A shell wrapper is not the package's own entry script.
    await writeFile(join(box.home, ".npm-global", "bin", "gemini"), "#!/bin/sh\nexec node x\n");
    await chmod(join(box.home, ".npm-global", "bin", "gemini"), 0o755);
    await expectLocatorError(locateGeminiCli(box.options()), "cli_missing");
  });

  it("tries the dev-only extra roots first, and the pin still applies to them [GUILD_DEV_GEMINI_CLI]", async () => {
    const box = await sandbox();
    const scratch = join(box.root, "scratch");
    const { packageRoot } = await writeCliPackage(scratch, "0.63.0");
    await expectLocatorError(locateGeminiCli(box.options()), "cli_missing");
    assert.equal((await locateGeminiCli({ ...box.options(), extraPackageRoots: [packageRoot] })).packageRoot, packageRoot);
    const unsupported = await writeCliPackage(join(box.root, "scratch3"), "0.80.0");
    await expectLocatorError(locateGeminiCli({ ...box.options(), extraPackageRoots: [unsupported.packageRoot] }), "cli_version_unsupported", "0.80.0");
    await expectLocatorError(locateGeminiCli({ ...box.options(), extraPackageRoots: ["relative/dir", join(box.root, "nope")] }), "cli_missing");
    const installed = await installCli(join(box.home, ".npm-global"), "0.64.0");
    assert.equal((await locateGeminiCli({ ...box.options(), extraPackageRoots: [packageRoot] })).packageRoot, packageRoot);
    assert.equal((await locateGeminiCli(box.options())).packageRoot, installed.packageRoot);
  });

  it("probes the version without hashing and without running anything", async () => {
    const box = await sandbox();
    const executed: string[] = [];
    const options = box.options(async (file) => { executed.push(file); return ""; });
    await expectLocatorError(probeGeminiCli(options), "cli_missing");
    const { packageRoot } = await installCli(join(box.home, ".npm-global"), "0.63.0");
    assert.deepEqual({ ...(await probeGeminiCli(options)) }, { version: "0.63.0" });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.99.0" }));
    await expectLocatorError(probeGeminiCli(options), "cli_version_unsupported", "0.99.0");
    assert.deepEqual(executed, []);
  });

  it("re-pins by reading only: a new version is an update, the same version with other bytes is flagged", async () => {
    const box = await sandbox();
    const { entry, packageRoot } = await installCli(join(box.home, ".npm-global"), "0.63.0");
    const executed: string[] = [];
    const options = box.options(async (file) => { executed.push(file); return ""; });
    const before = await locateGeminiCli(options);
    await writeFile(entry, "#!/usr/bin/env node\nconsole.log('swapped');\n");
    const swapped = await locateGeminiCli(options);
    assert.equal(swapped.version, before.version);
    assert.notEqual(swapped.fingerprintSha256, before.fingerprintSha256);
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.64.0" }));
    const updated = await locateGeminiCli(options);
    assert.equal(updated.version, "0.64.0");
    assert.deepEqual(executed, []);
    const engine = (cli: typeof before): LocatedGeminiEngine => ({
      node: { executablePath: "/n", sha256: "a".repeat(64), version: "26.0.0" },
      cli,
    });
    assert.equal(unexpectedGeminiEngineChange(engine(before), engine(swapped)), "cli");
    assert.equal(unexpectedGeminiEngineChange(engine(before), engine(updated)), undefined);
  });

  it("reads the package root from the entry script and nothing else", () => {
    assert.equal(geminiPackageRoot("/p/lib/node_modules/@google/gemini-cli/bundle/gemini.js"), "/p/lib/node_modules/@google/gemini-cli");
    for (const other of ["/p/dist/index.js", "/p/bundle/index.js", "/p/gemini.js", "/p/lib/gemini.js", "/p/bundle/gemini.mjs"]) {
      assert.equal(geminiPackageRoot(other), undefined, other);
    }
  });
});

describe("Gemini locator: whole engine", () => {
  it("returns node and the pinned CLI together", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node);
    await installCli(join(box.home, ".npm-global"), "0.63.0");
    const engine = await locateGeminiEngine(box.options(answers({ [node]: "v26.8.1" })));
    assert.equal(engine.node.executablePath, node);
    assert.equal(engine.cli.version, "0.63.0");
    assert.equal(Object.isFrozen(engine), true);
  });

  it("reports the first missing piece in the order node, CLI, in Gemini's own error type", async () => {
    const box = await sandbox();
    await expectLocatorError(locateGeminiEngine(box.options(answers({}))), "node_missing");
    const node = join(box.bin, "node");
    await writeMachO(node);
    await expectLocatorError(locateGeminiEngine(box.options(answers({ [node]: "v20.1.0" }))), "node_too_old", "20.1.0");
    const probe = answers({ [node]: "v26.8.1" });
    await expectLocatorError(locateGeminiEngine(box.options(probe)), "cli_missing");
    await installCli(join(box.home, ".npm-global"), "0.63.0");
    assert.equal((await locateGeminiEngine(box.options(probe))).node.version, "26.8.1");
  });

  it("holds the node to the launch's pin and raises the Gemini integrity error when it changed", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    await installCli(join(box.home, ".npm-global"), "0.63.0");
    const probe = answers({ [node]: "v26.8.1" });
    await locateGeminiEngine(box.options(probe));
    invalidateClaudeLocatorCache();
    await writeMachO(node, "swapped bytes");
    await assert.rejects(locateGeminiEngine(box.options(probe)), (cause: unknown) => {
      assert.ok(cause instanceof GeminiEngineIntegrityError);
      assert.equal(cause.message, "engine_integrity_changed");
      assert.equal(cause.component, "node");
      return true;
    });
  });
});

describe("Gemini locator: what a re-locate may replace [PC-ENG-004]", () => {
  const base: LocatedGeminiEngine = Object.freeze({
    node: Object.freeze({ executablePath: "/usr/local/bin/node", sha256: "a".repeat(64), version: "26.8.1" }),
    cli: Object.freeze({
      packageRoot: "/opt/gemini-cli",
      entryPath: "/opt/gemini-cli/bundle/gemini.js",
      version: "0.63.0",
      fingerprintSha256: "c".repeat(64),
    }),
  });
  const changed = (over: { node?: Partial<LocatedGeminiEngine["node"]>; cli?: Partial<LocatedGeminiEngine["cli"]> }): LocatedGeminiEngine =>
    Object.freeze({ node: Object.freeze({ ...base.node, ...over.node }), cli: Object.freeze({ ...base.cli, ...over.cli }) });

  it("accepts an identical result and an update, refuses the same version with other bytes", () => {
    assert.equal(unexpectedGeminiEngineChange(base, changed({})), undefined);
    assert.equal(unexpectedGeminiEngineChange(base, changed({ cli: { version: "0.64.0", fingerprintSha256: "d".repeat(64) } })), undefined);
    assert.equal(unexpectedGeminiEngineChange(base, changed({ cli: { fingerprintSha256: "d".repeat(64) } })), "cli");
  });

  it("never replaces the node, and reports it before the CLI", () => {
    assert.equal(unexpectedGeminiEngineChange(base, changed({ node: { sha256: "b".repeat(64) } })), "node");
    assert.equal(unexpectedGeminiEngineChange(base, changed({ node: { executablePath: "/opt/node/bin/node" } })), "node");
    assert.equal(unexpectedGeminiEngineChange(base, changed({ node: { version: "26.9.0" } })), undefined, "the version label alone is not a change");
    assert.equal(unexpectedGeminiEngineChange(base, changed({ node: { sha256: "b".repeat(64) }, cli: { fingerprintSha256: "d".repeat(64) } })), "node");
  });
});
