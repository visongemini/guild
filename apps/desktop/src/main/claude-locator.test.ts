import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  buildClaudeSearchPath,
  ClaudeLocatorError,
  invalidateClaudeLocatorCache,
  locateClaudeAdapter,
  locateClaudeBinary,
  locateClaudeEngine,
  locateNode,
  type ClaudeLocatorErrorCode,
  type ClaudeLocatorOptions,
} from "./claude-locator.js";

// Nothing here runs a real node, adapter or claude: files carry only a Mach-O magic number (or a
// shebang line) and version probes are answered by an injected function.
const MACH_O_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

afterEach(() => {
  invalidateClaudeLocatorCache();
});

type Sandbox = Readonly<{
  root: string;
  home: string;
  /** A directory that is on the simulated user PATH. */
  bin: string;
  options: (execute?: ClaudeLocatorOptions["execute"], extraPath?: readonly string[]) => ClaudeLocatorOptions;
}>;

async function sandbox(): Promise<Sandbox> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-claude-locator-")));
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

async function writeScript(path: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\necho v26.0.0\n");
  await chmod(path, 0o755);
}

function answers(table: Readonly<Record<string, string>>): { execute: NonNullable<ClaudeLocatorOptions["execute"]>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    execute: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      const answer = table[file];
      if (answer === undefined) throw new Error("probe failed");
      return answer;
    },
  };
}

async function writeAdapterPackage(
  prefix: string,
  version: string,
  name = "@agentclientprotocol/claude-agent-acp",
): Promise<{ readonly entry: string; readonly packageRoot: string }> {
  const packageRoot = join(prefix, "lib", "node_modules", ...name.split("/"));
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name, version }));
  const entry = join(packageRoot, "dist", "index.js");
  await writeFile(entry, "#!/usr/bin/env node\nconsole.log('adapter');\n");
  await chmod(entry, 0o755);
  return { entry, packageRoot };
}

async function expectLocatorError(
  operation: Promise<unknown>,
  code: ClaudeLocatorErrorCode,
  foundVersion?: string,
): Promise<void> {
  await assert.rejects(operation, (cause: unknown) => {
    assert.ok(cause instanceof ClaudeLocatorError, String(cause));
    assert.equal(cause.code, code);
    assert.equal(cause.foundVersion, foundVersion);
    return true;
  });
}

