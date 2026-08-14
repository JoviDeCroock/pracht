import type { Plugin } from "vite";

import { analyzeImage, createSharpImporter } from "./vite-analysis.ts";
import {
  createImageModuleCode,
  isPrachtImageId,
  PRACHT_IMAGE_QUERY,
  stripImageQuery,
} from "./vite-module.ts";
import { resolvePrachtImageOptions, type PrachtImageOptions } from "./vite-options.ts";
import { createImageTransformer, resolvePublicImageFile } from "./vite-transform.ts";

export { analyzeImage } from "./vite-analysis.ts";
export { createImageModuleCode, isPrachtImageId, stripImageQuery } from "./vite-module.ts";
export type { PrachtImageOptions } from "./vite-options.ts";

interface ResolvedImage {
  /** Filesystem path read by sharp and watched for changes. */
  filePath: string;
  /** Vite id imported by the generated metadata module. */
  assetId: string;
}

/**
 * Vite plugin enabling build-time image imports:
 *
 * ```ts
 * // vite.config.ts — add it next to pracht(); it is not included by default.
 * import { prachtImage } from "@pracht/image/vite";
 * export default { plugins: [pracht({ … }), prachtImage()] };
 * ```
 *
 * ```tsx
 * import hero from "./hero.jpg?pracht";
 * <Image src={hero} alt="…" placeholder="blur" />;
 * ```
 *
 * The import yields `{ src, width, height, blurDataURL }`: `src` goes through
 * Vite's normal asset pipeline (hashed source assets, stable publicDir URLs,
 * `base`, dev server), dimensions come from sharp metadata with EXIF
 * orientation applied, and `blurDataURL` is a tiny inline WebP generated at
 * build time. Add
 * `/// <reference types="@pracht/image/client" />` (or `"types":
 * ["@pracht/image/client"]` in tsconfig) so TypeScript understands the query.
 */
export function prachtImage(options: PrachtImageOptions = {}): Plugin {
  const resolvedOptions = resolvePrachtImageOptions(options);
  const transformImage = createImageTransformer({
    blurWidth: resolvedOptions.blurWidth,
    blurQuality: resolvedOptions.blurQuality,
    importSharp: createSharpImporter(resolvedOptions.loadSharp),
  });
  const resolvedImages = new Map<string, ResolvedImage>();
  let publicDir = "";

  return {
    name: "pracht:image-imports",
    // Run before Vite's asset plugin, which would otherwise treat
    // `hero.jpg?pracht` as a plain asset URL import.
    enforce: "pre",
    configResolved(config) {
      publicDir = config.publicDir;
    },
    async resolveId(source, importer) {
      if (!isPrachtImageId(source)) return null;
      // Resolve the underlying file with the query stripped so relative
      // paths and aliases work, then re-attach the query as the module id.
      const sourcePath = stripImageQuery(source);
      const resolved = await this.resolve(sourcePath, importer, { skipSelf: true });
      if (!resolved) return null;

      // Vite deliberately resolves a publicDir asset such as `/hero.jpg` to
      // that root-relative URL rather than its disk location. Sharp still
      // needs the real file path, while the generated `?url` import must keep
      // the public URL so Vite preserves its stable filename and applies base.
      const publicFile =
        resolved.id === sourcePath
          ? await resolvePublicImageFile(publicDir, sourcePath)
          : undefined;
      const moduleId = `${resolved.id}${resolved.id.includes("?") ? "&" : "?"}${PRACHT_IMAGE_QUERY}`;
      resolvedImages.set(moduleId, {
        filePath: publicFile ?? resolved.id,
        assetId: publicFile ? sourcePath : resolved.id,
      });
      return moduleId;
    },
    async load(id) {
      if (!isPrachtImageId(id)) return null;
      const sourcePath = stripImageQuery(id);
      const resolved = resolvedImages.get(id) ?? {
        filePath: sourcePath,
        assetId: sourcePath,
      };
      // Watch the source file so dev rebuilds when the image itself changes.
      this.addWatchFile(resolved.filePath);
      return transformImage(resolved.filePath, resolved.assetId);
    },
    watchChange(filePath) {
      if (this.environment.mode !== "dev") return;

      // publicDir modules use a root-relative URL as their module id, so Vite's
      // normal file-to-module index does not associate them with the public
      // file on disk. Invalidate those mapped modules explicitly when the
      // watcher reports a change; source-directory ids are already covered by
      // Vite and the duplicate invalidation is harmless.
      for (const [moduleId, resolved] of resolvedImages) {
        if (resolved.filePath.replace(/\\/g, "/") !== filePath.replace(/\\/g, "/")) continue;
        const module = this.environment.moduleGraph.getModuleById(moduleId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
      }
    },
  };
}
