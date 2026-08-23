import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import type { Plugin } from "vite";

import type { PrachtImageMetadata } from "./metadata.ts";

/**
 * Options for the `?pracht` image import plugin.
 */
export interface PrachtImageOptions {
  /**
   * Width in pixels of the generated blur placeholder. Kept tiny on purpose:
   * the placeholder is inlined as a base64 data URI in HTML and JS.
   * Defaults to 8.
   */
  blurWidth?: number;
  /** WebP quality (1-100) of the blur placeholder. Defaults to 70. */
  blurQuality?: number;
  /** Widths generated for `?pracht&pracht-static` imports. */
  staticWidths?: readonly number[];
  /** WebP quality for generated static variants. Defaults to 75. */
  staticQuality?: number;
  /**
   * Client asset directory used when a static image is reachable only from
   * the server graph. Relative paths resolve from Vite's root. Defaults to
   * `dist/client`, matching `pracht build`.
   */
  staticOutDir?: string;
  /** Override how sharp is imported (useful for tests). */
  loadSharp?: () => Promise<unknown>;
}

const PRACHT_IMAGE_QUERY = "pracht";
const DEFAULT_BLUR_WIDTH = 8;
const DEFAULT_BLUR_QUALITY = 70;
const DEFAULT_STATIC_QUALITY = 75;
const DEFAULT_STATIC_WIDTHS = [320, 640, 960, 1280, 1920] as const;
const STATIC_IMAGE_QUERY = "pracht-static";
const STATIC_CACHE_VERSION = "pracht-static-image-v2";
/**
 * WebP stores each dimension in 14 bits, so no side of an encoded image may
 * exceed 16383px. Both the configured widths and the intrinsic-width variant
 * are capped to it: a panorama should ship one clamped variant, not fail the
 * build with a raw encoder error.
 */
const WEBP_MAX_DIMENSION = 16_383;
/**
 * Generated variants that have not been used for this long are dropped from
 * the disk cache. Entries are touched on every hit, so anything older belongs
 * to an image that has since been edited, renamed, or deleted.
 */
const STATIC_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const SHARP_INSTALL_HINT =
  '[pracht/image] "?pracht" image imports require the optional "sharp" dependency ' +
  'at build time. Install it in your app with "pnpm add -D sharp" ' +
  "(or npm install -D sharp / yarn add -D sharp).";

/** Minimal structural typing for the parts of sharp used at build time. */
interface SharpMetadata {
  format?: string;
  width?: number;
  height?: number;
  orientation?: number;
  pages?: number;
}

