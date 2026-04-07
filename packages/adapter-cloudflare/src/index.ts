import {
  handleViactRequest,
  type HandleViactRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type ViactApp,
} from "viact";

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
  app: ViactApp;
  registry?: ModuleRegistry;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  assetsBinding?: string;
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
    const assetResponse = await maybeServeAsset(request, env, assetsBinding);
    if (assetResponse) {
      return assetResponse;
    }

    const context = options.createContext
      ? await options.createContext({ request, env, executionContext })
      : ({ env, executionContext } as TContext);

    return handleViactRequest({
      app: options.app,
      registry: options.registry,
      request,
      context,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandleViactRequestOptions<TContext>);
  };
}

export function createCloudflareServerEntryModule(
  options: CloudflareServerEntryModuleOptions = {},
): string {
  const assetsBinding = options.assetsBinding ?? "ASSETS";

  return [
    `export const cloudflareAssetsBinding = ${JSON.stringify(assetsBinding)};`,
    "",
    "async function maybeServeViactAsset(request, env) {",
    '  if (request.method !== "GET" && request.method !== "HEAD") {',
    "    return null;",
    "  }",
    "",
    "  // Route state requests must be handled by the framework (returns JSON), not static assets",
    '  if (request.headers.get("x-viact-route-state-request") === "1") {',
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
    "  headers.append('Vary', 'x-viact-route-state-request');",
    "  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });",
    "}",
    "",
    "async function fetch(request, env, executionContext) {",
    "  const assetResponse = await maybeServeViactAsset(request, env);",
    "  if (assetResponse) {",
    "    return assetResponse;",
    "  }",
    "",
    "  return handleViactRequest({",
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
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return null;
  }

  // Route state requests must be handled by the framework (returns JSON), not static assets
  if (request.headers.get("x-viact-route-state-request") === "1") {
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
  headers.append("Vary", "x-viact-route-state-request");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isFetcher(value: unknown): value is CloudflareFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}
