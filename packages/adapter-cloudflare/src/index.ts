import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import {
  applyDefaultSecurityHeaders,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core/server";

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
  workerExportsFrom?: string;
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
  /**
   * Vite-resolvable module path whose named exports (`queue`, `scheduled`,
   * `email`, `tail`, ...) are merged into the generated worker's default
   * export next to pracht's `fetch` handler, so apps can consume Queues, Cron
   * Triggers, and Email Routing without replacing the adapter. `fetch` always
   * remains pracht's handler; a `fetch` export in this module is ignored.
   */
  workerHandlersFrom?: string;
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
  const workerExports = options.workerExportsFrom
    ? [`export * from ${JSON.stringify(options.workerExportsFrom)};`]
    : [];
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";
  const handlersImport = options.workerHandlersFrom
    ? `import * as prachtWorkerHandlers from ${JSON.stringify(options.workerHandlersFrom)};`
    : "const prachtWorkerHandlers = {};";

  return [
    contextImport,
    handlersImport,
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
    "  const url = new URL(request.url);",
    '  if (request.headers.get("x-pracht-route-state-request") === "1" || url.searchParams.get("_data") === "1") {',
    "    return null;",
    "  }",
    "",
    "  // Markdown negotiation: let the framework serve markdown source for",
    "  // routes that export it instead of the prerendered HTML.",
    '  if ((request.headers.get("accept") ?? "").includes("text/markdown")) {',
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
    "    applyPrachtHeadersManifest(headers, await readPrachtHeadersManifest(request, assets), url.pathname);",
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
    "  const context = createPrachtContext",
    "    ? await createPrachtContext({ request, env, executionContext })",
    "    : { env, executionContext };",
    "",
    "  return handlePrachtRequest({",
    "    app: resolvedApp,",
    "    registry,",
    "    request,",
    "    context,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    "  });",
    "}",
    "",
    "export default { ...prachtWorkerHandlers, fetch };",
    "",
    ...workerExports,
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
  const url = new URL(request.url);
  if (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return null;
  }

  // Markdown negotiation: let the framework serve raw markdown for routes
  // that export it, instead of the prerendered HTML asset.
  if ((request.headers.get("accept") ?? "").includes("text/markdown")) {
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
    applyHeadersManifest(headers, headersManifest, url.pathname);
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
 * pracht({ adapter: cloudflareAdapter({ workerExportsFrom: "/src/cloudflare.ts" }) })
 * ```
 */
export function cloudflareAdapter(options: CloudflareServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "cloudflare",
    ownsDevServer: true,
    edge: true,
    serverImports:
      'import { applyDefaultSecurityHeaders, handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
    vitePlugins(): Plugin[] {
      return cloudflare({
        config: {
          main: "virtual:pracht/server",
        },
      });
    },
  };
}
