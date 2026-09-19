import {
  createInternalProcessHostForTesting,
  type GrokProcessHostOptions,
  type InternalProcessHostTestConfiguration,
} from "./process-host.js";

export type ProcessHostTestConfiguration = InternalProcessHostTestConfiguration;
export type GrokProcessHostTestInstance = ReturnType<typeof createInternalProcessHostForTesting>;

/** Package-internal deterministic constructor. This module is not exported by `src/index.ts`. */
export function createGrokProcessHostForTesting(
  options: GrokProcessHostOptions,
  configuration: ProcessHostTestConfiguration,
): GrokProcessHostTestInstance {
  return createInternalProcessHostForTesting(options, configuration);
}
