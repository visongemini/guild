import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { AdapterPinError } from "./adapter-pin.js";
import { CLAUDE_ENGINE_PROFILE, CODEX_ENGINE_PROFILE } from "./engine-profile.js";
import { GrokProcessHostError } from "./process-host.js";
import {
  DEFAULT_PRIVATE_INSTALL_IO,
  InstallNotPrivateError,
  assertPrivateInstall,
  findPrivateInstallProblem,
  privateInstallProblemOfStats,
  type PrivateInstallIo,
  type PrivateInstallStats,
} from "./private-install.js";

const USER = 501;
const OTHER = 502;

type FakeEntry =
  | Readonly<{ kind: "dir" | "file"; uid: number; mode: number }>
  | Readonly<{ kind: "link"; target: string }>;

/** An in-memory file system: real paths only, links named explicitly, enough to drive the rules. */
function fakeFs(entries: Readonly<Record<string, FakeEntry>>, counter?: { lstats: number }): PrivateInstallIo {
  const stat = (path: string): PrivateInstallStats => {
    const entry = entries[path];
    if (entry === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return entry.kind === "link"
      ? { uid: USER, mode: 0o120777, isDirectory: false, isSymbolicLink: true }
      : { uid: entry.uid, mode: entry.mode, isDirectory: entry.kind === "dir", isSymbolicLink: false };
  };
  return Object.freeze({
    uid: USER,
    lstat: async (path: string) => {
      if (counter !== undefined) counter.lstats += 1;
      return stat(path);
    },
    realpath: async (path: string) => {
      const entry = entries[path];
      if (entry === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (entry.kind !== "link") return path;
      if (entries[entry.target] === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entry.target;
    },
    readdir: async (path: string) => {
      const prefix = path === "/" ? "/" : `${path}/`;
      const names = new Set<string>();
      for (const key of Object.keys(entries)) {
        if (key !== path && key.startsWith(prefix)) names.add(key.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  });
}

const dir = (mode = 0o755, uid = USER): FakeEntry => ({ kind: "dir", uid, mode });
const file = (mode = 0o644, uid = USER): FakeEntry => ({ kind: "file", uid, mode });
const link = (target: string): FakeEntry => ({ kind: "link", target });

/** `/`, `/Users` and the home folder, as on a Mac: root, root, the user. */
const BASE: Readonly<Record<string, FakeEntry>> = Object.freeze({
  "/": dir(0o755, 0),
  "/Users": dir(0o755, 0),
  "/Users/me": dir(0o750),
  "/Users/me/.local": dir(),
  "/Users/me/.local/share": dir(),
  "/Users/me/.local/share/claude": dir(),
  "/Users/me/.local/share/claude/versions": dir(),
  "/Users/me/.local/share/claude/versions/2.1.291": file(0o755),
  "/Users/me/pkg": dir(),
  "/Users/me/pkg/package.json": file(),
  "/Users/me/pkg/dist": dir(),
  "/Users/me/pkg/dist/index.js": file(),
  "/Users/me/pkg/node_modules": dir(),
  "/Users/me/pkg/node_modules/dep": dir(),
  "/Users/me/pkg/node_modules/dep/index.js": file(),
});

const CLAUDE = "/Users/me/.local/share/claude/versions/2.1.291";

function with_(extra: Readonly<Record<string, FakeEntry>>): Readonly<Record<string, FakeEntry>> {
  return { ...BASE, ...extra };
}

describe("private install rules: one entry [PC-SEC-001, PC-ENG-002]", () => {
  it("accepts the user's and root's entries and refuses another owner and any group or other write bit", () => {
    const ok = (mode: number, uid: number) => privateInstallProblemOfStats({ uid, mode, isDirectory: false, isSymbolicLink: false }, USER);
    assert.equal(ok(0o755, USER), undefined);
    assert.equal(ok(0o700, USER), undefined);
    assert.equal(ok(0o755, 0), undefined);
    assert.equal(ok(0o644, 0), undefined);
    assert.equal(ok(0o755, OTHER), "not_owned");
    assert.equal(ok(0o775, USER), "group_writable");
    assert.equal(ok(0o664, USER), "group_writable");
    assert.equal(ok(0o757, USER), "world_writable");
    assert.equal(ok(0o777, USER), "world_writable");
    // Root's own group-writable file is still writable by the group.
    assert.equal(ok(0o775, 0), "group_writable");
    // Sticky does not make a world-writable folder private.
    assert.equal(ok(0o1777, 0), "world_writable");
  });
});

describe("private install rules: a file and the folders above it [PC-SEC-001, PC-ENG-002]", () => {
  it("passes a user-owned chain under root-owned / and /Users", async () => {
    assert.equal(await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(BASE)), undefined);
  });

  it("refuses the file itself when another user owns it or others can write it", async () => {
    const owned = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ [CLAUDE]: file(0o755, OTHER) })));
    assert.deepEqual(owned, { problem: "not_owned", path: CLAUDE });
    const group = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ [CLAUDE]: file(0o775) })));
    assert.deepEqual(group, { problem: "group_writable", path: CLAUDE });
    const world = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ [CLAUDE]: file(0o757) })));
    assert.deepEqual(world, { problem: "world_writable", path: CLAUDE });
  });

  it("names the folder above the file that others could use to swap it, whichever level it is", async () => {
    for (const folder of ["/Users/me/.local/share/claude/versions", "/Users/me/.local", "/Users/me", "/Users"]) {
      const group = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ [folder]: dir(0o775, folder === "/Users" ? 0 : USER) })));
      assert.deepEqual(group, { problem: "group_writable", path: folder }, `group-writable ${folder}`);
      const owned = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ [folder]: dir(0o755, OTHER) })));
      assert.deepEqual(owned, { problem: "not_owned", path: folder }, `owned by someone else ${folder}`);
    }
  });

  it("has no exemption: a Homebrew-style folder that the admin group can write, or a sticky world-writable one, is refused", async () => {
    const brew = "/opt/homebrew/lib/node_modules/pkg";
    const entries = {
      "/": dir(0o755, 0),
      "/opt": dir(0o755, 0),
      "/opt/homebrew": dir(0o775, USER),
      "/opt/homebrew/lib": dir(0o775, USER),
      "/opt/homebrew/lib/node_modules": dir(0o775, USER),
      [brew]: dir(0o755, USER),
    } as const;
    assert.deepEqual(
      await findPrivateInstallProblem({ trees: [brew] }, fakeFs(entries)),
      { problem: "group_writable", path: "/opt/homebrew/lib/node_modules" },
    );
    const sticky = await findPrivateInstallProblem({ files: [CLAUDE] }, fakeFs(with_({ "/Users/me/.local": dir(0o1777) })));
    assert.deepEqual(sticky, { problem: "world_writable", path: "/Users/me/.local" });
  });

  it("is unreadable for a path that is missing, and refuses a link on a path that was meant to be real", async () => {
    assert.deepEqual(await findPrivateInstallProblem({ files: ["/Users/me/missing"] }, fakeFs(BASE)), { problem: "unreadable", path: "/Users/me/missing" });
    const finding = await findPrivateInstallProblem(
      { files: [CLAUDE] },
      { ...fakeFs(BASE), realpath: async (path: string) => path, lstat: async (path: string) => path === "/Users/me/.local" ? { uid: USER, mode: 0o755, isDirectory: false, isSymbolicLink: true } : fakeFs(BASE).lstat(path) },
    );
    assert.deepEqual(finding, { problem: "linked", path: "/Users/me/.local" });
  });

  it("judges each folder of a chain once per call", async () => {
    const counter = { lstats: 0 };
    const io = fakeFs(BASE, counter);
    await findPrivateInstallProblem({ files: [CLAUDE, "/Users/me/pkg/package.json", "/Users/me/pkg/dist/index.js"] }, io);
    // Three files plus the distinct folders above them (/, /Users, /Users/me, .local chain, pkg, pkg/dist).
    assert.ok(counter.lstats <= 16, `lstat calls: ${counter.lstats}`);
  });
});

