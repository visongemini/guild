import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  AdapterPinError,
  GEMINI_ADAPTER_PACKAGE_NAME,
  GEMINI_ADAPTER_SPEC,
  GEMINI_ADAPTER_SUPPORTED_RANGE,
  fingerprintAdapterPackage,
  isSupportedGeminiCliVersion,
  pinClaudeAdapter,
  pinCodexAdapter,
  pinGeminiCli,
  probeAdapterPackage,
  verifyGeminiAdapterPin,
  type AdapterPinFailureCode,
} from "./adapter-pin.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function writeGemini(version = "0.63.0", name: string = GEMINI_ADAPTER_PACKAGE_NAME): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "guild-gemini-pin-")));
  roots.push(parent);
  const root = join(parent, "gemini-cli");
  await mkdir(join(root, "bundle", "docs"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
  await writeFile(join(root, "bundle", "gemini.js"), "console.log('gemini');\n");
  await writeFile(join(root, "bundle", "chunk-AAAA.js"), "export const a = 1;\n");
  await writeFile(join(root, "bundle", "docs", "readme.md"), "# docs\n");
  return root;
}

function hasPinCode(code: AdapterPinFailureCode): (cause: unknown) => boolean {
  return (cause) => cause instanceof AdapterPinError && cause.code === code;
}

describe("Gemini CLI version range (PC-ENG-004)", () => {
  it("accepts exactly 0.63 up to 0.69 and nothing with a suffix", () => {
    assert.equal(GEMINI_ADAPTER_SUPPORTED_RANGE, ">=0.63.0 <0.70.0");
    for (const version of ["0.63.0", "0.63.7", "0.64.2", "0.69.99"]) assert.equal(isSupportedGeminiCliVersion(version), true, version);
    for (const version of ["0.62.9", "0.70.0", "1.63.0", "0.63", "0.63.0-preview.1", "0.63.0+build", "", "v0.63.0", "2.2.2", "0.89.1"]) {
      assert.equal(isSupportedGeminiCliVersion(version), false, version);
    }
  });
});

describe("Gemini CLI pin (PC-ENG-004)", () => {
  it("pins the package by version and a fingerprint over package.json and the bundle tree, entry bundle/gemini.js", async () => {
    const root = await writeGemini();
    const pin = await pinGeminiCli(root);
    assert.equal(pin.version, "0.63.0");
    assert.equal(pin.packageRoot, root);
    assert.equal(pin.entryPath, join(root, "bundle", "gemini.js"));
    assert.match(pin.fingerprintSha256, /^[0-9a-f]{64}$/u);
    assert.equal(pin.fingerprintSha256, await fingerprintAdapterPackage(root, "bundle"));
    assert.notEqual(pin.fingerprintSha256, await fingerprintAdapterPackage(root, "bundle/docs"), "the content directory is part of what is hashed");
    assert.equal(Object.isFrozen(pin), true);
    await verifyGeminiAdapterPin(pin);
    // The other adapters' pins refuse a Gemini package, and this one refuses theirs.
    await assert.rejects(pinCodexAdapter(root), hasPinCode("adapter_missing"));
    await assert.rejects(pinClaudeAdapter(root), hasPinCode("adapter_missing"));
    await assert.rejects(pinGeminiCli(await writeGemini("0.63.0", "@agentclientprotocol/codex-acp")), hasPinCode("adapter_missing"));
  });

  it("refuses a changed, added or removed bundle file, a changed manifest and a repointed directory", async () => {
    const root = await writeGemini();
    const pin = await pinGeminiCli(root);
    await writeFile(join(root, "bundle", "chunk-AAAA.js"), "export const a = 2;\n");
    await assert.rejects(verifyGeminiAdapterPin(pin), hasPinCode("adapter_changed"));
    await writeFile(join(root, "bundle", "chunk-AAAA.js"), "export const a = 1;\n");
    await verifyGeminiAdapterPin(pin);
    await writeFile(join(root, "bundle", "docs", "extra.md"), "added\n");
    await assert.rejects(verifyGeminiAdapterPin(pin), hasPinCode("adapter_changed"));
    await rm(join(root, "bundle", "docs", "extra.md"));
    await rm(join(root, "bundle", "docs", "readme.md"));
    await assert.rejects(verifyGeminiAdapterPin(pin), hasPinCode("adapter_changed"));
    await writeFile(join(root, "bundle", "docs", "readme.md"), "# docs\n");
    await verifyGeminiAdapterPin(pin);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: GEMINI_ADAPTER_PACKAGE_NAME, version: "0.63.1" }));
    await assert.rejects(verifyGeminiAdapterPin(pin), hasPinCode("adapter_changed"));
  });

  it("fails closed on a link or any non-regular entry in the bundle", async () => {
    const root = await writeGemini();
    await symlink("/etc/hosts", join(root, "bundle", "link.js"));
    await assert.rejects(pinGeminiCli(root), hasPinCode("adapter_changed"));
  });

  it("refuses an unsupported version, a foreign package, a missing entry and a relative path", async () => {
    await assert.rejects(pinGeminiCli(await writeGemini("0.62.0")), (cause: unknown) => {
      assert.ok(cause instanceof AdapterPinError);
      assert.equal(cause.code, "adapter_version_unsupported");
      assert.equal(cause.version, "0.62.0");
      return true;
    });
    await assert.rejects(pinGeminiCli(await writeGemini("0.70.0")), hasPinCode("adapter_version_unsupported"));
    const noEntry = await writeGemini();
    await rm(join(noEntry, "bundle", "gemini.js"));
    await assert.rejects(pinGeminiCli(noEntry), hasPinCode("adapter_missing"));
    await assert.rejects(pinGeminiCli("relative/gemini-cli"), hasPinCode("adapter_missing"));
    await assert.rejects(pinGeminiCli("/nonexistent/gemini-cli"), hasPinCode("adapter_missing"));
  });

  it("probes an install without hashing it: version and entry only, same refusals", async () => {
    const root = await writeGemini("0.64.1");
    const probe = await probeAdapterPackage(GEMINI_ADAPTER_SPEC, root);
    assert.deepEqual({ ...probe }, { packageRoot: root, entryPath: join(root, "bundle", "gemini.js"), version: "0.64.1" });
    assert.equal("fingerprintSha256" in probe, false);
    await assert.rejects(probeAdapterPackage(GEMINI_ADAPTER_SPEC, await writeGemini("0.2.0")), hasPinCode("adapter_version_unsupported"));
    await assert.rejects(probeAdapterPackage(GEMINI_ADAPTER_SPEC, "relative"), hasPinCode("adapter_missing"));
    const noEntry = await writeGemini();
    await rm(join(noEntry, "bundle", "gemini.js"));
    await assert.rejects(probeAdapterPackage(GEMINI_ADAPTER_SPEC, noEntry), hasPinCode("adapter_missing"));
  });
});
