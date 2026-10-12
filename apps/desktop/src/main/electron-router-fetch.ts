import { session } from "electron";

function sessionInput(input: Parameters<typeof fetch>[0]): string | Request {
  return input instanceof URL ? input.href : input;
}

/**
 * Transports for the model router (docs/20 section 3.4). Both run on Chromium's network stack in
 * their own in-memory sessions, so Guild's renderer cookies, cache and permission handlers never
 * mix with vendor traffic:
 * - `proxied` (Anthropic and Online sources) follows the system proxy settings;
 * - `direct` (Local sources) never uses a proxy, because a Local server is on this computer or the
 *   user's own network and a proxy could neither reach nor be trusted with it.
 * Verified on Electron 43 (docs/20 smoke): `session.fetch` streams the body chunk by chunk, honours
 * an AbortSignal, and with `redirect: "manual"` REJECTS ("Redirect was cancelled") instead of
 * returning the 3xx; the router host turns that into a refused redirect.
 */
export function createElectronRouterFetches(): {
  readonly proxied: typeof fetch;
  readonly direct: typeof fetch;
} {
  const proxiedSession = session.fromPartition("guild-model-router");
  const directSession = session.fromPartition("guild-model-router-direct");
  const directReady = directSession.setProxy({ mode: "direct" });
  return {
    proxied: (input, init) => proxiedSession.fetch(sessionInput(input), init),
    direct: async (input, init) => {
      await directReady;
      return directSession.fetch(sessionInput(input), init);
    },
  };
}
