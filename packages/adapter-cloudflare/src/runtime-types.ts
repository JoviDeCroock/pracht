/** Shared public and internal types for the Cloudflare request runtime. */

import type {
  ISGManifestEntry,
  MarkdownManifest,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
} from "@pracht/core/server";
import type { CloudflareWorkersCacheOption } from "./cache.ts";

export type HeadersManifest = Record<string, Record<string, string>>;
export type ISGManifest = Record<string, ISGManifestEntry>;
export type RenderISGPage = (pathname: string, originalRequest: Request) => Promise<Response>;

export interface CloudflareFetcher {
  fetch(input: Request | URL | string): Promise<Response>;
}

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface CloudflareContextArgs<TEnv = Record<string, unknown>> {
  request: Request;
  env: TEnv;
  executionContext: CloudflareExecutionContext;
}

export interface CloudflareAdapterOptions<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  TContext = {
    env: TEnv;
    executionContext: CloudflareExecutionContext;
  },
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  assetsBinding?: string;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit to preserve negotiation for legacy/custom entries. */
  markdownManifest?: MarkdownManifest;
  isgManifest?: ISGManifest;
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
  /**
   * Serve time-revalidated ISG routes through Cloudflare Workers Caching:
   * instead of the build-time static snapshot and the worker-managed Cache
   * API path, ISG pages are rendered on demand and cached at the edge for
   * their `revalidate` window (via `cloudflare-cdn-cache-control`), with
   * stale pages served instantly while the Worker re-renders in the
   * background. Webhook-only ISG routes keep the worker-managed path so
   * revalidation takes effect immediately. Requires
   * `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: CloudflareWorkersCacheOption;
}
