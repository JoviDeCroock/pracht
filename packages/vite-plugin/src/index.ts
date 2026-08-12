import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";
import preact from "@preact/preset-vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnv, type Plugin } from "vite";

import type { RenderMode } from "@pracht/core";
import { PRACHT_GRAPH_ONLY_ENV } from "@pracht/core/server";
import { createEnvSafetyPlugin, PUBLIC_ENV_PREFIX, SERVER_ENV_MODULE_ID } from "./env-safety.ts";
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
} from "./plugin-capabilities.ts";
import { createClientModuleSafetyPlugin } from "./plugin-client-safety.ts";
import {
  clearPagesAppSourceCache,
  createPrachtClientModuleSource,
  createPrachtDevModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
} from "./plugin-codegen.ts";
import {
  createDevCssInjectionMiddleware,
  createDevSSRMiddleware,
  injectDevCssForPath,
} from "./plugin-dev-ssr.ts";
import { createEdgeRuntimeSafetyPlugin } from "./plugin-edge-runtime-safety.ts";
import { createOptimizeDepsPlugin, PREACT_DEDUPE } from "./plugin-optimize-deps.ts";
import { canonicalFilePath, resolveConfigPath, toPosixPath } from "./plugin-paths.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";

export type { RenderMode };
export type { PrachtAdapter } from "./plugin-adapter.ts";
export type {
  LlmsTxtSection,
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

  if (isPagesMode && options.appFile) {
    console.warn(
      "[pracht] Both `pagesDir` and `appFile` are set. `pagesDir` takes precedence — `appFile` will be ignored.",
    );
  }

  let isBuild = false;

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
      };
    },

    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
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
        return createPrachtClientModuleSource(resolved, { root });
      }
      if (isDevModule(id)) {
        return createPrachtDevModuleSource(resolved, { root });
      }
      if (isServerModule(id)) {
        return createPrachtServerModuleSource(resolved, { root, isBuild });
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

    handleHotUpdate({ file, server }) {
      const serverRoot = toPosixPath(server.config.root);
      const normalizedFile = toPosixPath(file);
      const relative = normalizedFile.startsWith(serverRoot)
        ? normalizedFile.slice(serverRoot.length)
        : normalizedFile;

      if (isPagesMode && relative.startsWith(resolved.pagesDir)) {
        clearPagesAppSourceCache();
        invalidateVirtualModules(server);
        sendServerOnlyFullReload(server, file);
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
        if (relative.startsWith(resolved.routesDir)) {
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

      sendServerOnlyFullReload(server, file);
    },
  };

  const clientModuleTransformPlugin = createClientModuleSafetyPlugin(resolved, () => root);

  const edgeRuntimeSafetyPlugin: Plugin | null = resolved.adapter.edge
    ? createEdgeRuntimeSafetyPlugin()
    : null;

  const optimizeDepsEntriesPlugin = createOptimizeDepsPlugin(resolved);

  const precompilePlugin = resolved.precompileSsrJsx
    ? preactSsrPrecompile({
        ...(resolved.precompileSsrJsx === true ? {} : resolved.precompileSsrJsx),
        ssrOnly: true,
      })
    : null;

  const plugins: Plugin[] = [
    ...(precompilePlugin ? [precompilePlugin] : []),
    ...preact(),
    prachtPlugin,
    clientModuleTransformPlugin,
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

function isGraphOnlyMode(): boolean {
  return process.env[PRACHT_GRAPH_ONLY_ENV] === "1";
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
