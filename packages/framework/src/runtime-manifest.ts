import type { ModuleImporter, ModuleRegistry } from "./types.ts";

/** Strip leading `./` and `/` so all module paths share one canonical form. */
export function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

function buildSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(manifest)) {
    const normalized = normalizeModulePath(key);
    if (!normalized) continue;

    if (!index.has(normalized)) {
      index.set(normalized, key);
    }

    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {
      const suffix = normalized.slice(i + 1);
      if (suffix && !index.has(suffix)) {
        index.set(suffix, key);
      }
    }
  }
  return index;
}

const suffixIndexCache = new WeakMap<object, Map<string, string>>();

export function getSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  let index = suffixIndexCache.get(manifest);
  if (index) return index;
  index = buildSuffixIndex(manifest);
  suffixIndexCache.set(manifest, index);
  return index;
}

export function resolveManifestEntries(
  manifest: Record<string, string[]>,
  file: string,
): string[] | undefined {
  if (file in manifest) return manifest[file];

  const resolved = getSuffixIndex(manifest).get(normalizeModulePath(file));
  if (resolved) return manifest[resolved];
  return undefined;
}

export function resolvePageUrlsFromManifest(
  manifest: Record<string, string[]>,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  const urls = new Set<string>();
  const add = (file: string): void => {
    const entries = resolveManifestEntries(manifest, file);
    if (entries) {
      for (const url of entries) urls.add(url);
    }
  };
  if (shellFile) add(shellFile);
  add(routeFile);
  return [...urls];
}

export function resolvePageCssUrls(
  cssManifest: Record<string, string[]> | undefined,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!cssManifest) return [];
  return resolvePageUrlsFromManifest(cssManifest, shellFile, routeFile);
}

export function resolvePageJsUrls(
  jsManifest: Record<string, string[]> | undefined,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!jsManifest) return [];
  return resolvePageUrlsFromManifest(jsManifest, shellFile, routeFile);
}

export async function resolveRegistryModule<T>(
  modules: Record<string, ModuleImporter> | undefined,
  file: string,
): Promise<T | undefined> {
  if (!modules) return undefined;

  // Direct key match (fast path)
  if (file in modules) {
    return modules[file]() as Promise<T>;
  }

  // Indexed suffix match
  const resolved = getSuffixIndex(modules).get(normalizeModulePath(file));
  if (resolved) {
    return modules[resolved]() as Promise<T>;
  }

  return undefined;
}

export async function resolveDataFunctions(
  route: import("./types.ts").ResolvedRoute,
  routeModule: import("./types.ts").RouteModule | undefined,
  registry: ModuleRegistry,
): Promise<{ loader: import("./types.ts").RouteModule["loader"]; loaderFile?: string }> {
  let loader = routeModule?.loader;
  let loaderFile = routeModule?.loader ? route.file : undefined;

  if (route.loaderFile) {
    const dataModule = await resolveRegistryModule<import("./types.ts").DataModule>(
      registry.dataModules,
      route.loaderFile,
    );
    if (dataModule?.loader) {
      loader = dataModule.loader;
      loaderFile = route.loaderFile;
    }
  }

  return { loader, loaderFile };
}
