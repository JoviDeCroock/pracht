import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  analyzeImage,
  createImageModuleCode,
  isPrachtImageId,
  prachtImage,
  stripImageQuery,
} from "../src/vite.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const sharpFactory = sharp as unknown as Parameters<typeof analyzeImage>[0];

const BLUR_OPTIONS = { blurWidth: 8, blurQuality: 70 };

async function readFixture(name: string): Promise<Uint8Array> {
  return readFile(fixture(name));
}

function decodeBlurDataURL(blurDataURL: string): Buffer {
  expect(blurDataURL).toMatch(/^data:image\/webp;base64,/);
  return Buffer.from(blurDataURL.slice("data:image/webp;base64,".length), "base64");
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("analyzeImage", () => {
  it("reads intrinsic dimensions and generates a tiny webp blur", async () => {
    const result = await analyzeImage(
      sharpFactory,
      await readFixture("landscape.jpg"),
      BLUR_OPTIONS,
    );

    expect(result.width).toBe(32);
    expect(result.height).toBe(20);
    expect(result.blurDataURL).toBeDefined();
    // The inline placeholder must stay small — it ships in HTML and JS.
    expect(result.blurDataURL!.length).toBeLessThan(1000);

    const blur = decodeBlurDataURL(result.blurDataURL!);
    const meta = await sharp(blur).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(5); // 32x20 aspect preserved
  });

  it("swaps dimensions for EXIF-rotated images and orients the blur", async () => {
    const result = await analyzeImage(
      sharpFactory,
      await readFixture("exif-rotated.jpg"),
      BLUR_OPTIONS,
    );

    // The raster is 32x20 with orientation 6: it displays as 20x32.
    expect(result.width).toBe(20);
    expect(result.height).toBe(32);

    const blur = decodeBlurDataURL(result.blurDataURL!);
    const meta = await sharp(blur).metadata();
    // The blur is portrait too — .rotate() applied the EXIF orientation.
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(13);
  });

  it("converts CMYK JPEGs to an sRGB blur", async () => {
    const result = await analyzeImage(sharpFactory, await readFixture("cmyk.jpg"), BLUR_OPTIONS);

    expect(result.width).toBe(32);
    expect(result.height).toBe(20);
    const meta = await sharp(decodeBlurDataURL(result.blurDataURL!)).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.space).toBe("srgb");
  });

  it("blurs the first frame of an animated GIF", async () => {
    const result = await analyzeImage(
      sharpFactory,
      await readFixture("animated.gif"),
      BLUR_OPTIONS,
    );

    expect(result.width).toBe(16);
    expect(result.height).toBe(16);
    const blur = decodeBlurDataURL(result.blurDataURL!);
    const meta = await sharp(blur).metadata();
    // A static, single-frame placeholder (first frame is solid red).
    expect(meta.pages ?? 1).toBe(1);
    const { dominant } = await sharp(blur).stats();
    expect(dominant.r).toBeGreaterThan(200);
    expect(dominant.g).toBeLessThan(50);
  });

  it("passes SVG dimensions through without generating a blur", async () => {
    const result = await analyzeImage(sharpFactory, await readFixture("icon.svg"), BLUR_OPTIONS);

    expect(result).toEqual({ width: 48, height: 24 });
  });

  it("handles a 1x1 image without upscaling the blur", async () => {
    const onePixel = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    const result = await analyzeImage(sharpFactory, onePixel, BLUR_OPTIONS);

    expect(result.width).toBe(1);
    expect(result.height).toBe(1);
    // withoutEnlargement: the blur must not upscale a source smaller than
    // blurWidth.
    const meta = await sharp(decodeBlurDataURL(result.blurDataURL!)).metadata();
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
  });

  it("produces byte-identical blurDataURLs for the same input (SSG determinism)", async () => {
    const source = await readFixture("landscape.jpg");
    const first = await analyzeImage(sharpFactory, source, BLUR_OPTIONS);
    const second = await analyzeImage(sharpFactory, source, BLUR_OPTIONS);

    expect(second.blurDataURL).toBe(first.blurDataURL);
  });

  it("fails with a clear error when dimensions cannot be determined", async () => {
    const stub = (() => ({
      metadata: () => Promise.resolve({ format: "svg" }),
    })) as unknown as Parameters<typeof analyzeImage>[0];

    await expect(analyzeImage(stub, new Uint8Array(), BLUR_OPTIONS)).rejects.toThrow(
      /could not determine intrinsic dimensions/,
    );
  });
});

