/**
 * Explicit test discovery for compiled workspace packages.
 * Passing dist directories to `node --test` treats the directories as tests
 * and is false-green when a package has no *.test.js files.
 * Every discovered *.test.js must have a current matching src *.test.ts so
 * orphaned incremental output cannot be executed after its source is removed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const PACKAGES = [
  {
    name: "@guild/contracts",
    dist: join(repoRoot, "packages/contracts/dist"),
    src: join(repoRoot, "packages/contracts/src"),
  },
  {
    name: "@guild/domain",
    dist: join(repoRoot, "packages/domain/dist"),
    src: join(repoRoot, "packages/domain/src"),
  },
  {
    name: "@guild/persistence",
    dist: join(repoRoot, "packages/persistence/dist"),
    src: join(repoRoot, "packages/persistence/src"),
  },
  {
    name: "@guild/runtime-grok",
    dist: join(repoRoot, "packages/runtime-grok/dist"),
    src: join(repoRoot, "packages/runtime-grok/src"),
  },
  {
    name: "@guild/ui",
    dist: join(repoRoot, "packages/ui/dist"),
    src: join(repoRoot, "packages/ui/src"),
  },
  {
    name: "@guild/desktop",
    dist: join(repoRoot, "apps/desktop/dist/main"),
    src: join(repoRoot, "apps/desktop/src/main"),
  },
];

/** Missing any of these compiled files is fatal. Extra future tests may still run. */
const REQUIRED_TEST_BASENAMES = {
  "@guild/contracts": [
    "ids.test.js",
    "run-events.test.js",
    "runtime-envelope.test.js",
    "runtime-payload.test.js",
    "runtime-turn-event.test.js",
    "traceability.test.js",
  ],
  "@guild/domain": [
    "run-machine.test.js",
    "session-binding.test.js",
    "permission-machine.test.js",
    "event-admission.test.js",
  ],
  "@guild/persistence": ["lease.test.js", "store.test.js"],
  "@guild/runtime-grok": [
    "acp-adapter.test.js",
    "acp-v1-codec.test.js",
    "acp-v1-methods.test.js",
    "grok-acp-profile.test.js",
    "ndjson.test.js",
    "json-rpc-peer.test.js",
    "process-host.test.js",
  ],
  "@guild/ui": ["timeline.test.js"],
  "@guild/desktop": ["guild-url.test.js", "live-service.test.js"],
};

function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      found.push(full);
    }
  }
  return found;
}

const files = [];
for (const pkg of PACKAGES) {
  if (!existsSync(pkg.dist)) {
    console.error(
      `test discovery failed: ${pkg.name} dist is missing (${relative(repoRoot, pkg.dist)})`,
    );
    process.exit(1);
  }
  const found = collectTestFiles(pkg.dist).sort();
  if (found.length === 0) {
    console.error(
      `test discovery failed: ${pkg.name} has no *.test.js files under ${relative(repoRoot, pkg.dist)}`,
    );
    process.exit(1);
  }
  const required = REQUIRED_TEST_BASENAMES[pkg.name];
  if (required !== undefined) {
    const present = new Set(found.map((file) => basename(file)));
    const missing = required.filter((name) => !present.has(name));
    if (missing.length > 0) {
      console.error(
        `test discovery failed: ${pkg.name} missing required test file(s): ${missing.join(", ")}`,
      );
      process.exit(1);
    }
  }
  for (const compiled of found) {
    const rel = relative(pkg.dist, compiled);
    const escaped = rel.startsWith(`..${sep}`) || rel === ".." || rel.split(sep).includes("..");
    if (escaped) {
      console.error(
        `test discovery failed: compiled test escapes dist (${relative(repoRoot, compiled)})`,
      );
      process.exit(1);
    }
    const source = join(pkg.src, rel.replace(/\.js$/u, ".ts"));
    let sourceIsFile = false;
    try {
      sourceIsFile = statSync(source).isFile();
    } catch {
      sourceIsFile = false;
    }
    if (!sourceIsFile) {
      console.error(
        `test discovery failed: compiled test ${relative(repoRoot, compiled)} has no corresponding source ${relative(repoRoot, source)}`,
      );
      process.exit(1);
    }
  }
  files.push(...found);
}

console.error(`running ${files.length} test files:`);
for (const file of files) {
  console.error(`  ${relative(repoRoot, file)}`);
}

// Lease and process-host suites intentionally measure real child-process liveness.
// Run them outside the broad file pool so their fixed deadlines measure product
// behavior rather than contention from the other compiled test files.
const isolatedBasenames = new Set(["lease.test.js", "process-host.test.js"]);
const pooledFiles = files.filter((file) => !isolatedBasenames.has(basename(file)));
const isolatedFiles = files.filter((file) => isolatedBasenames.has(basename(file)));

function run(filesToRun, concurrency) {
  if (filesToRun.length === 0) return 0;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      `--test-concurrency=${concurrency}`,
      "--test-reporter",
      "spec",
      ...filesToRun,
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
  if (result.error) {
    console.error(result.error);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

const pooledStatus = run(pooledFiles, 4);
if (pooledStatus !== 0) process.exit(pooledStatus);
process.exit(run(isolatedFiles, 1));
