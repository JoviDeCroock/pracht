import { copyFile, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
});

describe("prachtImage in the Vite dev server", () => {
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
});