describe("Claude locator search paths", () => {
  it("orders the directories per component and keeps only absolute, unique entries", () => {
    const fallback = ["/opt/homebrew/bin", "/usr/local/bin"];
    assert.deepEqual(buildClaudeSearchPath("claude", "/usr/bin:relative/bin::/opt/homebrew/bin", "/Users/example", fallback), [
      "/Users/example/.local/bin",
      "/usr/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    assert.deepEqual(buildClaudeSearchPath("adapter", "/usr/bin", "/Users/example", fallback), [
      "/Users/example/.npm-global/bin",
      "/usr/bin",
      "/Users/example/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    assert.deepEqual(buildClaudeSearchPath("node", undefined, "/Users/example", fallback), [
      "/Users/example/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
    assert.deepEqual(
      buildClaudeSearchPath("node", "/usr/bin:/bin", "/Users/example", []),
      ["/usr/bin", "/bin", "/Users/example/.local/bin"],
    );
  });
});

describe("Claude locator: node", () => {
  it("resolves a symlinked node, probes its version and hashes the real file", async () => {
    const box = await sandbox();
    const real = join(box.root, "toolchain", "node");
    await writeMachO(real, "node-binary");
    await symlink(real, join(box.home, ".local", "bin", "node"));
    const probe = answers({ [real]: "v26.8.1\n" });
    const located = await locateNode(box.options(probe.execute));
    assert.equal(located.executablePath, real);
    assert.equal(located.version, "26.8.1");
    assert.equal(located.sha256, createHash("sha256").update(await readFile(real)).digest("hex"));
    assert.equal(Object.isFrozen(located), true);
  });

  it("reuses the cached identity until the file changes", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    const probe = answers({ [node]: "v24.0.0" });
    const first = await locateNode(box.options(probe.execute));
    const second = await locateNode(box.options(probe.execute));
    assert.equal(second, first, "the same result object comes back from the cache");
    assert.equal(probe.calls.length, 1);
    await writeMachO(node, "second, longer payload");
    await utimes(node, new Date(), new Date(Date.now() + 5_000));
    const third = await locateNode(box.options(probe.execute));
    assert.equal(probe.calls.length, 2);
    assert.notEqual(third.sha256, first.sha256);
  });

  it("reports node_too_old with the version found, and prefers a later node that is new enough", async () => {
    const box = await sandbox();
    const old = join(box.bin, "node");
    await writeMachO(old, "old");
    await expectLocatorError(
      locateNode(box.options(answers({ [old]: "v20.11.0" }).execute)),
      "node_too_old",
      "20.11.0",
    );
    const second = join(box.root, "second", "node");
    await writeMachO(second, "new");
    const located = await locateNode(box.options(answers({ [old]: "v20.11.0", [second]: "v22.0.0" }).execute, [join(box.root, "second")]));
    assert.equal(located.executablePath, second);
    assert.equal(located.version, "22.0.0");
  });

  it("is node_missing when nothing usable exists: absent, a script, or a binary that cannot report a version", async () => {
    const box = await sandbox();
    await expectLocatorError(locateNode(box.options(answers({}).execute)), "node_missing");
    await writeScript(join(box.bin, "node"));
    await expectLocatorError(locateNode(box.options(answers({ [join(box.bin, "node")]: "v26.0.0" }).execute)), "node_missing");
    const broken = join(box.root, "broken", "node");
    await writeMachO(broken);
    await expectLocatorError(locateNode(box.options(answers({}).execute, [join(box.root, "broken")])), "node_missing");
    await writeMachO(join(box.root, "garbled", "node"));
    await expectLocatorError(
      locateNode(box.options(answers({ [join(box.root, "garbled", "node")]: "not a version" }).execute, [join(box.root, "garbled")])),
      "node_missing",
    );
  });
});

describe("Claude locator: adapter", () => {
  it("finds the adapter through a bin symlink and pins its package", async () => {
    const box = await sandbox();
    const prefix = join(box.home, ".npm-global");
    const { entry, packageRoot } = await writeAdapterPackage(prefix, "0.89.1");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    const pin = await locateClaudeAdapter(box.options());
    assert.equal(pin.packageRoot, packageRoot);
    assert.equal(pin.entryPath, entry);
    assert.equal(pin.version, "0.89.1");
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
  });

  it("also searches the user PATH and Homebrew-style locations", async () => {
    const box = await sandbox();
    const prefix = join(box.root, "homebrew");
    const { packageRoot } = await writeAdapterPackage(prefix, "0.89.7");
    await mkdir(join(prefix, "bin"), { recursive: true });
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    assert.equal((await locateClaudeAdapter(box.options(undefined, [join(prefix, "bin")]))).packageRoot, packageRoot);
    const viaFallback = { ...box.options(), environment: { PATH: "/nonexistent" }, fallbackDirectories: [join(prefix, "bin")] };
    assert.equal((await locateClaudeAdapter(viaFallback)).packageRoot, packageRoot);
  });

  it("names an unsupported version and still finds a supported install elsewhere", async () => {
    const box = await sandbox();
    const newer = join(box.home, ".npm-global");
    await writeAdapterPackage(newer, "0.90.0");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(newer, "bin", "claude-agent-acp"));
    await expectLocatorError(locateClaudeAdapter(box.options()), "adapter_version_unsupported", "0.90.0");

    const supported = join(box.root, "second");
    const { packageRoot } = await writeAdapterPackage(supported, "0.89.2");
    await mkdir(join(supported, "bin"), { recursive: true });
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(supported, "bin", "claude-agent-acp"));
    assert.equal((await locateClaudeAdapter(box.options(undefined, [join(supported, "bin")]))).packageRoot, packageRoot);
  });

  it("is adapter_missing for absent, foreign or wrapped installs", async () => {
    const box = await sandbox();
    await expectLocatorError(locateClaudeAdapter(box.options()), "adapter_missing");

    const foreign = join(box.root, "foreign");
    await writeAdapterPackage(foreign, "0.89.1", "some-other-cli");
    await mkdir(join(foreign, "bin"), { recursive: true });
    await symlink("../lib/node_modules/some-other-cli/dist/index.js", join(foreign, "bin", "claude-agent-acp"));
    await expectLocatorError(locateClaudeAdapter(box.options(undefined, [join(foreign, "bin")])), "adapter_missing");

    await writeScript(join(box.home, ".npm-global", "bin", "claude-agent-acp"));
    await expectLocatorError(locateClaudeAdapter(box.options()), "adapter_missing");
  });
});

