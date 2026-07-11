import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolveWorkersCacheOptions, type CloudflareWorkersCacheOption } from "./cache.ts";

export { createCloudflareFetchHandler } from "./runtime.ts";
export type {
  CloudflareAdapterOptions,
  CloudflareContextArgs,
  CloudflareExecutionContext,
  CloudflareFetcher,
} from "./runtime.ts";
export {
  ISG_CACHE_TAG,
  purgeCache,
  routeCacheTag,
  type CloudflareWorkersCacheOption,
  type CloudflareWorkersCacheOptions,
  type PurgeCacheOptions,
} from "./cache.ts";

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
  /**
   * Serve ISG routes through Cloudflare Workers Caching: instead of the
   * build-time static snapshot, ISG pages are rendered on demand and cached
   * at the edge for their `revalidate` window (via
   * `cloudflare-cdn-cache-control`), with stale pages served instantly while
   * the Worker re-renders in the background. Purge cached pages with
   * `purgeCache()` from `@pracht/adapter-cloudflare/cache`.
   * Requires `"cache": { "enabled": true }` in wrangler config.
   */
  cache?: CloudflareWorkersCacheOption;
}

export function createCloudflareServerEntryModule(
  options: CloudflareServerEntryModuleOptions = {},
): string {
  const assetsBinding = options.assetsBinding ?? "ASSETS";
  const cacheOptions = resolveWorkersCacheOptions(options.cache);
  // The entrypoint-name list lets `pracht build` write a clean deploy entry
  // (dist/server/worker.js) that re-exports only the default handler and these
  // classes: workerd validates every named export of the deployed entry module
  // and rejects the build metadata (buildTarget, manifests, ...) this module
  // also exports for the CLI's prerender pass.
  const workerExports = options.workerExportsFrom
    ? [
        `export * from ${JSON.stringify(options.workerExportsFrom)};`,
        `import * as prachtWorkerEntrypoints from ${JSON.stringify(options.workerExportsFrom)};`,
        "export const cloudflareWorkerEntrypointNames = Object.keys(prachtWorkerEntrypoints);",
      ]
    : ["export const cloudflareWorkerEntrypointNames = [];"];
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
    `export const cloudflareWorkersCacheEnabled = ${JSON.stringify(Boolean(cacheOptions))};`,
    "",
    "let headersManifestPromise;",
    "async function readPrachtHeadersManifest(request, assets) {",
    "  if (!headersManifestPromise) {",
    "    const manifestUrl = new URL('/_pracht/headers.json', request.url);",
    "    headersManifestPromise = assets.fetch(manifestUrl).then(async (response) => {",
    "      if (response.status === 404) return {};",
    "      if (!response.ok) throw new Error(`Failed to fetch pracht headers manifest: ${response.status}`);",
    "      return response.json();",
    "    }).catch(() => {",
    "      headersManifestPromise = undefined;",
    "      return {};",
    "    });",
    "  }",
    "  return headersManifestPromise;",
    "}",
    "",
    "let isgManifestPromise;",
    "async function readPrachtISGManifest(request, assets) {",
    "  if (!isgManifestPromise) {",
    "    const manifestUrl = new URL('/_pracht/isg.json', request.url);",
    "    isgManifestPromise = assets.fetch(manifestUrl).then(async (response) => {",
    "      if (response.status === 404) return {};",
    "      if (!response.ok) throw new Error(`Failed to fetch pracht ISG manifest: ${response.status}`);",
    "      return response.json();",
    "    }).catch(() => {",
    "      isgManifestPromise = undefined;",
    "      return {};",
    "    });",
    "  }",
    "  return isgManifestPromise;",
    "}",
    "",
    "async function fetch(request, env, executionContext) {",
    `  const assets = env?.[${JSON.stringify(assetsBinding)}];`,
    '  const headersManifest = assets && typeof assets.fetch === "function"',
    "    ? await readPrachtHeadersManifest(request, assets)",
    "    : {};",
    '  const isgManifest = assets && typeof assets.fetch === "function"',
    "    ? await readPrachtISGManifest(request, assets)",
    "    : {};",
    "",
    "  const handler = createCloudflareFetchHandler({",
    "    app: resolvedApp,",
    "    registry,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    cssManifest,",
    "    jsManifest,",
    `    assetsBinding: ${JSON.stringify(assetsBinding)},`,
    "    headersManifest,",
    "    isgManifest,",
    "    createContext: createPrachtContext,",
    `    cache: ${JSON.stringify(options.cache ?? false)},`,
    "  });",
    "  return handler(request, env, executionContext);",
    "}",
    "",
    "export default { ...prachtWorkerHandlers, fetch };",
    "",
    ...workerExports,
    "",
  ].join("\n");
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
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createCloudflareFetchHandler } from "@pracht/adapter-cloudflare/runtime";',
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