describe("private install rules: a package tree [PC-SEC-001, PC-ENG-002, PC-ENG-003]", () => {
  it("passes a user-owned package and refuses the first entry anywhere below it that others could write", async () => {
    assert.equal(await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(BASE)), undefined);
    for (const [path, entry] of [
      ["/Users/me/pkg/package.json", file(0o664)],
      ["/Users/me/pkg/dist/index.js", file(0o666)],
      ["/Users/me/pkg/node_modules/dep", dir(0o775)],
      ["/Users/me/pkg/node_modules/dep/index.js", file(0o644, OTHER)],
    ] as const) {
      const finding = await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(with_({ [path]: entry })));
      assert.equal(finding?.path, path, path);
    }
  });

  it("also judges the folders above the package root", async () => {
    const finding = await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(with_({ "/Users/me": dir(0o770) })));
    assert.deepEqual(finding, { problem: "group_writable", path: "/Users/me" });
  });

  it("walks a link that leaves the package, as part of it, and skips a link into the package", async () => {
    const outside = { "/Users/me/store": dir(), "/Users/me/store/dep": dir(), "/Users/me/store/dep/index.js": file() };
    const linked = with_({ ...outside, "/Users/me/pkg/node_modules/pnpm-dep": link("/Users/me/store/dep"), "/Users/me/pkg/node_modules/self": link("/Users/me/pkg/dist") });
    assert.equal(await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(linked)), undefined);
    const bad = with_({ ...outside, "/Users/me/store/dep/index.js": file(0o666), "/Users/me/pkg/node_modules/pnpm-dep": link("/Users/me/store/dep") });
    assert.deepEqual(
      await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(bad)),
      { problem: "world_writable", path: "/Users/me/store/dep/index.js" },
    );
    const badFolder = with_({ "/Users/me/shared": dir(0o777), "/Users/me/shared/dep": dir(), "/Users/me/pkg/node_modules/x": link("/Users/me/shared/dep") });
    assert.deepEqual(
      await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(badFolder)),
      { problem: "world_writable", path: "/Users/me/shared" },
      "a link to a folder whose parent others can write is refused",
    );
  });

  it("ignores a dangling link, and does not loop on a link to a folder above", async () => {
    const entries = with_({ "/Users/me/pkg/node_modules/gone": link("/Users/me/nowhere"), "/Users/me/pkg/node_modules/up": link("/Users/me/pkg") });
    assert.equal(await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(entries)), undefined);
  });

  it("refuses a tree with more entries than the limit, naming a folder", async () => {
    const finding = await findPrivateInstallProblem({ trees: ["/Users/me/pkg"] }, fakeFs(BASE), 3);
    assert.equal(finding?.problem, "too_many_entries");
    assert.ok(finding?.path.startsWith("/Users/me/pkg"));
  });
});