describe("module id handling", () => {
  it("detects the ?pracht query, alone or combined", () => {
    expect(isPrachtImageId("/a/hero.jpg?pracht")).toBe(true);
    expect(isPrachtImageId("/a/hero.jpg?pracht&import")).toBe(true);
    expect(isPrachtImageId("/a/hero.jpg?import&pracht")).toBe(true);
    expect(isPrachtImageId("/a/hero.jpg")).toBe(false);
    expect(isPrachtImageId("/a/hero.jpg?url")).toBe(false);
    expect(isPrachtImageId("/a/hero.jpg?prachtx")).toBe(false);
    expect(isPrachtImageId("/a/hero.jpg?pracht-client")).toBe(false);
  });

  it("strips the query to recover the file path", () => {
    expect(stripImageQuery("/a/hero.jpg?pracht&import")).toBe("/a/hero.jpg");
    expect(stripImageQuery("/a/hero.jpg")).toBe("/a/hero.jpg");
  });
});

describe("createImageModuleCode", () => {
  it("delegates the asset to Vite via a ?url import and exports metadata", () => {
    const code = createImageModuleCode("/repo/src/hero.jpg", {
      width: 640,
      height: 480,
      blurDataURL: "data:image/webp;base64,AA==",
    });

    // `no-inline` is load-bearing: without it, images under
    // `assetsInlineLimit` (default 4 KB) become `data:` URIs, which breaks
    // optimization-endpoint loaders and double-ships bytes next to the blur.
    expect(code).toContain('import src from "/repo/src/hero.jpg?url&no-inline";');
    expect(code).toContain("export const width = 640;");
    expect(code).toContain("export const height = 480;");
    expect(code).toContain('export const blurDataURL = "data:image/webp;base64,AA==";');
    expect(code).toContain("export default { src, width, height, blurDataURL };");
  });

  it("normalizes Windows path separators in the generated import", () => {
    const code = createImageModuleCode("C:\\repo\\src\\hero.jpg", {
      width: 1,
      height: 1,
    });

    expect(code).toContain('import src from "C:/repo/src/hero.jpg?url&no-inline";');
    expect(code).not.toContain("\\\\");
  });

  it("keeps the static-query variants export available for unprocessed public assets", () => {
    const code = createImageModuleCode("/photo.jpg", { width: 32, height: 20 }, undefined, true);

    expect(code).toContain("export const variants = undefined;");
    expect(code).toContain("export default { src, width, height, blurDataURL, variants };");
  });
});

