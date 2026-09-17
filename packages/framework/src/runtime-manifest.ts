import {
  getSuffixIndex,
  normalizeModulePath,
  resolveRegistryModule,
} from "@pracht/capabilities/server/internal";
import type { ModuleRegistry } from "./types.ts";

// Module-path canonicalization and registry resolution live in
// `@pracht/capabilities/server/internal` (the capability core resolves middleware and
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

/**
 * Split a page's ordered stylesheets into inline payloads and linked fallbacks.
 * Generated builds populate every URL when inlining is enabled; the fallback
 * keeps custom server entries safe when their content map is partial or stale.
 */
export function resolvePageCssAssets(
  cssManifest: Record<string, string[]> | undefined,
  cssContentManifest: Record<string, string> | undefined,
  shellFile: string | undefined,
  routeFile: string,
): Array<{ content?: string; href: string }> {
  const pageUrls = resolvePageCssUrls(cssManifest, shellFile, routeFile);
  return pageUrls.map((href) => toCssAsset(href, cssContentManifest));
}

function toCssAsset(
  href: string,
  cssContentManifest: Record<string, string> | undefined,
): { content?: string; href: string } {
  return {
    href,
    ...(cssContentManifest && Object.hasOwn(cssContentManifest, href)
      ? { content: cssContentManifest[href] }
      : {}),
  };
}

/**
 * Add the stylesheets of the islands a page rendered to its CSS assets.
 *
 * Islands are their own client entries, so their CSS is in neither the shell's
 * nor the route's closure and `resolvePageCssAssets` cannot see it. Left out of
 * the document it still reaches the browser, but only because Vite's preload
 * helper appends a `<link>` when the island's dynamic import runs — which is
 * after hydration, so the island's server-rendered markup paints unstyled and
 * the styles arrive visibly late.
 *
 * Hydration strategy is deliberately not consulted. `visible` and `idle` defer
 * an island's JavaScript, but its markup is in the document from the first
 * paint and needs its rules there too.
 */
export function withIslandCssAssets(
  cssAssets: Array<{ content?: string; href: string }>,
  cssManifest: Record<string, string[]> | undefined,
  cssContentManifest: Record<string, string> | undefined,
  islandFiles: Iterable<string>,
): Array<{ content?: string; href: string }> {
  if (!cssManifest) return cssAssets;
  const seen = new Set(cssAssets.map((asset) => asset.href));
  const merged = [...cssAssets];
  for (const file of islandFiles) {
    for (const href of resolveManifestEntries(cssManifest, file) ?? []) {
      if (seen.has(href)) continue;
      seen.add(href);
      merged.push(toCssAsset(href, cssContentManifest));
    }
  }
  return merged;
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
