import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ExecutablePinError } from "./executable-pin.js";
import { forgetSharedStagesForTesting, pinExecutableForTesting, pinExecutableSharedForTesting } from "./executable-pin-testing.js";
import {
  DEFAULT_STAGING_ROOT_IO,
  StagingRootError,
  secureStagingRoot,
  type StagingRootIo,
  type StagingRootProblem,
  type StagingRootStats,
} from "./staging-root.js";

/*
 * PC-SEC-001, PC-ENG-002, PC-ENG-003: the directory the executables are copied into must be ours alone, and is proven so when it
 * is made and again before every stage and spawn. Owner and mode come through an injectable io, so the cases that need a second
 * account (a root made by somebody else, a parent that is not ours) run here without one.
 */

const ME = 501;
const OTHER = 502;
const directory = (uid: number, mode: number): StagingRootStats => ({ uid, mode: 0o040000 | mode, isDirectory: true, isSymbolicLink: false });
const link: StagingRootStats = { uid: ME, mode: 0o120777, isDirectory: false, isSymbolicLink: true };
const file: StagingRootStats = { uid: ME, mode: 0o100600, isDirectory: false, isSymbolicLink: false };

/** A tiny file system: path -> stats, with the calls recorded. */
function fakeIo(entries: Record<string, StagingRootStats>, uid = ME, options: { chmodTakes?: boolean; mkdirRace?: StagingRootStats } = {}): StagingRootIo & { calls: string[]; entries: Record<string, StagingRootStats> } {
  const state = { ...entries };
  const calls: string[] = [];
  return {
    uid,
    calls,
    entries: state,
    realpath: async (path) => path,
    lstat: async (path) => {
      const found = state[path];
      if (found === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return found;
    },
    mkdir: async (path, mode) => {
      calls.push(`mkdir ${path} ${mode.toString(8)}`);
      if (options.mkdirRace !== undefined) {
        state[path] = options.mkdirRace;
        throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
      }
      state[path] = directory(uid, mode);
    },
    chmod: async (path, mode) => {
      calls.push(`chmod ${path} ${mode.toString(8)}`);
      const current = state[path]!;
      if (options.chmodTakes !== false) state[path] = { ...current, mode: (current.mode & ~0o7777) | mode };
    },
  };
}

async function refused(promise: Promise<unknown>, problem: StagingRootProblem): Promise<void> {
  await assert.rejects(promise, (cause: unknown) => {
    assert.ok(cause instanceof StagingRootError, String(cause));
    assert.equal(cause.problem, problem);
    return true;
  });
}

describe("staging root rules, with the owner and mode injected [PC-SEC-001]", () => {
  const PARENT = "/var/T";
  const ROOT = "/var/T/guild-v2-runtime";
  const parent = directory(ME, 0o700);

  it("accepts a root that is ours with mode 0700 in a parent that is ours, and changes nothing", async () => {
    const io = fakeIo({ [PARENT]: parent, [ROOT]: directory(ME, 0o700) });
    assert.equal(await secureStagingRoot(ROOT, { io }), ROOT);
    assert.deepEqual(io.calls, []);
  });

  it("creates a missing root with mode 0700 only when asked to, and checks what it created", async () => {
    const io = fakeIo({ [PARENT]: parent });
    await refused(secureStagingRoot(ROOT, { io }), "root_unreadable");
    assert.deepEqual(io.calls, []);
    assert.equal(await secureStagingRoot(ROOT, { create: true, io }), ROOT);
    assert.deepEqual(io.calls, [`mkdir ${ROOT} 700`]);
    await refused(secureStagingRoot(ROOT, { create: true, io: fakeIo({}) }), "parent_missing");
  });

  it("refuses a root that is owned by somebody else, whatever its mode, and does not touch it", async () => {
    for (const mode of [0o700, 0o755, 0o777]) {
      const io = fakeIo({ [PARENT]: parent, [ROOT]: directory(OTHER, mode) });
      await refused(secureStagingRoot(ROOT, { io }), "root_not_ours");
      assert.deepEqual(io.calls, [], `mode ${mode.toString(8)} of somebody else's root is left alone`);
    }
    // Root-owned is not "ours" either: the root must be the current user's.
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: parent, [ROOT]: directory(0, 0o700) }) }), "root_not_ours");
  });

  it("refuses a link or a file in place of the root, and a root somebody pre-created while we were creating ours", async () => {
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: parent, [ROOT]: link }) }), "root_is_link");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: parent, [ROOT]: file }) }), "root_not_directory");
    await refused(
      secureStagingRoot(ROOT, { create: true, io: fakeIo({ [PARENT]: parent }, ME, { mkdirRace: directory(OTHER, 0o777) }) }),
      "root_not_ours",
    );
  });

  it("tightens a root that is ours but looser, and refuses when the tightening does not take", async () => {
    for (const mode of [0o755, 0o777, 0o750, 0o707]) {
      const io = fakeIo({ [PARENT]: parent, [ROOT]: directory(ME, mode) });
      assert.equal(await secureStagingRoot(ROOT, { io }), ROOT, mode.toString(8));
      assert.deepEqual(io.calls, [`chmod ${ROOT} 700`]);
      assert.equal(io.entries[ROOT]!.mode & 0o777, 0o700);
    }
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: parent, [ROOT]: directory(ME, 0o777) }, ME, { chmodTakes: false }) }), "root_cannot_be_tightened");
  });

  it("refuses a parent others can write to unless it has the sticky bit, and a parent that is not ours or root's", async () => {
    const root = { [ROOT]: directory(ME, 0o700) };
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(ME, 0o777), ...root }) }), "parent_writable");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(0, 0o777), ...root }) }), "parent_writable");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(0, 0o775), ...root }) }), "parent_writable");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(ME, 0o772), ...root }) }), "parent_writable");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(OTHER, 0o755), ...root }) }), "parent_not_ours");
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: file, ...root }) }), "parent_not_directory");
    // /tmp: root-owned, world-writable, sticky: others cannot rename or remove what is ours.
    assert.equal(await secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(0, 0o1777), ...root }) }), ROOT);
    assert.equal(await secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(0, 0o755), ...root }) }), ROOT);
    await refused(secureStagingRoot(ROOT, { io: fakeIo({ [PARENT]: directory(OTHER, 0o1777), ...root }) }), "parent_not_ours");
  });

  it("refuses a relative path", async () => {
    await refused(secureStagingRoot("guild-v2-runtime", { io: fakeIo({}) }), "not_absolute");
    await refused(secureStagingRoot("/", { io: fakeIo({}) }), "not_absolute");
  });
});