interface SharpPipeline {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpPipeline;
  resize(options: {
    width: number;
    height?: number;
    fit?: "inside";
    withoutEnlargement: boolean;
  }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

type SharpFactory = ((input: Uint8Array) => SharpPipeline) & {
  versions?: { sharp?: string };
};

function createSharpImporter(load: () => Promise<unknown>): () => Promise<SharpFactory> {
  let cached: Promise<SharpFactory> | undefined;
  return () => {
    cached ??= load().then(
      (mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory,
      () => {
        cached = undefined;
        throw new Error(SHARP_INSTALL_HINT);
      },
    );
    return cached;
  };
}

/** `/path/to/hero.jpg?pracht` → true; `?pracht` may combine with other params. */
export function isPrachtImageId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;
  return id
    .slice(queryStart + 1)
    .split("&")
    .some((part) => part === PRACHT_IMAGE_QUERY);
}

export function isStaticPrachtImageId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;
  return id
    .slice(queryStart + 1)
    .split("&")
    .some((part) => part === STATIC_IMAGE_QUERY);
}

/** Strip the entire query, leaving the file path. */
export function stripImageQuery(id: string): string {
  const queryStart = id.indexOf("?");
  return queryStart === -1 ? id : id.slice(0, queryStart);
}

/**
 * Read intrinsic dimensions (respecting EXIF orientation) and generate the
 * blur placeholder for one image buffer. Exported for tests.
 */
export async function analyzeImage(
  sharp: SharpFactory,
  source: Uint8Array,
  options: { blurWidth: number; blurQuality: number },
): Promise<Omit<PrachtImageMetadata, "src">> {
  const metadata = await sharp(source).metadata();

  let width = metadata.width;
  let height = metadata.height;
  // EXIF orientations 5-8 rotate the image by 90°: the raster dimensions are
  // swapped relative to how the image displays. Browsers honor the EXIF flag
  // (image-orientation: from-image is the default), so report display
  // dimensions or every `?pracht` portrait photo would reserve landscape space.
  const orientation = metadata.orientation ?? 1;
  if (orientation >= 5 && orientation <= 8) {
    width = metadata.height;
    height = metadata.width;
  }

  if (width == null || height == null || width <= 0 || height <= 0) {
    throw new Error(
      `could not determine intrinsic dimensions (format: ${metadata.format ?? "unknown"}). ` +
        "For SVG sources, add width/height or a viewBox attribute.",
    );
  }

  // SVG: vectors scale losslessly, so a raster blur placeholder would only
  // add bytes. Pass dimensions through and skip the blur.
  if (metadata.format === "svg") {
    return { width, height };
  }

  // Animated GIF/WebP: sharp reads the first frame by default, which is
  // exactly what a placeholder should show. `.rotate()` applies the EXIF
  // orientation so the blur matches how the full image displays. The height
  // cap only binds beyond a ~2048:1 portrait aspect ratio — every ordinary
  // image resizes byte-identically — but without it a source narrower than
  // `blurWidth` and taller than WebP's limit fails to encode at all.
  const blur = await sharp(source)
    .rotate()
    .resize({
      width: options.blurWidth,
      height: WEBP_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: options.blurQuality })
    .toBuffer();

  return {
    width,
    height,
    blurDataURL: `data:image/webp;base64,${Buffer.from(blur).toString("base64")}`,
  };
}

/**
 * Generate the virtual module for a `?pracht` import. The `?url` import
 * delegates the actual file to Vite's asset pipeline, so hashing, `base`,
 * and dev serving all behave exactly like a plain asset import. `no-inline`
 * opts out of `assetsInlineLimit`: without it, images under the limit
 * (default 4 KB) turn `src` into a `data:` URI, which breaks
 * optimization-endpoint loaders (`/api/_pracht/image?url=data%3A…` is not a
 * fetchable same-origin path) and double-ships the bytes next to
 * `blurDataURL`. The metadata contract promises a real asset URL (hashed for
 * source files, stable for publicDir files). Exported for tests.
 */
export function createImageModuleCode(
  assetId: string,
  analyzed: Omit<PrachtImageMetadata, "src">,
  variants: PrachtImageMetadata["variants"] = undefined,
  staticQuery = false,
): string {
  if (variants?.length) {
    return [
      `export const variants = ${JSON.stringify(variants)};`,
      "export const src = variants[variants.length - 1].src;",
      `export const width = ${JSON.stringify(analyzed.width)};`,
      `export const height = ${JSON.stringify(analyzed.height)};`,
      `export const blurDataURL = ${JSON.stringify(analyzed.blurDataURL)};`,
      "export default { src, width, height, blurDataURL, variants };",
    ].join("\n");
  }
  // Vite ids always use forward slashes, including Windows drive paths
  // (`C:/…`). Normalize before embedding the path in the generated import.
  const assetImport = `${assetId.replace(/\\/g, "/")}?url&no-inline`;
  return [
    `import src from ${JSON.stringify(assetImport)};`,
    `export const width = ${JSON.stringify(analyzed.width)};`,
    `export const height = ${JSON.stringify(analyzed.height)};`,
    `export const blurDataURL = ${JSON.stringify(analyzed.blurDataURL)};`,
    ...(staticQuery ? ["export const variants = undefined;"] : []),
    "export { src };",
    staticQuery
      ? "export default { src, width, height, blurDataURL, variants };"
      : "export default { src, width, height, blurDataURL };",
  ].join("\n");
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  code: Promise<string>;
}

interface ResolvedImage {
  /** Filesystem path read by sharp and watched for changes. */
  filePath: string;
  /** Vite id imported by the generated metadata module. */
  assetId: string;
  /** Root-relative publicDir assets deliberately stay unprocessed. */
  publicAsset?: boolean;
}

interface StaticAsset {
  contentType: `image/${string}`;
  /**
   * Where the bytes are read from at emit/serve time: the disk cache entry for
   * a generated WebP variant, or the original file for pass-through sources.
   * Holding the path instead of the buffer keeps whole images out of RAM for
   * the length of a build and for the lifetime of a dev server.
   */
  path: string;
  /**
   * Source files that produced this asset. `watchChange` removes the edited
   * source so its now-unreachable variants do not accumulate across a dev
   * session; an asset is dropped once no source claims it.
   */
  sources: Set<string>;
}

/** Vite ids, watcher paths, and Windows drive paths must compare equal. */
function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function resolvePublicFile(publicDir: string, source: string): Promise<string | undefined> {
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

function contentTypeForOriginal(format: string | undefined, extension: string): `image/${string}` {
  if (format === "svg" || extension === ".svg") return "image/svg+xml";
  if (format) return `image/${format}`;
  const subtype = extension.replace(/^\./, "") || "octet-stream";
  return `image/${subtype}`;
}

/**
 * Vite plugin enabling build-time image imports:
 *
 * ```ts
 * // vite.config.ts — add it next to pracht(); it is not included by default.
 * import { prachtImage } from "@pracht/image/vite";
 * export default { plugins: [prachtImage(), pracht({ … })] };
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
  const blurWidth = options.blurWidth ?? DEFAULT_BLUR_WIDTH;
  const blurQuality = options.blurQuality ?? DEFAULT_BLUR_QUALITY;
  const staticQuality = options.staticQuality ?? DEFAULT_STATIC_QUALITY;
  const staticWidths = [...new Set(options.staticWidths ?? DEFAULT_STATIC_WIDTHS)].sort(
    (left, right) => left - right,
  );
  if (!Number.isInteger(blurWidth) || blurWidth < 1 || blurWidth > 64) {
    throw new Error("prachtImage({ blurWidth }) expects an integer between 1 and 64.");
  }
  if (!Number.isInteger(blurQuality) || blurQuality < 1 || blurQuality > 100) {
    throw new Error("prachtImage({ blurQuality }) expects an integer between 1 and 100.");
  }
  if (!Number.isInteger(staticQuality) || staticQuality < 1 || staticQuality > 100) {
    throw new Error("prachtImage({ staticQuality }) expects an integer between 1 and 100.");
  }
  if (
    staticWidths.length === 0 ||
    staticWidths.some(
      (width) => !Number.isInteger(width) || width < 1 || width > WEBP_MAX_DIMENSION,
    )
  ) {
    throw new Error(
      `prachtImage({ staticWidths }) expects one or more integer widths between 1 and ${WEBP_MAX_DIMENSION}; ` +
        "WebP cannot encode a dimension above that.",
    );
  }
  const importSharp = createSharpImporter(options.loadSharp ?? (() => import("sharp")));
  // Include the asset id in the cache key: the same file can be imported via
  // publicDir (stable root-relative URL) or by filesystem path (hashed URL).
  // Invalidating by mtime+size picks up edits in dev while repeated
  // builds/environments reuse the sharp work for matching URL semantics.
  const cache = new Map<string, CacheEntry>();
  const resolvedImages = new Map<string, ResolvedImage>();
  const staticAssets = new Map<string, StaticAsset>();
  let publicDir = "";
  let root = process.cwd();
  let base = "/";
  let assetsDir = "assets";
  let cacheDir = "";
  let staticOutDir = "";
  let isSsrBuild = false;

  function staticAssetUrl(fileName: string): string {
    if (base === "" || base === "./") return `${base}${fileName}`;
    return `${base.endsWith("/") ? base : `${base}/`}${fileName}`;
  }

  function staticCacheDir(): string {
    return join(cacheDir, "pracht-image");
  }

  /**
   * Record a generated (or pass-through) asset by path. The same content hash
   * can legitimately be produced by two sources, so ownership is a set: an
   * entry only disappears once every source that claimed it is gone.
   */
  function registerStaticAsset(
    fileName: string,
    contentType: `image/${string}`,
    path: string,
    filePath: string,
  ): void {
    const existing = staticAssets.get(fileName);
    if (existing) {
      existing.sources.add(toPosixPath(filePath));
      return;
    }
    staticAssets.set(fileName, {
      contentType,
      path,
      sources: new Set([toPosixPath(filePath)]),
    });
  }

  async function readStaticAsset(fileName: string, asset: StaticAsset): Promise<Buffer> {
    try {
      return await readFile(asset.path);
    } catch (error) {
      throw new Error(
        `[pracht/image] Could not read the bytes for static asset ${JSON.stringify(fileName)} ` +
          `from ${JSON.stringify(asset.path)} (generated from ${[...asset.sources]
            .map((source) => JSON.stringify(source))
            .join(", ")}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let cachePrune: Promise<void> | undefined;
  /**
   * Age-based prune of the generated-variant cache, run once per plugin
   * instance. Without it, every image edit leaves its previous encodes behind
   * forever. Best effort by design: an unreadable or unwritable cache
   * directory must never fail a build.
   */
  function pruneStaticCache(): Promise<void> {
    cachePrune ??= (async () => {
      const directory = staticCacheDir();
      const entries = await readdir(directory).catch(() => [] as string[]);
      const cutoff = Date.now() - STATIC_CACHE_MAX_AGE_MS;
      await Promise.all(
        entries.map(async (entry) => {
          const entryPath = join(directory, entry);
          const stats = await stat(entryPath).catch(() => undefined);
          if (!stats?.isFile() || stats.mtimeMs >= cutoff) return;
          await unlink(entryPath).catch(() => undefined);
        }),
      );
    })().catch(() => undefined);
    return cachePrune;
  }

  async function createStaticVariants(
    sharp: SharpFactory,
    source: Uint8Array,
    filePath: string,
    intrinsicWidth: number,
    intrinsicHeight: number,
  ): Promise<PrachtImageMetadata["variants"]> {
    const metadata = await sharp(source).metadata();
    if (metadata.format === "svg" || (metadata.pages ?? 1) > 1) {
      const extension = extname(filePath).toLowerCase();
      const stem =
        basename(filePath, extname(filePath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "image";
      const hash = createHash("sha256")
        .update(STATIC_CACHE_VERSION)
        .update("original")
        .update(source)
        .digest("hex")
        .slice(0, 12);
      const fileName = posix.join(assetsDir, `${stem}.${hash}${extension}`);
      const contentType = contentTypeForOriginal(metadata.format, extension);
      // Pass-through sources are emitted byte-for-byte, so the original file
      // is its own cache entry — no need to keep a second copy in memory.
      registerStaticAsset(fileName, contentType, filePath, filePath);
      return [
        {
          src: staticAssetUrl(fileName),
          width: intrinsicWidth,
          type: contentType,
        },
      ];
    }

    // Resizing by width scales the height with it, so the widest encodable
    // variant is bounded by whichever WebP limit binds first. A 20000x8
    // panorama caps at 16383px wide; an 8x20000 stripe caps at the width whose
    // scaled height still fits. Clamping keeps the largest variant honest
    // instead of handing sharp a request it cannot encode.
    const maxWidth = Math.max(
      1,
      Math.min(
        intrinsicWidth,
        WEBP_MAX_DIMENSION,
        Math.floor((WEBP_MAX_DIMENSION * intrinsicWidth) / intrinsicHeight),
      ),
    );
    const widths = [...new Set([...staticWidths.filter((width) => width < maxWidth), maxWidth])];
    const stem = basename(filePath, extname(filePath)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "image";
    const variants = [];
    for (const width of widths) {
      const hash = createHash("sha256")
        .update(STATIC_CACHE_VERSION)
        .update(source)
        .update(
          JSON.stringify({
            width,
            quality: staticQuality,
            format: "webp",
            encoder: sharp.versions?.sharp ?? "unknown",
          }),
        )
        .digest("hex")
        .slice(0, 12);
      const fileName = posix.join(assetsDir, `${stem}.${width}.${hash}.webp`);
      const cachedPath = join(staticCacheDir(), `${hash}.webp`);
      const cached = await stat(cachedPath).catch(() => undefined);
      if (cached?.isFile()) {
        // Touch on hit so the age-based prune only ever reaches entries whose
        // source image no longer exists in this shape.
        const now = new Date();
        await utimes(cachedPath, now, now).catch(() => undefined);
      } else {
        const output = Buffer.from(
          await sharp(source)
            .rotate()
            .resize({
              width,
              height: WEBP_MAX_DIMENSION,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: staticQuality })
            .toBuffer(),
        );
        await mkdir(staticCacheDir(), { recursive: true });
        const temporaryPath = `${cachedPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, output);
          await rename(temporaryPath, cachedPath);
        } catch (error) {
          // Another build may have atomically populated the same content key.
          // Reuse its complete bytes; never accept a partially written cache
          // entry and never fail merely because equivalent work won the race.
          const concurrent = await stat(cachedPath).catch(() => undefined);
          if (!concurrent?.isFile()) throw error;
        } finally {
          await unlink(temporaryPath).catch(() => undefined);
        }
      }
      registerStaticAsset(fileName, "image/webp", cachedPath, filePath);
      variants.push({ src: staticAssetUrl(fileName), width, type: "image/webp" as const });
    }
    return variants;
  }

