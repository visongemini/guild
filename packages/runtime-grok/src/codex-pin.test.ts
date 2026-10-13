import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AdapterPinError,
  CODEX_ADAPTER_PACKAGE_NAME,
  CODEX_ADAPTER_SUPPORTED_RANGE,
  isSupportedCodexAdapterVersion,
  pinClaudeAdapter,
  pinCodexAdapter,
  verifyCodexAdapterPin,
  type AdapterPinFailureCode,
} from "./adapter-pin.js";
import { codexPlatformTarget, pinCodexCore, verifyCodexCorePin } from "./codex-core-pin.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const TARGET = Object.freeze({ packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" });
const MACH_O_64 = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0, 1, 2, 3, 4]);

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-codex-pin-")));
  roots.push(root);
  return root;
}

async function writeAdapter(version = "2.2.2", name: string = CODEX_ADAPTER_PACKAGE_NAME, parent?: string): Promise<string> {
  const root = join(parent ?? (await temporaryRoot()), "adapter");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(root, "dist", "index.js"), "console.log('codex-acp');\n");
  return root;
}

/** The platform package the way npm installs it, with an executable `codex` and its manifest. */
async function writeCore(
  packageDirectory: string,
  options: { version?: string; bytes?: Buffer; mode?: number; entrypoint?: string; manifest?: boolean } = {},
): Promise<string> {
  const vendor = join(packageDirectory, "vendor", TARGET.triple);
  await mkdir(join(vendor, "bin"), { recursive: true });
  if (options.manifest !== false) {
    await writeFile(
      join(vendor, "codex-package.json"),
      JSON.stringify({ layoutVersion: 1, version: options.version ?? "0.160.1", target: TARGET.triple, entrypoint: options.entrypoint ?? "bin/codex" }),
    );
  }
  const executable = join(vendor, "bin", "codex");
  await writeFile(executable, options.bytes ?? MACH_O_64);
  await chmod(executable, options.mode ?? 0o755);
  return executable;
}

function hasPinCode(code: AdapterPinFailureCode): (cause: unknown) => boolean {
  return (cause) => cause instanceof AdapterPinError && cause.code === code;
}

describe("Codex adapter version range (PC-ENG-003)", () => {
  it("accepts exactly the 2.x releases", () => {
    assert.equal(CODEX_ADAPTER_SUPPORTED_RANGE, ">=2.0.0 <3.0.0");
    for (const version of ["2.0.0", "2.2.2", "2.99.7"]) assert.equal(isSupportedCodexAdapterVersion(version), true, version);
    for (const version of ["1.9.9", "3.0.0", "2", "2.2", "2.2.2-beta.1", "2.2.2+build", "", "v2.2.2", "0.89.1"]) {
      assert.equal(isSupportedCodexAdapterVersion(version), false, version);
    }
  });
});

describe("Codex adapter pin", () => {
  it("pins the 2.x package by version and fingerprint, and the Claude pin refuses it", async () => {
    const root = await writeAdapter();
    const pin = await pinCodexAdapter(root);
    assert.equal(pin.version, "2.2.2");
    assert.equal(pin.entryPath, join(root, "dist", "index.js"));
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
    await verifyCodexAdapterPin(pin);
    await assert.rejects(pinClaudeAdapter(root), hasPinCode("adapter_missing"), "a Codex package is not the Claude adapter");
  });

  it("refuses a changed file, an unsupported major and a foreign package", async () => {
    const root = await writeAdapter();
    const pin = await pinCodexAdapter(root);
    await writeFile(join(root, "dist", "index.js"), "console.log('tampered');\n");
    await assert.rejects(verifyCodexAdapterPin(pin), hasPinCode("adapter_changed"));

    await assert.rejects(pinCodexAdapter(await writeAdapter("3.0.0")), (cause: unknown) => {
      assert.ok(cause instanceof AdapterPinError);
      assert.equal(cause.code, "adapter_version_unsupported");
      assert.equal(cause.version, "3.0.0");
      return true;
    });
    await assert.rejects(pinCodexAdapter(await writeAdapter("1.4.0")), hasPinCode("adapter_version_unsupported"));
    await assert.rejects(pinCodexAdapter(await writeAdapter("2.2.2", "@agentclientprotocol/claude-agent-acp")), hasPinCode("adapter_missing"));
  });
});

