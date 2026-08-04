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

function hasRuntimeModules(environment: EnvironmentLike, file: string): boolean {
  for (const module of environment.moduleGraph.getModulesByFile(file) ?? []) {
    if (module.type !== "asset") return true;
  }
  return false;
}
