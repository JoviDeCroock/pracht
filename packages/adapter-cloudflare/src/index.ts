import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core";

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
  createContext?: (args: CloudflareContextArgs<TEnv>) => TContext | Promise<TContext>;
}

export interface CloudflareServerEntryModuleOptions {
  assetsBinding?: string;
  /**
   * Path to a worker entrypoint file (e.g. "/src/worker.ts") that exports
   * additional Cloudflare primitives such as DurableObject classes, Workflow
   * classes, or event handlers (`scheduled`, `queue`, `tail`, `email`, `trace`).
   *
   * Named exports are re-exported from the generated entry so Cloudflare can
   * discover them.  Known event-handler exports are merged into the default
   * `{ fetch, scheduled, … }` object.
   */
  workerEntrypoint?: string;
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
  const workerEntrypoint = options.workerEntrypoint;

  const lines = [
    `export const cloudflareAssetsBinding = ${JSON.stringify(assetsBinding)};`,
    "",
  ];

  // Re-export named exports (DurableObject classes, Workflow classes, etc.)
  if (workerEntrypoint) {
    lines.push(
      `import * as __userWorker from ${JSON.stringify(workerEntrypoint)};`,
      `export * from ${JSON.stringify(workerEntrypoint)};`,
      "",
    );
  }

  lines.push(
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
  );

  // Build the default export — merge pracht's fetch with user event handlers
  if (workerEntrypoint) {
    lines.push(
      "export default {",
      "  fetch,",
      "  ...(typeof __userWorker.scheduled === 'function' ? { scheduled: __userWorker.scheduled } : {}),",
      "  ...(typeof __userWorker.queue === 'function' ? { queue: __userWorker.queue } : {}),",
      "  ...(typeof __userWorker.tail === 'function' ? { tail: __userWorker.tail } : {}),",
      "  ...(typeof __userWorker.email === 'function' ? { email: __userWorker.email } : {}),",
      "  ...(typeof __userWorker.trace === 'function' ? { trace: __userWorker.trace } : {}),",
      "};",
      "",
    );
  } else {
    lines.push("export default { fetch };", "");
  }

  return lines.join("\n");
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
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
    serverImports: 'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
  };
}
