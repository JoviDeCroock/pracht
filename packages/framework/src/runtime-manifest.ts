import {
  getSuffixIndex,
  normalizeModulePath,
  resolveRegistryModule,
} from "@pracht/capabilities/server";
import type { ModuleRegistry } from "./types.ts";

// Module-path canonicalization and registry resolution live in
// `@pracht/capabilities/server` (the capability core resolves middleware and
// capability modules with them); re-exported here for the rest of the runtime.
export { getSuffixIndex, normalizeModulePath, resolveRegistryModule };

// Reserved jsManifest keys under which the build stores the transitive static
// JS imports of the client/islands entry chunks. Without these, the browser
// only discovers the entry's secondary chunks after downloading and parsing
// the entry itself — one extra serial round trip before hydration. Must match
// the virtual module ids in @pracht/vite-plugin (plugin-assets.ts).
export const CLIENT_ENTRY_MANIFEST_KEY = "virtual:pracht/client";
export const ISLANDS_ENTRY_MANIFEST_KEY = "virtual:pracht/islands-client";

/**
 * Merge an entry chunk's own static import urls into a page's modulepreload
 * list. Entry deps come first — they gate hydration — and duplicates from the
 * page's route/shell chunk closure are dropped.
 */
export function mergeEntryPreloadUrls(
  jsManifest: Record<string, string[]> | undefined,
  entryKey: string,
  pageUrls: string[],
): string[] {
  const entryUrls = jsManifest?.[entryKey];
  if (!entryUrls || entryUrls.length === 0) return pageUrls;
  return [...new Set([...entryUrls, ...pageUrls])];
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