  async function transform(
    filePath: string,
    assetId: string,
    staticImport: boolean,
    staticQuery: boolean,
  ): Promise<string> {
    const stats = await stat(filePath).catch(() => {
      throw new Error(`[pracht/image] Could not read "${filePath}" for a "?pracht" import.`);
    });

    const cacheKey = `${filePath}\0${assetId}\0${
      staticImport ? "static" : staticQuery ? "static-fallback" : "metadata"
    }`;
    const cached = cache.get(cacheKey);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.code;
    }

    const code = (async () => {
      const [sharp, source] = await Promise.all([importSharp(), readFile(filePath)]);
      let analyzed: Omit<PrachtImageMetadata, "src">;
      try {
        analyzed = await analyzeImage(sharp, source, { blurWidth, blurQuality });
      } catch (error) {
        throw new Error(
          `[pracht/image] Failed to process "?pracht" import of "${filePath}": ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      let variants: PrachtImageMetadata["variants"];
      if (staticImport) {
        try {
          variants = await createStaticVariants(
            sharp,
            source,
            filePath,
            analyzed.width,
            analyzed.height,
          );
        } catch (error) {
          // Encoder and cache failures are reported against the import that
          // caused them; a bare sharp message names no file at all.
          throw new Error(
            `[pracht/image] Failed to generate static variants for "${filePath}": ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return createImageModuleCode(assetId, analyzed, variants, staticQuery);
    })();
    // Drop failed transforms so a fixed image (or a later sharp install) is
    // retried instead of replaying a cached rejection.
    code.catch(() => cache.delete(cacheKey));

    cache.set(cacheKey, { mtimeMs: stats.mtimeMs, size: stats.size, code });
    return code;
  }

  return {
    name: "pracht:image-imports",
    // Run before Vite's asset plugin, which would otherwise treat
    // `hero.jpg?pracht` as a plain asset URL import.
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
      base = config.base;
      assetsDir = config.build.assetsDir;
      cacheDir = config.cacheDir;
      staticOutDir = resolve(root, options.staticOutDir ?? "dist/client");
      isSsrBuild = Boolean(config.build.ssr);
    },
    buildStart() {
      // Vite runs this once per environment on both builds and dev-server
      // startup; the prune memoizes itself so the work happens once.
      return pruneStaticCache();
    },
    async resolveId(source, importer) {
      if (!isPrachtImageId(source)) return null;
      // Resolve the underlying file with the query stripped so relative
      // paths and aliases work, then re-attach the query as the module id.
      const sourcePath = stripImageQuery(source);
      const staticImport = isStaticPrachtImageId(source);
      const resolved = await this.resolve(sourcePath, importer, { skipSelf: true });
      if (!resolved) return null;

      // Vite deliberately resolves a publicDir asset such as `/hero.jpg` to
      // that root-relative URL rather than its disk location. Sharp still
      // needs the real file path, while the generated `?url` import must keep
      // the public URL so Vite preserves its stable filename and applies base.
      const publicFile =
        resolved.id === sourcePath ? await resolvePublicFile(publicDir, sourcePath) : undefined;
      const query = staticImport
        ? `${PRACHT_IMAGE_QUERY}&${STATIC_IMAGE_QUERY}`
        : PRACHT_IMAGE_QUERY;
      const moduleId = `${resolved.id}${resolved.id.includes("?") ? "&" : "?"}${query}`;
      resolvedImages.set(moduleId, {
        filePath: publicFile ?? resolved.id,
        assetId: publicFile ? sourcePath : resolved.id,
        publicAsset: publicFile !== undefined,
      });
      return moduleId;
    },
    async load(id) {
      if (!isPrachtImageId(id)) return null;
      const resolved = resolvedImages.get(id) ?? {
        filePath: stripImageQuery(id),
        assetId: stripImageQuery(id),
      };
      // Watch the source file so dev rebuilds when the image itself changes.
      this.addWatchFile(resolved.filePath);
      const staticQuery = isStaticPrachtImageId(id);
      const staticImport = staticQuery && !resolved.publicAsset;
      if (staticImport && (base === "" || base === "./")) {
        throw new Error(
          '[pracht/image] "?pracht&pracht-static" imports require an absolute Vite base ' +
            '(for example "/" or "/docs/"); a relative base cannot produce route-safe image URLs.',
        );
      }
      return transform(resolved.filePath, resolved.assetId, staticImport, staticQuery);
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://pracht.local").pathname;
        const entry = [...staticAssets].find(
          ([fileName]) =>
            new URL(staticAssetUrl(fileName), "http://pracht.local").pathname === pathname,
        );
        if (!entry) return next();
        const method = (request.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") return next();
        const respond = (source?: Uint8Array): void => {
          response.statusCode = 200;
          response.setHeader("cache-control", "no-store");
          response.setHeader("content-type", entry[1].contentType);
          response.setHeader("x-content-type-options", "nosniff");
          response.end(source);
        };
        // Variant bytes live on disk, so a HEAD needs no read at all and a GET
        // materializes them for the duration of the response only.
        if (method === "HEAD") return respond();
        readStaticAsset(entry[0], entry[1]).then(respond, next);
      });
    },
    async generateBundle() {
      const consumer = this.environment?.config?.consumer;
      const isServerBundle = consumer ? consumer === "server" : isSsrBuild;
      if (isServerBundle) return;
      for (const [fileName, asset] of staticAssets) {
        this.emitFile({ type: "asset", fileName, source: await readStaticAsset(fileName, asset) });
      }
    },
    async writeBundle() {
      const consumer = this.environment?.config?.consumer;
      const isServerBundle = consumer ? consumer === "server" : isSsrBuild;
      if (!isServerBundle) return;

      // Hydration-disabled routes are intentionally absent from the client
      // graph. Their image imports are first discovered during the server
      // build, so publish those generated files into the adapter-served client
      // directory instead of leaving prerendered HTML with dangling URLs.
      for (const [fileName, asset] of staticAssets) {
        const outputPath = resolve(staticOutDir, fileName);
        const relativePath = relative(staticOutDir, outputPath);
        if (
          relativePath === "" ||
          relativePath === ".." ||
          relativePath.startsWith(`..${sep}`) ||
          isAbsolute(relativePath)
        ) {
          throw new Error(
            `[pracht/image] Refusing to write static variant outside ${JSON.stringify(staticOutDir)}: ${JSON.stringify(fileName)}.`,
          );
        }
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, await readStaticAsset(fileName, asset));
      }
    },
    watchChange(filePath) {
      const changed = toPosixPath(filePath);

      // Variants are content-hashed, so an edit makes every entry generated
      // from the old bytes permanently unreachable. Drop them here or a long
      // dev session accumulates one dead set of variants per save.
      for (const [fileName, asset] of staticAssets) {
        if (!asset.sources.delete(changed)) continue;
        if (asset.sources.size === 0) staticAssets.delete(fileName);
      }

      if (this.environment.mode !== "dev") return;

      // publicDir modules use a root-relative URL as their module id, so Vite's
      // normal file-to-module index does not associate them with the public
      // file on disk. Invalidate those mapped modules explicitly when the
      // watcher reports a change; source-directory ids are already covered by
      // Vite and the duplicate invalidation is harmless.
      for (const [moduleId, resolved] of resolvedImages) {
        if (toPosixPath(resolved.filePath) !== changed) continue;
        const module = this.environment.moduleGraph.getModuleById(moduleId);
        if (module) this.environment.moduleGraph.invalidateModule(module);
      }
    },
  };
}
