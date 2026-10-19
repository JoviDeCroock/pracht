// The contract between `pracht build`, the Vite plugin that generates
// `dist/server/server.js`, and the deployment adapters. Every import below is
// type-only, so this subpath adds no runtime dependency to an adapter. Core
// deliberately declares no `vite` edge, not even an optional peer: a runtime
// package's edge to the build toolchain keeps Vite in production installs.
// The declarations resolve `vite` from the app, which always has it.
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Plugin } from "vite";

import type { ISGManifestEntry, prerenderApp, prerenderMarkdown } from "./prerender.ts";
import type { ModuleRegistry, ResolvedApiRoute, ResolvedPrachtApp } from "./types.ts";

/**
 * What `pracht build` hands an adapter's `finalizeBuild` once `dist/` holds
 * the client bundle, the server bundle, every prerendered page, and the
 * build manifests.
 */
export interface PrachtAdapterBuildContext {
  /** The Vite root. */
  root: string;
  /** Absolute path of `dist/client`, the static output. */
  clientDir: string;
  /** Absolute path of the public directory Vite resolved. */
  publicDir: string;
  /** The public directory relative to the root, for messages. */
  publicDirLabel: string;
  /** The deploy base the build was made for (`/` or `/docs/`). */
  base: string;
  /** `pracht({ trailingSlash })`. */
  trailingSlash: "ignore" | "never" | "always";
  /** The `@pracht/cli` version running the build. */
  frameworkVersion: string;
  /**
   * The identity of this `pracht build`, the same value as the server entry's
   * `buildId`. Absent when an older `@pracht/cli` runs the build.
   */
  buildId?: string;
  /** The exports of `dist/server/server.js`. */
  serverEntry: Readonly<Record<string, unknown>>;
  /** Every prerendered page path (SSG and ISG), in build order. */
  pages: readonly string[];
  /** Prerendered page paths whose HTML was not written because the runtime renders them on demand. */
  onDemandPages: readonly string[];
  /** ISG routes and their revalidation policy, as in `dist/server/isg-manifest.json`. */
  isgManifest: Readonly<Record<string, ISGManifestEntry>>;
  /** Response headers per static path, flat (one header set per path). */
  headersManifest: Readonly<Record<string, Record<string, string>>>;
  /** Prerendered routes whose module exports `markdown`. */
  markdownRoutes: readonly string[];
  /** Markdown companions the build wrote: their URL path and their file relative to `clientDir`. */
  markdownFiles: readonly { path: string; outputPath: string }[];
  /** URL paths of the content-collection artifacts in `clientDir`. */
  contentArtifacts: readonly string[];
  /** Other HTML pages in `clientDir` served at their clean URL (OpenAPI UI, content routes). */
  staticRoutes: readonly string[];
  /** Prints a progress line (silent under `--analyze-json`). */
  log(message: string): void;
  /** Prints a warning to stderr (silent under `--analyze-json`). */
  warn(message: string): void;
}