describe("private install rules: the real file system [PC-SEC-001]", () => {
  const roots: string[] = [];
  after(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** The real lstat, with every folder above the sandbox shown as root's 0755: the temp directory is not the subject here. */
  async function sandbox(): Promise<Readonly<{ root: string; io: PrivateInstallIo }>> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "guild-private-install-")));
    roots.push(root);
    await chmod(root, 0o755);
    const io: PrivateInstallIo = {
      ...DEFAULT_PRIVATE_INSTALL_IO,
      lstat: async (path) => path === root || path.startsWith(`${root}/`)
        ? DEFAULT_PRIVATE_INSTALL_IO.lstat(path)
        : { uid: 0, mode: 0o40755, isDirectory: true, isSymbolicLink: false },
    };
    return { root, io };
  }

  it("passes a package the user made and names the file whose mode a chmod then opens", async () => {
    const { root, io } = await sandbox();
    const pkg = join(root, "pkg");
    await mkdir(join(pkg, "dist"), { recursive: true });
    await writeFile(join(pkg, "package.json"), "{}");
    await writeFile(join(pkg, "dist", "index.js"), "x");
    for (const path of [pkg, join(pkg, "dist")]) await chmod(path, 0o755);
    assert.equal(await findPrivateInstallProblem({ trees: [pkg] }, io), undefined);
    await chmod(join(pkg, "dist", "index.js"), 0o664);
    assert.deepEqual(await findPrivateInstallProblem({ trees: [pkg] }, io), { problem: "group_writable", path: join(pkg, "dist", "index.js") });
    await chmod(join(pkg, "dist", "index.js"), 0o644);
    await chmod(join(pkg, "dist"), 0o757);
    assert.deepEqual(await findPrivateInstallProblem({ trees: [pkg] }, io), { problem: "world_writable", path: join(pkg, "dist") });
  });

  it("follows a link out of the package into a folder others can write", async () => {
    const { root, io } = await sandbox();
    const pkg = join(root, "pkg");
    const open = join(root, "open");
    await mkdir(join(pkg, "node_modules"), { recursive: true });
    await mkdir(open, { recursive: true });
    for (const path of [pkg, join(pkg, "node_modules"), open]) await chmod(path, 0o755);
    await writeFile(join(open, "x.js"), "x");
    await symlink(open, join(pkg, "node_modules", "dep"));
    assert.equal(await findPrivateInstallProblem({ trees: [pkg] }, io), undefined);
    await chmod(open, 0o777);
    assert.deepEqual(await findPrivateInstallProblem({ trees: [pkg] }, io), { problem: "world_writable", path: open });
  });

  it("assertPrivateInstall throws an install_not_private pin error that carries the path", async () => {
    const { root, io } = await sandbox();
    const target = join(root, "claude");
    await writeFile(target, "x");
    await chmod(target, 0o775);
    await assert.rejects(assertPrivateInstall({ files: [target] }, io), (cause: unknown) => {
      assert.ok(cause instanceof InstallNotPrivateError);
      assert.ok(cause instanceof AdapterPinError);
      assert.equal(cause.code, "install_not_private");
      assert.equal(cause.path, target);
      assert.equal(cause.problem, "group_writable");
      assert.equal(cause.message.includes(target), false, "the message stays free of local paths");
      return true;
    });
  });
});

