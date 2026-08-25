import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";
import preact from "@preact/preset-vite";
import { existsSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, resolve } from "node:path";
import { loadEnv, type Plugin, type UserConfig } from "vite";
import {
  isPrachtClientModuleId,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";

import type { RenderMode } from "@pracht/core";
import { PRACHT_GRAPH_ONLY_ENV } from "@pracht/core/server";
import { createEnvSafetyPlugin, PUBLIC_ENV_PREFIX, SERVER_ENV_MODULE_ID } from "./env-safety.ts";
import { createClientModulePrefreshPlugin } from "./client-module-prefresh.ts";
import { reachesRouteHintedModule } from "./head-hint-reload.ts";
import { sendRouteDataStale } from "./route-data-stale.ts";
import { sendServerOnlyFullReload } from "./hot-update-reload.ts";
import {
  PRACHT_CAPABILITIES_MODULE_ID,
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_DEV_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  PRACHT_WEBMCP_MODULE_ID,
  isCapabilitiesModule,
  isClientModule,
  isDevModule,
  isIslandsClientModule,
  isServerModule,
  isWebmcpModule,
} from "./plugin-assets.ts";
import {
  createPrachtCapabilitiesClientModuleSource,
  createPrachtWebmcpModuleSource,
  hasAgentSurface,
  hasWebmcpCapabilities,
  resolveCapabilityModulePaths,
} from "./plugin-capabilities.ts";
import {
  clearPagesAppSourceCache,
  createPrachtClientModuleSource,
  createPrachtDevModuleSource,
  createPrachtIslandsClientModuleSource,
  createRouteHeadersHintsForVirtualModules,
  createRouteHeadHintsForVirtualModules,
  createRouteLoaderHintsForVirtualModules,
  createServerLoaderHintsForHotUpdates,
  createPrachtServerModuleSource,
} from "./plugin-codegen.ts";
import {
  createDevCssInjectionMiddleware,
  createOwnedDevEntryMiddleware,
  createDevSSRMiddleware,
  injectDevCssForPath,
} from "./plugin-dev-ssr.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";
import {
  DEFAULT_ROUTE_EXTENSIONS,
  extensionGlob,
  withAdditionalExtensions,
} from "./route-extensions.ts";

export type { RenderMode };
export type { PrachtAdapter } from "./plugin-adapter.ts";
export type {
  LlmsTxtSection,
  PrachtClientOptions,
  PrachtLlmsTxtOptions,
  PrachtPluginOptions,
} from "./plugin-options.ts";
export {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
  createPrachtRegistryModuleSource,
} from "./plugin-codegen.ts";
export {
  createEnvSafetyPlugin,
  formatEnvLeakError,
  PUBLIC_ENV_PREFIX,
  scanCodeForEnvLeaks,
  VITE_BUILTIN_ENV_VARS,
  type EnvLeakReference,
  type EnvSafetyOptions,
} from "./env-safety.ts";
export {
  createPrachtCapabilitiesClientModuleSource,
  createPrachtWebmcpModuleSource,
  extractCapabilities,
} from "./plugin-capabilities.ts";
export {
  PRACHT_CAPABILITIES_MODULE_ID,
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  PRACHT_WEBMCP_MODULE_ID,
};

export function pracht(options: PrachtPluginOptions = {}): Plugin[] {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  let root = process.cwd();
  let routeFileDirs: string[] = [];
  let clientRouteHeadHints: Record<string, boolean> = {};
  let clientRouteHeadersHints: Record<string, boolean> = {};
  let clientRouteLoaderHints: Record<string, boolean> = {};
  let serverRouteLoaderHints: Record<string, true> = {};
  const routeFileExtensions = withAdditionalExtensions(
    DEFAULT_ROUTE_EXTENSIONS,
    resolved.additionalExtensions,
  );
  let capabilityModulePaths = new Set<string>();

  if (isPagesMode && options.appFile) {
    console.warn(
      "[pracht] Both `pagesDir` and `appFile` are set. `pagesDir` takes precedence — `appFile` will be ignored.",
    );
  }

  let isBuild = false;
  let base = "/";
  let configuredBase: string | undefined;

  const prachtPlugin: Plugin = {
    name: "pracht",
    enforce: "pre",

    config(_config, env) {
      const isEdge = resolved.adapter.edge === true;
      const isSSRBuild = env.isSsrBuild;

      // Emit the islands bootstrap as its own client entry so islands-mode
      // routes can load it without the full client runtime. WebMCP also owns
      // this entry on islands routes, including responses that render no
      // island components and apps that have no islands directory.
      const configRoot = _config.root ?? process.cwd();
      const wantsIslandsEntry =
        env.command === "build" &&
        !isSSRBuild &&
        (existsSync(resolveConfigPath(configRoot, resolved.islandsDir)) ||
          hasWebmcpCapabilities(resolved, configRoot));

      // `publicEnv` needs every PRACHT_PUBLIC_ key, but reading the whole
      // `import.meta.env` object to enumerate them makes Vite inline *all*
      // exposed vars — VITE_ ones included — into the client bundle. Injecting
      // the pre-filtered subset keeps that enumeration public-only.
      const envDir = _config.envDir ? resolve(configRoot, _config.envDir) : configRoot;
      const publicEnvDefine = JSON.stringify(loadEnv(env.mode, envDir, PUBLIC_ENV_PREFIX));

      // Apps that register no capabilities and configure no agents get the
      // capability + Web Bot Auth runtimes dead-code-eliminated out of the
      // server bundle instead of shipping them unused. Build only: `config()`
      // runs once, and in dev the manifest is edited live — a stale `false`
      // would make a freshly added capability 404 until the server restarts.
      const agentSurfaceDefine =
        env.command === "build" ? String(hasAgentSurface(resolved, configRoot)) : "true";

      // Static-export builds bake the flag into both bundles: the client
      // router switches to `/_pracht/state/…` files and the server bundle's
      // prerender pass emits matching preload URLs. Dev always serves the
      // live route-state endpoint, so the flag stays false there.
      const staticTargetDefine = String(
        env.command === "build" && resolved.adapter.staticTarget === true,
      );

      // Declared by the app rather than derived from the manifest, so the
      // same flags apply in dev — a feature switched off must behave the same
      // in `pracht dev` as it does in the build that ships.
      const clientFeatureDefines = {
        __PRACHT_CLIENT_PREFETCH__: String(resolved.client.prefetch),
      };

      return {
        appType: "custom" as const,
        // Expose PRACHT_PUBLIC_-prefixed vars on import.meta.env (client and
        // server) while keeping Vite's default VITE_ prefix working.
        envPrefix: ["VITE_", PUBLIC_ENV_PREFIX],
        resolve: {
          // Preact's hook state lives in module-level `options` on the Preact
          // instance that rendered the tree. A second copy in the graph — from
          // hoisting, a linked package, or a UI library with its own Preact
          // dependency — makes any hook-using component die during SSR with
          // `Cannot read properties of undefined (reading '__H')`, which names
          // neither the component nor the cause. Collapsing the family onto one
          // copy is the only sane default.
          dedupe: PREACT_DEDUPE,
        },
        define: {
          __PRACHT_PUBLIC_ENV__: publicEnvDefine,
          __PRACHT_AGENT_SURFACE__: agentSurfaceDefine,
          __PRACHT_STATIC_TARGET__: staticTargetDefine,
          ...clientFeatureDefines,
        },
        // The vendor split only makes sense for the client bundle; SSR builds
        // that disable code splitting (e.g. webworker targets) reject
        // `manualChunks` outright.
        ...(isSSRBuild
          ? {}
          : {
              build: {
                rollupOptions: {
                  ...(wantsIslandsEntry ? { input: [PRACHT_ISLANDS_CLIENT_MODULE_ID] } : {}),
                  output: {
                    manualChunks(id: string) {
                      if (
                        id.includes("node_modules/preact") ||
                        id.includes("node_modules/preact-suspense")
                      ) {
                        return "vendor";
                      }
                    },
                  },
                },
              },
            }),
        ...(isEdge && isSSRBuild
          ? {
              ssr: {
                noExternal: true,
                // Edge server bundles run outside Node; without this the SSR
                // build emits Node-flavored CJS interop
                // (`createRequire(import.meta.url)`) that workerd rejects at
                // startup.
                target: "webworker" as const,
              },
              // `ssr.target: "webworker"` applies the client condition list,
              // so a package's `browser` entry wins in a server bundle. Correct
              // that resolution without enabling `keepProcessEnv`: preserving
              // raw `process.env` reads across the entire noExternal bundle
              // would make unguarded dependency code throw on Cloudflare.
              environments: {
                ssr: {
                  resolve: {
                    // The client list resolved `@pracht/core/env/server` to the
                    // stub that exists to make a *client* import fail loudly.
                    // `worker` goes first so worker-aware packages (this one
                    // included) can answer an edge server build with server
                    // code; `browser` stays as the fallback that keeps
                    // browser-only dependencies resolvable.
                    conditions: ["worker", "module", "browser", "development|production"],
                    // Rolldown's generated interop runtime references
                    // `node:module` while deciding whether a helper is needed.
                    // Edge builds tree-shake that helper, but Vite otherwise
                    // warns that it auto-externalized a Node builtin. Marking
                    // it explicitly keeps successful Worker builds quiet;
                    // the edge-runtime-safety plugin still fails the build if
                    // this or any other Node import survives tree shaking.
                    external: ["node:module"],
                  },
                },
              },
              build: {
                rollupOptions: {
                  // Platform-scheme modules only exist inside the target
                  // runtime and must stay runtime imports.
                  external: [/^cloudflare:/],
                },
              },
            }
          : {}),
        // Dev needs this as badly as the build does. `pracht dev` renders
        // through `ssrLoadModule("@pracht/core/server")`, which Vite always
        // inlines, while the app's own `import { useLocation } from
        // "@pracht/core"` is a bare node_modules id that Vite externalizes to
        // a native Node import. That is two copies of the runtime in one
        // render: the document is rendered with the inlined copy's
        // `RouteDataContext.Provider`, and every app component reads the
        // externalized copy's context — a different `createContext()` object,
        // so `useLocation()`/`useParams()`/`useRouteData()` all fall back to
        // their empty defaults server-side and the page hydrates into a
        // mismatch. Workspace-linked installs (the examples here) are inlined
        // either way and never saw it; a published install always does.
        ...((!isEdge && isSSRBuild) || env.command === "serve"
          ? {
              ssr: {
                noExternal: [PRACHT_SSR_NO_EXTERNAL],
              },
            }
          : {}),
      };
    },

    configResolved(config) {
      assertSafeRootAbsoluteDeployBase(config.base);
      root = config.root;
      isBuild = config.command === "build";
      base = config.base;
      routeFileDirs = computeRouteFileDirs(root, resolved);
      capabilityModulePaths = new Set(
        resolveCapabilityModulePaths(resolved, root).map(canonicalFilePath),
      );
    },

    resolveId(id, importer, resolveIdOptions) {
      if (isIslandsClientModule(id)) return PRACHT_ISLANDS_CLIENT_MODULE_ID;
      if (isClientModule(id)) return PRACHT_CLIENT_MODULE_ID;
      if (isDevModule(id)) return PRACHT_DEV_MODULE_ID;
      if (isServerModule(id)) return PRACHT_SERVER_MODULE_ID;
      if (isCapabilitiesModule(id)) return PRACHT_CAPABILITIES_MODULE_ID;
      if (isWebmcpModule(id)) return PRACHT_WEBMCP_MODULE_ID;

      // Fail loudly when client code imports the server-only env entry.
      // `scan` resolutions (dep optimizer discovery) are skipped because the
      // scanner does not run the client transform that strips server-only
      // exports (and their now-unused imports) from route files.
      if (
        id === SERVER_ENV_MODULE_ID &&
        !resolveIdOptions?.ssr &&
        !(resolveIdOptions as { scan?: boolean } | undefined)?.scan
      ) {
        throw new Error(
          `[pracht] ${JSON.stringify(SERVER_ENV_MODULE_ID)} was imported by ` +
            `${JSON.stringify(importer ?? "unknown module")} in client code. serverEnv is ` +
            "server-only — read it inside loaders, middleware, or API routes, or use " +
            `publicEnv (PRACHT_PUBLIC_-prefixed variables) from "@pracht/core" instead.`,
        );
      }

      return null;
    },

    load(id) {
      if (isIslandsClientModule(id)) {
        return createPrachtIslandsClientModuleSource(resolved, { root });
      }
      if (isClientModule(id)) {
        clientRouteHeadHints = createRouteHeadHintsForVirtualModules(resolved, root);
        clientRouteHeadersHints = createRouteHeadersHintsForVirtualModules(resolved, root);
        clientRouteLoaderHints = createRouteLoaderHintsForVirtualModules(resolved, root);
        serverRouteLoaderHints = createServerLoaderHintsForHotUpdates(resolved, root);
        return createPrachtClientModuleSource(resolved, { root });
      }
      if (isDevModule(id)) {
        return createPrachtDevModuleSource(resolved, { root, base });
      }
      if (isServerModule(id)) {
        return createPrachtServerModuleSource(resolved, { root, isBuild, base, configuredBase });
      }
      if (isCapabilitiesModule(id)) {
        return createPrachtCapabilitiesClientModuleSource(resolved, { root });
      }
      if (isWebmcpModule(id)) {
        return createPrachtWebmcpModuleSource(resolved, { root });
      }
      return null;
    },

    transform(code, id) {
      // Transform () => import("./path") to "./path" in the app manifest file.
      // This lets users write import() for IDE click-to-navigate while keeping
      // the framework's string-based file resolution intact.
      const appFileAbs = canonicalFilePath(resolveConfigPath(root, resolved.appFile));
      const normalizedId = canonicalFilePath(id.split("?")[0]);
      if (normalizedId !== appFileAbs) return null;

      const withStringModuleRefs = code.replace(
        /\(\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/g,
        "$1$2$1",
      );
      const transformed = rewriteManifestCoreImports(withStringModuleRefs);
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },

    configureServer(server) {
      if (isPagesMode) {
        watchPagesDirectory(server, resolved, root);
      }

      if (resolved.adapter.ownsDevServer) {
        server.middlewares.use(createOwnedDevEntryMiddleware(server));
        server.middlewares.use(createDevCssInjectionMiddleware(server));
        return;
      }
      return () => {
        server.middlewares.use(
          createDevSSRMiddleware(server, {
            llmsTxt: !!resolved.llmsTxt,
            maxBodySize: resolved.maxBodySize,
          }),
        );
      };
    },

    async transformIndexHtml(html, context) {
      if (isBuild || !context.server || !html.includes("</head>")) return html;

      try {
        return await injectDevCssForPath(context.server, context.path, html);
      } catch {
        // The original request path owns development error reporting. CSS
        // discovery must not replace its overlay or response with a second
        // module-loading failure from this HTML transform.
        return html;
      }
    },

    handleHotUpdate({ file, modules = [], server }) {
      const serverRoot = toPosixPath(server.config.root);
      const normalizedFile = toPosixPath(file);
      const relative = normalizedFile.startsWith(serverRoot)
        ? normalizedFile.slice(serverRoot.length)
        : normalizedFile;
      const changesRouteHeadSource = isPagesMode
        ? relative.startsWith(resolved.pagesDir)
        : relative.startsWith(resolved.routesDir) || relative.startsWith(resolved.shellsDir);
      const changesRouteLoaderSource = isPagesMode
        ? relative.startsWith(resolved.pagesDir)
        : relative.startsWith(resolved.routesDir);
      const previousServerRouteLoaderHints = serverRouteLoaderHints;
      if (!isPagesMode && relative.startsWith(resolved.serverDir)) {
        try {
          serverRouteLoaderHints = createServerLoaderHintsForHotUpdates(resolved, root);
        } catch {
          // A transient read failure must not erase the last known loader
          // ownership. The server-only fallback still reloads an ordinary data
          // module edit; retaining both snapshots below also catches removals
          // from a client-reachable module.
        }
      }
      const loaderDependencyHints = {
        ...clientRouteLoaderHints,
        ...previousServerRouteLoaderHints,
        ...serverRouteLoaderHints,
      };
      const changesRouteHeadDependency = reachesRouteHintedModule(
        modules,
        serverRoot,
        clientRouteHeadHints,
        { startAtImporters: changesRouteHeadSource },
      );
      const changesRouteHeadersDependency = reachesRouteHintedModule(
        modules,
        serverRoot,
        clientRouteHeadersHints,
        { startAtImporters: changesRouteHeadSource },
      );
      const changesRouteLoaderDependency = reachesRouteHintedModule(
        modules,
        serverRoot,
        loaderDependencyHints,
        { startAtImporters: changesRouteLoaderSource },
      );
      let shouldReloadClientEntry = changesRouteHeadDependency || changesRouteHeadersDependency;
      let clientHeadModule: ReturnType<typeof server.moduleGraph.getModuleById>;
      if (changesRouteHeadSource || changesRouteHeadDependency || changesRouteHeadersDependency) {
        clientHeadModule = server.moduleGraph.getModuleById(PRACHT_CLIENT_MODULE_ID);
      }
      if (changesRouteHeadSource) {
        const previousHint = clientRouteHeadHints[relative] === true;
        try {
          const nextHints = createRouteHeadHintsForVirtualModules(resolved, root);
          // Only a *transition* changes what the virtual client entry bakes:
          // the hint is "does this module export head", and the client router
          // reads it to decide whether a navigation must fetch route state.
          // Reloading whenever a head-bearing route is touched — the old
          // behaviour — meant every edit to such a route lost client state,
          // and most routes export head. Editing the head *body* still needs a
          // manual refresh to show in the document, which is the same rule
          // pracht already applies to client-side navigation: head metadata is
          // server-rendered and does not follow the router.
          shouldReloadClientEntry ||= previousHint !== (nextHints[relative] === true);
          clientRouteHeadHints = nextHints;
        } catch {
          // A file can be observed while its editor is replacing it. Reloading
          // is the safe fallback because the previous or next module may own
          // server-generated head state that cannot be patched in the browser.
          shouldReloadClientEntry = true;
        }
      } else if (changesRouteHeadDependency && clientHeadModule) {
        // A dependency such as src/fonts.ts is part of normal client HMR, but
        // its generated style/preload state only exists in the virtual entry.
        server.moduleGraph.invalidateModule(clientHeadModule);
      }

      if (changesRouteHeadSource) {
        const previouslyHadHeaders = clientRouteHeadersHints[relative] === true;
        try {
          const nextHints = createRouteHeadersHintsForVirtualModules(resolved, root);
          // A route-state fetch cannot update document response headers such
          // as CSP or Cache-Control. Any edit to a module that owns headers —
          // including adding or removing the export — needs a real navigation.
          shouldReloadClientEntry ||= previouslyHadHeaders || nextHints[relative] === true;
          clientRouteHeadersHints = nextHints;
        } catch {
          shouldReloadClientEntry = true;
        }
      }

      if (changesRouteLoaderSource) {
        const previousHint = clientRouteLoaderHints[relative] === true;
        try {
          const nextHints = createRouteLoaderHintsForVirtualModules(resolved, root);
          // Like head presence, loader presence is baked into the browser's
          // resolved route table. The custom stale-data event refreshes only
          // the active route; a transition must reload the client entry so a
          // later navigation does not keep using the old fetch decision.
          shouldReloadClientEntry ||= previousHint !== (nextHints[relative] === true);
          clientRouteLoaderHints = nextHints;
        } catch {
          shouldReloadClientEntry = true;
        }
      }

      if (isPagesMode && relative.startsWith(resolved.pagesDir)) {
        clearPagesAppSourceCache();
        invalidateVirtualModules(server);
        const sentFullReload = sendServerOnlyFullReload(server, file);
        if (!sentFullReload && !shouldReloadClientEntry) {
          sendRouteDataStale(server);
        }
        if (!sentFullReload && shouldReloadClientEntry && clientHeadModule) {
          // Invalidating a virtual module only clears Vite's transform cache;
          // it does not add that module to this HMR update. Returning the root
          // client module makes Vite reload the document and regenerate fonts.
          return [...new Set([...modules, clientHeadModule])];
        }
        return;
      }

      if (!isPagesMode && relative === resolved.appFile) {
        server.restart();
        return [];
      }

      const dirs = [
        resolved.routesDir,
        resolved.shellsDir,
        resolved.middlewareDir,
        resolved.apiDir,
        resolved.serverDir,
        resolved.islandsDir,
        resolved.capabilitiesDir,
      ];
      if (dirs.some((dir) => relative.startsWith(dir))) {
        const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
        const devMod = server.moduleGraph.getModuleById(PRACHT_DEV_MODULE_ID);
        if (devMod) server.moduleGraph.invalidateModule(devMod);
        // Route loader hints and route/shell head hints are baked into the
        // generated client module. Regenerate it when either source changes.
        if (relative.startsWith(resolved.routesDir) || relative.startsWith(resolved.shellsDir)) {
          const clientMod = server.moduleGraph.getModuleById(PRACHT_CLIENT_MODULE_ID);
          if (clientMod) server.moduleGraph.invalidateModule(clientMod);
        }
        if (relative.startsWith(resolved.islandsDir)) {
          const islandsMod = server.moduleGraph.getModuleById(PRACHT_ISLANDS_CLIENT_MODULE_ID);
          if (islandsMod) server.moduleGraph.invalidateModule(islandsMod);
        }
        if (relative.startsWith(resolved.capabilitiesDir)) {
          // Exposure metadata and schemas are baked into the generated
          // browser modules — regenerate them alongside the server module.
          // The client entries embed the WebMCP bootstrap conditionally on
          // `hasWebmcpCapabilities()`, so they must regenerate too when a
          // capability adds or drops webmcp exposure.
          for (const moduleId of [
            PRACHT_CAPABILITIES_MODULE_ID,
            PRACHT_WEBMCP_MODULE_ID,
            PRACHT_CLIENT_MODULE_ID,
            PRACHT_ISLANDS_CLIENT_MODULE_ID,
          ]) {
            const capabilityMod = server.moduleGraph.getModuleById(moduleId);
            if (capabilityMod) server.moduleGraph.invalidateModule(capabilityMod);
          }
        }
      }

      const sentFullReload = sendServerOnlyFullReload(server, file);
      if (!sentFullReload && shouldReloadClientEntry && clientHeadModule) {
        return [...new Set([...modules, clientHeadModule])];
      }
      // Fast Refresh patches the component and stops there, which is right for
      // the half of a route module that runs in the browser and wrong for the
      // half that does not: `loader`, `head`, and `getStaticPaths`
      // are stripped out of the browser copy, so an edit to any of them leaves
      // the page holding data or font state the server would no longer send.
      // Reloading was what used to deliver it. Tell the client to re-fetch
      // route state instead — same freshness, without the state loss.
      if (!sentFullReload && (changesRouteHeadSource || changesRouteLoaderDependency)) {
        sendRouteDataStale(server);
      }
    },
  };

  // Vite normalizes document-relative bases to `/` for SSR builds. Capture
  // the fully merged, user-authored value after ordinary config hooks have
  // run so a plugin-provided `base: "./"` cannot evade static-export
  // validation.
  const configuredBasePlugin: Plugin = {
    name: "pracht:configured-base",
    config: {
      order: "post",
      handler(config) {
        configuredBase = typeof config.base === "string" ? config.base : undefined;
      },
    },
  };

  const clientModuleTransformPlugin: Plugin = {
    name: "pracht:client-module-transform",
    enforce: "post",

    transform(code, id, transformOptions) {
      // Capability modules are server-only: they hold `run()` and everything it
      // imports (database clients, secrets, internal stores). Nothing strips
      // them the way route loaders are stripped, so a component importing one
      // directly would ship the whole contract and its dependencies to every
      // visitor. The generated browser projection exists precisely so that
      // never has to happen — fail the build and point at it.
      if (!transformOptions?.ssr && isCapabilityModule(id, capabilityModulePaths)) {
        throw new Error(
          `[pracht] Capability module ${JSON.stringify(toPosixPath(id))} was imported by client ` +
            "code. Capability modules are server-only — their run() implementation and its " +
            "imports would be bundled for every visitor. Call the capability instead: " +
            '`callCapability`/`capabilities` from "virtual:pracht/capabilities" in the browser, ' +
            'or `invokeCapability` from "@pracht/core/server" in loaders, middleware, and API routes.',
        );
      }

      const shouldStrip =
        isPrachtClientModuleId(id) ||
        (!transformOptions?.ssr && isRouteOrShellFile(id, routeFileDirs, routeFileExtensions));
      if (!shouldStrip) return null;

      const transformed = stripServerOnlyExportsForClient(code, id);
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },
  };

  const edgeRuntimeSafetyPlugin: Plugin | null = resolved.adapter.edge
    ? createEdgeRuntimeSafetyPlugin()
    : null;

  const optimizeDepsEntriesPlugin: Plugin = {
    name: "pracht:optimize-deps-entries",
    enforce: "post",

    config(config) {
      return withPrachtOptimizeDepsEntries(
        config,
        resolved,
        createPrachtOptimizeDepsInclude(config.root ?? process.cwd()),
      );
    },
  };

  const precompilePlugin = resolved.precompileSsrJsx
    ? preactSsrPrecompile({
        ...(resolved.precompileSsrJsx === true ? {} : resolved.precompileSsrJsx),
        ssrOnly: true,
      })
    : null;

  const preactPlugins = preact();
  // Ordered right after `clientModuleTransformPlugin` on purpose: prefresh has
  // to see the module with its server-only exports already stripped.
  const clientModulePrefreshPlugin = createClientModulePrefreshPlugin(preactPlugins, {
    isRouteOrShellModule: (id) => isRouteOrShellFile(id, routeFileDirs, routeFileExtensions),
  });

  const plugins: Plugin[] = [
    ...(precompilePlugin ? [precompilePlugin] : []),
    ...preactPlugins,
    prachtPlugin,
    configuredBasePlugin,
    clientModuleTransformPlugin,
    ...(clientModulePrefreshPlugin ? [clientModulePrefreshPlugin] : []),
    ...(edgeRuntimeSafetyPlugin ? [edgeRuntimeSafetyPlugin] : []),
    createEnvSafetyPlugin(resolved.envSafety),
  ];

  // Graph-only mode: the CLI's short-lived Vite server (`pracht inspect`,
  // `verify`, `doctor`, `plan`, `report`, `typegen`) evaluates adapter-neutral
  // metadata and closes immediately. Deployment runtimes can own resources
  // that outlive `server.close()`, so adapters must opt plugins into this mode
  // explicitly through the graph-safe hook.
  const adapterPlugins = isGraphOnlyMode()
    ? resolved.adapter.graphVitePlugins?.()
    : resolved.adapter.vitePlugins?.();
  if (adapterPlugins?.length) {
    plugins.push(...adapterPlugins);
  }
  plugins.push(optimizeDepsEntriesPlugin);

  return plugins;
}

function assertSafeRootAbsoluteDeployBase(base: string | undefined): void {
  if (typeof base !== "string" || !base.startsWith("/") || base.startsWith("//")) return;

  let safe = !base.includes("?") && !base.includes("#");
  if (safe) {
    try {
      const segments = base.split("/");
      safe = segments.every((segment, index) => {
        // The leading and trailing slash produce the two expected empty
        // components. Any other empty component represents a repeated slash,
        // which filesystem-backed adapters cannot preserve portably.
        if (segment === "" && index !== 0 && index !== segments.length - 1) return false;
        const decoded = decodeURIComponent(segment);
        if (decoded === "." || decoded === "..") return false;
        for (const character of decoded) {
          const codePoint = character.codePointAt(0);
          if (
            character === "/" ||
            character === "\\" ||
            codePoint === 0 ||
            (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f))
          ) {
            return false;
          }
        }
        return true;
      });
    } catch {
      safe = false;
    }
  }

  if (!safe) {
    throw new Error(
      `[pracht] Vite \`base\` is set to ${JSON.stringify(base)}, but root-absolute deploy bases must contain safe URL segments. ` +
        "Repeated slashes, malformed escapes, and segments that decode to a path separator, `.`, `..`, NUL, or another control character are not allowed.",
    );
  }
}

function isGraphOnlyMode(): boolean {
  return process.env[PRACHT_GRAPH_ONLY_ENV] === "1";
}

function createEdgeRuntimeSafetyPlugin(): Plugin {
  let isSsrBuild = false;

  return {
    name: "pracht:edge-runtime-safety",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      isSsrBuild = !!config.build.ssr;
    },

    generateBundle(_options, bundle) {
      // Prefer Vite's environment identity when available and retain the
      // config flag for direct Rollup/plugin tests and older Vite contexts.
      const consumer = this.environment?.config?.consumer;
      const isServerBundle = consumer ? consumer === "server" : isSsrBuild;
      if (!isServerBundle) return;

      const survivors: Array<{ chunk: string; specifier: string }> = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "chunk") continue;
        for (const specifier of collectNodeBuiltinImports(this.parse(output.code))) {
          survivors.push({ chunk: fileName, specifier });
        }
      }

      if (survivors.length === 0) return;
      this.error(
        [
          "[pracht] Edge server bundle retains Node.js builtin imports that are unavailable at runtime:",
          ...survivors.map(({ chunk, specifier }) => `  - ${specifier} in ${chunk}`),
          "Remove the Node-only dependency or move that route to a Node deployment target.",
        ].join("\n"),
      );
    },
  };
}

