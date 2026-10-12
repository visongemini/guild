import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AdapterPinError,
  CLAUDE_ADAPTER_PACKAGE_NAME,
  fingerprintAdapterPackage,
  isSupportedAdapterVersion,
  pinClaudeAdapter,
  verifyClaudeAdapterPin,
  type AdapterPinFailureCode,
} from "./adapter-pin.js";

const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function writeAdapter(
  version = "0.89.1",
  name: string = CLAUDE_ADAPTER_PACKAGE_NAME,
): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "guild-adapter-pin-")));
  roots.push(root);
  await mkdir(join(root, "dist", "nested"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(root, "dist", "index.js"), "console.log('entry');\n");
  await writeFile(join(root, "dist", "nested", "util.js"), "export const x = 1;\n");
  return root;
}

function hasPinCode(code: AdapterPinFailureCode): (cause: unknown) => boolean {
  return (cause) => cause instanceof AdapterPinError && cause.code === code;
}

describe("Claude adapter version range (PC-ENG-002)", () => {
  it("accepts exactly >=0.89.0 <0.90.0 release versions", () => {
    for (const version of ["0.89.0", "0.89.1", "0.89.27"]) {
      assert.equal(isSupportedAdapterVersion(version), true, version);
    }
    for (const version of ["0.88.9", "0.90.0", "1.89.0", "0.89", "0.89.1-beta.1", "0.89.1+build", "", "v0.89.1"]) {
      assert.equal(isSupportedAdapterVersion(version), false, version);
    }
  });
});

describe("Claude adapter pin", () => {
  it("pins version, entry script and a stable fingerprint over package.json and dist", async () => {
    const root = await writeAdapter();
    const pin = await pinClaudeAdapter(root);
    assert.equal(pin.packageRoot, root);
    assert.equal(pin.entryPath, join(root, "dist", "index.js"));
    assert.equal(pin.version, "0.89.1");
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
    assert.equal(await fingerprintAdapterPackage(root), pin.fingerprintSha256);
    assert.equal(Object.isFrozen(pin), true);
    await verifyClaudeAdapterPin(pin);
  });

  it("changes the fingerprint when any dist file, a new file or package.json changes", async () => {
    const root = await writeAdapter();
    const original = await fingerprintAdapterPackage(root);
    await writeFile(join(root, "dist", "nested", "util.js"), "export const x = 2;\n");
    const edited = await fingerprintAdapterPackage(root);
    assert.notEqual(edited, original);
    await writeFile(join(root, "dist", "added.js"), "\n");
    const added = await fingerprintAdapterPackage(root);
    assert.notEqual(added, edited);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: CLAUDE_ADAPTER_PACKAGE_NAME, version: "0.89.1", extra: true }));
    assert.notEqual(await fingerprintAdapterPackage(root), added);
  });

  it("binds a hash to its path so swapping two files' contents is detected", async () => {
    const root = await writeAdapter();
    await writeFile(join(root, "dist", "a.js"), "A");
    await writeFile(join(root, "dist", "b.js"), "B");
    const before = await fingerprintAdapterPackage(root);
    await writeFile(join(root, "dist", "a.js"), "B");
    await writeFile(join(root, "dist", "b.js"), "A");
    assert.notEqual(await fingerprintAdapterPackage(root), before);
  });

  it("refuses to start with adapter_changed when the files change after pinning", async () => {
    const root = await writeAdapter();
    const pin = await pinClaudeAdapter(root);
    await writeFile(join(root, "dist", "index.js"), "console.log('tampered');\n");
    await assert.rejects(verifyClaudeAdapterPin(pin), hasPinCode("adapter_changed"));
  });

  it("reports adapter_changed when the version, the directory or a file disappears", async () => {
    const versionRoot = await writeAdapter();
    const versionPin = await pinClaudeAdapter(versionRoot);
    await writeFile(join(versionRoot, "package.json"), JSON.stringify({ name: CLAUDE_ADAPTER_PACKAGE_NAME, version: "0.89.2" }));
    await assert.rejects(verifyClaudeAdapterPin(versionPin), hasPinCode("adapter_changed"));

    const goneRoot = await writeAdapter();
    const gonePin = await pinClaudeAdapter(goneRoot);
    await rm(goneRoot, { recursive: true, force: true });
    await assert.rejects(verifyClaudeAdapterPin(gonePin), hasPinCode("adapter_changed"));

    const fileRoot = await writeAdapter();
    const filePin = await pinClaudeAdapter(fileRoot);
    await rm(join(fileRoot, "dist", "nested", "util.js"));
    await assert.rejects(verifyClaudeAdapterPin(filePin), hasPinCode("adapter_changed"));
  });

  it("fails closed on a symlink inside dist", async () => {
    const root = await writeAdapter();
    const pin = await pinClaudeAdapter(root);
    await symlink("/etc/hosts", join(root, "dist", "link.js"));
    await assert.rejects(verifyClaudeAdapterPin(pin), hasPinCode("adapter_changed"));
    await assert.rejects(pinClaudeAdapter(root), hasPinCode("adapter_changed"));
  });

  it("names the failure for an unsupported version, a foreign package and a missing entry", async () => {
    await assert.rejects(pinClaudeAdapter(await writeAdapter("0.90.0")), (cause: unknown) => {
      assert.ok(cause instanceof AdapterPinError);
      assert.equal(cause.code, "adapter_version_unsupported");
      assert.equal(cause.version, "0.90.0");
      return true;
    });
    await assert.rejects(pinClaudeAdapter(await writeAdapter("0.88.0")), hasPinCode("adapter_version_unsupported"));
    await assert.rejects(pinClaudeAdapter(await writeAdapter("0.89.1", "some-other-package")), hasPinCode("adapter_missing"));
    const noEntry = await writeAdapter();
    await rm(join(noEntry, "dist", "index.js"));
    await assert.rejects(pinClaudeAdapter(noEntry), hasPinCode("adapter_missing"));
    await assert.rejects(pinClaudeAdapter("relative/path"), hasPinCode("adapter_missing"));
    await assert.rejects(pinClaudeAdapter(join(tmpdir(), "guild-adapter-pin-does-not-exist")), hasPinCode("adapter_missing"));
  });
});
