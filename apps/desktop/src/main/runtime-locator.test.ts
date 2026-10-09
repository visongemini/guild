import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  buildRuntimeSearchPath,
  invalidateOfficialGrokRuntimeCache,
  locateOfficialGrokRuntime,
  mergeMacOSSystemProxyEnvironment,
} from "./runtime-locator.js";

describe("official Grok runtime search path", () => {
  it("extends a Finder-style PATH with common Homebrew locations", () => {
    assert.equal(
      buildRuntimeSearchPath("/usr/bin:/bin:/usr/sbin:/sbin", "/Users/example"),
      "/usr/bin:/bin:/usr/sbin:/sbin:/Users/example/.grok/bin:/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin",
    );
  });

  it("deduplicates existing locations without adding an empty current-directory entry", () => {
    assert.equal(
      buildRuntimeSearchPath(":/opt/homebrew/bin:/usr/bin:", "/Users/example"),
      "/opt/homebrew/bin:/usr/bin:/Users/example/.grok/bin:/Users/example/.local/bin:/usr/local/bin:/bin:/usr/sbin:/sbin",
    );
  });
});

describe("official Grok runtime proxy environment", () => {
  const systemProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : localhost
    1 : 127.0.0.0/8
  }
  HTTPEnable : 1
  HTTPPort : 10808
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 10808
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 10808
  SOCKSProxy : 127.0.0.1
}`;

  it("translates the active macOS proxy for a Finder-style environment", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      { PATH: "/usr/bin:/bin", LANG: "zh_CN.UTF-8" },
      systemProxy,
    );
    assert.equal(environment.HTTP_PROXY, "http://127.0.0.1:10808");
    assert.equal(environment.http_proxy, "http://127.0.0.1:10808");
    assert.equal(environment.HTTPS_PROXY, "http://127.0.0.1:10808");
    assert.equal(environment.https_proxy, "http://127.0.0.1:10808");
    assert.equal(environment.ALL_PROXY, undefined);
    assert.equal(environment.NO_PROXY, "localhost,127.0.0.1,::1,127.0.0.0/8");
    assert.equal(environment.no_proxy, environment.NO_PROXY);
    assert.equal(Object.isFrozen(environment), true);
  });

  it("preserves explicit proxy variables instead of overriding them", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      { HTTPS_PROXY: "http://explicit.example:8080" },
      systemProxy,
    );
    assert.equal(environment.HTTPS_PROXY, "http://explicit.example:8080");
    assert.equal(environment.HTTP_PROXY, undefined);
  });

  it("ignores malformed system proxy endpoints", () => {
    const environment = mergeMacOSSystemProxyEnvironment(
      {},
      `HTTPEnable : 1\nHTTPProxy : bad host/@example\nHTTPPort : 70000`,
    );
    assert.equal(environment.HTTP_PROXY, undefined);
    assert.equal(environment.NO_PROXY, undefined);
  });
});

describe("official Grok runtime location cache", () => {
  const directories: string[] = [];

  afterEach(async () => {
    invalidateOfficialGrokRuntimeCache();
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** A tiny fake `grok` whose `--version` run is counted, so cache hits are observable. */
  async function fixture(version = "1.0.0") {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "guild-locator-")));
    directories.push(directory);
    const bin = join(directory, "bin");
    await mkdir(bin);
    const counter = join(directory, "versions-run");
    const executable = join(bin, "grok");
    const write = async (nextVersion: string, path = executable) => {
      await writeFile(path, `#!/bin/sh\necho run >> "${counter}"\necho "grok ${nextVersion} (fixture)"\n`, { mode: 0o755 });
      await chmod(path, 0o755);
    };
    await write(version);
    const versionRuns = async () =>
      (await readFile(counter, "utf8").catch(() => "")).split("\n").filter((line) => line === "run").length;
    return { directory, bin, executable, write, versionRuns, environment: { PATH: bin } };
  }

  it("runs which, the full hash and --version once and then returns the same result", async () => {
    const f = await fixture("1.0.0");
    const first = await locateOfficialGrokRuntime(f.environment);
    assert.equal(first.executablePath, f.executable);
    assert.equal(first.version, "grok 1.0.0 (fixture)");
    assert.equal(first.sha256, createHash("sha256").update(await readFile(f.executable)).digest("hex"));
    const again = await Promise.all([1, 2, 3].map(() => locateOfficialGrokRuntime(f.environment)));
    for (const result of again) assert.strictEqual(result, first);
    assert.equal(await f.versionRuns(), 1);
  });

  it("shares the work of concurrent first calls", async () => {
    const f = await fixture();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => locateOfficialGrokRuntime(f.environment)));
    assert.equal(new Set(results).size, 1);
    assert.equal(await f.versionRuns(), 1);
  });

  it("re-locates when the file's size and mtime change", async () => {
    const f = await fixture("1.0.0");
    const first = await locateOfficialGrokRuntime(f.environment);
    await f.write("1.0.1-longer");
    const second = await locateOfficialGrokRuntime(f.environment);
    assert.notStrictEqual(second, first);
    assert.equal(second.version, "grok 1.0.1-longer (fixture)");
    assert.notEqual(second.sha256, first.sha256);
    assert.equal(await f.versionRuns(), 2);
  });

  it("re-locates when only the mtime changes", async () => {
    const f = await fixture();
    const first = await locateOfficialGrokRuntime(f.environment);
    const later = new Date(Date.now() + 60_000);
    await utimes(f.executable, later, later);
    const second = await locateOfficialGrokRuntime(f.environment);
    assert.notStrictEqual(second, first);
    assert.equal(second.sha256, first.sha256);
    assert.equal(await f.versionRuns(), 2);
  });

  it("re-locates when same-size content is rewritten and the old mtime is restored", async () => {
    const f = await fixture("1.0.0");
    const first = await locateOfficialGrokRuntime(f.environment);
    const { mtime } = await stat(f.executable);
    await f.write("1.0.9");
    await utimes(f.executable, mtime, mtime);
    const second = await locateOfficialGrokRuntime(f.environment);
    assert.notStrictEqual(second, first);
    assert.equal(second.version, "grok 1.0.9 (fixture)");
    assert.notEqual(second.sha256, first.sha256);
  });

  it("follows a symlink that is repointed to a newer binary", async () => {
    const f = await fixture();
    const v1 = join(f.directory, "grok-1");
    const v2 = join(f.directory, "grok-2");
    await f.write("1.0.0", v1);
    await f.write("2.0.0-different", v2);
    await unlink(f.executable);
    await symlink(v1, f.executable);
    const first = await locateOfficialGrokRuntime(f.environment);
    assert.equal(first.executablePath, v1);
    await unlink(f.executable);
    await symlink(v2, f.executable);
    const second = await locateOfficialGrokRuntime(f.environment);
    assert.equal(second.executablePath, v2);
    assert.equal(second.version, "grok 2.0.0-different (fixture)");
  });

  it("forgets the binary when asked to invalidate it", async () => {
    const f = await fixture();
    const first = await locateOfficialGrokRuntime(f.environment);
    invalidateOfficialGrokRuntimeCache();
    const second = await locateOfficialGrokRuntime(f.environment);
    assert.notStrictEqual(second, first);
    assert.equal(second.sha256, first.sha256);
    assert.equal(await f.versionRuns(), 2);
  });

  it("does not answer for a different search path from the cache", async () => {
    const a = await fixture("1.0.0");
    const b = await fixture("3.0.0");
    assert.equal((await locateOfficialGrokRuntime(a.environment)).version, "grok 1.0.0 (fixture)");
    assert.equal((await locateOfficialGrokRuntime(b.environment)).version, "grok 3.0.0 (fixture)");
    assert.equal((await locateOfficialGrokRuntime(a.environment)).executablePath, a.executable);
  });

  it("never answers with a cached binary that has disappeared", async () => {
    const f = await fixture();
    await locateOfficialGrokRuntime(f.environment);
    await unlink(f.executable);
    // Another install may still be found on the fallback search path; the stale one must not be.
    const result = await locateOfficialGrokRuntime(f.environment).catch(() => undefined);
    assert.notEqual(result?.executablePath, f.executable);
  });
});