function collectNodeBuiltinImports(program: unknown): Set<string> {
  const imports = new Set<string>();

  function sourceValue(node: unknown): string | null {
    if (!node || typeof node !== "object" || !("value" in node)) return null;
    return typeof node.value === "string" ? node.value : null;
  }

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== "object") return;

    const record = node as Record<string, unknown>;
    const type = record.type;
    if (
      type === "ImportDeclaration" ||
      type === "ExportAllDeclaration" ||
      type === "ExportNamedDeclaration" ||
      type === "ImportExpression"
    ) {
      const specifier = sourceValue(record.source);
      if (specifier && isBuiltin(specifier)) imports.add(specifier);
    } else if (type === "CallExpression") {
      const callee = record.callee as Record<string, unknown> | undefined;
      const isImport = callee?.type === "Import";
      const isRequire = callee?.type === "Identifier" && callee.name === "require";
      if (isImport || isRequire) {
        const specifier = sourceValue((record.arguments as unknown[] | undefined)?.[0]);
        if (specifier && isBuiltin(specifier)) imports.add(specifier);
      }
    }

    for (const value of Object.values(record)) visit(value);
  }

  visit(program);
  return imports;
}

const MANIFEST_CORE_IMPORTS = new Set(["defineApp", "group", "route", "timeRevalidate"]);

