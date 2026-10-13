import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  MACOS_ADMIN_GID,
  defaultPathTrustPolicy,
  findPathTrustProblem,
  isInsideRoot,
  trustProblemOfStats,
  versionManagerBinDirectories,
  type PathTrustPolicy,
} from "./trusted-location.js";

/*
 * PC-ENG-002, PC-ENG-003, PC-ENG-004: what makes a file acceptable to a packaged app as `node`, an adapter or `claude`.
 */

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const uid = process.getuid?.() ?? 0;
const policy: PathTrustPolicy = Object.freeze({ currentUid: 501, adminGid: MACOS_ADMIN_GID, rejectedRoots: Object.freeze(["/private/tmp", "/private/var/folders"]) });

async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-trusted-location-")));
  roots.push(root);
  return root;
}

describe("Trusted location rules [PC-ENG-002]", () => {
  it("accepts the current user and root as owners, and nobody else", () => {
    assert.equal(trustProblemOfStats({ uid: 501, gid: 20, mode: 0o100755 }, false, policy), undefined);
    assert.equal(trustProblemOfStats({ uid: 0, gid: 0, mode: 0o100755 }, false, policy), undefined);
    assert.equal(trustProblemOfStats({ uid: 502, gid: 20, mode: 0o100755 }, false, policy), "not_owned");
    assert.equal(trustProblemOfStats({ uid: 502, gid: 20, mode: 0o040755 }, true, policy), "not_owned");
  });

  it("refuses anything others can write, and a group-writable entry unless it is a directory of the admin group", () => {
    assert.equal(trustProblemOfStats({ uid: 501, gid: 20, mode: 0o100757 }, false, policy), "world_writable");
    assert.equal(trustProblemOfStats({ uid: 501, gid: 20, mode: 0o041777 }, true, policy), "world_writable", "a sticky temp-like directory too");
    assert.equal(trustProblemOfStats({ uid: 501, gid: 20, mode: 0o100775 }, false, policy), "group_writable");
    assert.equal(trustProblemOfStats({ uid: 501, gid: 20, mode: 0o040775 }, true, policy), "group_writable", "staff is not the admin group");
    assert.equal(trustProblemOfStats({ uid: 501, gid: MACOS_ADMIN_GID, mode: 0o040775 }, true, policy), undefined, "a Homebrew directory");
    assert.equal(trustProblemOfStats({ uid: 501, gid: MACOS_ADMIN_GID, mode: 0o100775 }, false, policy), "group_writable", "never the file itself");
    assert.equal(trustProblemOfStats({ uid: 501, gid: MACOS_ADMIN_GID, mode: 0o040775 }, true, { ...policy, adminGid: undefined }), "group_writable");
  });

  it("knows which paths lie inside a root", () => {
    assert.equal(isInsideRoot("/private/tmp", ["/private/tmp"]), true);
    assert.equal(isInsideRoot("/private/tmp/x/node", ["/private/tmp"]), true);
    assert.equal(isInsideRoot("/private/tmpfoo/node", ["/private/tmp"]), false);
    assert.equal(isInsideRoot("/opt/homebrew/bin/node", ["/private/tmp", "/private/var/folders"]), false);
  });

  it("builds the default policy from the real temporary directories and the macOS admin group", async () => {
    const built = defaultPathTrustPolicy();
    assert.equal(built.currentUid, process.getuid?.() ?? -1);
    assert.equal(built.adminGid, process.platform === "darwin" ? MACOS_ADMIN_GID : undefined);
    for (const expected of ["/tmp", "/private/tmp", await realpath(tmpdir()), tmpdir().replace(/\/$/u, "")]) {
      assert.equal(built.rejectedRoots.includes(expected), true, expected);
    }
    assert.equal(Object.isFrozen(built), true);
    assert.equal(defaultPathTrustPolicy(), built, "built once");
  });

  it("judges a real file and every directory above it, and says which one failed", async () => {
    const root = await scratch();
    const open: PathTrustPolicy = { currentUid: uid, adminGid: undefined, rejectedRoots: [] };
    const directory = join(root, "a", "b");
    await mkdir(directory, { recursive: true });
    const file = join(directory, "node");
    await writeFile(file, "x");
    await chmod(file, 0o755);
    assert.equal(await findPathTrustProblem(file, open), undefined);
    await chmod(file, 0o775);
    assert.deepEqual({ ...(await findPathTrustProblem(file, open)) }, { problem: "group_writable", path: file });
    await chmod(file, 0o755);
    await chmod(join(root, "a"), 0o777);
    assert.deepEqual({ ...(await findPathTrustProblem(file, open)) }, { problem: "world_writable", path: join(root, "a") });
    await chmod(join(root, "a"), 0o755);
    const gid = (await stat(directory)).gid;
    await chmod(directory, 0o775);
    assert.deepEqual({ ...(await findPathTrustProblem(file, open)) }, { problem: "group_writable", path: directory });
    assert.equal(await findPathTrustProblem(file, { ...open, adminGid: gid }), undefined, "the admin-group exception covers directories");
    if (uid !== 0) {
      assert.equal((await findPathTrustProblem(file, { ...open, adminGid: gid, currentUid: uid + 1 }))?.problem, "not_owned");
    }
  });

  it("refuses temporary locations, links, relative paths and files that are not there", async () => {
    const root = await scratch();
    const file = join(root, "node");
    await writeFile(file, "x");
    await chmod(file, 0o755);
    assert.equal((await findPathTrustProblem(file, defaultPathTrustPolicy()))?.problem, "temporary_location");
    const open: PathTrustPolicy = { currentUid: uid, adminGid: undefined, rejectedRoots: [] };
    await symlink(file, join(root, "link"));
    assert.equal((await findPathTrustProblem(join(root, "link"), open))?.problem, "linked", "the caller resolves links first");
    assert.equal((await findPathTrustProblem("node", open))?.problem, "unreadable");
    assert.equal((await findPathTrustProblem(join(root, "missing"), open))?.problem, "unreadable");
    assert.equal((await findPathTrustProblem(`${file}\0`, open))?.problem, "unreadable");
  });

  it("accepts the system's own node location on a machine that has one", async (context) => {
    // Not a fixture: /usr/local/bin/node (nodejs.org installer) is root-owned in root-owned directories.
    const real = await realpath("/usr/local/bin/node").catch(() => undefined);
    if (real === undefined) return context.skip("no /usr/local/bin/node here");
    const result = await findPathTrustProblem(real, { ...defaultPathTrustPolicy(), rejectedRoots: defaultPathTrustPolicy().rejectedRoots });
    assert.equal(result, undefined, JSON.stringify(result));
  });

  it("lists the newest releases of the supported version managers, real directories only", async () => {
    const home = await scratch();
    for (const path of [
      [".nvm", "versions", "node", "v22.9.0", "bin"],
      [".nvm", "versions", "node", "v24.1.0", "bin"],
      [".nvm", "versions", "node", "v24.10.0", "bin"],
      [".nvm", "versions", "node", "v20.1.0", "bin"],
      [".nvm", "versions", "node", "v26.0.0", "bin"],
      [".nvm", "versions", "node", "v27.0.0", "bin"],
      [".nvm", "versions", "node", "not-a-version", "bin"],
      [".volta", "tools", "image", "node", "26.8.1", "bin"],
      [".volta", "bin"],
      [".asdf", "installs", "nodejs", "24.0.0", "bin"],
      [".asdf", "shims"],
      ["Library", "Application Support", "fnm", "node-versions", "v22.2.0", "installation", "bin"],
      [".local", "share", "mise", "installs", "node", "22.0.0", "bin"],
    ]) await mkdir(join(home, ...path), { recursive: true });
    const found = await versionManagerBinDirectories(home, 22);
    assert.deepEqual(found.map((directory) => directory.slice(home.length + 1)), [
      join(".nvm", "versions", "node", "v27.0.0", "bin"),
      join(".nvm", "versions", "node", "v26.0.0", "bin"),
      join(".nvm", "versions", "node", "v24.10.0", "bin"),
      join(".volta", "tools", "image", "node", "26.8.1", "bin"),
      join(".asdf", "installs", "nodejs", "24.0.0", "bin"),
      join("Library", "Application Support", "fnm", "node-versions", "v22.2.0", "installation", "bin"),
      join(".local", "share", "mise", "installs", "node", "22.0.0", "bin"),
    ], "at most three per manager, newest first, never a shim directory or an old release");
    assert.deepEqual(await versionManagerBinDirectories(join(home, "nothing-here"), 22), []);
  });
});
