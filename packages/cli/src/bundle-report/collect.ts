import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type {
  BundleChunk,
  BundleReport,
  CollectBundleReportOptions,
  RouteBundle,
} from "./types.js";

/** Strip leading `./` and `/` so module paths share one canonical form. */
function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

// Mirrors the runtime's suffix matching (@pracht/core runtime-manifest) so the
// report resolves the same chunks the server injects for each route.
function buildSuffixIndex(manifest: Record<string, string[]>): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(manifest)) {
    const normalized = normalizeModulePath(key);
    if (!normalized) continue;
    if (!index.has(normalized)) index.set(normalized, key);
    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {
      const suffix = normalized.slice(i + 1);
      if (suffix && !index.has(suffix)) index.set(suffix, key);
    }
  }
  return index;
}

function resolveManifestEntries(
  manifest: Record<string, string[]>,
  suffixIndex: Map<string, string>,
  file: string,
): string[] {
  if (file in manifest) return manifest[file];
  const resolved = suffixIndex.get(normalizeModulePath(file));
  return resolved ? manifest[resolved] : [];
}

export function collectBundleReport({
  routes,
  jsManifest,
  clientEntryJs,
  islandsEntryJs = [],
  islandFiles = [],
  clientDir,
}: CollectBundleReportOptions): BundleReport {
  const suffixIndex = buildSuffixIndex(jsManifest);
  const chunkCache = new Map<string, BundleChunk>();

  function measureChunk(url: string): BundleChunk {
    const cached = chunkCache.get(url);
    if (cached) return cached;

    const filePath = join(clientDir, url.replace(/^\//, ""));
    let bytes = 0;
    let gzipBytes = 0;
    if (existsSync(filePath)) {
      const contents = readFileSync(filePath);
      bytes = contents.byteLength;
      gzipBytes = gzipSync(contents).byteLength;
    }

    const chunk: BundleChunk = { url, bytes, gzipBytes };
    chunkCache.set(url, chunk);
    return chunk;
  }

  const sharedUrls = new Set(clientEntryJs);
  const sharedChunks = clientEntryJs.map(measureChunk);
  const sharedBytes = sumBytes(sharedChunks);
  const sharedGzipBytes = sumGzipBytes(sharedChunks);

  // Which islands a page renders is only known at render time, so this set is
  // the conservative per-route upper bound for islands hydration.
  const islandUrls = new Set<string>(islandsEntryJs);
  for (const file of islandFiles) {
    for (const url of resolveManifestEntries(jsManifest, suffixIndex, file)) {
      islandUrls.add(url);
    }
  }

  const reportRoutes: RouteBundle[] = routes.map((route) => {
    const hydration = route.hydration ?? "full";

    if (hydration === "none") {
      return {
        ...(route.id ? { id: route.id } : {}),
        path: route.path,
        render: route.render ?? "ssr",
        hydration,
        chunks: [],
        routeBytes: 0,
        routeGzipBytes: 0,
        totalBytes: 0,
        totalGzipBytes: 0,
      };
    }

    if (hydration === "islands") {
      const chunks = [...islandUrls]
        .map(measureChunk)
        .sort((left, right) => right.gzipBytes - left.gzipBytes);
      const routeBytes = sumBytes(chunks);
      const routeGzipBytes = sumGzipBytes(chunks);

      return {
        ...(route.id ? { id: route.id } : {}),
        path: route.path,
        render: route.render ?? "ssr",
        hydration,
        chunks,
        routeBytes,
        routeGzipBytes,
        // Islands routes never load the shared full-hydration client entry.
        totalBytes: routeBytes,
        totalGzipBytes: routeGzipBytes,
      };
    }

    const urls = new Set<string>();
    if (route.shellFile) {
      for (const url of resolveManifestEntries(jsManifest, suffixIndex, route.shellFile)) {
        urls.add(url);
      }
    }
    for (const url of resolveManifestEntries(jsManifest, suffixIndex, route.file)) {
      urls.add(url);
    }

    const chunks = [...urls]
      .filter((url) => !sharedUrls.has(url))
      .map(measureChunk)
      .sort((left, right) => right.gzipBytes - left.gzipBytes);
    const routeBytes = sumBytes(chunks);
    const routeGzipBytes = sumGzipBytes(chunks);

    return {
      ...(route.id ? { id: route.id } : {}),
      path: route.path,
      render: route.render ?? "ssr",
      chunks,
      routeBytes,
      routeGzipBytes,
      totalBytes: routeBytes + sharedBytes,
      totalGzipBytes: routeGzipBytes + sharedGzipBytes,
    };
  });

  reportRoutes.sort(
    (left, right) =>
      right.totalGzipBytes - left.totalGzipBytes || left.path.localeCompare(right.path),
  );

  return {
    shared: {
      chunks: [...sharedChunks].sort((left, right) => right.gzipBytes - left.gzipBytes),
      bytes: sharedBytes,
      gzipBytes: sharedGzipBytes,
    },
    routes: reportRoutes,
  };
}

function sumBytes(chunks: BundleChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.bytes, 0);
}

function sumGzipBytes(chunks: BundleChunk[]): number {
  return chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0);
}
