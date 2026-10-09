import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { pinExecutableShared, pruneStalePinnedExecutables } from "@guild/runtime-grok";
import { locateOfficialGrokRuntime } from "./runtime-locator.js";

const WARMUP_TIMEOUT_MS = 20_000;

/**
 * Prepares the official runtime before the first task needs it: locates it (hash and version
 * are cached for the life of the app), removes staged copies of other builds, stages the
 * pinned copy, and executes it once. macOS inspects a never-executed file on its first launch,
 * which costs seconds for a 160 MB binary; paying that here keeps it out of the first message.
 * Failures are ignored: every spawn repeats the same checks and reports them properly.
 */
export async function warmOfficialGrokRuntime(stagingRoot: string): Promise<void> {
  const located = await locateOfficialGrokRuntime();
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await pruneStalePinnedExecutables(stagingRoot, located.sha256);
  const pinned = await pinExecutableShared(located.executablePath, stagingRoot, located.sha256);
  try {
    await pinned.verifyForSpawn();
    await new Promise<void>((resolve) => {
      execFile(
        pinned.stagedExecutablePath,
        ["--version"],
        { env: { PATH: "/usr/bin:/bin" }, timeout: WARMUP_TIMEOUT_MS, windowsHide: true },
        () => resolve(),
      );
    });
  } finally {
    await pinned.cleanup();
  }
}
