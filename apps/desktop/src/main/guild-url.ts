export const GUILD_APP_ORIGIN = "guild-app://app";
export const GUILD_MEDIA_ORIGIN = "guild-media://media";

/** Exact custom-scheme authority check; custom protocols report a null URL.origin in Node. */
export function isTrustedGuildAppUrl(input: string | URL): boolean {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return false;
  }
  return (
    url.protocol === "guild-app:" &&
    url.hostname === "app" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function isTrustedGuildMediaUrl(input: string | URL): boolean {
  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(input);
  } catch {
    return false;
  }
  return (
    url.protocol === "guild-media:" &&
    url.hostname === "media" &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}