function rewriteManifestCoreImports(code: string): string {
  return code.replace(
    /import\s+(type\s+)?\{([^}]+)\}\s+from\s+(['"])@pracht\/core\3/g,
    (match, typeKeyword: string | undefined, specifiers: string, quote: string) => {
      const valueImports = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .filter((specifier) => !specifier.startsWith("type "))
        .map((specifier) => specifier.split(/\s+as\s+/)[0]?.trim())
        .filter(Boolean);

      if (!typeKeyword && valueImports.some((specifier) => !MANIFEST_CORE_IMPORTS.has(specifier))) {
        return match;
      }

      return `import ${typeKeyword ?? ""}{${specifiers}} from ${quote}@pracht/core/manifest${quote}`;
    },
  );
}

// Client-side dependencies the scanner can never discover on its own: the
// virtual client entry imports `@pracht/core/client`, and the plugin's
// transforms inject `@pracht/core/manifest` imports after scanning. Without
// pre-bundling them, the first browser hit triggers a re-optimize + full
// reload that aborts in-flight module requests mid-hydration. `@pracht/core`
// is included alongside them so user imports share the same optimized chunk
// graph (a source copy next to a pre-bundled client copy splits the runtime
// context in two).
const PRACHT_OPTIMIZE_DEPS_INCLUDE = [
  "@pracht/core",
  "@pracht/core/client",
  "@pracht/core/islands-client",
  "@pracht/core/manifest",
];

// Package names only: Vite matches `dedupe` against the bare package id, so a
// subpath entry such as `preact/hooks` would never match. Deduping `preact`
// already covers every subpath, since they all resolve through that package —
// and with them the `options` object `preact/hooks` mutates, which is the
// state a second copy splits in two.
const PREACT_DEDUPE = ["preact", "preact-render-to-string"];
// Published Pracht packages live under node_modules, where Vite would
// externalize them from Node/static SSR builds. Keep them in the bundle so
// compile-time values such as import.meta.env.BASE_URL are transformed and
// module-scoped request state is shared with generated app code.
const PRACHT_SSR_NO_EXTERNAL = /^@pracht\//;

function createPrachtOptimizeDepsInclude(root: string): string[] {
  // Vite deliberately leaves workspace-linked packages un-optimized (they are
  // treated as source). Force-including only some `@pracht/core` entries in
  // that setup would create a pre-bundled copy of the runtime next to the
  // linked source copy and split the router context in two — so the includes
  // only apply when the app resolves `@pracht/core` from node_modules.
  try {
    const require = createRequire(join(root, "package.json"));
    const corePackagePath = toPosixPath(require.resolve("@pracht/core/package.json"));
    if (!corePackagePath.includes("/node_modules/")) return [];
    return PRACHT_OPTIMIZE_DEPS_INCLUDE;
  } catch {
    return [];
  }
}

function withPrachtOptimizeDepsEntries(
  config: UserConfig,
  resolved: ResolvedPrachtPluginOptions,
  prachtInclude: string[],
): UserConfig {
  const prachtEntries = createPrachtOptimizeDepsEntries(resolved, config.optimizeDeps?.extensions);
  const environments = Object.fromEntries(
    Object.entries(config.environments ?? {}).map(([name, environment]) => [
      name,
      {
        optimizeDeps: {
          entries: mergeOptimizeDepsEntries(
            environment.optimizeDeps?.entries,
            createPrachtOptimizeDepsEntries(
              resolved,
              environment.optimizeDeps?.extensions ?? config.optimizeDeps?.extensions,
            ),
          ),
        },
      },
    ]),
  );

  return {
    optimizeDeps: {
      entries: mergeOptimizeDepsEntries(config.optimizeDeps?.entries, prachtEntries),
      ...(prachtInclude.length > 0
        ? { include: mergeOptimizeDepsEntries(config.optimizeDeps?.include, prachtInclude) }
        : {}),
    },
    ...(Object.keys(environments).length > 0 ? { environments } : {}),
  };
}

const VITE_SCANNABLE_ROUTE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".mjs",
  ".cts",
  ".cjs",
  // Vite's dependency scanner extracts module scripts from these formats.
  ".vue",
  ".svelte",
  ".astro",
  ".imba",
]);