describe("Codex core pin (PC-ENG-003)", () => {
  it("knows the macOS platform packages and nothing else", () => {
    assert.deepEqual(codexPlatformTarget("darwin", "arm64"), TARGET);
    assert.deepEqual(codexPlatformTarget("darwin", "x64"), { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" });
    assert.equal(codexPlatformTarget("linux", "x64"), undefined);
    assert.equal(codexPlatformTarget("win32", "arm64"), undefined);
    assert.equal(codexPlatformTarget("darwin", "ia32"), undefined);
  });

  it("finds the core in the adapter's own node_modules and pins path, version and size", async () => {
    const adapter = await writeAdapter();
    const executable = await writeCore(join(adapter, "node_modules", "@openai", "codex-darwin-arm64"));
    const pin = await pinCodexCore(adapter, TARGET);
    assert.deepEqual(pin, { executablePath: executable, version: "0.160.1", sizeBytes: MACH_O_64.length });
    assert.equal(Object.isFrozen(pin), true);
    await verifyCodexCorePin(pin);
  });

  it("walks the ancestors' node_modules the way Node does, nearest first", async () => {
    const top = await temporaryRoot();
    const hoisted = await writeCore(join(top, "node_modules", "@openai", "codex-darwin-arm64"), { version: "0.150.0" });
    const adapter = await writeAdapter("2.2.2", CODEX_ADAPTER_PACKAGE_NAME, join(top, "node_modules", "@agentclientprotocol", "codex-acp"));
    assert.equal((await pinCodexCore(adapter, TARGET)).executablePath, hoisted);
    const nested = await writeCore(join(adapter, "node_modules", "@openai", "codex-darwin-arm64"), { version: "0.160.1" });
    const pin = await pinCodexCore(adapter, TARGET);
    assert.equal(pin.executablePath, nested, "the adapter's own copy wins");
    assert.equal(pin.version, "0.160.1");
  });

  it("skips an incomplete candidate and keeps looking", async () => {
    const top = await temporaryRoot();
    const outer = await writeCore(join(top, "node_modules", "@openai", "codex-darwin-arm64"));
    const adapter = await writeAdapter("2.2.2", CODEX_ADAPTER_PACKAGE_NAME, join(top, "pkg"));
    await mkdir(join(adapter, "node_modules", "@openai", "codex-darwin-arm64", "vendor"), { recursive: true });
    assert.equal((await pinCodexCore(adapter, TARGET)).executablePath, outer);
  });

  it("refuses a missing core, an unsupported platform, a relative path and a manifest it does not know", async () => {
    const adapter = await writeAdapter();
    await assert.rejects(pinCodexCore(adapter, TARGET), hasPinCode("engine_core_invalid"));
    await assert.rejects(pinCodexCore(adapter, undefined), hasPinCode("engine_core_invalid"));
    await assert.rejects(pinCodexCore("relative/adapter", TARGET), hasPinCode("engine_core_invalid"));
    const pkg = join(adapter, "node_modules", "@openai", "codex-darwin-arm64");
    for (const [label, options] of [
      ["no manifest", { manifest: false }],
      ["a version that is not x.y.z", { version: "0.160.1-darwin-arm64" }],
      ["another entrypoint", { entrypoint: "bin/other" }],
    ] as const) {
      await rm(pkg, { recursive: true, force: true });
      await writeCore(pkg, options);
      await assert.rejects(pinCodexCore(adapter, TARGET), hasPinCode("engine_core_invalid"), label);
    }
  });

  it("refuses a core that is a script, not executable, or linked out of its package", async () => {
    const adapter = await writeAdapter();
    const pkg = join(adapter, "node_modules", "@openai", "codex-darwin-arm64");
    await writeCore(pkg, { bytes: Buffer.from("#!/bin/sh\necho hi\n") });
    await assert.rejects(pinCodexCore(adapter, TARGET), hasPinCode("engine_core_invalid"), "a script");
    await rm(pkg, { recursive: true, force: true });
    await writeCore(pkg, { mode: 0o644 });
    await assert.rejects(pinCodexCore(adapter, TARGET), hasPinCode("engine_core_invalid"), "no execute bit");

    await rm(pkg, { recursive: true, force: true });
    const elsewhere = join(await temporaryRoot(), "codex");
    await writeFile(elsewhere, MACH_O_64);
    await chmod(elsewhere, 0o755);
    await writeCore(pkg);
    await rm(join(pkg, "vendor", TARGET.triple, "bin", "codex"));
    await symlink(elsewhere, join(pkg, "vendor", TARGET.triple, "bin", "codex"));
    await assert.rejects(pinCodexCore(adapter, TARGET), hasPinCode("engine_core_invalid"), "a link out of the package");
  });

  it("re-proves the pin before a spawn: same file, same size, same version label", async () => {
    const adapter = await writeAdapter();
    const pkg = join(adapter, "node_modules", "@openai", "codex-darwin-arm64");
    const executable = await writeCore(pkg);
    const pin = await pinCodexCore(adapter, TARGET);
    await verifyCodexCorePin(pin);

    await writeFile(join(pkg, "vendor", TARGET.triple, "codex-package.json"), JSON.stringify({ version: "0.161.0", entrypoint: "bin/codex" }));
    await assert.rejects(verifyCodexCorePin(pin), hasPinCode("engine_core_invalid"), "version label changed");
    await writeFile(join(pkg, "vendor", TARGET.triple, "codex-package.json"), JSON.stringify({ version: "0.160.1", entrypoint: "bin/codex" }));
    await verifyCodexCorePin(pin);

    await truncate(executable, MACH_O_64.length + 8);
    await assert.rejects(verifyCodexCorePin(pin), hasPinCode("engine_core_invalid"), "size changed");
    await truncate(executable, MACH_O_64.length);
    await verifyCodexCorePin(pin);

    await rm(executable);
    await assert.rejects(verifyCodexCorePin(pin), hasPinCode("engine_core_invalid"), "gone");
    // A replacement behind a link is not the pinned file either.
    const other = join(await temporaryRoot(), "codex");
    await writeFile(other, MACH_O_64);
    await chmod(other, 0o755);
    await symlink(other, executable);
    await assert.rejects(verifyCodexCorePin(pin), hasPinCode("engine_core_invalid"), "linked");
  });
});
