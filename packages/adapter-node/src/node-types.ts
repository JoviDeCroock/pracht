/** Shared public types for the Node request, static, and ISG layers. */

import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ISGManifestEntry,
  MarkdownManifest,
  ModuleRegistry,
  PrachtApp,
  ResolvedApiRoute,
} from "@pracht/core/server";

export type HeadersManifest = Record<string, Record<string, string>>;

export interface NodeAdapterContextArgs {
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeAdapterOptions<TContext = unknown> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  staticDir?: string;
  viteManifest?: unknown;
  isgManifest?: Record<string, ISGManifestEntry>;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  islandsEntryUrl?: string;
  islandsBootstrapRequired?: boolean;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
  /** Exact Markdown-capable routes. Omit to preserve negotiation for legacy/custom entries. */
  markdownManifest?: MarkdownManifest;
  createContext?: (args: NodeAdapterContextArgs) => TContext | Promise<TContext>;
  /**
   * Canonical public origin for request URL construction. When set, the Node
   * adapter ignores `Host` / forwarded host headers and always builds
   * `request.url` against this origin.
   */
  canonicalOrigin?: string;
  /**
   * Whether to trust proxy headers (`Forwarded`, `X-Forwarded-Proto`,
   * `X-Forwarded-Host`) when constructing the request URL.
   *
   * When `canonicalOrigin` is set, it takes precedence and these headers are
   * ignored for URL construction.
   *
   * When **false** (the default) and no `canonicalOrigin` is set, the request
   * URL is derived from the socket: protocol is inferred from TLS state, and
   * host from the `Host` header. Forwarded headers are ignored.
   *
   * When **true**, forwarded headers are honored with the following precedence:
   *   1. RFC 7239 `Forwarded` header (`proto=` and `host=` directives)
   *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
   *   3. Socket-derived values (fallback)
   *
   * Enable this only when the Node server sits behind a trusted reverse proxy
   * (e.g. nginx, Cloudflare, a load balancer) that sets these headers.
   */
  trustProxy?: boolean;
  /** Maximum request body size in bytes. Defaults to 1 MiB. */
  maxBodySize?: number;
}
