import type {
  ISGManifestEntry,
  MarkdownManifest,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
} from "@pracht/core/server";

export type HeadersManifest = Record<string, Record<string, string>>;

export interface NetlifyExecutionContext {
  waitUntil?(promise: Promise<unknown>): void;
  [key: string]: unknown;
}

export interface NetlifyContextArgs<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
> {
  request: Request;
  context: TNetlifyContext;
}

export interface NetlifyPurgeCacheOptions {
  tags?: string[];
}

export type NetlifyPurgeCache = (options?: NetlifyPurgeCacheOptions) => Promise<unknown>;

export interface NetlifyCacheOptions {
  /** Seconds stale ISG output may be served while Netlify refreshes it. Set to 0 to disable. Defaults to one year. */
  staleWhileRevalidate?: number;
  /** Edge lifetime for immutable-per-deploy SSG documents. Set to 0 for no freshness. Defaults to one year. */
  staticMaxAge?: number;
}

export interface NetlifyHandlerOptions<
  TNetlifyContext extends NetlifyExecutionContext = NetlifyExecutionContext,
  TContext = TNetlifyContext,
> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  staticDir?: string;
  isgManifest?: Record<string, ISGManifestEntry>;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit only for legacy/custom server entries. */
  markdownManifest?: MarkdownManifest;
  createContext?: (args: NetlifyContextArgs<TNetlifyContext>) => TContext | Promise<TContext>;
  purgeCache?: NetlifyPurgeCache;
  cache?: NetlifyCacheOptions;
}

export interface NetlifyAdapterOptions extends NetlifyCacheOptions {
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
  /** Generated Netlify Function name. Defaults to `pracht`. */
  functionName?: string;
  /** Directory where the generated function wrapper is written. */
  functionsDir?: string;
  /** Additional paths Netlify should serve directly instead of invoking the function. */
  excludedPath?: string[];
}
