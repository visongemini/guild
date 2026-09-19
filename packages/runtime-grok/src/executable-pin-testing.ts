import {
  pinExecutableInternal,
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
