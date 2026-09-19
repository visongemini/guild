import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(projectRoot, "..", "..");
const legalRoot = join(projectRoot, "dist", "legal");
const lock = JSON.parse(readFileSync(join(workspaceRoot, "package-lock.json"), "utf8"));

rmSync(legalRoot, { recursive: true, force: true });
mkdirSync(legalRoot, { recursive: true });
copyFileSync(join(workspaceRoot, "NOTICE"), join(legalRoot, "NOTICE"));
copyFileSync(join(workspaceRoot, "THIRD-PARTY-NOTICES"), join(legalRoot, "THIRD-PARTY-NOTICES"));

const electronDistribution = join(projectRoot, "node_modules", "electron", "dist");
copyFileSync(join(electronDistribution, "LICENSE"), join(legalRoot, "LICENSE.electron.txt"));
copyFileSync(
  join(electronDistribution, "LICENSES.chromium.html"),
  join(legalRoot, "LICENSES.chromium.html"),
);

const sections = [
  "Guild npm dependency license texts",
  "Generated deterministically from the installed packages pinned by package-lock.json.",
];
const packageEntries = Object.entries(lock.packages ?? {})
  .filter(([packagePath, metadata]) =>
    packagePath.includes("node_modules/") && metadata?.link !== true && existsSync(join(workspaceRoot, packagePath)))
  .sort(([left], [right]) => left.localeCompare(right));

for (const [packagePath, lockMetadata] of packageEntries) {
  const directory = join(workspaceRoot, packagePath);
  const installedMetadataPath = join(directory, "package.json");
  const installedMetadata = existsSync(installedMetadataPath)
    ? JSON.parse(readFileSync(installedMetadataPath, "utf8"))
    : {};
  const licenseFiles = readdirSync(directory)
    .filter((name) => /^(licen[cs]e|copying|notice)(\..*)?$/iu.test(name))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort((left, right) => left.localeCompare(right));
  const name = installedMetadata.name ?? basename(packagePath);
  const version = installedMetadata.version ?? lockMetadata.version ?? "unknown";
  const declaredLicense = installedMetadata.license ?? lockMetadata.license ?? "not declared";
  sections.push("", "=".repeat(78), `${name}@${version}`, `Installed path: ${packagePath}`, `Declared license: ${declaredLicense}`);
  if (licenseFiles.length === 0) {
    sections.push("No standalone license text file was present in this installed npm package.");
    continue;
  }
  for (const filename of licenseFiles) {
    sections.push("", `--- ${filename} ---`, readFileSync(join(directory, filename), "utf8").trimEnd());
  }
}

writeFileSync(join(legalRoot, "THIRD-PARTY-LICENSES.txt"), `${sections.join("\n")}\n`, "utf8");