function createPrachtOptimizeDepsEntries(
  resolved: ResolvedPrachtPluginOptions,
  optimizerExtensions: string[] | undefined,
): string[] {
  const scriptExtensions = "{ts,tsx,js,jsx}";
  const explicitlyScannable = new Set(optimizerExtensions ?? []);
  const routeExtensions = extensionGlob(
    [...new Set([...DEFAULT_ROUTE_EXTENSIONS, ...resolved.additionalExtensions])].filter(
      (extension) =>
        VITE_SCANNABLE_ROUTE_EXTENSIONS.has(extension) || explicitlyScannable.has(extension),
    ),
  );
  const apiDir = toOptimizeDepsEntry(resolved.apiDir);
  const apiEntries = [`${apiDir}/**/*.{ts,js,tsx,jsx}`, `!${apiDir}/**/*.d.ts`];
  const entries = resolved.pagesDir
    ? [
        `${toOptimizeDepsEntry(resolved.pagesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        ...apiEntries,
        `${toOptimizeDepsEntry(resolved.serverDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.islandsDir)}/**/*.${scriptExtensions}`,
      ]
    : [
        toOptimizeDepsEntry(resolved.appFile),
        `${toOptimizeDepsEntry(resolved.routesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.shellsDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        ...apiEntries,
        `${toOptimizeDepsEntry(resolved.serverDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.islandsDir)}/**/*.${scriptExtensions}`,
        `${toOptimizeDepsEntry(resolved.capabilitiesDir)}/**/*.{ts,js,tsx,jsx}`,
      ];

  return [...new Set(entries.filter(Boolean))];
}

function mergeOptimizeDepsEntries(
  userEntries: string | string[] | undefined,
  prachtEntries: string[],
): string[] {
  const normalizedUserEntries = Array.isArray(userEntries)
    ? userEntries
    : userEntries
      ? [userEntries]
      : [];
  return [...new Set([...normalizedUserEntries, ...prachtEntries])];
}

function toOptimizeDepsEntry(path: string): string {
  return toPosixPath(path).replace(/^\.\//, "").replace(/^\//, "").replace(/\/$/, "");
}

function watchPagesDirectory(
  server: import("vite").ViteDevServer,
  resolved: ResolvedPrachtPluginOptions,
  root: string,
): void {
  const abs = resolveConfigPath(root, resolved.pagesDir);
  server.watcher.on("add", (f: string) => {
    if (toPosixPath(f).startsWith(toPosixPath(abs))) {
      clearPagesAppSourceCache();
      server.restart();
    }
  });
  server.watcher.on("unlink", (f: string) => {
    if (toPosixPath(f).startsWith(toPosixPath(abs))) {
      clearPagesAppSourceCache();
      server.restart();
    }
  });
}

function invalidateVirtualModules(server: import("vite").ViteDevServer): void {
  const clientMod = server.moduleGraph.getModuleById(PRACHT_CLIENT_MODULE_ID);
  const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
  const devMod = server.moduleGraph.getModuleById(PRACHT_DEV_MODULE_ID);
  if (clientMod) server.moduleGraph.invalidateModule(clientMod);
  if (serverMod) server.moduleGraph.invalidateModule(serverMod);
  if (devMod) server.moduleGraph.invalidateModule(devMod);
}

function computeRouteFileDirs(root: string, resolved: ResolvedPrachtPluginOptions): string[] {
  const dirs = resolved.pagesDir ? [resolved.pagesDir] : [resolved.routesDir, resolved.shellsDir];
  return dirs.map((dir) => canonicalFilePath(resolveConfigPath(root, dir))).map(withTrailingSep);
}

/**
 * Whether `id` is one of the capability modules the manifest registers.
 * Matching the registered set rather than a directory keeps ordinary files that
 * merely live beside capabilities importable, and still catches a capability
 * registered from anywhere else in the project. Extension-agnostic, because the
 * comparison is against paths the manifest already resolved.
 */
function isCapabilityModule(id: string, capabilityModulePaths: Set<string>): boolean {
  if (capabilityModulePaths.size === 0) return false;
  const queryStart = id.indexOf("?");
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  if (path.startsWith("\0") || path.startsWith("virtual:")) return false;
  return capabilityModulePaths.has(canonicalFilePath(path));
}

/**
 * Match Vite's canonical module ids even when the manifest path crosses a
 * symlink (including macOS' /var -> /private/var alias). Missing paths keep
 * their lexical identity so the projection code can raise its precise missing
 * capability error later.
 */
function canonicalFilePath(path: string): string {
  try {
    return toPosixPath(realpathSync.native(path));
  } catch {
    return toPosixPath(path);
  }
}

function isRouteOrShellFile(id: string, dirs: string[], extensions: Set<string>): boolean {
  if (dirs.length === 0) return false;
  const queryStart = id.indexOf("?");
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  // Skip virtual modules and non-file ids.
  if (path.startsWith("\0") || path.startsWith("virtual:")) return false;
  const extIndex = path.lastIndexOf(".");
  if (extIndex === -1) return false;
  const ext = path.slice(extIndex);
  if (!extensions.has(ext)) return false;
  const normalized = toPosixPath(path);
  return dirs.some((dir) => normalized.startsWith(dir));
}

function resolveConfigPath(root: string, configPath: string): string {
  const normalizedRoot = toPosixPath(root).replace(/\/$/, "");
  const relativePath = configPath.replace(/^\//, "");
  if (normalizedRoot.startsWith("/") && !/^[A-Za-z]:\//.test(normalizedRoot)) {
    return `${normalizedRoot}/${relativePath}`;
  }
  return toPosixPath(resolve(root, relativePath));
}

function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function withTrailingSep(p: string): string {
  return p.endsWith("/") ? p : `${p}/`;
}
