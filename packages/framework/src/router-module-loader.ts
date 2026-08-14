import type { RouteMatch } from "./types.ts";
import type {
  ClientRouteRenderer,
  ClientRouteRendererOptions,
  RouterModuleMap,
} from "./router-renderer-types.ts";

export type ClientRouteModuleLoader = Pick<
  ClientRouteRenderer,
  "startRouteImport" | "startShellImport" | "warmModules"
>;

type ModuleLoaderOptions = Pick<
  ClientRouteRendererOptions,
  "findModuleKey" | "routeModules" | "shellModules"
>;

export function createClientRouteModuleLoader(
  options: ModuleLoaderOptions,
): ClientRouteModuleLoader {
  const { routeModules, shellModules, findModuleKey } = options;
  const moduleCache = new Map<string, Promise<unknown>>();

  function loadModule(modules: RouterModuleMap, key: string): Promise<unknown> {
    let cached = moduleCache.get(key);
    if (!cached) {
      cached = modules[key]();
      moduleCache.set(key, cached);
    }
    return cached;
  }

  function startRouteImport(match: RouteMatch): Promise<unknown> | null {
    const routeKey = findModuleKey(routeModules, match.route.file);
    if (!routeKey) return null;
    return loadModule(routeModules, routeKey);
  }

  function startShellImport(match: RouteMatch): Promise<unknown> | null {
    if (!match.route.shellFile) return null;
    const shellKey = findModuleKey(shellModules, match.route.shellFile);
    if (!shellKey) return null;
    return loadModule(shellModules, shellKey);
  }

  function warmModules(match: RouteMatch): void {
    startRouteImport(match);
    startShellImport(match);
  }

  return {
    startRouteImport,
    startShellImport,
    warmModules,
  };
}
