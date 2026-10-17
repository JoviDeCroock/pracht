import { resolveRegistryModule } from "@pracht/core";

type ModuleMap = Record<string, () => Promise<unknown>>;

interface ManifestRouteRecord {
  id?: string;
  path?: string;
  file?: string;
  shellFile?: string;
  middlewareFiles?: string[];
}

interface ServerModuleShape {
  resolvedApp?: {
    routes?: ManifestRouteRecord[];
    notFound?: ManifestRouteRecord;
    middleware?: Record<string, string>;
    api?: { middleware?: string[] };
  };
  registry?: {
    routeModules?: ModuleMap;
    shellModules?: ModuleMap;
    middlewareModules?: ModuleMap;
  };
}

/**
 * Whether the runtime's registry lookup finds `file`, without importing it:
 * the lookup is handed importers that resolve to their own key.
 */
async function registryHas(modules: ModuleMap | undefined, file: string): Promise<boolean> {
  if (!modules) return false;
  const keys: ModuleMap = {};
  for (const key of Object.keys(modules)) keys[key] = async () => key;
  return (await resolveRegistryModule(keys, file)) !== undefined;
}

/**
 * Manifest module refs the built server registry cannot serve, one line each.
 * Every one of them fails each request that reaches it.
 */
export async function findUnresolvedManifestModules(
  serverModule: ServerModuleShape,
): Promise<string[]> {
  const registry = serverModule.registry;
  const app = serverModule.resolvedApp;
  if (!registry || !app) return [];

  const problems: string[] = [];
  const check = async (
    label: string,
    modules: ModuleMap | undefined,
    kind: string,
    file: string | undefined,
  ): Promise<void> => {
    if (!file || (await registryHas(modules, file))) return;
    problems.push(`${label}: ${kind} ${JSON.stringify(file)}`);
  };

  const records: Array<[string, ManifestRouteRecord]> = (app.routes ?? []).map((route) => [
    `route ${JSON.stringify(route.id ?? route.path)} (${route.path})`,
    route,
  ]);
  if (app.notFound) records.push(["notFound page", app.notFound]);

  for (const [label, record] of records) {
    await check(label, registry.routeModules, "module", record.file);
    await check(label, registry.shellModules, "shell", record.shellFile);
    for (const file of new Set(record.middlewareFiles ?? [])) {
      await check(label, registry.middlewareModules, "middleware", file);
    }
  }
  // API routes run `api.middleware` by name, skipping names nothing declares.
  for (const name of new Set(app.api?.middleware ?? [])) {
    const file = app.middleware?.[name];
    if (typeof file === "string") {
      await check(
        `api middleware ${JSON.stringify(name)}`,
        registry.middlewareModules,
        "module",
        file,
      );
    }
  }
  return [...new Set(problems)];
}

export function formatUnresolvedManifestModules(problems: string[]): string {
  return (
    `[pracht] ${problems.length === 1 ? "A manifest module ref matches" : `${problems.length} manifest module refs match`} ` +
    "no module in the build, so every request that needs one would fail:\n" +
    problems.map((problem) => `  - ${problem}`).join("\n") +
    "\nRefs resolve against the app manifest's directory (src/ for src/routes.ts), even in a " +
    "module the manifest imports. Fix the path. A module outside the routes, shells, or " +
    "middleware directory is found only when its ref is a string literal in the route(), " +
    "shells, or middleware entry itself."
  );
}
