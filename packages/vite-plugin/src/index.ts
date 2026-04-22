import preact from "@preact/preset-vite";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  isPrachtClientModuleId,
  stripPrachtClientModuleQuery,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";

import type { RenderMode } from "@pracht/core";
import {
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  isClientModule,
  isServerModule,
} from "./plugin-assets.ts";
import {
  clearPagesAppSourceCache,
  createPrachtClientModuleSource,
  createPrachtServerModuleSource,
} from "./plugin-codegen.ts";
import { createDevSSRMiddleware } from "./plugin-dev-ssr.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
  type TsrxOptions,
} from "./plugin-options.ts";

export type { RenderMode };
export type { PrachtAdapter } from "./plugin-adapter.ts";
export type { PrachtPluginOptions, TsrxOptions } from "./plugin-options.ts";
export {
  createPrachtClientModuleSource,
  createPrachtServerModuleSource,
  createPrachtRegistryModuleSource,
} from "./plugin-codegen.ts";
export { PRACHT_CLIENT_MODULE_ID, PRACHT_SERVER_MODULE_ID };

export async function pracht(options: PrachtPluginOptions = {}): Promise<Plugin[]> {
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

      return {
        appType: "custom" as const,
        build: {
          rollupOptions: {
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
        ...(isEdge && isSSRBuild
          ? {
              ssr: {
                noExternal: true,
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
      if (isClientModule(id)) return PRACHT_CLIENT_MODULE_ID;
      if (isServerModule(id)) return PRACHT_SERVER_MODULE_ID;
      return null;
    },

    load(id) {
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

      const transformed = code.replace(/\(\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/g, "$1$2$1");
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },

    configureServer(server) {
      if (isPagesMode) {
        watchPagesDirectory(server, resolved, root);
      }

      if (resolved.adapter.ownsDevServer) return;
      return () => {
        server.middlewares.use(createDevSSRMiddleware(server));
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
      ];
      if (dirs.some((dir) => relative.startsWith(dir))) {
        const serverMod = server.moduleGraph.getModuleById(PRACHT_SERVER_MODULE_ID);
        if (serverMod) server.moduleGraph.invalidateModule(serverMod);
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

  const plugins: Plugin[] = [...preact(), prachtPlugin, clientModuleTransformPlugin];

  const tsrxPlugin = await loadTsrxPlugin(resolved.tsrx);
  if (tsrxPlugin) {
    plugins.unshift(tsrxPlugin);
  }

  const adapterPlugins = await resolved.adapter.vitePlugins?.();
  if (adapterPlugins?.length) {
    plugins.push(...adapterPlugins);
  }

  return plugins;
}

async function loadTsrxPlugin(tsrx: false | TsrxOptions): Promise<Plugin | null> {
  if (!tsrx) return null;

  let mod: typeof import("@tsrx/vite-plugin-preact");
  try {
    mod = await import("@tsrx/vite-plugin-preact");
  } catch (error) {
    throw new Error(
      "[pracht] `tsrx` is enabled but `@tsrx/vite-plugin-preact` could not be loaded. " +
        "Install it with `pnpm add -D @tsrx/vite-plugin-preact` (or your package manager equivalent).",
      { cause: error },
    );
  }

  const plugin = mod.tsrxPreact(tsrx);

  // The upstream plugin only matches `/\.tsrx$/`, so it skips ids carrying our
  // `?pracht-client` query suffix. Wrap `transform` to delegate with the bare
  // path so the same compilation runs for the client variant of route modules.
  type TransformFn = (this: unknown, code: string, id: string, options?: unknown) => unknown;
  const upstreamTransform = plugin.transform as TransformFn | undefined;
  if (typeof upstreamTransform === "function") {
    const wrappedTransform: TransformFn = function (this, code, id, options) {
      if (isPrachtClientModuleId(id)) {
        const stripped = stripPrachtClientModuleQuery(id);
        const path = stripped.split("?")[0];
        if (path.endsWith(".tsrx")) {
          return upstreamTransform.call(this, code, stripped, options);
        }
      }
      return upstreamTransform.call(this, code, id, options);
    };
    (plugin as { transform: TransformFn }).transform = wrappedTransform;
  }

  return plugin;
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
