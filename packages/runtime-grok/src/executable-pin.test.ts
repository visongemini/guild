import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  ExecutablePinError,
  pinExecutableShared,
  pruneStalePinnedExecutables,
} from "./executable-pin.js";
import {
  forgetSharedStagesForTesting,
  pinExecutableSharedForTesting,
} from "./executable-pin-testing.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];

type Fixture = {
  readonly directory: string;
  readonly stagingRoot: string;
  readonly executablePath: string;
  readonly sha256: string;
};

afterEach(async () => {
  await forgetSharedStagesForTesting();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function prepareFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(packageRoot, ".runtime-grok-pin-cache-"));
  directories.push(directory);
  const stagingRoot = join(directory, "staging");
  await mkdir(stagingRoot, { mode: 0o700 });
  const executablePath = join(directory, "grok-fixture");
  await copyFile(await realpath("/usr/bin/true"), executablePath);
  await chmod(executablePath, 0o700);
  return { directory, stagingRoot, executablePath, sha256: sha256Of(await readFile(executablePath)) };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pinEntries(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith(".grok-pin-")).sort();
}

describe("shared staged executable (cold start cache)", () => {
  it("stages one read-only copy per SHA-256 and reuses it without copying again", async () => {
    const fixture = await prepareFixture();
    const first = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const staged = await stat(first.stagedExecutablePath, { bigint: true });
    assert.equal(first.stagedExecutablePath.includes(`.grok-pin-${fixture.sha256}`), true);
    assert.equal(staged.mode & 0o7777n, 0o500n);
    assert.notEqual(staged.ino, (await stat(fixture.executablePath, { bigint: true })).ino);
    assert.equal(sha256Of(await readFile(first.stagedExecutablePath)), fixture.sha256);
    await first.verifyForSpawn();

    // A lease owns neither the descriptor nor the directory; the copy must survive its cleanup.
    assert.deepEqual(await first.cleanup(), {
      stageHandleClosed: true,
      stagingDirectoryRemoved: true,
      failure: "none",
    });
    const second = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const reused = await stat(second.stagedExecutablePath, { bigint: true });
    assert.equal(second.stagedExecutablePath, first.stagedExecutablePath);
    assert.equal(reused.ino, staged.ino);
    assert.equal(reused.mtimeNs, staged.mtimeNs);
    assert.equal(second.ino, first.ino);
    await second.verifyForSpawn();
    assert.deepEqual(await pinEntries(fixture.stagingRoot), [`.grok-pin-${fixture.sha256}`]);
  });

  it("shares one stage between concurrent first uses", async () => {
    const fixture = await prepareFixture();
    const pins = await Promise.all(
      [1, 2, 3, 4].map(() => pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256)),
    );
    assert.equal(new Set(pins.map((pin) => pin.stagedExecutablePath)).size, 1);
    assert.equal(new Set(pins.map((pin) => pin.ino)).size, 1);
    assert.deepEqual(await pinEntries(fixture.stagingRoot), [`.grok-pin-${fixture.sha256}`]);
  });

  it("does not touch the source on a hit beyond the cheap preflight", async () => {
    const fixture = await prepareFixture();
    const first = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    // The staged bytes already equal the pin, so a swapped source pathname cannot alter what runs.
    const replacement = join(fixture.directory, "replacement");
    await copyFile(await realpath("/usr/bin/false"), replacement);
    await chmod(replacement, 0o700);
    await rename(replacement, fixture.executablePath);
    const second = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    assert.equal(second.ino, first.ino);
    assert.equal(sha256Of(await readFile(second.stagedExecutablePath)), fixture.sha256);
  });

  it("keeps rejecting an unusable source even when a stage for that SHA-256 exists", async () => {
    const fixture = await prepareFixture();
    await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const script = join(fixture.directory, "script");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await assert.rejects(
      pinExecutableShared(script, fixture.stagingRoot, fixture.sha256),
      (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "not_macho",
    );
    await assert.rejects(
      pinExecutableShared("relative/grok", fixture.stagingRoot, fixture.sha256),
      (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "path_not_absolute",
    );
  });

  it("rejects a hash mismatch and leaves no stage behind", async () => {
    const fixture = await prepareFixture();
    await assert.rejects(
      pinExecutableShared(fixture.executablePath, fixture.stagingRoot, "0".repeat(64)),
      (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "hash_mismatch",
    );
    await assert.rejects(
      pinExecutableShared(fixture.executablePath, fixture.stagingRoot, "../escape"),
      (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "hash_mismatch",
    );
    assert.deepEqual(await pinEntries(fixture.stagingRoot), []);
    // A failed attempt must not poison a later correct one.
    const pin = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    assert.equal(pin.sha256, fixture.sha256);
  });

  for (const [name, tamper] of [
    ["deleted", async (path: string) => rm(path)],
    [
      "made writable and appended to",
      async (path: string) => {
        await chmod(path, 0o700);
        await appendFile(path, "x");
        await chmod(path, 0o500);
      },
    ],
    [
      "swapped for another inode with the same bytes and mode",
      async (path: string) => {
        const copy = `${path}.copy`;
        await copyFile(path, copy);
        await chmod(copy, 0o500);
        await rename(copy, path);
      },
    ],
    ["made writable only", async (path: string) => chmod(path, 0o700)],
  ] as const) {
    it(`replaces a staged copy that was ${name}`, async () => {
      const fixture = await prepareFixture();
      const first = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
      await tamper(first.stagedExecutablePath);
      const second = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
      const restaged = await lstat(second.stagedExecutablePath, { bigint: true });
      assert.equal(restaged.mode & 0o7777n, 0o500n);
      assert.notEqual(restaged.ino, first.ino, "a changed copy must be re-staged, not reused");
      assert.equal(sha256Of(await readFile(second.stagedExecutablePath)), fixture.sha256);
      await second.verifyForSpawn();
      assert.deepEqual(await pinEntries(fixture.stagingRoot), [`.grok-pin-${fixture.sha256}`]);
    });
  }

  it("fails the spawn verifier of a lease whose copy changes after it was granted", async () => {
    const fixture = await prepareFixture();
    const pin = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    await chmod(pin.stagedExecutablePath, 0o700);
    await assert.rejects(
      pin.verifyForSpawn(),
      (cause: unknown) => cause instanceof ExecutablePinError && cause.code === "executable_changed",
    );
  });

  it("adopts an intact copy left by an earlier process without copying it again", async () => {
    const fixture = await prepareFixture();
    const first = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const before = await stat(first.stagedExecutablePath, { bigint: true });
    await forgetSharedStagesForTesting();
    const second = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const after = await stat(second.stagedExecutablePath, { bigint: true });
    assert.equal(second.stagedExecutablePath, first.stagedExecutablePath);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    await second.verifyForSpawn();
  });

  it("re-stages a leftover copy whose bytes no longer match, even if its timestamps were restored", async () => {
    const fixture = await prepareFixture();
    const first = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    const original = await stat(first.stagedExecutablePath);
    await forgetSharedStagesForTesting();
    await chmod(first.stagedExecutablePath, 0o700);
    await writeFile(first.stagedExecutablePath, Buffer.concat([await readFile(fixture.executablePath), Buffer.from("!")]));
    await chmod(first.stagedExecutablePath, 0o500);
    await utimes(first.stagedExecutablePath, original.atime, original.mtime);
    const second = await pinExecutableShared(fixture.executablePath, fixture.stagingRoot, fixture.sha256);
    assert.equal(sha256Of(await readFile(second.stagedExecutablePath)), fixture.sha256);
    assert.equal((await lstat(second.stagedExecutablePath)).mode & 0o7777, 0o500);
    await second.verifyForSpawn();
  });

  it("does not leave a private stage directory behind when publishing loses a race", async () => {
    const fixture = await prepareFixture();
    const shared = join(fixture.stagingRoot, `.grok-pin-${fixture.sha256}`);
    const pin = await pinExecutableSharedForTesting(fixture.executablePath, fixture.stagingRoot, fixture.sha256, {
      afterDescriptorCopy: async () => {
        // Another process publishes a valid copy while this one is still staging.
        await mkdir(shared, { mode: 0o700 });
        const winner = join(shared, "grok-fixture");
        await copyFile(fixture.executablePath, winner);
        await chmod(winner, 0o500);
      },
    });
    assert.equal(pin.stagedExecutablePath, join(shared, "grok-fixture"));
    assert.deepEqual(await pinEntries(fixture.stagingRoot), [`.grok-pin-${fixture.sha256}`]);
    await pin.verifyForSpawn();
  });
});

describe("stale staging cleanup", () => {
  it("removes other-SHA copies and orphaned private stages while keeping live and unrelated entries", async () => {
    const fixture = await prepareFixture();
    const root = fixture.stagingRoot;
    const keep = fixture.sha256;
    const otherSha = randomBytes(32).toString("hex");
    const oldPrivate = `.grok-pin-${randomBytes(18).toString("hex")}`;
    const freshPrivate = `.grok-pin-${randomBytes(18).toString("hex")}`;
    for (const name of [`.grok-pin-${keep}`, `.grok-pin-${otherSha}`, oldPrivate, freshPrivate, "sibling-sentinel"]) {
      await mkdir(join(root, name), { mode: 0o700 });
      await writeFile(join(root, name, "payload"), "x");
    }
    const outside = join(fixture.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep-me"), "x");
    await symlink(outside, join(root, `.grok-pin-${randomBytes(32).toString("hex")}`));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(join(root, oldPrivate), old, old);

    assert.equal(await pruneStalePinnedExecutables(root, keep), 2);
    assert.deepEqual(
      (await readdir(root)).filter((entry) => !entry.startsWith(".grok-pin-") || (entry.length === 74 && entry.endsWith(keep))).sort(),
      [`.grok-pin-${keep}`, "sibling-sentinel"],
    );
    assert.equal((await readdir(root)).includes(freshPrivate), true);
    assert.equal((await readdir(root)).includes(`.grok-pin-${otherSha}`), false);
    assert.equal((await readdir(root)).includes(oldPrivate), false);
    await readFile(join(outside, "keep-me"));
  });

  it("is a no-op for a missing or relative staging root", async () => {
    assert.equal(await pruneStalePinnedExecutables("relative", "0".repeat(64)), 0);
    assert.equal(await pruneStalePinnedExecutables(join(packageRoot, ".does-not-exist"), "0".repeat(64)), 0);
  });
});
