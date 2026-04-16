import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";
import {
  applyDefaultSecurityHeaders,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core";

type HeadersManifest = Record<string, Record<string, string>>;

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
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  assetsBinding?: string;
  headersManifest?: HeadersManifest;
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
}

export interface CloudflareServerEntryModuleOptions {
  assetsBinding?: string;
}

export function createCloudflareFetchHandler<
  TEnv extends Record<string, unknown> = Record<string, unknown>,
  TContext = {
    env: TEnv;
    executionContext: CloudflareExecutionContext;
  },
>(options: CloudflareAdapterOptions<TEnv, TContext>) {
  const assetsBinding = options.assetsBinding ?? "ASSETS";

  return async (
    request: Request,
    env: TEnv,
    executionContext: CloudflareExecutionContext,
  ): Promise<Response> => {
    const assetResponse = await maybeServeAsset(
      request,
      env,
      assetsBinding,
      options.headersManifest ?? {},
    );
    if (assetResponse) {
      return assetResponse;
    }

    const context = options.createContext
      ? await options.createContext({ request, env, executionContext })
      : ({ env, executionContext } as TContext);

    return handlePrachtRequest({
      app: options.app,
      registry: options.registry,
      request,
      context,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);
  };
}

export function createCloudflareServerEntryModule(
  options: CloudflareServerEntryModuleOptions = {},
): string {
  const assetsBinding = options.assetsBinding ?? "ASSETS";

  return [
    `export const cloudflareAssetsBinding = ${JSON.stringify(assetsBinding)};`,
    "",
    "let headersManifestPromise;",
    "async function readPrachtHeadersManifest(request, assets) {",
    "  if (!headersManifestPromise) {",
    "    const manifestUrl = new URL('/_pracht/headers.json', request.url);",
    "    headersManifestPromise = assets.fetch(manifestUrl).then(async (response) => {",
    "      if (!response.ok) return {};",
    "      return response.json();",
    "    }).catch(() => ({}));",
    "  }",
    "  return headersManifestPromise;",
    "}",
    "",
    "function applyPrachtHeadersManifest(headers, headersManifest, pathname) {",
    "  const withoutIndex = pathname.replace(/\\/index\\.html$/, '') || '/';",
    "  const withoutSlash = pathname.replace(/\\/$/, '') || '/';",
    "  const routeHeaders = headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex];",
    "  if (!routeHeaders) return;",
    "  for (const [key, value] of Object.entries(routeHeaders)) {",
    "    headers.set(key, value);",
    "  }",
    "}",
    "",
    "async function maybeServePrachtAsset(request, env) {",
    '  if (request.method !== "GET" && request.method !== "HEAD") {',
    "    return null;",
    "  }",
    "",
    "  // Route state requests must be handled by the framework (returns JSON), not static assets",
    '  if (request.headers.get("x-pracht-route-state-request") === "1") {',
    "    return null;",
    "  }",
    "",
    `  const assets = env?.[${JSON.stringify(assetsBinding)}];`,
    '  if (!assets || typeof assets.fetch !== "function") {',
    "    return null;",
    "  }",
    "",
    "  const response = await assets.fetch(request);",
    "  if (response.status === 404) return null;",
    "  // Vary on the route-state header so the CDN caches HTML and JSON responses separately",
    "  const headers = new Headers(response.headers);",
    "  headers.append('Vary', 'x-pracht-route-state-request');",
    "  applyDefaultSecurityHeaders(headers);",
    "  if ((headers.get('content-type') ?? '').includes('text/html')) {",
    "    applyPrachtHeadersManifest(headers, await readPrachtHeadersManifest(request, assets), new URL(request.url).pathname);",
    "  }",
    "  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });",
    "}",
    "",
    "async function fetch(request, env, executionContext) {",
    "  const assetResponse = await maybeServePrachtAsset(request, env);",
    "  if (assetResponse) {",
    "    return assetResponse;",
    "  }",
    "",
    "  return handlePrachtRequest({",
    "    app: resolvedApp,",
    "    registry,",
    "    request,",
    "    context: { env, executionContext },",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    "  });",
    "}",
    "",
    "export default { fetch };",
    "",
  ].join("\n");
}

async function maybeServeAsset(
  request: Request,
  env: Record<string, unknown>,
  assetsBinding: string,
  headersManifest: HeadersManifest = {},
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  // Route state requests must be handled by the framework (returns JSON), not static assets
  if (request.headers.get("x-pracht-route-state-request") === "1") {
    return null;
  }

  const assets = env[assetsBinding];
  if (!isFetcher(assets)) {
    return null;
  }

  const response = await assets.fetch(request);
  if (response.status === 404) return null;
  // Vary on the route-state header so the CDN caches HTML and JSON responses separately
  const headers = new Headers(response.headers);
  headers.append("Vary", "x-pracht-route-state-request");
  applyDefaultSecurityHeaders(headers);
  if ((headers.get("content-type") ?? "").includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, new URL(request.url).pathname);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  const routeHeaders =
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex];
  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

function isFetcher(value: unknown): value is CloudflareFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

/**
 * Create a pracht adapter for Cloudflare Workers.
 *
 * ```ts
 * import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
 * pracht({ adapter: cloudflareAdapter() })
 * ```
 */
export function cloudflareAdapter(options: CloudflareServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "cloudflare",
    ownsDevServer: true,
    edge: true,
    serverImports:
      'import { applyDefaultSecurityHeaders, handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
    async vitePlugins(): Promise<Plugin[]> {
      const { cloudflare } = (await import("@cloudflare/vite-plugin")) as {
        cloudflare: (opts?: { config?: { main?: string } }) => Plugin[];
      };
      return cloudflare({
        config: {
          main: "virtual:pracht/server",
        },
      });
    },
  };
}
