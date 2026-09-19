import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const requireFromDesktop = createRequire(new URL("../package.json", import.meta.url));
const electronPackagePath = requireFromDesktop.resolve("electron/package.json");
const electronPackageRoot = dirname(electronPackagePath);
const electronDistribution = join(electronPackageRoot, "dist");
const electronMetadata = JSON.parse(readFileSync(electronPackagePath, "utf8"));

function distributionIsComplete() {
  const requiredFiles = [
    "Electron.app/Contents/MacOS/Electron",
    "LICENSE",
    "LICENSES.chromium.html",
    "version",
  ];
  if (!requiredFiles.every((relativePath) => existsSync(join(electronDistribution, relativePath)))) {
    return false;
  }
  return readFileSync(join(electronDistribution, "version"), "utf8").trim() === electronMetadata.version;
}

if (!distributionIsComplete()) {
  console.log(`Preparing Electron ${electronMetadata.version}; the first run may download its macOS binary...`);
  requireFromDesktop("electron");
}

if (!distributionIsComplete()) {
  throw new Error(
    `Electron ${electronMetadata.version} is incomplete after preparation. ` +
      "Check network access, then run `npm run prepare:electron` again.",
  );
}

console.log(`Electron ${electronMetadata.version} is ready.`);
