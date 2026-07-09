import { preactSsrPrecompile } from "@pracht/preact-ssr-precompile";
import preact from "@preact/preset-vite";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Plugin, UserConfig } from "vite";
import {
  isPrachtClientModuleId,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";

import type { RenderMode } from "@pracht/core";
import {
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  isClientModule,
  isIslandsClientModule,
  isServerModule,
} from "./plugin-assets.ts";
import {
  clearPagesAppSourceCache,
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
} from "./plugin-codegen.ts";
import { existsSync } from "node:fs";
import { createDevSSRMiddleware } from "./plugin-dev-ssr.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";

export type { RenderMode };
export type { PrachtAdapter } from "./plugin-adapter.ts";
export type { PrachtPluginOptions } from "./plugin-options.ts";
export {
  createPrachtClientModuleSource,
  createPrachtIslandsClientModuleSource,
  createPrachtServerModuleSource,
  createPrachtRegistryModuleSource,
} from "./plugin-codegen.ts";
export { PRACHT_CLIENT_MODULE_ID, PRACHT_ISLANDS_CLIENT_MODULE_ID, PRACHT_SERVER_MODULE_ID };

export function pracht(options: PrachtPluginOptions = {}): Plugin[] {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  let root = process.cwd();
  let routeFileDirs: string[] = [];

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

      return {
        appType: "custom" as const,
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
    },

    resolveId(id) {
      if (isIslandsClientModule(id)) return PRACHT_ISLANDS_CLIENT_MODULE_ID;
      if (isClientModule(id)) return PRACHT_CLIENT_MODULE_ID;
      if (isServerModule(id)) return PRACHT_SERVER_MODULE_ID;
      return null;
    },

    load(id) {
      if (isIslandsClientModule(id)) {
        return createPrachtIslandsClientModuleSource(resolved);
      }
      if (isClientModule(id)) {
        return createPrachtClientModuleSource(resolved, { root });
      }
      if (isServerModule(id)) {
        return createPrachtServerModuleSource(resolved, { root, isBuild });
      }
      return null;
    },

    transform(code, id) {
      // Transform () => import("./path") to "./path" in the app manifest file.
      // This lets users write import() for IDE click-to-navigate while keeping
      // the framework's string-based file resolution intact.
      const appFileAbs = resolveConfigPath(root, resolved.appFile);
      const normalizedId = toPosixPath(id.split("?")[0]);
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

      if (resolved.adapter.ownsDevServer) return;
      return () => {
        server.middlewares.use(
          createDevSSRMiddleware(server, { maxBodySize: resolved.maxBodySize }),
        );
      };
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
      ];
      if (dirs.some((dir) => relative.startsWith(dir))) {
        const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
        if (relative.startsWith(resolved.routesDir)) {
          const clientMod = server.moduleGraph.getModuleById(PRACHT_CLIENT_MODULE_ID);
          if (clientMod) server.moduleGraph.invalidateModule(clientMod);
        }
        if (relative.startsWith(resolved.islandsDir)) {
          const islandsMod = server.moduleGraph.getModuleById(PRACHT_ISLANDS_CLIENT_MODULE_ID);
          if (islandsMod) server.moduleGraph.invalidateModule(islandsMod);
        }
      }
    },
  };

  const clientModuleTransformPlugin: Plugin = {
    name: "pracht:client-module-transform",
    enforce: "post",

    transform(code, id, transformOptions) {
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
  if (clientMod) server.moduleGraph.invalidateModule(clientMod);
  if (serverMod) server.moduleGraph.invalidateModule(serverMod);
}

const ROUTE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".mdx", ".tsrx"]);

function computeRouteFileDirs(root: string, resolved: ResolvedPrachtPluginOptions): string[] {
  const dirs = resolved.pagesDir ? [resolved.pagesDir] : [resolved.routesDir, resolved.shellsDir];
  return dirs.map((dir) => resolveConfigPath(root, dir)).map(withTrailingSep);
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
