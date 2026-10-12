// Main-process seams shared by the live service and the Guild 3.0 hosts (docs/20 sections 3.3-3.5).
// The live service depends only on these interfaces; index.ts wires the real hosts.

export type RoutedModelGroup = "online" | "local";

export interface RoutedModelInfo {
  readonly id: string;
  readonly label: string;
  readonly group: RoutedModelGroup;
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly contextWindow?: number;
  readonly supportsImages?: boolean;
}

export interface ModelRouterHostPort {
  /** Online and Local models that are enabled and confirmed, usable right now. */
  listRoutedModels(): readonly RoutedModelInfo[];
  /** Starts the loopback router if needed. The URL carries the router token: never log it. */
  ensureStarted(): Promise<{ readonly baseUrl: string }>;
  /** Called after sources are added, confirmed, edited, disabled or deleted. */
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface BrowserMcpPort {
  /** Starts the loopback browser MCP server if needed. The URL carries a token: never log it. */
  ensureStarted(): Promise<{ readonly url: string }>;
}
