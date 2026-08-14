import { getIslandsClientEntryUrl, type IslandCapture } from "./islands-server.ts";
import { buildHtmlDocument, htmlResponse } from "./runtime-html.ts";
import {
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
} from "./runtime-manifest.ts";
import type { RenderPageRepresentationOptions } from "./runtime-page-render-types.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import type { HeadMetadata } from "./types.ts";

export function renderStaticPageRepresentation(
  options: RenderPageRepresentationOptions,
  ssrContent: string,
  islandCapture: IslandCapture | null,
  cssUrls: string[],
  head: HeadMetadata,
): Response {
  const islandFiles = [
    ...new Set((islandCapture?.islands ?? []).map((usage) => usage.descriptor.file)),
  ];
  let islandsEntryUrl: string | undefined;
  const needsIslandsBootstrap =
    options.match.route.hydration === "islands" &&
    (islandFiles.length > 0 || options.islandsBootstrapRequired === true);
  if (needsIslandsBootstrap) {
    islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
    if (!islandsEntryUrl) {
      throw new Error(
        `Route "${options.match.route.path}" uses hydration: "islands" and requires the ` +
          `islands bootstrap${islandFiles.length > 0 ? ` for ${islandFiles.length} rendered island(s)` : " for a page-level runtime projection"}, but no bootstrap URL is registered. ` +
          (islandFiles.length > 0
            ? "This usually means the @pracht/vite-plugin islands entry was not built — check that your islands live in the configured islands directory."
            : "This usually means generated page-runtime metadata was not forwarded by the deployment adapter."),
      );
    }
  }

  // Only preload islands that hydrate immediately. Preloading visible/idle
  // islands would defeat their deferred-network strategy.
  const preloadFiles = new Set(
    (islandCapture?.islands ?? [])
      .filter((usage) => usage.strategy === "load")
      .map((usage) => usage.descriptor.file),
  );
  const islandPreloadUrls = new Set<string>();
  if (options.jsManifest) {
    for (const file of preloadFiles) {
      for (const url of resolveManifestEntries(options.jsManifest, file) ?? []) {
        islandPreloadUrls.add(url);
      }
    }
  }

  return htmlResponse(
    buildHtmlDocument({
      head,
      body: ssrContent,
      clientEntryUrl: islandsEntryUrl,
      cssUrls,
      modulePreloadUrls: islandsEntryUrl
        ? mergeEntryPreloadUrls(options.jsManifest, ISLANDS_ENTRY_MANIFEST_KEY, [
            ...islandPreloadUrls,
          ])
        : [...islandPreloadUrls],
      speculationRules: getAppSpeculationRules(options.resolvedApp),
    }),
    options.status,
    options.documentHeaders,
  );
}
