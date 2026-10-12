export type SourceKind = "online" | "local";

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
  /** Vendor or server base URL. */
  readonly baseUrl: string;
  /** Held in memory; never logged. */
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

/** What the router tells the transport about an upstream request, beyond the request itself. */
export interface UpstreamRequestContext {
  /**
   * Kind of the source the router chose for this request. A transport that differs by kind (Local
   * never uses a proxy) must decide from this alone, never from the registry or the URL.
   */
  readonly sourceKind: SourceKind;
}

export type UpstreamFetch = (input: string, init: RequestInit, context: UpstreamRequestContext) => Promise<Response>;

export interface ModelRouterOptions {
  /** Online and local sources: the only models the router serves. */
  readonly sources: readonly RouterSource[];
  readonly provenance: ProvenanceStore;
  readonly logger: RouterLogger;
  /** Production: Electron net.fetch (system proxy). Tests: global fetch, which ignores the context. */
  readonly fetchImpl: UpstreamFetch;
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

/**
 * Reserved source id. Guild 3.0.0 recorded Anthropic as the producer of thinking signatures under this id,
 * and those rows persist, so no source may ever take it (a new source would inherit them).
 */
export const ANTHROPIC_SOURCE_ID = "anthropic";