describe("staging root on the real file system [PC-SEC-001]", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await forgetSharedStagesForTesting();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(): Promise<{ parent: string; root: string; executable: string; sha256: string }> {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "guild-staging-root-")));
    roots.push(parent);
    const executable = join(parent, "tool");
    await copyFile(await realpath("/usr/bin/true"), executable);
    await chmod(executable, 0o700);
    return { parent, root: join(parent, "guild-v2-runtime"), executable, sha256: createHash("sha256").update(await readFile(executable)).digest("hex") };
  }

  it("creates the root 0700, tightens a looser one of ours, and refuses a link", async () => {
    const { parent, root } = await fixture();
    assert.equal(await secureStagingRoot(root, { create: true }), root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await chmod(root, 0o777);
    assert.equal(await secureStagingRoot(root), root);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await rename(root, join(parent, "real"));
    await symlink(join(parent, "real"), root);
    await refused(secureStagingRoot(root), "root_is_link");
    await rm(root);
    await writeFile(root, "x");
    await refused(secureStagingRoot(root), "root_not_directory");
  });

  it("refuses a parent that anybody can write to without the sticky bit, and accepts one that has it", async () => {
    const { parent, root } = await fixture();
    await mkdir(root, { mode: 0o700 });
    await chmod(parent, 0o777);
    await refused(secureStagingRoot(root), "parent_writable");
    await chmod(parent, 0o1777);
    assert.equal(await secureStagingRoot(root), root);
    await chmod(parent, 0o775);
    await refused(secureStagingRoot(root), "parent_writable");
    await chmod(parent, 0o700);
    assert.equal(await secureStagingRoot(root), root);
    assert.equal(DEFAULT_STAGING_ROOT_IO.uid, process.getuid?.());
  });
});

describe("the pin checks the staging root before it stages and again before every spawn [PC-SEC-001]", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await forgetSharedStagesForTesting();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(): Promise<{ parent: string; root: string; executable: string; sha256: string }> {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "guild-staging-pin-")));
    roots.push(parent);
    const executable = join(parent, "tool");
    await copyFile(await realpath("/usr/bin/true"), executable);
    await chmod(executable, 0o700);
    return { parent, root: join(parent, "guild-v2-runtime"), executable, sha256: createHash("sha256").update(await readFile(executable)).digest("hex") };
  }
  const refusedPin = (promise: Promise<unknown>): Promise<void> => assert.rejects(promise, (cause: unknown) => {
    assert.ok(cause instanceof ExecutablePinError, String(cause));
    assert.equal(cause.code, "staging_root_unsafe");
    return true;
  });

  it("refuses to stage into a root that somebody else owns, for a private and for a shared copy", async () => {
    const { parent, root, executable, sha256 } = await fixture();
    await mkdir(root, { mode: 0o700 });
    const notMine: StagingRootIo = { ...DEFAULT_STAGING_ROOT_IO, uid: (process.getuid?.() ?? 0) + 1 };
    await refusedPin(pinExecutableForTesting(executable, root, sha256, { stagingRootIo: notMine }));
    await refusedPin(pinExecutableSharedForTesting(executable, root, sha256, { stagingRootIo: notMine }));
    // Nothing was staged into it.
    assert.deepEqual((await lstat(root)).isDirectory(), true);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(root), []);
    // The same root is fine for its owner; the root is created when missing.
    const mine = await pinExecutableForTesting(executable, join(parent, "fresh-root"), sha256, {});
    assert.equal((await stat(join(parent, "fresh-root"))).mode & 0o777, 0o700);
    await mine.cleanup();
  });

  it("proves the root private again right before each spawn: a root swapped for a link after the copy was verified is refused", async () => {
    const { parent, root, executable, sha256 } = await fixture();
    for (const shared of [false, true]) {
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { mode: 0o700 });
      const pinned = shared
        ? await pinExecutableSharedForTesting(executable, root, sha256, {})
        : await pinExecutableForTesting(executable, root, sha256, {});
      await pinned.verifyForSpawn();
      // Whoever can rename the root puts an attacker's directory in its place.
      const aside = join(parent, `aside-${shared ? "shared" : "private"}`);
      await rename(root, aside);
      await symlink(aside, root);
      await refusedPin(pinned.verifyForSpawn());
      await rm(root);
      await rename(aside, root);
      await pinned.verifyForSpawn();
      // A looser mode is tightened (the root is ours), a root that became somebody else's is not.
      await chmod(root, 0o777);
      await pinned.verifyForSpawn();
      assert.equal((await stat(root)).mode & 0o777, 0o700);
      await pinned.cleanup();
      await forgetSharedStagesForTesting();
    }
  });
});
