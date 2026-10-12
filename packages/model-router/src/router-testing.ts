import { startRouterInternal } from "./router.js";
import type { ModelRouterHandle, ModelRouterOptions } from "./types.js";

export interface RouterTestConfiguration {
  /** Fake Anthropic upstream, e.g. `http://127.0.0.1:<port>`. */
  readonly anthropicBaseUrl: string;
  readonly maxRequestBytes?: number;
}

const TEST_MAX_REQUEST_BYTES = 128 * 1024 * 1024;

/** Package-internal deterministic entry. This module is not exported by `src/index.ts`. */
export function startModelRouterForTesting(
  options: ModelRouterOptions,
  configuration: RouterTestConfiguration,
): Promise<ModelRouterHandle> {
  return startRouterInternal(options, {
    anthropicBaseUrl: configuration.anthropicBaseUrl,
    maxRequestBytes: configuration.maxRequestBytes ?? TEST_MAX_REQUEST_BYTES,
  });
}
