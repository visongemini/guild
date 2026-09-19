const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const UNUSED_PRIVACY_USAGE_KEYS = Object.freeze([
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]);

function runPlutil(args) {
  const result = spawnSync("/usr/bin/plutil", args, { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "plutil failed").trim().slice(0, 500);
    throw new Error(detail);
  }
}

function removeIfPresent(plistPath, key) {
  const probe = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    { encoding: "utf8" },
  );
  if (probe.status === 0) runPlutil(["-remove", key, plistPath]);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const plistPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Info.plist",
  );

  // electron-builder broadens ATS for electron-updater's localhost proxy after
  // mac.extendInfo is applied. Guild has no updater proxy; the official Grok
  // child process owns upstream networking, so the desktop bundle stays closed.
  runPlutil([
    "-replace",
    "NSAppTransportSecurity",
    "-json",
    JSON.stringify({ NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: false }),
    plistPath,
  ]);
  for (const key of UNUSED_PRIVACY_USAGE_KEYS) removeIfPresent(plistPath, key);
  runPlutil(["-lint", plistPath]);
};
