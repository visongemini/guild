import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  buildClaudeSearchPath,
  ClaudeEngineIntegrityError,
  ClaudeLocatorError,
  invalidateClaudeLocatorCache,
  locateClaudeAdapter,
  locateClaudeBinary,
  locateClaudeEngine,
  locateNode,
  resetClaudeLaunchPinsForTesting,
  unexpectedEngineChange,
  type ClaudeLocatorErrorCode,
  type ClaudeLocatorOptions,
  type LocatedClaudeEngine,
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
  resetClaudeLaunchPinsForTesting();
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

  it("reuses the cached identity while the file is unchanged", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    const probe = answers({ [node]: "v24.0.0" });
    const first = await locateNode(box.options(probe.execute));
    const second = await locateNode(box.options(probe.execute));
    assert.equal(second, first, "the same result object comes back from the cache");
    assert.equal(probe.calls.length, 1);
  });

  it("trusts the first node of an app launch and refuses a changed one without running it [PC-ENG-002]", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    const probe = answers({ [node]: "v24.0.0" });
    const first = await locateNode(box.options(probe.execute));
    assert.equal(probe.calls.length, 1);

    // The bytes change under the same path. Dropping the identity cache does not make the new file trusted.
    await writeMachO(node, "second, longer payload");
    await utimes(node, new Date(), new Date(Date.now() + 5_000));
    invalidateClaudeLocatorCache();
    await assert.rejects(locateNode(box.options(probe.execute)), (cause: unknown) => {
      assert.ok(cause instanceof ClaudeEngineIntegrityError, String(cause));
      assert.equal(cause.component, "node");
      assert.equal(cause.message, "engine_integrity_changed");
      return true;
    });
    assert.equal(probe.calls.length, 1, "the changed node was never run, not even for --version");
    // The whole engine is refused the same way, and still nothing runs.
    await assert.rejects(locateClaudeEngine(box.options(probe.execute)), ClaudeEngineIntegrityError);
    assert.equal(probe.calls.length, 1);

    // The pinned bytes coming back clear the refusal; a new launch then trusts what is on disk.
    await writeMachO(node, "first");
    await utimes(node, new Date(), new Date(Date.now() + 9_000));
    assert.equal((await locateNode(box.options(probe.execute))).sha256, first.sha256);
    assert.equal(probe.calls.length, 1, "unchanged bytes are the same node, no run needed");

    await writeMachO(node, "second, longer payload");
    resetClaudeLaunchPinsForTesting();
    invalidateClaudeLocatorCache();
    const second = await locateNode(box.options(probe.execute));
    assert.equal(probe.calls.length, 2, "a new launch probes the new node (trust on first use)");
    assert.notEqual(second.sha256, first.sha256);
  });

  it("keeps the launch's node when only a touch or a different PATH is seen, and refuses it when gone [PC-ENG-002]", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "first");
    const probe = answers({ [node]: "v24.0.0" });
    const first = await locateNode(box.options(probe.execute));

    // Same bytes, new mtime: no run.
    await utimes(node, new Date(), new Date(Date.now() + 5_000));
    invalidateClaudeLocatorCache();
    assert.equal((await locateNode(box.options(probe.execute))).sha256, first.sha256);

    // Another node earlier on the path is never even considered within this launch.
    const other = join(box.root, "other", "node");
    await writeMachO(other, "other node");
    const both = answers({ [node]: "v24.0.0", [other]: "v26.0.0" });
    const viaOther = await locateNode(box.options(both.execute, []));
    assert.equal(viaOther.executablePath, node);
    const reordered = { ...box.options(both.execute), environment: { PATH: [join(box.root, "other"), box.bin].join(delimiter) } };
    assert.equal((await locateNode(reordered)).executablePath, node);
    assert.deepEqual(both.calls, [], "no other node was run");

    await rm(node);
    invalidateClaudeLocatorCache();
    await assert.rejects(locateNode(box.options(both.execute)), ClaudeEngineIntegrityError);
    assert.deepEqual(both.calls, []);
  });

  it("pins nothing for a node that is too old, so a newer one is found without a restart", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "old");
    await expectLocatorError(locateNode(box.options(answers({ [node]: "v20.0.0" }).execute)), "node_too_old", "20.0.0");
    await writeMachO(node, "new enough");
    const located = await locateNode(box.options(answers({ [node]: "v26.0.0" }).execute));
    assert.equal(located.version, "26.0.0");
    assert.equal(located.sha256, createHash("sha256").update(await readFile(node)).digest("hex"));
  });

  it("hashes before the first run and trusts nothing that changed while it was probed [PC-ENG-002]", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "original");
    const originalSha = createHash("sha256").update(await readFile(node)).digest("hex");
    let runs = 0;
    const swappingProbe: NonNullable<ClaudeLocatorOptions["execute"]> = async () => {
      runs += 1;
      if (runs === 1) {
        await writeMachO(node, "swapped while the probe ran");
        await utimes(node, new Date(), new Date(Date.now() + 5_000));
      }
      return "v26.0.0";
    };
    const first = await locateNode(box.options(swappingProbe));
    assert.equal(first.sha256, originalSha, "the hash is of the bytes that were there before the run");
    // The torn identity was not remembered or trusted: the next locate looks at the file again.
    const second = await locateNode(box.options(swappingProbe));
    assert.equal(runs, 2);
    assert.notEqual(second.sha256, originalSha);
    const third = await locateNode(box.options(swappingProbe));
    assert.equal(third, second);
    assert.equal(runs, 2, "now stable, so it is pinned and cached");
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

  it("re-pins by reading only: a new version is an update, the same version with other bytes is flagged, and nothing runs [PC-ENG-002]", async () => {
    const box = await sandbox();
    const prefix = join(box.home, ".npm-global");
    const { entry, packageRoot } = await writeAdapterPackage(prefix, "0.89.1");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    const executed: string[] = [];
    const options = box.options(async (file) => { executed.push(file); return ""; });
    const before = await locateClaudeAdapter(options);

    await writeFile(entry, "#!/usr/bin/env node\nconsole.log('swapped');\n");
    const swapped = await locateClaudeAdapter(options);
    assert.equal(swapped.version, before.version);
    assert.notEqual(swapped.fingerprintSha256, before.fingerprintSha256);

    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.89.2" }));
    const updated = await locateClaudeAdapter(options);
    assert.equal(updated.version, "0.89.2");
    assert.deepEqual(executed, [], "the adapter's files were only read");

    const engine = (adapter: typeof before): LocatedClaudeEngine => ({
      node: { executablePath: "/n", sha256: "a".repeat(64), version: "26.0.0" },
      adapter,
      claude: { executablePath: "/c/versions/2.1.291", version: "2.1.291" },
    });
    assert.equal(unexpectedEngineChange(engine(before), engine(swapped)), "adapter");
    assert.equal(unexpectedEngineChange(engine(before), engine(updated)), undefined);
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

describe("Claude locator: claude binary after a failed pin [PC-ENG-002]", () => {
  async function installed(box: Sandbox, version: string, root = "share"): Promise<string> {
    const path = join(box.root, root, "claude", "versions", version);
    await writeMachO(path, `claude ${root} ${version}`);
    return path;
  }

  it("judges a different path by its name and never runs it", async () => {
    const box = await sandbox();
    const link = join(box.home, ".local", "bin", "claude");
    const first = await installed(box, "2.1.291");
    await symlink(first, link);
    const probe = answers({ [first]: "2.1.291 (Claude Code)" });
    const pinned = await locateClaudeBinary(box.options(probe.execute));
    assert.equal(probe.calls.length, 1);

    // The installer repoints the link to a new release.
    const next = await installed(box, "2.1.300");
    await rm(link);
    await symlink(next, link);
    invalidateClaudeLocatorCache();
    const updated = await locateClaudeBinary(box.options(probe.execute), pinned);
    assert.deepEqual({ ...updated }, { executablePath: next, version: "2.1.300" });
    assert.equal(probe.calls.length, 1, "the new binary was not run to find that out");

    // The same release at another path is not an update.
    const sameRelease = await installed(box, "2.1.291", "copy");
    await rm(link);
    await symlink(sameRelease, link);
    await assert.rejects(locateClaudeBinary(box.options(probe.execute), pinned), (cause: unknown) => {
      assert.ok(cause instanceof ClaudeEngineIntegrityError, String(cause));
      assert.equal(cause.component, "claude");
      return true;
    });
    // Neither is a binary outside the installer's layout, whatever version it would report.
    const stray = join(box.root, "stray", "claude");
    await writeMachO(stray, "stray");
    await rm(link);
    await symlink(stray, link);
    await assert.rejects(locateClaudeBinary(box.options(probe.execute), pinned), ClaudeEngineIntegrityError);
    assert.equal(probe.calls.length, 1, "nothing was run for any of them");
  });

  it("keeps the pinned binary when the link still resolves to it, without running it", async () => {
    const box = await sandbox();
    const link = join(box.home, ".local", "bin", "claude");
    const first = await installed(box, "2.1.291");
    await symlink(first, link);
    const probe = answers({ [first]: "2.1.291 (Claude Code)" });
    const pinned = await locateClaudeBinary(box.options(probe.execute));
    invalidateClaudeLocatorCache();
    assert.equal(await locateClaudeBinary(box.options(probe.execute), pinned), pinned);
    assert.equal(probe.calls.length, 1);
    // Gone, or no longer a Mach-O binary: not a replacement, simply missing.
    await rm(first);
    await expectLocatorError(locateClaudeBinary(box.options(probe.execute), pinned), "claude_missing");
    await rm(link);
    await writeScript(link);
    await expectLocatorError(locateClaudeBinary(box.options(probe.execute), pinned), "claude_missing");
    assert.equal(probe.calls.length, 1);
  });

  it("re-locates the whole engine without running the changed pieces", async () => {
    const box = await sandbox();
    const node = join(box.bin, "node");
    await writeMachO(node, "node");
    const link = join(box.home, ".local", "bin", "claude");
    const first = await installed(box, "2.1.291");
    await symlink(first, link);
    const prefix = join(box.home, ".npm-global");
    const { packageRoot } = await writeAdapterPackage(prefix, "0.89.1");
    await symlink("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js", join(prefix, "bin", "claude-agent-acp"));
    const probe = answers({ [node]: "v26.8.1", [first]: "2.1.291 (Claude Code)" });
    const before = await locateClaudeEngine(box.options(probe.execute));
    assert.equal(probe.calls.length, 2);
    invalidateClaudeLocatorCache();

    // An adapter update and a claude release together: both re-pinned, nothing run.
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@agentclientprotocol/claude-agent-acp", version: "0.89.2" }));
    const next = await installed(box, "2.1.300");
    await rm(link);
    await symlink(next, link);
    const after = await locateClaudeEngine(box.options(probe.execute), before);
    assert.equal(after.node, before.node);
    assert.equal(after.adapter.version, "0.89.2");
    assert.equal(after.claude.version, "2.1.300");
    assert.equal(unexpectedEngineChange(before, after), undefined);
    assert.equal(probe.calls.length, 2, "the node was hashed, the adapter read, the claude path judged: no run");

    // The node's bytes change at the same time: refused, and the node is not run.
    await writeMachO(node, "node, replaced");
    invalidateClaudeLocatorCache();
    await assert.rejects(locateClaudeEngine(box.options(probe.execute), before), (cause: unknown) => {
      assert.ok(cause instanceof ClaudeEngineIntegrityError, String(cause));
      assert.equal(cause.component, "node");
      return true;
    });
    assert.equal(probe.calls.length, 2);
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

describe("Claude locator: what a re-locate may replace [PC-ENG-002]", () => {
  const base: LocatedClaudeEngine = Object.freeze({
    node: Object.freeze({ executablePath: "/usr/local/bin/node", sha256: "a".repeat(64), version: "26.8.1" }),
    adapter: Object.freeze({
      packageRoot: "/opt/adapter",
      entryPath: "/opt/adapter/dist/index.js",
      version: "0.89.1",
      fingerprintSha256: "c".repeat(64),
    }),
    claude: Object.freeze({ executablePath: "/home/u/.local/share/claude/versions/2.1.291", version: "2.1.291" }),
  });
  const changed = (over: {
    node?: Partial<LocatedClaudeEngine["node"]>;
    adapter?: Partial<LocatedClaudeEngine["adapter"]>;
    claude?: Partial<LocatedClaudeEngine["claude"]>;
  }): LocatedClaudeEngine =>
    Object.freeze({
      node: Object.freeze({ ...base.node, ...over.node }),
      adapter: Object.freeze({ ...base.adapter, ...over.adapter }),
      claude: Object.freeze({ ...base.claude, ...over.claude }),
    });

  it("accepts an identical result and every kind of update", () => {
    assert.equal(unexpectedEngineChange(base, changed({})), undefined);
    assert.equal(
      unexpectedEngineChange(base, changed({ adapter: { version: "0.89.2", fingerprintSha256: "d".repeat(64) } })),
      undefined,
    );
    assert.equal(
      unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/.local/share/claude/versions/2.1.300", version: "2.1.300" } })),
      undefined,
    );
  });

  it("refuses the same adapter version with other bytes, naming the piece", () => {
    assert.equal(unexpectedEngineChange(base, changed({ adapter: { fingerprintSha256: "d".repeat(64) } })), "adapter");
  });

  it("never replaces the node: other bytes, another path or another version are all refused", () => {
    assert.equal(unexpectedEngineChange(base, changed({ node: { sha256: "b".repeat(64) } })), "node");
    assert.equal(unexpectedEngineChange(base, changed({ node: { version: "26.9.0", sha256: "b".repeat(64) } })), "node");
    assert.equal(unexpectedEngineChange(base, changed({ node: { version: "26.9.0" } })), undefined, "the version label alone is not a change");
    assert.equal(unexpectedEngineChange(base, changed({ node: { executablePath: "/opt/node/bin/node" } })), "node");
  });

  it("accepts a claude link only when it now resolves to a new versions/<ver> release [PC-ENG-002]", () => {
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/tmp/evil/claude" } })), "claude");
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/.local/share/claude/versions/latest" } })), "claude");
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/versions/2.1.300/other" } })), "claude");
    // The same release at another path is not an update, whatever the new file claims to be.
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/tmp/other/versions/2.1.291" } })), "claude");
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/tmp/other/versions/2.1.291-copy" } })), "claude");
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/tmp/other/versions/2.1.291", version: "2.1.300" } })), "claude");
    // The release comes from the directory name: a new file that still reports the pinned version is refused too.
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/.local/share/claude/versions/2.1.300", version: "2.1.291" } })), "claude");
    // A different release in the same layout is an update.
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/.local/share/claude/versions/2.1.300", version: "2.1.300" } })), undefined);
    // A "new release" outside the pinned versions directory is not the installer's update.
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/tmp/x/versions/9.9.9", version: "9.9.9" } })), "claude");
    assert.equal(unexpectedEngineChange(base, changed({ claude: { executablePath: "/home/u/.local/share/claude/versions/2.1.200", version: "2.1.200" } })), undefined);
    // A claude binary that stays where it was is not a path change (it is pinned by path, not by hash).
    assert.equal(unexpectedEngineChange(base, changed({ claude: { version: "2.1.292" } })), undefined);
  });

  it("reports node before adapter before claude", () => {
    const all = changed({
      node: { sha256: "b".repeat(64) },
      adapter: { fingerprintSha256: "d".repeat(64) },
      claude: { executablePath: "/tmp/x" },
    });
    assert.equal(unexpectedEngineChange(base, all), "node");
    assert.equal(unexpectedEngineChange(base, changed({ adapter: all.adapter, claude: all.claude })), "adapter");
  });
});
