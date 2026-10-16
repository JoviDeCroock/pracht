import type { PrachtAdapter } from "@pracht/vite-plugin";
import type { Plugin } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { resolveWorkersCacheOptions, type CloudflareWorkersCacheOption } from "./cache.ts";
import { cloudflareEdgeNodeBuiltins } from "./node-builtins.ts";

export { createCloudflareFetchHandler } from "./runtime.ts";
export type {
  CloudflareAdapterOptions,
  CloudflareContextArgs,
  CloudflareExecutionContext,
  CloudflareFetcher,
} from "./runtime.ts";
export type { PrachtHandler, PrachtHandlerOptions } from "./worker.ts";
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
  /**
   * Vite-resolvable module path (for example `/src/worker.ts`) that owns the
   * Worker: its default export becomes the Worker's handler object and its
   * named exports (Durable Object, Workflow, and WorkerEntrypoint classes)
   * are deployed beside it. Serve pracht from its `fetch` with
   * `createPrachtHandler()` from `@pracht/adapter-cloudflare/worker`.
   * Replaces `workerExportsFrom`, `workerHandlersFrom`, and
   * `createContextFrom`, which cannot be combined with it.
   */
  workerEntry?: string;
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
   * Wrangler config file the local Cloudflare runtime reads bindings and
   * compatibility settings from, relative to the project root. Defaults to
   * Cloudflare's lookup of `wrangler.jsonc`, `wrangler.json`, or
   * `wrangler.toml`. Point it at a generated file, such as Void's
   * `./.void-wrangler.jsonc`, when a tool owns the config.
   */
  configPath?: string;
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