describe("prachtImage plugin", () => {
  function loadWith(
    plugin: ReturnType<typeof prachtImage>,
    id: string,
    addWatchFile: (id: string) => void = () => {},
  ): Promise<string> {
    const load = plugin.load as (this: { addWatchFile(id: string): void }, id: string) => unknown;
    return Promise.resolve(load.call({ addWatchFile }, id)) as Promise<string>;
  }

  it("validates its options", () => {
    expect(() => prachtImage({ blurWidth: 0 })).toThrow(/blurWidth/);
    expect(() => prachtImage({ blurQuality: 101 })).toThrow(/blurQuality/);
    expect(() => prachtImage({ staticQuality: 0 })).toThrow(/staticQuality/);
    expect(() => prachtImage({ staticWidths: [] })).toThrow(/staticWidths/);
    expect(() => prachtImage({ staticWidths: [320, 1.5] })).toThrow(/staticWidths/);
  });

  it("transforms ?pracht ids and watches the source file", async () => {
    const plugin = prachtImage();
    const watched: string[] = [];
    const code = await loadWith(plugin, `${fixture("landscape.jpg")}?pracht`, (id) =>
      watched.push(id),
    );

    expect(watched).toEqual([fixture("landscape.jpg")]);
    expect(code).toContain("export const width = 32;");
    expect(code).toContain("export const height = 20;");
    expect(code).toContain("data:image/webp;base64,");
    expect(code).toContain(`?url&no-inline";`);
  });

  it("ignores ids without the ?pracht query", async () => {
    const plugin = prachtImage();
    await expect(loadWith(plugin, fixture("landscape.jpg"))).resolves.toBeNull();
    await expect(loadWith(plugin, `${fixture("landscape.jpg")}?url`)).resolves.toBeNull();
  });

  it("re-transforms when the source image changes on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pracht-image-"));
    tempDirs.push(dir);
    const file = join(dir, "photo.jpg");
    await copyFile(fixture("landscape.jpg"), file);

    const plugin = prachtImage();
    const first = await loadWith(plugin, `${file}?pracht`);
    expect(first).toContain("export const width = 32;");

    // Same path, different content and mtime: the cache must not serve the
    // stale metadata.
    await copyFile(fixture("exif-rotated.jpg"), file);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    const second = await loadWith(plugin, `${file}?pracht`);
    expect(second).toContain("export const width = 20;");
    expect(second).toContain("export const height = 32;");
  });

  it("serves identical repeated loads from the cache", async () => {
    const loadSharp = vi.fn(() => import("sharp"));
    const plugin = prachtImage({ loadSharp });

    const first = await loadWith(plugin, `${fixture("landscape.jpg")}?pracht`);
    const second = await loadWith(plugin, `${fixture("landscape.jpg")}?pracht`);
    expect(second).toBe(first);
    expect(loadSharp).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent transforms of the same image", async () => {
    const loadSharp = vi.fn(() => import("sharp"));
    const plugin = prachtImage({ loadSharp });
    const id = `${fixture("landscape.jpg")}?pracht`;

    // Fired without awaiting: the stat continuations race, but the first to
    // finish seeds the cache and the rest must reuse it — sharp work runs once.
    const [first, second, third] = await Promise.all([
      loadWith(plugin, id),
      loadWith(plugin, id),
      loadWith(plugin, id),
    ]);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(loadSharp).toHaveBeenCalledTimes(1);
  });

  it("errors with the file path for a zero-byte file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pracht-image-"));
    tempDirs.push(dir);
    const file = join(dir, "empty.jpg");
    await writeFile(file, "");

    const plugin = prachtImage();
    await expect(loadWith(plugin, `${file}?pracht`)).rejects.toThrow(file);
  });

  it("errors clearly when sharp is not installed", async () => {
    const plugin = prachtImage({ loadSharp: () => Promise.reject(new Error("not found")) });

    await expect(loadWith(plugin, `${fixture("landscape.jpg")}?pracht`)).rejects.toThrow(
      /pnpm add -D sharp/,
    );
  });

  it("errors with the file path when the source is not an image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pracht-image-"));
    tempDirs.push(dir);
    const file = join(dir, "not-an-image.txt");
    await writeFile(file, "plain text");

    const plugin = prachtImage();
    await expect(loadWith(plugin, `${file}?pracht`)).rejects.toThrow(file);
  });

  it("errors with the file path when the file does not exist", async () => {
    const plugin = prachtImage();
    await expect(loadWith(plugin, "/definitely/missing.jpg?pracht")).rejects.toThrow(
      /Could not read "\/definitely\/missing\.jpg"/,
    );
  });
});

type ImagePlugin = ReturnType<typeof prachtImage>;
interface EmittedAsset {
  fileName: string;
  source: Uint8Array;
}

/** Apply the config fields the plugin reads, without booting Vite. */
function configureWith(plugin: ImagePlugin, cacheDir: string, base = "/"): void {
  const hook = plugin.configResolved as unknown as (config: unknown) => void;
  hook({
    root: cacheDir,
    publicDir: "",
    base,
    cacheDir,
    build: { assetsDir: "assets", ssr: false },
  });
}

function runBuildStart(plugin: ImagePlugin): Promise<void> {
  const hook = plugin.buildStart as unknown as (this: unknown) => void | Promise<void>;
  return Promise.resolve(hook.call({}));
}

