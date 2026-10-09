import {
  forgetSharedStagesInternal,
  pinExecutableInternal,
  pinExecutableSharedInternal,
  type PinnedExecutable,
} from "./executable-pin.js";

export type ExecutablePinTestHooks = {
  readonly afterDescriptorCopy?: () => void | Promise<void>;
};

/** Package-internal deterministic entry. This module is not exported by `src/index.ts`. */
export function pinExecutableForTesting(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
  hooks: ExecutablePinTestHooks,
): Promise<PinnedExecutable> {
  return pinExecutableInternal(executablePath, stagingRoot, expectedSha256, hooks);
}

/** Package-internal: the shared-stage entry with the same deterministic hooks. */
export function pinExecutableSharedForTesting(
  executablePath: string,
  stagingRoot: string,
  expectedSha256: string,
  hooks: ExecutablePinTestHooks,
): Promise<PinnedExecutable> {
  return pinExecutableSharedInternal(executablePath, stagingRoot, expectedSha256, hooks);
}

/** Package-internal: forget in-memory shared stages as if the process had exited. */
export function forgetSharedStagesForTesting(): Promise<void> {
  return forgetSharedStagesInternal();
}
