import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IDENTITY_NAME = "Guild Local Release Signing";
const scriptRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(scriptRoot, "..", "..");
const signingRoot = join(homedir(), "Library", "Application Support", "Guild", "BuildSigning");
const keychainPath = join(signingRoot, "Guild-Local-Release.keychain-db");
const passwordPath = join(signingRoot, "keychain-password");
const electronBuilder = join(workspaceRoot, "node_modules", ".bin", "electron-builder");
const electronPackageRoot = join(scriptRoot, "node_modules", "electron");
const electronDist = join(electronPackageRoot, "dist");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: scriptRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env,
  });
  if (result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "command failed").trim() : "command failed";
    throw new Error(`${command}: ${detail.slice(0, 1_000)}`);
  }
  return options.capture ? result.stdout : "";
}

let activeBuildChild;

function runBuild(command, args, options = {}) {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(command, args, {
      cwd: scriptRoot,
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    activeBuildChild = child;
    child.once("error", (error) => {
      if (activeBuildChild === child) activeBuildChild = undefined;
      rejectBuild(error);
    });
    child.once("close", (code, signal) => {
      if (activeBuildChild === child) activeBuildChild = undefined;
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`${command}: command failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function keychainPassword() {
  mkdirSync(signingRoot, { recursive: true, mode: 0o700 });
  chmodSync(signingRoot, 0o700);
  if (!existsSync(passwordPath)) {
    writeFileSync(passwordPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  }
  chmodSync(passwordPath, 0o600);
  return readFileSync(passwordPath, "utf8").trim();
}

function identityIsAvailable() {
  if (!existsSync(keychainPath)) return false;
  const result = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning", keychainPath], { encoding: "utf8" });
  return result.status === 0 && result.stdout.includes(`\"${IDENTITY_NAME}\"`);
}

function keychainUnlocks(password) {
  const result = spawnSync("/usr/bin/security", ["unlock-keychain", "-p", password, keychainPath], { encoding: "utf8" });
  return result.status === 0;
}

function refreshNonInteractiveSigningAccess(password) {
  run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
  run("/usr/bin/security", [
    "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainPath,
  ]);
}

function createIdentity(password) {
  const temporary = mkdtempSync(join(tmpdir(), "guild-local-signing-"));
  const privateKey = join(temporary, "private-key.pem");
  const certificate = join(temporary, "certificate.pem");
  const archive = join(temporary, "identity.p12");
  try {
    run("/usr/bin/security", ["create-keychain", "-p", password, keychainPath]);
    run("/usr/bin/security", ["unlock-keychain", "-p", password, keychainPath]);
    run("/usr/bin/security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
    run("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:3072", "-keyout", privateKey, "-out", certificate,
      "-days", "3650", "-nodes", "-subj", `/CN=${IDENTITY_NAME}/O=BDV`,
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=codeSigning",
    ]);
    run("/usr/bin/openssl", [
      "pkcs12", "-export", "-out", archive, "-inkey", privateKey, "-in", certificate,
      "-passout", `pass:${password}`,
    ]);
    run("/usr/bin/security", [
      "import", archive, "-k", keychainPath, "-P", password,
      "-T", "/usr/bin/codesign", "-T", "/usr/bin/productbuild",
    ]);
    run("/usr/bin/security", [
      "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign",
      "-k", keychainPath, certificate,
    ]);
    run("/usr/bin/security", [
      "set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainPath,
    ]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function listedUserKeychains() {
  const output = run("/usr/bin/security", ["list-keychains", "-d", "user"], { capture: true });
  return [...output.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

const password = keychainPassword();
const installedElectronVersion = readFileSync(join(electronDist, "version"), "utf8").trim();
const declaredElectronVersion = JSON.parse(
  readFileSync(join(electronPackageRoot, "package.json"), "utf8"),
).version;
if (
  !existsSync(join(electronDist, "Electron.app")) ||
  installedElectronVersion !== declaredElectronVersion
) {
  throw new Error("verified local Electron distribution unavailable");
}
if (existsSync(keychainPath) && !keychainUnlocks(password)) {
  throw new Error(
    "stable Guild signing keychain cannot be unlocked; preserve it for recovery instead of rotating the application identity",
  );
}
if (existsSync(keychainPath) && !identityIsAvailable()) {
  throw new Error(
    "stable Guild signing identity is unavailable; preserve the keychain for recovery instead of rotating the application identity",
  );
}
if (!identityIsAvailable()) createIdentity(password);
run("/usr/bin/security", ["unlock-keychain", "-p", password, keychainPath]);
refreshNonInteractiveSigningAccess(password);
if (!identityIsAvailable()) throw new Error("stable Guild signing identity unavailable");

const previousKeychains = listedUserKeychains();
if (previousKeychains.length === 0) {
  throw new Error("refusing to modify an unreadable user keychain search list");
}
const buildKeychains = previousKeychains.includes(keychainPath)
  ? previousKeychains
  : [keychainPath, ...previousKeychains];
const forwardBuildSignal = (signal) => {
  activeBuildChild?.kill(signal);
};
const onSigint = () => forwardBuildSignal("SIGINT");
const onSigterm = () => forwardBuildSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...buildKeychains]);
  await runBuild(electronBuilder, [
    "--mac", "dmg", "--publish", "never",
    `--config.mac.identity=${IDENTITY_NAME}`,
    `--config.electronDist=${electronDist}`,
  ], {
    env: {
      ...process.env,
      CSC_KEYCHAIN: keychainPath,
      CSC_NAME: IDENTITY_NAME,
    },
  });
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  activeBuildChild = undefined;
  run("/usr/bin/security", ["list-keychains", "-d", "user", "-s", ...previousKeychains]);
}

console.log(`Packaged with stable local identity: ${IDENTITY_NAME}`);
