import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { analyzeImage, type SharpFactory } from "./vite-analysis.ts";
import { createImageModuleCode } from "./vite-module.ts";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  code: Promise<string>;
}

interface ImageTransformOptions {
  blurWidth: number;
  blurQuality: number;
  importSharp: () => Promise<SharpFactory>;
}

export function createImageTransformer(options: ImageTransformOptions) {
  // Include the asset id in the cache key: the same file can be imported via
  // publicDir (stable root-relative URL) or by filesystem path (hashed URL).
  // Invalidating by mtime+size picks up edits in dev while repeated
  // builds/environments reuse the sharp work for matching URL semantics.
  const cache = new Map<string, CacheEntry>();

  return async function transformImage(filePath: string, assetId: string): Promise<string> {
    const stats = await stat(filePath).catch(() => {
      throw new Error(`[pracht/image] Could not read "${filePath}" for a "?pracht" import.`);
    });

    const cacheKey = `${filePath}\0${assetId}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.code;
    }

    const code = (async () => {
      const [sharp, source] = await Promise.all([options.importSharp(), readFile(filePath)]);
      try {
        const analyzed = await analyzeImage(sharp, source, options);
        return createImageModuleCode(assetId, analyzed);
      } catch (error) {
        throw new Error(
          `[pracht/image] Failed to process "?pracht" import of "${filePath}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    // Drop failed transforms so a fixed image (or a later sharp install) is
    // retried instead of replaying a cached rejection.
    code.catch(() => cache.delete(cacheKey));

    cache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, code });
    return code;
  };
}

export async function resolvePublicImageFile(
  publicDir: string,
  source: string,
): Promise<string | undefined> {
  if (!publicDir || !source.startsWith("/")) return undefined;

  const candidate = resolve(publicDir, `.${source}`);
  const relativePath = relative(publicDir, candidate);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  const stats = await stat(candidate).catch(() => undefined);
  return stats?.isFile() ? candidate : undefined;
}
