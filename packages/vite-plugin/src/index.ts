import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";
import preact from "@preact/preset-vite";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { loadEnv, type Plugin, type UserConfig } from "vite";
import {
  isPrachtClientModuleId,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";

import type { RenderMode } from "@pracht/core";
import { createEnvSafetyPlugin, PUBLIC_ENV_PREFIX, SERVER_ENV_MODULE_ID } from "./env-safety.ts";
import { sendServerOnlyFullReload } from "./hot-update-reload.ts";
import {
  CLIENT_ONLY_MODULE_ID,
  SERVER_ONLY_MODULE_ID,
  createImportBoundariesPlugin,
} from "./import-boundaries.ts";
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
  resolveCapabilityModulePaths,
} from "./plugin-capabilities.ts";
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
  CLIENT_ONLY_MODULE_ID,
  SERVER_ONLY_MODULE_ID,
  createImportBoundariesPlugin,
  filenameBoundary,
} from "./import-boundaries.ts";
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
  let capabilityModulePaths = new Set<string>();

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
      // routes can load it without the full client runtime. Only added when
      // the app actually has an islands directory, so builds of apps without
      // islands are byte-for-byte unchanged.
      const configRoot = _config.root ?? process.cwd();
      const wantsIslandsEntry =
        env.command === "build" &&
        !isSSRBuild &&
        existsSync(resolveConfigPath(configRoot, resolved.islandsDir));

      // `publicEnv` needs every PRACHT_PUBLIC_ key, but reading the whole
      // `import.meta.env` object to enumerate them makes Vite inline *all*
      // exposed vars — VITE_ ones included — into the client bundle. Injecting
      // the pre-filtered subset keeps that enumeration public-only.
      const envDir = _config.envDir ? resolve(configRoot, _config.envDir) : configRoot;
      const publicEnvDefine = JSON.stringify(loadEnv(env.mode, envDir, PUBLIC_ENV_PREFIX));

      return {
        appType: "custom" as const,
        // Expose PRACHT_PUBLIC_-prefixed vars on import.meta.env (client and
        // server) while keeping Vite's default VITE_ prefix working.
        envPrefix: ["VITE_", PUBLIC_ENV_PREFIX],
        define: { __PRACHT_PUBLIC_ENV__: publicEnvDefine },
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
        (!transformOptions?.ssr && isRouteOrShellFile(id, routeFileDirs));
      if (!shouldStrip) return null;

      const transformed = stripServerOnlyExportsForClient(code, id);
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },
  };

  const optimizeDepsEntriesPlugin: Plugin = {
    name: "pracht:optimize-deps-entries",
    enforce: "post",

    config(config) {
      return withPrachtOptimizeDepsEntries(
        config,
        createPrachtOptimizeDepsEntries(resolved),
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

  const plugins: Plugin[] = [
    ...(precompilePlugin ? [precompilePlugin] : []),
    ...preact(),
    prachtPlugin,
    clientModuleTransformPlugin,
    createImportBoundariesPlugin(resolved.importBoundaries),
    createEnvSafetyPlugin(resolved.envSafety),
  ];

  const adapterPlugins = resolved.adapter.vitePlugins?.();
  if (adapterPlugins?.length) {
    plugins.push(...adapterPlugins);
  }
  plugins.push(optimizeDepsEntriesPlugin);

  return plugins;
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
  prachtEntries: string[],
  prachtInclude: string[],
): UserConfig {
  const environments = Object.fromEntries(
    Object.entries(config.environments ?? {}).map(([name, environment]) => [
      name,
      {
        optimizeDeps: {
          entries: mergeOptimizeDepsEntries(environment.optimizeDeps?.entries, prachtEntries),
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

function createPrachtOptimizeDepsEntries(resolved: ResolvedPrachtPluginOptions): string[] {
  const scriptExtensions = "{ts,tsx,js,jsx}";
  const routeExtensions = "{ts,tsx,js,jsx,md,mdx,tsrx}";
  const entries = resolved.pagesDir
    ? [
        `${toOptimizeDepsEntry(resolved.pagesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        `${toOptimizeDepsEntry(resolved.apiDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.serverDir)}/**/*.{ts,js,tsx,jsx}`,
        `${toOptimizeDepsEntry(resolved.islandsDir)}/**/*.${scriptExtensions}`,
      ]
    : [
        toOptimizeDepsEntry(resolved.appFile),
        `${toOptimizeDepsEntry(resolved.routesDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.shellsDir)}/**/*.${routeExtensions}`,
        `${toOptimizeDepsEntry(resolved.middlewareDir)}/**/*.${scriptExtensions}`,
        `${toOptimizeDepsEntry(resolved.apiDir)}/**/*.{ts,js,tsx,jsx}`,
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

const ROUTE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".mdx", ".tsrx"]);

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

function isRouteOrShellFile(id: string, dirs: string[]): boolean {
  if (dirs.length === 0) return false;
  const queryStart = id.indexOf("?");
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  // Skip virtual modules and non-file ids.
  if (path.startsWith("\0") || path.startsWith("virtual:")) return false;
  const extIndex = path.lastIndexOf(".");
  if (extIndex === -1) return false;
  const ext = path.slice(extIndex);
  if (!ROUTE_FILE_EXTENSIONS.has(ext)) return false;
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
