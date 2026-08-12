/**
 * Dev-server reload for files that only exist on the server.
 *
 * Routes rendered with `hydration: "islands"` or `hydration: "none"` are
 * deliberately excluded from the client bundle (see
 * `createNonFullHydrationExcludes`), so neither the route file nor the
 * components it imports ever enter the client module graph. Vite only falls
 * back to `full-reload` for a zero-module update when the changed file is
 * HTML — for everything else it logs "no modules matched" and sends nothing.
 * The dev SSR output changes, but the open page never hears about it and stays
 * stale until a manual refresh.
 *
 * A file that is in the SSR graph and absent from the client graph can never be
 * reached by client HMR, so a full reload is the only correct update for it.
 * Files present in the client graph are left alone — their own HMR (route
 * modules, islands, prefresh component updates) already handles them.
 */

interface ModuleNodeLike {
  type?: "js" | "css" | "asset";
}

interface ModuleGraphLike {
  getModulesByFile(file: string): Set<ModuleNodeLike> | undefined;
}

interface EnvironmentLike {
  moduleGraph: ModuleGraphLike;
  hot?: { send(payload: { type: "full-reload" }): void };
}

export interface HotUpdateServerLike {
  environments?: Record<string, EnvironmentLike | undefined>;
}

/**
 * True when `file` participates in server rendering but has no runtime
 * counterpart in the client module graph, meaning client HMR can never deliver
 * its change. File-only asset entries created by content scanners are watchers,
 * not browser modules, so they do not make an update client-reachable.
 */
export function isServerOnlyModuleFile(server: HotUpdateServerLike, file: string): boolean {
  const environments = server.environments;
  const client = environments?.client;
  // Without the client environment there is no browser graph to compare
  // against — leave the update to Vite's own handling.
  if (!client) return false;
  if (hasRuntimeModules(client, file)) return false;

  for (const [name, environment] of Object.entries(environments ?? {})) {
    if (name === "client" || !environment) continue;
    if (hasRuntimeModules(environment, file)) return true;
  }
  return false;
}

/** Reload open pages when `file` can only reach them through the server. */
export function sendServerOnlyFullReload(server: HotUpdateServerLike, file: string): boolean {
  if (!isServerOnlyModuleFile(server, file)) return false;
  server.environments?.client?.hot?.send({ type: "full-reload" });
  return true;
}

/** Restart the pages graph when files are added or removed. */
export function watchPagesDirectory(
  server: ViteDevServer,
  resolved: ResolvedPrachtPluginOptions,
  root: string,
): void {
  const pagesDir = toPosixPath(resolveConfigPath(root, resolved.pagesDir));
  const restartForPageChange = (file: string): void => {
    if (!toPosixPath(file).startsWith(pagesDir)) return;
    clearPagesAppSourceCache();
    void server.restart();
  };
  server.watcher.on("add", restartForPageChange);
  server.watcher.on("unlink", restartForPageChange);
}

/** Apply Pracht's virtual-module invalidation and reload policy for one file. */
export function handlePrachtHotUpdate(
  context: { file: string; server: ViteDevServer },
  resolved: ResolvedPrachtPluginOptions,
): [] | undefined {
  const { file, server } = context;
  const serverRoot = toPosixPath(server.config.root);
  const normalizedFile = toPosixPath(file);
  const relative = normalizedFile.startsWith(serverRoot)
    ? normalizedFile.slice(serverRoot.length)
    : normalizedFile;

  if (resolved.pagesDir && relative.startsWith(resolved.pagesDir)) {
    clearPagesAppSourceCache();
    invalidateModules(server, [
      PRACHT_CLIENT_MODULE_ID,
      PRACHT_SERVER_MODULE_ID,
      PRACHT_DEV_MODULE_ID,
    ]);
    sendServerOnlyFullReload(server, file);
    return;
  }

  if (!resolved.pagesDir && relative === resolved.appFile) {
    void server.restart();
    return [];
  }

  const sourceDirs = [
    resolved.routesDir,
    resolved.shellsDir,
    resolved.middlewareDir,
    resolved.apiDir,
    resolved.serverDir,
    resolved.islandsDir,
    resolved.capabilitiesDir,
  ];
  if (sourceDirs.some((dir) => relative.startsWith(dir))) {
    const moduleIds = [PRACHT_SERVER_MODULE_ID, PRACHT_DEV_MODULE_ID];
    if (relative.startsWith(resolved.routesDir)) moduleIds.push(PRACHT_CLIENT_MODULE_ID);
    if (relative.startsWith(resolved.islandsDir)) moduleIds.push(PRACHT_ISLANDS_CLIENT_MODULE_ID);
    if (relative.startsWith(resolved.capabilitiesDir)) {
      // Capability schemas and exposure metadata are embedded in every browser
      // projection, including both full and islands client bootstraps.
      moduleIds.push(
        PRACHT_CAPABILITIES_MODULE_ID,
        PRACHT_WEBMCP_MODULE_ID,
        PRACHT_CLIENT_MODULE_ID,
        PRACHT_ISLANDS_CLIENT_MODULE_ID,
      );
    }
    invalidateModules(server, moduleIds);
  }

  sendServerOnlyFullReload(server, file);
}

function invalidateModules(server: ViteDevServer, moduleIds: string[]): void {
  for (const moduleId of new Set(moduleIds)) {
    const module = server.moduleGraph.getModuleById(moduleId);
    if (module) server.moduleGraph.invalidateModule(module);
  }
}

function hasRuntimeModules(environment: EnvironmentLike, file: string): boolean {
  for (const module of environment.moduleGraph.getModulesByFile(file) ?? []) {
    if (module.type !== "asset") return true;
  }
  return false;
}
import type { ViteDevServer } from "vite";

import {
  PRACHT_CAPABILITIES_MODULE_ID,
  PRACHT_CLIENT_MODULE_ID,
  PRACHT_DEV_MODULE_ID,
  PRACHT_ISLANDS_CLIENT_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
  PRACHT_WEBMCP_MODULE_ID,
} from "./plugin-assets.ts";
import { clearPagesAppSourceCache } from "./plugin-codegen.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";
import { resolveConfigPath, toPosixPath } from "./plugin-paths.ts";