async function emitClientAssets(plugin: ImagePlugin): Promise<EmittedAsset[]> {
  const emitted: EmittedAsset[] = [];
  const hook = plugin.generateBundle as unknown as (this: unknown) => Promise<void>;
  await hook.call({
    environment: { config: { consumer: "client" } },
    emitFile: (asset: EmittedAsset) => emitted.push(asset),
  });
  return emitted;
}

function runWatchChange(plugin: ImagePlugin, filePath: string): void {
  const hook = plugin.watchChange as unknown as (this: unknown, filePath: string) => void;
  hook.call(
    {
      environment: {
        mode: "dev",
        moduleGraph: { getModuleById: () => undefined, invalidateModule: () => {} },
      },
    },
    filePath,
  );
}

function loadStatic(plugin: ImagePlugin, filePath: string): Promise<string> {
  const load = plugin.load as (this: { addWatchFile(id: string): void }, id: string) => unknown;
  return Promise.resolve(
    load.call({ addWatchFile: () => {} }, `${filePath}?pracht&pracht-static`),
  ) as Promise<string>;
}

function parseVariants(code: string): Array<{ src: string; width: number; type: string }> {
  const match = code.match(/^export const variants = (.+);$/m);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]) as Array<{ src: string; width: number; type: string }>;
}

async function writeStripe(path: string, width: number, height: number): Promise<void> {
  await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 80 } },
  })
    .png()
    .toFile(path);
}

async function makeWorkspace(): Promise<{ dir: string; cacheDir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pracht-image-static-"));
  tempDirs.push(dir);
  return { dir, cacheDir: join(dir, ".cache") };
}

describe("static variants beyond WebP's dimension limit", () => {
  it("rejects configured widths WebP cannot encode", () => {
    expect(() => prachtImage({ staticWidths: [16_384] })).toThrow(/staticWidths/);
    expect(() => prachtImage({ staticWidths: [16_384] })).toThrow(/16383/);
    expect(() => prachtImage({ staticWidths: [16_383] })).not.toThrow();
  });

  it("clamps the intrinsic-width variant of an over-wide source", { timeout: 60_000 }, async () => {
    const { dir, cacheDir } = await makeWorkspace();
    const file = join(dir, "panorama.png");
    await writeStripe(file, 16_400, 8);

    const plugin = prachtImage({ staticWidths: [16] });
    configureWith(plugin, cacheDir);
    const code = await loadStatic(plugin, file);

    // The intrinsic width stays in the metadata; only the encoded variant
    // is capped, so a panorama builds instead of failing in sharp.
    expect(code).toContain("export const width = 16400;");
    expect(parseVariants(code).map((variant) => variant.width)).toEqual([16, 16_383]);

    const emitted = await emitClientAssets(plugin);
    const widest = emitted.find((asset) => asset.fileName.includes(".16383."));
    expect(widest).toBeDefined();
    const meta = await sharp(Buffer.from(widest!.source)).metadata();
    expect(meta.width).toBe(16_383);
    expect(meta.height).toBeLessThanOrEqual(16_383);
  });

  it("clamps by height when a narrow source is taller than WebP allows", async () => {
    const { dir, cacheDir } = await makeWorkspace();
    const file = join(dir, "stripe.png");
    await writeStripe(file, 8, 16_400);

    const plugin = prachtImage({ staticWidths: [16] });
    configureWith(plugin, cacheDir);
    const code = await loadStatic(plugin, file);

    // Resizing by width scales the height with it: 8px wide would still encode
    // a 16400px-tall image, so the width has to come down to 7.
    expect(parseVariants(code).map((variant) => variant.width)).toEqual([7]);

    const [emitted] = await emitClientAssets(plugin);
    const meta = await sharp(Buffer.from(emitted.source)).metadata();
    expect(meta.width).toBe(7);
    expect(meta.height).toBeLessThanOrEqual(16_383);
    // The blur placeholder shares the limit and must not blow up either.
    expect(code).toContain("data:image/webp;base64,");
  });

  it("names the source file when a variant still cannot be encoded", async () => {
    const { dir, cacheDir } = await makeWorkspace();
    const file = join(dir, "photo.jpg");
    await copyFile(fixture("landscape.jpg"), file);

    // A sharp stub that encodes the 8px blur but refuses the 16px variant.
    interface StubPipeline {
      metadata(): Promise<{ format: string; width: number; height: number }>;
      rotate(): StubPipeline;
      resize(options: { width: number }): StubPipeline;
      webp(): StubPipeline;
      toBuffer(): Promise<Uint8Array>;
    }
    const loadSharp = () =>
      Promise.resolve({
        default: () => {
          let requestedWidth = 0;
          const pipeline: StubPipeline = {
            metadata: () => Promise.resolve({ format: "jpeg", width: 32, height: 20 }),
            rotate: () => pipeline,
            resize: ({ width }) => {
              requestedWidth = width;
              return pipeline;
            },
            webp: () => pipeline,
            toBuffer: () =>
              requestedWidth === 8
                ? Promise.resolve(new Uint8Array([1, 2, 3]))
                : Promise.reject(new Error("Processed image is too large for the WebP format")),
          };
          return pipeline;
        },
      });

    const plugin = prachtImage({ staticWidths: [16], loadSharp });
    configureWith(plugin, cacheDir);

    await expect(loadStatic(plugin, file)).rejects.toThrow(file);
    await expect(loadStatic(plugin, file)).rejects.toThrow(/too large for the WebP format/);
  });
});

