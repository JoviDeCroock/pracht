import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { readClientBuildAssets } from "../build-metadata.js";
import { writeVercelBuildOutput } from "../build-shared.js";

export const buildCommand = defineCommand({
  meta: {
    name: "build",
    description: "Production build (client + server)",
  },
  async run() {
    const { build: viteBuild } = await import("vite");

    const root = process.cwd();

    consola.start("Building client...");
    await viteBuild({
      root,
      build: {
        outDir: "dist",
        manifest: true,
        rollupOptions: {
          input: "virtual:pracht/client",
        },
      },
    });

    consola.start("Building server...");
    await viteBuild({
      root,
      build: {
        outDir: "dist/server",
        ssr: "virtual:pracht/server",
      },
    });

    const serverEntry = resolve(root, "dist/server/server.js");
    let clientDir: string;
    if (existsSync(resolve(root, "dist/client/.vite/manifest.json"))) {
      clientDir = resolve(root, "dist/client");
    } else {
      clientDir = resolve(root, "dist/client");
      const distRoot = resolve(root, "dist");
      mkdirSync(clientDir, { recursive: true });
      for (const entry of readdirSync(distRoot)) {
        if (entry === "server" || entry === "client") continue;
        const sourcePath = join(distRoot, entry);
        const destinationPath = join(clientDir, entry);
        cpSync(sourcePath, destinationPath, { recursive: true });
        rmSync(sourcePath, { force: true, recursive: true });
      }
    }

    if (existsSync(serverEntry)) {
      const serverMod = await import(serverEntry);
      const { prerenderApp } = serverMod;
      const { clientEntryUrl, cssManifest, jsManifest } = readClientBuildAssets(root);

      const { pages, isgManifest } = await prerenderApp({
        app: serverMod.resolvedApp,
        clientEntryUrl: clientEntryUrl ?? undefined,
        cssManifest,
        jsManifest,
        registry: serverMod.registry,
        withISGManifest: true,
      });

      if (pages.length > 0) {
        consola.start(`Prerendering ${pages.length} SSG/ISG route(s)...`);
        for (const page of pages as { path: string; html: string }[]) {
          const filePath =
            page.path === "/"
              ? join(clientDir, "index.html")
              : join(clientDir, page.path, "index.html");

          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, page.html, "utf-8");
          consola.info(`  ${page.path} -> ${filePath.replace(root + "/", "")}`);
        }
      }

      if (Object.keys(isgManifest).length > 0) {
        const isgManifestPath = resolve(root, "dist/server/isg-manifest.json");
        writeFileSync(isgManifestPath, JSON.stringify(isgManifest, null, 2), "utf-8");
        consola.info(
          `ISG manifest -> dist/server/isg-manifest.json (${Object.keys(isgManifest).length} route(s))`,
        );
      }

      if (serverMod.buildTarget === "cloudflare") {
        consola.info("Cloudflare worker -> dist/server/server.js");
        consola.info("Deploy with: wrangler deploy");
      }

      if (serverMod.buildTarget === "vercel") {
        const outputPath = writeVercelBuildOutput({
          functionName: serverMod.vercelFunctionName,
          isgRoutes: Object.keys(isgManifest),
          regions: serverMod.vercelRegions,
          root,
          staticRoutes: (pages as { path: string }[])
            .map((page) => page.path)
            .filter((path: string) => !(path in isgManifest)),
        });

        consola.info(`Vercel build output -> ${outputPath}`);
      }
    }

    consola.success("Build complete.");
  },
});
