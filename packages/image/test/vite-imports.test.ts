import { copyFile, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
  const { readFile } = await import("node:fs/promises");
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