describe("static variant cache and memory hygiene", () => {
  it("prunes cache entries that have gone stale and keeps fresh ones", async () => {
    const { cacheDir } = await makeWorkspace();
    const cacheHome = join(cacheDir, "pracht-image");
    await mkdir(cacheHome, { recursive: true });
    const stale = join(cacheHome, "stale.webp");
    const fresh = join(cacheHome, "fresh.webp");
    await writeFile(stale, "stale");
    await writeFile(fresh, "fresh");
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(stale, longAgo, longAgo);

    const plugin = prachtImage();
    configureWith(plugin, cacheDir);
    await runBuildStart(plugin);

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fresh)).resolves.toBeDefined();
  });

  it("never fails the build when the cache directory cannot be read", async () => {
    const plugin = prachtImage();
    configureWith(plugin, join(tmpdir(), "pracht-image-missing-cache-dir"));

    await expect(runBuildStart(plugin)).resolves.toBeUndefined();
  });

  it("touches cache entries on a hit so live variants survive pruning", async () => {
    const { dir, cacheDir } = await makeWorkspace();
    const file = join(dir, "photo.jpg");
    await copyFile(fixture("landscape.jpg"), file);

    const first = prachtImage({ staticWidths: [16] });
    configureWith(first, cacheDir);
    await loadStatic(first, file);

    const cacheHome = join(cacheDir, "pracht-image");
    const [entry] = (await readdir(cacheHome)).filter((name) => name.endsWith(".webp"));
    expect(entry).toBeDefined();
    const cached = join(cacheHome, entry);
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await utimes(cached, longAgo, longAgo);

    // A second plugin instance reuses the cached bytes; the hit must refresh
    // the mtime or the next prune would delete a variant that is still in use.
    const second = prachtImage({ staticWidths: [16] });
    configureWith(second, cacheDir);
    await loadStatic(second, file);

    const stats = await stat(cached);
    expect(stats.mtimeMs).toBeGreaterThan(longAgo.getTime());
  });

  it("evicts a source's stale variants when the watcher reports a change", async () => {
    const { dir, cacheDir } = await makeWorkspace();
    const file = join(dir, "photo.jpg");
    await copyFile(fixture("landscape.jpg"), file);

    const plugin = prachtImage({ staticWidths: [16] });
    configureWith(plugin, cacheDir);
    await loadStatic(plugin, file);
    const before = (await emitClientAssets(plugin)).map((asset) => asset.fileName);
    expect(before).toHaveLength(2);

    await copyFile(fixture("exif-rotated.jpg"), file);
    await utimes(file, new Date(), new Date(Date.now() + 5000));
    runWatchChange(plugin, file);
    await loadStatic(plugin, file);

    // Without eviction every dev-session save would leave its unreachable,
    // content-hashed variants behind.
    const after = (await emitClientAssets(plugin)).map((asset) => asset.fileName);
    expect(after).toHaveLength(2);
    expect(after.some((fileName) => before.includes(fileName))).toBe(false);
  });
});