// Every runtime export of each module must exist here, or a contract that
// imports the missing name breaks graph commands. The export surface mirrors the prerender
// stubs in @pracht/cli (`prerender-module-hooks.ts`); a test enumerates the
// real workerd modules and checks both sets against them.
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
    "export class RpcPromise { constructor() { unavailable('RpcPromise'); } }",
    "export class RpcProperty { constructor() { unavailable('RpcProperty'); } }",
    "export class RpcTarget { constructor() { unavailable('RpcTarget'); } }",
    "export class ServiceStub { constructor() { unavailable('ServiceStub'); } }",
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
    "export class NonRetryableError extends Error {",
    "  constructor(message, name = 'NonRetryableError') { super(message); this.name = name; }",
    "}",
    // Not a runtime export of `cloudflare:workflows`, but kept so older
    // imports keep linking; `cloudflare:workers` is where it lives.
    "export class WorkflowEntrypoint { constructor() { unavailable('WorkflowEntrypoint'); } }",
  ].join("\n"),
  "cloudflare:pipelines": [
    "function unavailable(api) { throw new Error(`cloudflare:pipelines ${api} is unavailable during graph inspection`); }",
    "export class PipelineTransformationEntrypoint { constructor() { unavailable('PipelineTransformationEntrypoint'); } }",
  ].join("\n"),
  "cloudflare:node": [
    "function unavailable(api) { throw new Error(`cloudflare:node ${api} is unavailable during graph inspection`); }",
    "export function httpServerHandler() { return unavailable('httpServerHandler'); }",
    "export function handleAsNodeRequest() { return unavailable('handleAsNodeRequest'); }",
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

const WORKER_ENTRY_EXCLUSIVE_OPTIONS = [
  "workerExportsFrom",
  "workerHandlersFrom",
  "createContextFrom",
] as const;

function assertValidWorkerEntryOptions(options: CloudflareServerEntryModuleOptions): void {
  if (options.workerEntry === undefined) return;
  if (typeof options.workerEntry !== "string" || options.workerEntry.trim() === "") {
    throw new Error(
      'cloudflareAdapter({ workerEntry }) must be a module path such as "/src/worker.ts".',
    );
  }
  const combined = WORKER_ENTRY_EXCLUSIVE_OPTIONS.filter((name) => options[name] !== undefined);
  if (combined.length > 0) {
    throw new Error(
      `cloudflareAdapter({ workerEntry }) cannot be combined with ${combined.join(", ")}. ` +
        "Export Worker classes and event handlers from the workerEntry module itself, and pass " +
        "createContext to createPrachtHandler() there.",
    );
  }
}

/**
 * The tail of `virtual:pracht/server` when the app owns its Worker module:
 * the generated `fetch` is registered for `createPrachtHandler()` instead of
 * being exported, and the app module's default and named exports become the
 * Worker's.
 */
function createWorkerEntryExports(workerEntry: string): string[] {
  return [
    "registerPrachtWorker(fetch);",
    "",
    "const prachtWorkerDefault = prachtUserWorker.default;",
    "if (",
    '  !(typeof prachtWorkerDefault === "object" && prachtWorkerDefault !== null && typeof prachtWorkerDefault.fetch === "function") &&',
    '  !(typeof prachtWorkerDefault === "function" && typeof prachtWorkerDefault.prototype?.fetch === "function")',
    ") {",
    "  throw new Error(",
    `    ${JSON.stringify(`The Cloudflare workerEntry ${workerEntry} must default-export a Worker handler whose fetch() calls createPrachtHandler().fetch().`)},`,
    "  );",
    "}",
    "export default prachtWorkerDefault;",
    "",
    `export * from ${JSON.stringify(workerEntry)};`,
    // Only classes and handler objects are Worker entrypoints. The deploy
    // entry leaves other values out, matching what the Cloudflare dev runtime
    // registers from the same module.
    "export const cloudflareWorkerEntrypointNames = Object.keys(prachtUserWorker).filter((name) => {",
    "  const value = prachtUserWorker[name];",
    '  return name !== "default" && (typeof value === "function" || (typeof value === "object" && value !== null));',
    "});",
  ];
}

export function createCloudflareServerEntryModule(
  options: CloudflareServerEntryModuleOptions = {},
): string {
  assertValidWorkerEntryOptions(options);
  const assetsBinding = options.assetsBinding ?? "ASSETS";
  const cacheOptions = resolveWorkersCacheOptions(options.cache);
  // Imported from a virtual module, so a `./` path would resolve against
  // nothing. Read it as relative to the Vite root, like the `/src/...` form.
  const workerEntry = options.workerEntry?.replace(/^\.\//, "/");
  // The entrypoint-name list lets `pracht build` write a clean deploy entry
  // (dist/server/worker.js) that re-exports only the default handler and these
  // classes: workerd validates every named export of the deployed entry module
  // and rejects the build metadata (buildTarget, manifests, ...) this module
  // also exports for the CLI's prerender pass.
  const workerExports = workerEntry
    ? createWorkerEntryExports(workerEntry)
    : options.workerExportsFrom
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

  const workerEntryImports = workerEntry
    ? [
        'import { registerPrachtWorker } from "@pracht/adapter-cloudflare/worker";',
        `import * as prachtUserWorker from ${JSON.stringify(workerEntry)};`,
      ]
    : [];

  return [
    contextImport,
    handlersImport,
    ...workerEntryImports,
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
    "async function fetch(request, env, executionContext, createContext = createPrachtContext) {",
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
    "    cssContentManifest,",
    "    jsManifest,",
    `    assetsBinding: ${JSON.stringify(assetsBinding)},`,
    "    assetsBindingUsesPublicBase: import.meta.env.DEV,",
    "    headersManifest,",
    "    markdownManifest,",
    "    isgManifest,",
    "    createContext,",
    `    cache: ${JSON.stringify(options.cache ?? false)},`,
    "  });",
    "  return handler(request, env, executionContext);",
    "}",
    "",
    ...(workerEntry ? [] : ["export default { ...prachtWorkerHandlers, fetch };"]),
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
 * pracht({ adapter: cloudflareAdapter({ workerEntry: "/src/worker.ts" }) })
 * ```
 */
export function cloudflareAdapter(options: CloudflareViteAdapterOptions = {}): PrachtAdapter {
  assertValidWorkerEntryOptions(options);
  return {
    id: "cloudflare",
    ownsDevServer: true,
    edge: true,
    serverImports:
      'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";\nimport { createCloudflareFetchHandler } from "@pracht/adapter-cloudflare/runtime";',
    createServerEntryModule() {
      return createCloudflareServerEntryModule(options);
    },
    edgeNodeBuiltins(root) {
      return cloudflareEdgeNodeBuiltins(root, options.configPath);
    },
    graphVitePlugins(): Plugin[] {
      return [cloudflareGraphRuntimeStubs()];
    },
    vitePlugins(): Plugin[] {
      return cloudflare({
        config: {
          main: "virtual:pracht/server",
        },
        configPath: options.configPath,
        inspectorPort: options.inspectorPort,
        persistState: options.persistState,
      });
    },
  };
}
