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

export interface CloudflareViteAdapterOptions extends CloudflareServerEntryModuleOptions {
  /**
   * Inspector port for the local Cloudflare runtime, or `false` to disable it.
   * Set this explicitly when multiple Cloudflare Vite dev servers can start at
   * the same time; automatic availability probes can otherwise race.
   */
  inspectorPort?: number | false;
  /**
   * Persist local Cloudflare binding state, optionally below a custom path.
   * Use separate paths or `false` for concurrent dev servers in one project.
   * Defaults to Cloudflare's `.wrangler/state` behavior.
   */
  persistState?: boolean | { path: string };
}

const GRAPH_RUNTIME_STUB_PREFIX = "\0pracht:cloudflare-graph-runtime:";
const GRAPH_RUNTIME_STUBS: Record<string, string> = {
  "cloudflare:workers": [
    "function unavailable(api) { throw new Error(`cloudflare:workers ${api} is unavailable during graph inspection`); }",
    "function unavailableObject(api) {",
    "  const fail = (operation) => unavailable(`${api} ${operation}`);",
    "  const inspectSymbol = Symbol.for('nodejs.util.inspect.custom');",
    "  const target = Object.create(null);",
    "  Object.defineProperty(target, inspectSymbol, { configurable: true, value() { return fail('inspection'); } });",
    "  return new Proxy(target, {",
    "    get(_target, property) {",
    "      if (property === inspectSymbol) return () => fail('inspection');",
    "      if (property === Symbol.toPrimitive) return () => fail('coercion');",
    "      return fail(`property ${String(property)} access`);",
    "    },",
    "    set(_target, property) { return fail(`property ${String(property)} assignment`); },",
    "    has(_target, property) { return fail(`property ${String(property)} membership check`); },",
    "    ownKeys() { return fail('property enumeration'); },",
    "    getOwnPropertyDescriptor(_target, property) { return fail(`property ${String(property)} descriptor inspection`); },",
    "    defineProperty(_target, property) { return fail(`property ${String(property)} definition`); },",
    "    deleteProperty(_target, property) { return fail(`property ${String(property)} deletion`); },",
    "    getPrototypeOf() { return fail('prototype inspection'); },",
    "    setPrototypeOf() { return fail('prototype mutation'); },",
    "    isExtensible() { return fail('extensibility inspection'); },",
    "    preventExtensions() { return fail('extension prevention'); },",
    "  });",
    "}",
    "export class RpcStub { constructor() { unavailable('RpcStub'); } }",
    "export class RpcTarget { constructor() { unavailable('RpcTarget'); } }",
    "export class WorkerEntrypoint { constructor() { unavailable('WorkerEntrypoint'); } }",
    "export class DurableObject { constructor() { unavailable('DurableObject'); } }",
    "export class WorkflowEntrypoint { constructor() { unavailable('WorkflowEntrypoint'); } }",
    "export function waitUntil() { return unavailable('waitUntil'); }",
    "export function withEnv() { return unavailable('withEnv'); }",
    "export function withExports() { return unavailable('withExports'); }",
    "export function withEnvAndExports() { return unavailable('withEnvAndExports'); }",
    "export const env = unavailableObject('env');",
    "export const exports = unavailableObject('exports');",
    "export const cache = { purge() { return unavailable('cache.purge'); } };",
    "export const tracing = { enterSpan() { return unavailable('tracing.enterSpan'); } };",
  ].join("\n"),
  "cloudflare:email": [
    "function unavailable(api) { throw new Error(`cloudflare:email ${api} is unavailable during graph inspection`); }",
    "export class EmailMessage { constructor() { unavailable('EmailMessage'); } }",
  ].join("\n"),
  "cloudflare:sockets":
    'export function connect() { throw new Error("cloudflare:sockets is unavailable during graph inspection"); }\n',
  "cloudflare:workflows": [
    "function unavailable(api) { throw new Error(`cloudflare:workflows ${api} is unavailable during graph inspection`); }",
    "export class WorkflowEntrypoint { constructor() { unavailable('WorkflowEntrypoint'); } }",
  ].join("\n"),
};

/**
 * Graph readers execute capability contracts in Vite's Node SSR runner. Keep
 * Cloudflare runtime imports resolvable there without starting workerd; code
 * that actually calls a platform API still fails loudly.
 */
function cloudflareGraphRuntimeStubs(): Plugin {
  return {
    name: "pracht:cloudflare-graph-runtime-stubs",
    enforce: "pre",
    resolveId(source) {
      if (!source.startsWith("cloudflare:")) return;
      if (!(source in GRAPH_RUNTIME_STUBS)) {
        throw new Error(
          `Pracht graph inspection has no Node stub for "${source}". ` +
            `Supported Cloudflare runtime modules: ${Object.keys(GRAPH_RUNTIME_STUBS).join(", ")}.`,
        );
      }
      return `${GRAPH_RUNTIME_STUB_PREFIX}${source}`;
    },
    load(id) {
      if (!id.startsWith(GRAPH_RUNTIME_STUB_PREFIX)) return;
      return GRAPH_RUNTIME_STUBS[id.slice(GRAPH_RUNTIME_STUB_PREFIX.length)];
    },
  };
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
    "let markdownManifestPromise;",
    "async function readPrachtMarkdownManifest(request, assets) {",
    "  if (!markdownManifestPromise) {",
    "    const manifestUrl = new URL('/_pracht/markdown.json', request.url);",
    "    markdownManifestPromise = assets.fetch(manifestUrl).then(async (response) => {",
    "      if (response.status === 404) return undefined;",
    "      if (!response.ok) throw new Error(`Failed to fetch pracht markdown manifest: ${response.status}`);",
    "      return response.json();",
    "    }).catch(() => {",
    "      markdownManifestPromise = undefined;",
    "      return undefined;",
    "    });",
    "  }",
    "  return markdownManifestPromise;",
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
    '  const isUpgradeRequest = request.headers.has("upgrade");',
    '  const headersManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    "    ? await readPrachtHeadersManifest(request, assets)",
    "    : {};",
    '  const markdownManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    "    ? await readPrachtMarkdownManifest(request, assets)",
    "    : undefined;",
    '  const isgManifest = !isUpgradeRequest && assets && typeof assets.fetch === "function"',
    "    ? await readPrachtISGManifest(request, assets)",
    "    : {};",
    "",
    "  const handler = createCloudflareFetchHandler({",
    "    app: resolvedApp,",
    "    registry,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    islandsEntryUrl: islandsEntryUrl ?? undefined,",
    "    islandsBootstrapRequired,",
    "    cssManifest,",
    "    jsManifest,",
    `    assetsBinding: ${JSON.stringify(assetsBinding)},`,
    "    headersManifest,",
    "    markdownManifest,",
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
export function cloudflareAdapter(options: CloudflareViteAdapterOptions = {}): PrachtAdapter {
  return {
    id: "cloudflare",
    ownsDevServer: true,
    edge: true,
    serverImports:
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createCloudflareFetchHandler } from "@pracht/adapter-cloudflare/runtime";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
    graphVitePlugins(): Plugin[] {
      return [cloudflareGraphRuntimeStubs()];
    },
    vitePlugins(): Plugin[] {
      return cloudflare({
        config: {
          main: "virtual:pracht/server",
        },
        inspectorPort: options.inspectorPort,
        persistState: options.persistState,
      });
    },
  };
}