describe("Claude locator: claude binary", () => {
  it("prefers ~/.local/bin/claude and resolves it to the versioned binary", async () => {
    const box = await sandbox();
    const versioned = join(box.root, "share", "claude", "versions", "2.1.291");
    await writeMachO(versioned);
    await symlink(versioned, join(box.home, ".local", "bin", "claude"));
    const other = join(box.bin, "claude");
    await writeMachO(other, "other");
    const probe = answers({ [versioned]: "2.1.291 (Claude Code)\n", [other]: "1.0.0 (Claude Code)\n" });
    const located = await locateClaudeBinary(box.options(probe.execute));
    assert.equal(located.executablePath, versioned);
    assert.equal(located.version, "2.1.291");
    assert.deepEqual(probe.calls, [`${versioned} --version`]);
    // Cached while the file is unchanged.
    await locateClaudeBinary(box.options(probe.execute));
    assert.equal(probe.calls.length, 1);
  });

  it("falls back to PATH and skips scripts and binaries that do not answer --version", async () => {
    const box = await sandbox();
    await writeScript(join(box.home, ".local", "bin", "claude"));
    const silentDirectory = join(box.root, "silent");
    const silent = join(silentDirectory, "claude");
    await writeMachO(silent, "silent");
    const working = join(box.bin, "claude");
    await writeMachO(working, "working");
    const options = (execute: NonNullable<ClaudeLocatorOptions["execute"]>): ClaudeLocatorOptions => ({
      ...box.options(execute),
      environment: { PATH: [silentDirectory, box.bin].join(delimiter) },
    });
    const located = await locateClaudeBinary(options(answers({ [working]: "2.2.0 (Claude Code)" }).execute));
    assert.equal(located.executablePath, working);
    assert.equal(located.version, "2.2.0");
    await rm(working);
    invalidateClaudeLocatorCache();
    await expectLocatorError(locateClaudeBinary(options(answers({}).execute)), "claude_missing");
  });
});

describe("Claude locator: whole engine", () => {
  it("returns node, adapter and claude together", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    const claude = join(box.home, ".local", "bin", "claude");
    await writeMachO(node);
    await writeMachO(claude);
    const prefix = join(box.home, ".npm-global");
    await writeAdapterPackage(prefix, "0.89.1");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    const engine = await locateClaudeEngine(box.options(answers({ [node]: "v26.8.1", [claude]: "2.1.291 (Claude Code)" }).execute));
    assert.equal(engine.node.executablePath, node);
    assert.equal(engine.adapter.version, "0.89.1");
    assert.equal(engine.claude.executablePath, claude);
  });

  it("reports the first missing piece in the order node, adapter, claude", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node);
    const probe = answers({ [node]: "v26.8.1" });
    await expectLocatorError(locateClaudeEngine(box.options(answers({}).execute)), "node_missing");
    await expectLocatorError(locateClaudeEngine(box.options(probe.execute)), "adapter_missing");
    const prefix = join(box.home, ".npm-global");
    await writeAdapterPackage(prefix, "0.89.1");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    await expectLocatorError(locateClaudeEngine(box.options(probe.execute)), "claude_missing");
  });
});
