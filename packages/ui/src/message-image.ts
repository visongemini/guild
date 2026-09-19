const GUILD_MEDIA_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/u;

export function isAllowedMessageImageUrl(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false;
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/iu.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.username !== "" || url.password !== "") return false;
    if (url.protocol === "https:") return true;
    return isAllowedTimelineMediaUrl(value);
  } catch {
    return false;
  }
}

export function isAllowedTimelineMediaUrl(value: string | undefined): value is string {
  if (value === undefined || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === "guild-media:" &&
      url.hostname === "media" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      GUILD_MEDIA_PATH.test(url.pathname) &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}