/** What `pracht dev` knows about a request when it builds the app context. */
export interface PrachtAdapterDevRequest {
  /** The Web `Request` the framework runtime receives. */
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
  /** Registers background work with the dev server's shutdown drain. */
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * How `pracht dev` reproduces the adapter's generated entry when the
 * vite-plugin serves requests itself (every adapter without `ownsDevServer`).
 */
export interface PrachtAdapterDevOptions {
  /**
   * Vite-resolvable module exporting `createContext(args)` — the same module
   * the generated server entry imports. Loaded through Vite's SSR module graph
   * and called once per dev request.
   */
  createContextFrom?: string;
  /**
   * Shape the argument the context factory receives, so it matches what the
   * adapter passes in production. Defaults to `{ request }`.
   */
  createContextArgs?(input: PrachtAdapterDevRequest): object;
  /**
   * Vite-resolvable module exporting `configureServer(server)` — the same
   * module the generated server entry calls before `listen()`. `pracht dev`
   * calls it with its own `node:http` server on every start and restart.
   * Upgrade requests for Vite's HMR socket never reach the listeners it adds.
   */
  configureServerFrom?: string;
}

/** What the generated server entry knows when it asks an adapter for its source. */
export interface PrachtServerEntryModuleContext {
  /** The entry's `buildId`, to pass to the adapter's runtime. */
  buildId: string;
}

/** Optional formats a server entry's runtime reads. */
export interface PrachtServerEntryFeatures {
  /**
   * The headers-manifest form the runtime parses: `1` the flat form, `2` the
   * shared form (`applyHeadersManifest` reads both).
   */
  headersManifest: 1 | 2;
}

/**
 * An adapter object that bridges pracht's platform-agnostic core to a specific
 * deployment target.  Built-in adapters are provided by `@pracht/adapter-node`,
 * `@pracht/adapter-cloudflare`, and `@pracht/adapter-vercel`.  You can also
 * supply a custom adapter that conforms to this interface.
 */
export interface PrachtAdapter {
  /** A short identifier used at build time (e.g. "node", "cloudflare", "vercel"). */
  id: string;
  /**
   * Extra import statements that must appear at the top of the generated
   * `virtual:pracht/server` module.  Return an empty string if none are needed.
   */
  serverImports: string;
  /**
   * Returns the JavaScript source code appended to the generated
   * `virtual:pracht/server` module.  This is where the adapter wires up its
   * request handler or default export. `entry` is absent when an older
   * `@pracht/vite-plugin` generates the module.
   */
  createServerEntryModule(entry?: PrachtServerEntryModuleContext): string;
  /**
   * Formats the adapter's runtime reads beyond the baseline, recorded in the
   * server entry's `features` so `pracht build` writes them.
   */
  features?: Partial<PrachtServerEntryFeatures>;
  /**
   * Additional Vite plugins the adapter needs (e.g. `@cloudflare/vite-plugin`).
   * Returned plugins are appended to the plugin array returned by `pracht()`.
   */
  vitePlugins?(): Plugin[];
  /**
   * Vite plugins that can safely run in the CLI's graph-only server. These
   * plugins may provide runtime-module stubs or other metadata-only support,
   * but must not start deployment runtimes, listeners, or persistent workers.
   * When omitted, graph commands load no adapter-contributed plugins.
   */
  graphVitePlugins?(): Plugin[];
  /**
   * If true, the adapter owns dev-server request handling and the vite-plugin
   * will not install its own SSR middleware. Used when the adapter contributes
   * a Vite plugin that runs the dev server in a platform-specific runtime
   * (e.g. Cloudflare workerd via `@cloudflare/vite-plugin`).
   */
  ownsDevServer?: boolean;
  /**
   * If true, the adapter's Vite plugins define the `ssr` environment the
   * server build runs in (resolve conditions, externals, entries), so pracht
   * leaves out the generic edge settings it otherwise applies to that build.
   * Used by `@pracht/adapter-cloudflare`, whose Worker environment is the
   * server build.
   */
  ownsServerEnvironment?: boolean;
  /**
   * The parts of the generated entry `pracht dev` must reproduce: the app
   * context factory and the HTTP-server hook. Ignored when `ownsDevServer` is set, since the
   * adapter's own dev runtime then runs the generated entry.
   */
  dev?: PrachtAdapterDevOptions;
  /**
   * If true, the adapter targets an edge runtime that cannot resolve
   * dependencies from `node_modules` at runtime. The Vite plugin will set
   * `ssr.noExternal = true` for SSR builds so all dependencies are bundled
   * into the server output.
   */
  edge?: boolean;
  /**
   * Node.js builtins the edge runtime provides, as `node:` specifiers, or
   * `true` when the adapter's own Vite plugins resolve every builtin the
   * bundle imports. An edge server bundle may import these; any other builtin
   * left in it fails the build. Listed builtins are also kept external.
   * Called with the Vite root once per server build.
   */
  edgeNodeBuiltins?(root: string): Iterable<string> | true;
  /**
   * If true, the adapter produces a pure static export with no server at
   * runtime (e.g. `@pracht/adapter-static`). Production builds then define
   * `__PRACHT_STATIC_TARGET__` as `true`, which switches the client router's
   * route-state fetching from the live `x-pracht-route-state-request`
   * endpoint to the serialized `/_pracht/state/…` files that `pracht build`
   * emits. Dev servers keep the live endpoint (the flag only applies to
   * builds). Custom static targets must also expose the static artifact hooks
   * generated by `@pracht/adapter-static`; the CLI fails when a configured
   * not-found or fallback artifact cannot be rendered.
   */
  staticTarget?: boolean;
  /**
   * Turns the finished `dist/` into the platform's deploy layout (Vercel's
   * `.vercel/output`, Cloudflare's `_headers` and Worker entry). `pracht
   * build` calls it after prerendering, once, with the build's manifests.
   * Runs in Node, so it may use `node:fs`; keep that code behind a dynamic
   * import when the adapter's module is also bundled into the server.
   */
  finalizeBuild?(context: PrachtAdapterBuildContext): void | Promise<void>;
}

/** The version of {@link PrachtServerEntry} a generated entry declares as `contract`. */
export const SERVER_ENTRY_CONTRACT = 1;

/**
 * @internal The environment variable `pracht build` hands its build id to
 * the Vite plugin through, so every bundle of one run agrees on it.
 */
export const PRACHT_BUILD_ID_ENV = "PRACHT_INTERNAL_BUILD_ID";

/** @internal A new build id: sortable by time, unique per build, safe in a URL path. */
export function createBuildId(now: number = Date.now()): string {
  const random = new Uint8Array(6);
  globalThis.crypto.getRandomValues(random);
  let suffix = "";
  for (const byte of random) suffix += byte.toString(16).padStart(2, "0");
  return `${now.toString(36)}-${suffix}`;
}

/** One file `pracht({ openapi })` asks the build to write into dist/client. */
interface GeneratedArtifact {
  path?: unknown;
  outputPath?: unknown;
  content?: unknown;
}

/** A route the OpenAPI generator could not describe. */
interface GeneratedWarning {
  method?: unknown;
  path?: unknown;
  message?: unknown;
}

/**
 * What `pracht build` reads from `dist/server/server.js`, as
 * {@link readServerEntry} returns it.
 *
 * `@pracht/vite-plugin` generates these exports and each adapter's
 * `createServerEntryModule()` appends its own. Everything the build can do
 * without is optional, because server bundles from older plugin and adapter
 * releases omit exports added since.
 */
export interface PrachtServerEntry {
  /** The contract version the entry was generated for. */
  contract: typeof SERVER_ENTRY_CONTRACT;
  /** One per `pracht build`; adapters key cached output by it. */
  buildId: string;
  /** The `id` of the adapter that generated the entry. */
  adapterId: string;
  features: PrachtServerEntryFeatures;
  /** The app manifest after `resolveApp()`. */
  resolvedApp: ResolvedPrachtApp;
  /** Core's prerenderer, bundled with the same module instances as the routes. */
  prerenderApp: typeof prerenderApp;
  prerenderMarkdown?: typeof prerenderMarkdown;
  apiRoutes?: ResolvedApiRoute[];
  registry?: ModuleRegistry;
  /** @deprecated The adapter's `id`; read `adapterId`. */
  buildTarget?: string;
  staticTarget?: boolean;
  buildBase?: string;
  configuredBase?: string;
  buildTrailingSlash?: unknown;
  clientEntryUrl?: string;
  islandsEntryUrl?: string | null;
  islandsBootstrapRequired?: boolean;
  islandFiles?: unknown;
  cssManifest?: Record<string, string[]>;
  cssContentManifest?: Record<string, string>;
  jsManifest?: Record<string, string[]>;
  prerenderConcurrency?: number;
  budgets?: Record<string, string | number>;
  /** `false` only when `pracht({ markdownFiles: false })`. */
  markdownFiles?: boolean;
  /** Present only when `pracht({ llmsTxt })` is enabled. */
  generateLlmsTxt?: (overrides?: { markdownFiles?: string[] }) => string | Promise<string>;
  /** Present only when `@pracht/openapi`'s plugin is installed. */
  generatePrachtOpenApiArtifacts?: () =>
    | { artifacts?: GeneratedArtifact[]; warnings?: GeneratedWarning[] }
    | undefined
    | Promise<{ artifacts?: GeneratedArtifact[]; warnings?: GeneratedWarning[] } | undefined>;
  /** Netlify's post-build step, exported from its generated entry. */
  finalizePrachtBuild?: (context: { clientDir: string; root: string }) => unknown;
  // Static export.
  staticExportConfig?: { fallback?: string | null; fallbackHead?: unknown };
  renderStaticNotFoundHtml?: () => Promise<unknown>;
  renderStaticFallbackHtml?: (notFoundState?: { data?: unknown; error?: unknown }) => unknown;
  // Cloudflare.
  cloudflareWorkersCacheEnabled?: boolean;
}

export interface ReadServerEntryOptions {
  /** The `buildId` given to an entry generated before entries carried one. */
  legacyBuildId?: string;
}

const UPGRADE_HINT =
  "Keep @pracht/vite-plugin, @pracht/core, @pracht/cli and the adapter on matching releases.";

/**
 * Check the exports of a built `dist/server/server.js` and return them as a
 * {@link PrachtServerEntry}, with every other export kept. An entry generated
 * before the contract existed is read from its older exports (`buildTarget`,
 * `headersManifestFormat`). Throws, naming what is missing, for a module the
 * `pracht()` Vite plugin did not generate.
 */
export function readServerEntry(
  mod: object,
  options: ReadServerEntryOptions = {},
): PrachtServerEntry & Readonly<Record<string, unknown>> {
  const exports = mod as Record<string, unknown>;
  const missing: string[] = [];
  const app = exports.resolvedApp as { routes?: unknown } | null | undefined;
  if (typeof app !== "object" || app === null || !Array.isArray(app.routes)) {
    missing.push("resolvedApp");
  }
  if (typeof exports.prerenderApp !== "function") missing.push("prerenderApp()");
  if (missing.length > 0) {
    throw new Error(
      `dist/server/server.js is missing ${missing.join(" and ")}, so it was not generated by ` +
        "the pracht() Vite plugin. Build with `pracht build` (not `vite build`), keep `pracht()` " +
        "in vite.config's plugins, and keep @pracht/vite-plugin and @pracht/core on matching releases.",
    );
  }

  const legacy = exports.contract === undefined;
  if (!legacy && exports.contract !== SERVER_ENTRY_CONTRACT) {
    throw new Error(
      `dist/server/server.js declares server entry contract ${JSON.stringify(exports.contract)}, ` +
        `but this release reads contract ${SERVER_ENTRY_CONTRACT}. ${UPGRADE_HINT}`,
    );
  }

  const adapterId = legacy ? exports.buildTarget : exports.adapterId;
  const buildId = legacy ? (options.legacyBuildId ?? "legacy") : exports.buildId;
  const features = exports.features as { headersManifest?: unknown } | null | undefined;
  const invalid: string[] = [];
  if (!isNonEmptyString(adapterId)) invalid.push(legacy ? "buildTarget" : "adapterId");
  if (!isNonEmptyString(buildId)) invalid.push("buildId");
  if (
    !legacy &&
    (typeof features !== "object" ||
      features === null ||
      (features.headersManifest !== 1 && features.headersManifest !== 2))
  ) {
    invalid.push("features");
  }
  if (invalid.length > 0) {
    throw new Error(
      `dist/server/server.js has no valid ${invalid.join(", ")} export, so pracht build cannot ` +
        `tell which adapter produced it and would skip its deploy output. ${UPGRADE_HINT}`,
    );
  }

  // An adapter released before `features` existed announces the shared
  // headers-manifest form through its own `headersManifestFormat` export.
  const headersManifest =
    features?.headersManifest === 2 || exports.headersManifestFormat === 2 ? 2 : 1;

  return {
    ...(exports as Record<string, unknown>),
    contract: SERVER_ENTRY_CONTRACT,
    buildId: buildId as string,
    adapterId: adapterId as string,
    features: { headersManifest },
  } as PrachtServerEntry & Readonly<Record<string, unknown>>;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
