import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const appPath = join(projectRoot, "dist", "mac-arm64", "Guild.app");
const appAsar = join(appPath, "Contents", "Resources", "app.asar");
const legacyBrowserServer = join(
  appPath,
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "mcp-browser-server.cjs",
);
const sourceIcon = join(projectRoot, "build", "icon.icns");
const packagedIcon = join(appPath, "Contents", "Resources", "icon.icns");
const infoPlist = join(appPath, "Contents", "Info.plist");
const legalRoot = join(appPath, "Contents", "Resources", "legal");
const dmgPath = join(projectRoot, "dist", `Guild-${packageJson.version}-arm64.dmg`);
const workspaceRoot = join(projectRoot, "..", "..");
const asarCli = join(workspaceRoot, "node_modules", ".bin", "asar");
const fuseCli = join(workspaceRoot, "node_modules", ".bin", "electron-fuses");

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${basename(command)} failed`).trim().slice(0, 1_000));
  }
  return result.stdout;
}

function plistValue(key, format = "raw") {
  return run("/usr/bin/plutil", ["-extract", key, format, "-o", "-", infoPlist]).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(existsSync(appPath), "packaged app missing");
assert(existsSync(dmgPath), "DMG missing");
assert(packageJson.build?.mac?.timestamp === "none", "local signing must not require an online timestamp authority");
assert(!existsSync(legacyBrowserServer), "legacy browser server would relaunch Guild as a foreground app");
assert(plistValue("CFBundleIdentifier") === "app.guild.desktop.v2", "unexpected bundle identifier");
assert(plistValue("CFBundleShortVersionString") === packageJson.version, "version mismatch");
assert(plistValue("CFBundleName") === "Guild", "unexpected bundle name");
assert(plistValue("CFBundleExecutable") === "Guild", "unexpected executable name");
assert(plistValue("CFBundleIconFile") === "icon.icns", "unexpected application icon");
assert(plistValue("NSHumanReadableCopyright") === "Copyright © 2026 BDV", "copyright mismatch");
assert(existsSync(sourceIcon), "source application icon missing");
assert(existsSync(packagedIcon), "packaged application icon missing");
assert(readFileSync(sourceIcon).equals(readFileSync(packagedIcon)), "packaged icon differs from explicit source ICNS");

for (const [name, minimumBytes] of [
  ["NOTICE", 100],
  ["THIRD-PARTY-NOTICES", 500],
  ["THIRD-PARTY-LICENSES.txt", 10_000],
  ["LICENSE.electron.txt", 500],
  ["LICENSES.chromium.html", 1_000_000],
]) {
  const path = join(legalRoot, name);
  assert(existsSync(path), `packaged legal file missing: ${name}`);
  assert(statSync(path).size >= minimumBytes, `packaged legal file unexpectedly small: ${name}`);
}

const ats = JSON.parse(plistValue("NSAppTransportSecurity", "json"));
assert(ats.NSAllowsArbitraryLoads === false, "arbitrary network loads enabled");
assert(ats.NSAllowsLocalNetworking === false, "unused local networking enabled");
assert(ats.NSExceptionDomains === undefined, "unexpected ATS exception domains");

for (const key of [
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]) {
  const probe = spawnSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
  assert(probe.status !== 0, `unused privacy declaration present: ${key}`);
}

const fuses = run(fuseCli, ["read", "--app", appPath]);
for (const expected of [
  "RunAsNode is Disabled",
  "EnableCookieEncryption is Enabled",
  "EnableNodeOptionsEnvironmentVariable is Disabled",
  "EnableNodeCliInspectArguments is Disabled",
  "EnableEmbeddedAsarIntegrityValidation is Enabled",
  "OnlyLoadAppFromAsar is Enabled",
  "GrantFileProtocolExtraPrivileges is Disabled",
]) assert(fuses.includes(expected), `missing fuse: ${expected}`);

const signedBundles = [
  [appPath, "app.guild.desktop.v2"],
  [join(appPath, "Contents", "Frameworks", "Guild Helper.app"), "app.guild.desktop.v2.helper"],
  [join(appPath, "Contents", "Frameworks", "Guild Helper (GPU).app"), "app.guild.desktop.v2.helper.GPU"],
  [join(appPath, "Contents", "Frameworks", "Guild Helper (Plugin).app"), "app.guild.desktop.v2.helper.Plugin"],
  [join(appPath, "Contents", "Frameworks", "Guild Helper (Renderer).app"), "app.guild.desktop.v2.helper.Renderer"],
];
let applicationRequirement = "";
for (const [bundlePath, expectedIdentifier] of signedBundles) {
  assert(existsSync(bundlePath), `signed bundle missing: ${expectedIdentifier}`);
  const signatureDetails = spawnSync("/usr/bin/codesign", ["-dvv", bundlePath], { encoding: "utf8" });
  assert(signatureDetails.status === 0, `unable to inspect signature: ${expectedIdentifier}`);
  const signatureText = `${signatureDetails.stdout}\n${signatureDetails.stderr}`;
  assert(signatureText.includes(`Identifier=${expectedIdentifier}`), `signature identifier mismatch: ${expectedIdentifier}`);
  assert(/flags=.*\bruntime\b/u.test(signatureText), `hardened runtime flag missing: ${expectedIdentifier}`);
  assert(signatureText.includes("Authority=Guild Local Release Signing"), `unstable signing identity: ${expectedIdentifier}`);
  assert(!signatureText.includes("Signature=adhoc"), `ad-hoc identity would reset macOS permissions: ${expectedIdentifier}`);

  if (bundlePath === appPath) {
    const requirementDetails = spawnSync("/usr/bin/codesign", ["-dr", "-", bundlePath], { encoding: "utf8" });
    assert(requirementDetails.status === 0, "unable to inspect application designated requirement");
    applicationRequirement = `${requirementDetails.stdout}\n${requirementDetails.stderr}`;
  }

  const entitlementDetails = spawnSync(
    "/usr/bin/codesign",
    ["-d", "--entitlements", ":-", bundlePath],
    { encoding: "utf8" },
  );
  assert(entitlementDetails.status === 0, `unable to inspect entitlements: ${expectedIdentifier}`);
  const entitlementText = `${entitlementDetails.stdout}\n${entitlementDetails.stderr}`;
  assert(entitlementText.includes("com.apple.security.cs.allow-jit"), `JIT entitlement missing: ${expectedIdentifier}`);
  assert(
    entitlementText.includes("com.apple.security.cs.allow-unsigned-executable-memory"),
    `unsigned executable memory entitlement missing: ${expectedIdentifier}`,
  );
  assert(
    entitlementText.includes("com.apple.security.cs.disable-library-validation"),
    `ad-hoc library-validation exception missing: ${expectedIdentifier}`,
  );
  assert(!entitlementText.includes("com.apple.security.get-task-allow"), `debug entitlement present: ${expectedIdentifier}`);
}
assert(applicationRequirement.includes('identifier "app.guild.desktop.v2"'), "application requirement lost stable identifier");
assert(applicationRequirement.includes("certificate root = H\""), "application requirement is not certificate-stable");
assert(!applicationRequirement.includes("cdhash H\""), "application requirement is pinned to one build hash");

const archiveEntries = run(asarCli, ["list", appAsar]).split("\n").filter(Boolean);
assert(archiveEntries.length < 100, "unexpectedly large app.asar file set");
for (const entry of archiveEntries) {
  assert(!entry.includes("/dist/mac-"), "nested packaged application detected");
  assert(!entry.endsWith(".map"), "source map packaged");
  assert(!entry.endsWith(".test.js"), "test file packaged");
  assert(!entry.endsWith("-testing.js"), "test seam packaged");
  assert(!entry.endsWith("/dist/main/fixture-service.js"), "UI fixture packaged");
  assert(!entry.includes("/node_modules/@guild/ui/"), "renderer-only UI dependency packaged");
  assert(!entry.includes("/node_modules/@guild/") || !entry.includes("/src/"), "workspace source packaged");
}

const scanRoot = mkdtempSync(join(tmpdir(), "guild-package-scan-"));
try {
  run(asarCli, ["extract", appAsar, scanRoot]);
  const sensitivePatterns = [
    /\/Users\/[^/\s]+/u,
    /\/Applications\/Guild\.app/u,
    /\.grok\/auth\.json/u,
    /github_pat_[A-Za-z0-9_]{20,}/u,
    /gh[pousr]_[A-Za-z0-9]{20,}/u,
    /(?:sk|xai)-[A-Za-z0-9_-]{20,}/u,
    /Bearer\s+[A-Za-z0-9._~+/-]{24,}/u,
  ];
  const pending = [scanRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) pending.push(path);
      else {
        const bytes = readFileSync(path);
        assert(!sensitivePatterns.some((pattern) => pattern.test(bytes.toString("utf8"))), `sensitive pattern in ${relative(scanRoot, path)}`);
      }
    }
  }
} finally {
  rmSync(scanRoot, { recursive: true, force: true });
}

run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
run("/usr/bin/hdiutil", ["verify", dmgPath]);

const digest = createHash("sha256");
await new Promise((resolve, reject) => {
  createReadStream(dmgPath).on("data", (chunk) => digest.update(chunk)).on("end", resolve).on("error", reject);
});
console.log(`verified ${basename(dmgPath)} sha256=${digest.digest("hex")}`);
