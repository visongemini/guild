export type SourceKind = "anthropic" | "online" | "local";

export interface RouterModel {
  readonly id: string;
  readonly label: string;
  readonly contextWindow?: number;
  readonly supportsImages?: boolean;
}

export interface RouterSource {
  readonly id: string;
  readonly kind: SourceKind;
  readonly label: string;
  /** Online/local: vendor or server base URL. Anthropic entries are informational only. */
  readonly baseUrl: string;
  /** Online/local only. Held in memory; never logged. */
  readonly key?: string;
  /** Host (URL.host, including a non-default port) the key was confirmed for. */
  readonly confirmedHost?: string;
  readonly models: readonly RouterModel[];
}

/** Maps sha256(signature)[:32] to the id of the source that produced the signature. */
export interface ProvenanceStore {
  get(hash: string): string | undefined;
  put(hash: string, sourceId: string): void;
}

export interface RouterLogger {
  info(event: string, fields: Record<string, string | number | boolean>): void;
}

export interface ModelRouterOptions {
  /** Online and local sources. Entries of kind "anthropic" are never routable. */
  readonly sources: readonly RouterSource[];
  /** Registry predicate supplied by Guild: true for Claude model ids served by Anthropic. */
  readonly isAnthropicModel: (model: string) => boolean;
  readonly provenance: ProvenanceStore;
  readonly logger: RouterLogger;
  /** Production: Electron net.fetch (system proxy). Tests: global fetch. */
  readonly fetchImpl: typeof fetch;
  /** DNS lookup used for local-source address checks. Default: node:dns. */
  readonly lookup?: (host: string) => Promise<string[]>;
  /** Must be a loopback address. Default "127.0.0.1". */
  readonly host?: string;
}

export interface ModelRouterHandle {
  /** `http://<loopback>:<port>/<token>/` */
  readonly url: string;
  readonly port: number;
  updateSources(sources: readonly RouterSource[]): void;
  close(): Promise<void>;
}

export const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
export const ANTHROPIC_SOURCE_ID = "anthropic";