describe("private install rule at launch: before every spawn, and before any pin is read [PC-SEC-001, PC-ENG-002, PC-ENG-003]", () => {
  const adapter = Object.freeze({ packageRoot: "/Users/me/pkg", entryPath: "/Users/me/pkg/dist/index.js", version: "0.89.0", fingerprintSha256: "0".repeat(64) });
  const core = Object.freeze({
    executablePath: "/Users/me/pkg/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    version: "0.160.1",
    sizeBytes: 12,
  });
  const claudeLaunch = (io: PrivateInstallIo | undefined) => ({
    engine: "claude" as const,
    adapter,
    claudeExecutablePath: CLAUDE,
    ...(io === undefined ? {} : { privateInstall: { required: true as const, io } }),
  });
  const codexLaunch = (io: PrivateInstallIo | undefined) => ({
    engine: "codex" as const,
    adapter,
    core,
    ...(io === undefined ? {} : { privateInstall: { required: true as const, io } }),
  });
  const codexTree = {
    "/Users/me/pkg/node_modules/@openai": dir(),
    "/Users/me/pkg/node_modules/@openai/codex-darwin-arm64": dir(),
    "/Users/me/pkg/node_modules/@openai/codex-darwin-arm64/vendor": dir(),
    "/Users/me/pkg/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin": dir(),
    "/Users/me/pkg/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin": dir(),
    [core.executablePath]: file(0o755),
  } as const;

  async function failure(run: () => Promise<void>): Promise<unknown> {
    try {
      await run();
    } catch (cause) {
      return cause;
    }
    return undefined;
  }

  it("Claude: refuses a binary, a folder above it or an adapter entry that others could rewrite, naming the path, without reading the pin", async () => {
    const plan = (io: PrivateInstallIo | undefined) => CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch(io));
    for (const [path, entry] of [
      [CLAUDE, file(0o775)],
      ["/Users/me/.local/share/claude/versions", dir(0o777)],
      ["/Users/me/pkg/dist/index.js", file(0o666)],
      ["/Users/me/pkg/node_modules/dep/index.js", file(0o666)],
    ] as const) {
      const cause = await failure(() => plan(fakeFs(with_({ [path]: entry }))).verifyBeforeSpawn!());
      assert.ok(cause instanceof InstallNotPrivateError, path);
      assert.equal(cause.path, path);
    }
    // The pin points at files that do not exist: had the pin been read first, this would be adapter_changed.
    const pass = await failure(() => plan(fakeFs(BASE)).verifyBeforeSpawn!());
    assert.ok(pass instanceof AdapterPinError && pass.code !== "install_not_private", "a private install goes on to the pin check");
  });

  it("Claude: does nothing about it unless the launch asks (a development run)", async () => {
    const cause = await failure(() => CLAUDE_ENGINE_PROFILE.planLaunch(claudeLaunch(undefined)).verifyBeforeSpawn!());
    assert.ok(cause instanceof AdapterPinError && cause.code === "adapter_changed", String(cause));
  });

  it("Codex: refuses the core, its folder, a folder above it or the adapter package, and passes a private one on to the pin check", async () => {
    const base = with_(codexTree);
    const plan = (io: PrivateInstallIo | undefined) => CODEX_ENGINE_PROFILE.planLaunch(codexLaunch(io));
    for (const [path, entry] of [
      [core.executablePath, file(0o775)],
      ["/Users/me/pkg/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin", dir(0o777)],
      ["/Users/me/pkg/dist/index.js", file(0o666)],
      ["/Users/me/pkg/node_modules/@openai", dir(0o775)],
    ] as const) {
      const cause = await failure(() => plan(fakeFs({ ...base, [path]: entry })).verifyBeforeSpawn!());
      assert.ok(cause instanceof InstallNotPrivateError, path);
      assert.equal(cause.path, path);
    }
    const pass = await failure(() => plan(fakeFs(base)).verifyBeforeSpawn!());
    assert.ok(pass instanceof AdapterPinError && pass.code !== "install_not_private");
  });

  it("Codex: judges a core that npm hoisted out of the adapter package, with the helpers beside it, on its own", async () => {
    const hoistedCore = "/Users/me/hoisted/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex";
    const vendor = "/Users/me/hoisted/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin";
    const hoisted = {
      "/Users/me/hoisted": dir(),
      "/Users/me/hoisted/node_modules": dir(),
      "/Users/me/hoisted/node_modules/@openai": dir(),
      "/Users/me/hoisted/node_modules/@openai/codex-darwin-arm64": dir(),
      "/Users/me/hoisted/node_modules/@openai/codex-darwin-arm64/vendor": dir(),
      [vendor]: dir(),
      [`${vendor}/bin`]: dir(),
      [hoistedCore]: file(0o755),
      [`${vendor}/codex-resources`]: dir(),
      [`${vendor}/codex-resources/rg`]: file(0o755),
    } as const;
    const launch = (io: PrivateInstallIo) => CODEX_ENGINE_PROFILE.planLaunch({
      engine: "codex",
      adapter,
      core: { ...core, executablePath: hoistedCore },
      privateInstall: { required: true, io },
    });
    const pass = await failure(() => launch(fakeFs(with_(hoisted))).verifyBeforeSpawn!());
    assert.ok(pass instanceof AdapterPinError && pass.code !== "install_not_private", "private: on to the pin check");
    for (const [path, entry] of [
      [`${vendor}/codex-resources/rg`, file(0o666)],
      [`${vendor}/codex-resources`, dir(0o777)],
      ["/Users/me/hoisted/node_modules/@openai", dir(0o775)],
      [hoistedCore, file(0o775)],
    ] as const) {
      const cause = await failure(() => launch(fakeFs(with_({ ...hoisted, [path]: entry }))).verifyBeforeSpawn!());
      assert.ok(cause instanceof InstallNotPrivateError, path);
      assert.equal(cause.path, path);
    }
  });

  it("the process host reports it as a preflight failure with the path, and spawns nothing", async () => {
    const { EngineProcessHost } = await import("./process-host.js");
    const stagingRoot = await mkdtemp(join(tmpdir(), "guild-private-install-host-"));
    try {
      await chmod(stagingRoot, 0o700);
      const nodeBytes = await readFile(process.execPath);
      const host = new EngineProcessHost({
        profile: CLAUDE_ENGINE_PROFILE,
        launch: claudeLaunch(fakeFs(with_({ [CLAUDE]: file(0o775) }))),
        executablePath: process.execPath,
        expectedSha256: createHash("sha256").update(nodeBytes).digest("hex"),
        workingDirectory: tmpdir(),
        stagingRoot: join(stagingRoot, "stage"),
        baseEnvironment: {},
      });
      const seen: string[] = [];
      host.onEvent((event) => { seen.push(event.type); });
      const cause = await failure(async () => { await host.start(); });
      assert.ok(cause instanceof GrokProcessHostError);
      assert.equal(cause.failure.type, "preflight_failure");
      if (cause.failure.type === "preflight_failure") {
        assert.equal(cause.failure.code, "install_not_private");
        assert.equal(cause.failure.path, CLAUDE);
      }
      assert.ok(seen.includes("preflight_failure"));
      assert.ok(!seen.includes("process_close"), "nothing was started");
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  });
});
