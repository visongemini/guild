import type { GuildRendererApi } from "@guild/contracts";

declare global {
  interface Window {
    readonly guild?: GuildRendererApi;
  }
}

export {};
