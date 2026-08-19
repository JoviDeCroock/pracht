import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { prachtImage } from "../src/vite.ts";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pracht-image-int-"));
  tempDirs.push(root);
  return root;
}

describe("prachtImage in a real Vite build", () => {
  it(
    "emits deterministic responsive WebP files for static imports",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const sharp = (await import("sharp")).default;
      const root = await makeRoot();
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        'import meta from "./photo.jpg?pracht&pracht-static"; console.log(meta);',
      );

      await build({
        root,
        base: "/sub/",
        logLevel: "error",
        plugins: [prachtImage({ staticWidths: [16, 32] })],
        build: {
          outDir: join(root, "dist"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "assets"));
      const variants = assets.filter((file) => file.endsWith(".webp"));
      expect(variants).toHaveLength(2);
      expect(assets.some((file) => file.endsWith(".jpg"))).toBe(false);
      const widths = await Promise.all(
        variants.map(
          async (file) => (await sharp(join(root, "dist", "assets", file)).metadata()).width,
        ),
      );
      expect(widths.sort((left, right) => left! - right!)).toEqual([16, 32]);

      const chunkName = assets.find((file) => file.endsWith(".js"));
      const chunk = await readFile(join(root, "dist", "assets", chunkName!), "utf8");
      expect(chunk).toContain("/sub/assets/photo.16.");
      expect(chunk).toContain("/sub/assets/photo.32.");
      expect(chunk).toMatch(/type:[`'"]image\/webp[`'"]/);
    },
  );

  it(
    "emits static variants at the output root when assetsDir is empty",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        'import meta from "./photo.jpg?pracht&pracht-static"; console.log(meta);',
      );

      await build({
        root,
        logLevel: "error",
        plugins: [prachtImage({ staticWidths: [16] })],
        build: {
          assetsDir: "",
          outDir: join(root, "dist"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const output = await readdir(join(root, "dist"));
      const variants = output.filter((file) => file.endsWith(".webp"));
      expect(variants).toHaveLength(2);
      const chunkName = output.find((file) => file.endsWith(".js"));
      const chunk = await readFile(join(root, "dist", chunkName!), "utf8");
      expect(chunk).toContain(`/photo.16.`);
      expect(chunk).not.toContain(`//photo.16.`);
    },
  );

  it(
    "emits a hashed URL (never a data: URI), respects base, and dedupes plain imports",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      // landscape.jpg is 355 bytes — far below the default 4 KB
      // assetsInlineLimit. Without `no-inline` in the generated module, Vite
      // inlines it and `src` becomes a `data:` URI, which breaks
      // optimization-endpoint loaders (`?url=data%3A…`) and double-ships the
      // bytes next to blurDataURL.
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        [
          'import meta from "./photo.jpg?pracht";',
          'import plain from "./photo.jpg";',
          "console.log(meta, plain);",
        ].join("\n"),
      );

      await build({
        root,
        base: "/sub/",
        logLevel: "error",
        plugins: [prachtImage()],
        build: {
          outDir: join(root, "dist"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "assets"));
      const images = assets.filter((file) => file.endsWith(".jpg"));
      // Exactly one emitted file even though the image is imported twice
      // (`?pracht` and plain): assets are content-hashed and deduped.
      expect(images).toHaveLength(1);

      const chunkName = assets.find((file) => file.endsWith(".js"));
      const chunk = await readFile(join(root, "dist", "assets", chunkName!), "utf8");
      // Metadata `src` is the base-prefixed hashed URL, never an inlined
      // `data:` payload. (The plain import may still inline per Vite's normal
      // assetsInlineLimit — that path keeps stock asset semantics.)
      expect(chunk).toMatch(new RegExp(`src:[\`"']/sub/assets/${images[0]}`));
      expect(chunk).not.toMatch(/src:[`"']data:/);
      // The blur placeholder is still the tiny build-time WebP.
      expect(chunk).toContain("data:image/webp;base64,");
    },
  );

  it(
    "reads publicDir images from disk while preserving their public URL semantics",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await mkdir(join(root, "public"));
      await copyFile(fixture("landscape.jpg"), join(root, "public", "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        [
          'import publicMeta, { variants as publicVariants } from "/photo.jpg?pracht&pracht-static";',
          'import sourceMeta from "./public/photo.jpg?pracht";',
          "console.log(publicMeta, publicVariants, sourceMeta);",
        ].join("\n"),
      );

      await build({
        root,
        base: "/sub/",
        logLevel: "error",
        plugins: [prachtImage()],
        build: {
          outDir: join(root, "dist"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "assets"));
      const chunkName = assets.find((file) => file.endsWith(".js"));
      const chunk = await readFile(join(root, "dist", "assets", chunkName!), "utf8");
      expect(chunk).toMatch(/src:[`"']\/sub\/photo\.jpg/);
      const images = assets.filter((file) => file.endsWith(".jpg"));
      expect(images).toHaveLength(1);
      expect(assets.some((file) => file.endsWith(".webp"))).toBe(false);
      expect(chunk).toMatch(new RegExp(`src:[\`"']/sub/assets/${images[0]}`));
      expect(chunk).toContain("width:32");
      expect(chunk).toContain("height:20");
      expect(chunk).toContain("data:image/webp;base64,");
      await expect(readFile(join(root, "dist", "photo.jpg"))).resolves.toEqual(
        await readFile(fixture("landscape.jpg")),
      );
    },
  );

  it(
    "rejects static variants with a relative base instead of emitting route-unsafe URLs",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        'import meta from "./photo.jpg?pracht&pracht-static"; console.log(meta);',
      );

      await expect(
        build({
          root,
          base: "./",
          logLevel: "silent",
          plugins: [prachtImage({ staticWidths: [16] })],
          build: {
            outDir: join(root, "dist"),
            rollupOptions: { input: join(root, "entry.js") },
          },
        }),
      ).rejects.toThrow(/require an absolute Vite base/);
    },
  );

  it(
    "keeps SVG and animated static imports in their original formats",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("icon.svg"), join(root, "icon.svg"));
      await copyFile(fixture("animated.gif"), join(root, "animated.gif"));
      await writeFile(
        join(root, "entry.js"),
        [
          'import icon from "./icon.svg?pracht&pracht-static";',
          'import animation from "./animated.gif?pracht&pracht-static";',
          "console.log(icon, animation);",
        ].join("\n"),
      );

      await build({
        root,
        logLevel: "error",
        plugins: [prachtImage({ staticWidths: [8] })],
        build: {
          outDir: join(root, "dist"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "assets"));
      expect(assets.some((file) => file.endsWith(".webp"))).toBe(false);
      expect(assets.some((file) => file.endsWith(".svg"))).toBe(true);
      expect(assets.some((file) => file.endsWith(".gif"))).toBe(true);
    },
  );

  it(
    "publishes variants discovered only by an SSR graph into the client asset directory",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(
        join(root, "entry.js"),
        'import meta from "./photo.jpg?pracht&pracht-static"; export default meta;',
      );

      await build({
        root,
        logLevel: "error",
        plugins: [prachtImage({ staticWidths: [16] })],
        build: {
          ssr: true,
          outDir: join(root, "dist", "server"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "client", "assets"));
      expect(assets.filter((file) => file.endsWith(".webp"))).toHaveLength(2);
      await expect(readdir(join(root, "dist", "server", "assets"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it(
    "publishes original SVG and animated assets discovered only by an SSR graph",
    { timeout: 60_000 },
    async () => {
      const { build } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("icon.svg"), join(root, "icon.svg"));
      await copyFile(fixture("animated.gif"), join(root, "animated.gif"));
      await writeFile(
        join(root, "entry.js"),
        [
          'import icon, { variants as iconVariants } from "./icon.svg?pracht&pracht-static";',
          'import animation from "./animated.gif?pracht&pracht-static";',
          "console.log(icon, iconVariants, animation);",
          "export default [icon, animation];",
        ].join("\n"),
      );

      await build({
        root,
        logLevel: "error",
        plugins: [prachtImage()],
        build: {
          ssr: true,
          outDir: join(root, "dist", "server"),
          rollupOptions: { input: join(root, "entry.js") },
        },
      });

      const assets = await readdir(join(root, "dist", "client", "assets"));
      expect(assets.some((file) => file.endsWith(".svg"))).toBe(true);
      expect(assets.some((file) => file.endsWith(".gif"))).toBe(true);
      const serverEntry = await readFile(join(root, "dist", "server", "entry.mjs"), "utf8");
      expect(serverEntry).toMatch(/["']\/assets\/icon\.[a-f0-9]+\.svg/);
      expect(serverEntry).toMatch(/["']\/assets\/animated\.[a-f0-9]+\.gif/);
    },
  );
});

describe("prachtImage in the Vite dev server", () => {
  it("serves generated static variants directly in development", { timeout: 60_000 }, async () => {
    const { createServer } = await import("vite");
    const sharp = (await import("sharp")).default;
    const root = await makeRoot();
    await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
    await writeFile(
      join(root, "main.js"),
      'import meta from "./photo.jpg?pracht&pracht-static";\n',
    );
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');

    const server = await createServer({
      root,
      logLevel: "error",
      plugins: [prachtImage({ staticWidths: [16] })],
      server: { host: "127.0.0.1", port: 0, hmr: false },
    });

    try {
      await server.listen();
      const transformed = await server.transformRequest("/photo.jpg?pracht&pracht-static");
      const variantPath = transformed?.code.match(/\/assets\/photo\.16\.[a-f0-9]+\.webp/)?.[0];
      expect(variantPath).toBeDefined();

      const address = server.httpServer?.address();
      expect(address && typeof address === "object").toBe(true);
      if (!address || typeof address !== "object") throw new Error("Vite did not expose a port");
      const response = await fetch(`http://127.0.0.1:${address.port}${variantPath}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      expect(metadata.width).toBe(16);
    } finally {
      await server.close();
    }
  });

  it(
    "invalidates Vite's transform cache when the image changes on disk",
    { timeout: 60_000 },
    async () => {
      const { createServer } = await import("vite");
      const root = await makeRoot();
      await copyFile(fixture("landscape.jpg"), join(root, "photo.jpg"));
      await writeFile(join(root, "main.js"), 'import meta from "./photo.jpg?pracht";\n');
      await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');

      const server = await createServer({
        root,
        logLevel: "error",
        plugins: [prachtImage()],
        server: {
          middlewareMode: true,
          hmr: false,
          // Deterministic change detection on temp dirs across platforms.
          watch: { usePolling: true, interval: 50 },
        },
      });

      try {
        const first = await server.transformRequest("/photo.jpg?pracht");
        expect(first?.code).toContain("export const width = 32;");

        // Replace the image: the EXIF-rotated fixture displays as 20x32. The
        // plugin's own mtime cache is only half the story — Vite also caches
        // the transformed module, so the watcher must invalidate the module
        // graph or importers keep the stale metadata.
        await copyFile(fixture("exif-rotated.jpg"), join(root, "photo.jpg"));
        await utimes(join(root, "photo.jpg"), new Date(), new Date(Date.now() + 5000));

        const mod = await server.moduleGraph.getModuleByUrl("/photo.jpg?pracht");
        expect(mod).toBeDefined();
        const deadline = Date.now() + 10_000;
        while (mod!.transformResult != null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(mod!.transformResult).toBeNull();

        const second = await server.transformRequest("/photo.jpg?pracht");
        expect(second?.code).toContain("export const width = 20;");
        expect(second?.code).toContain("export const height = 32;");
      } finally {
        await server.close();
      }
    },
  );

  it("invalidates metadata when an image in publicDir changes", { timeout: 60_000 }, async () => {
    const { createServer } = await import("vite");
    const root = await makeRoot();
    await mkdir(join(root, "public"));
    const image = join(root, "public", "photo.jpg");
    await copyFile(fixture("landscape.jpg"), image);
    await writeFile(join(root, "main.js"), 'import meta from "/photo.jpg?pracht";\n');
    await writeFile(join(root, "index.html"), '<script type="module" src="/main.js"></script>');

    const server = await createServer({
      root,
      logLevel: "error",
      plugins: [prachtImage()],
      server: {
        middlewareMode: true,
        hmr: false,
        watch: { usePolling: true, interval: 50 },
      },
    });

    try {
      const first = await server.transformRequest("/photo.jpg?pracht");
      expect(first?.code).toContain("export const width = 32;");
      expect(first?.code).toMatch(/import src from "\/photo\.jpg\?[^"]*url&no-inline";/);

      await copyFile(fixture("exif-rotated.jpg"), image);
      await utimes(image, new Date(), new Date(Date.now() + 5000));

      const mod = await server.moduleGraph.getModuleByUrl("/photo.jpg?pracht");
      expect(mod).toBeDefined();
      const deadline = Date.now() + 10_000;
      while (mod!.transformResult != null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(mod!.transformResult).toBeNull();

      const second = await server.transformRequest("/photo.jpg?pracht");
      expect(second?.code).toContain("export const width = 20;");
      expect(second?.code).toContain("export const height = 32;");
    } finally {
      await server.close();
    }
  });
});
