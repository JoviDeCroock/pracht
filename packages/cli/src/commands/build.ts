import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";
import { build as viteBuild } from "vite";

import { finalizeBuildAdapter } from "../build-adapter-output.js";
import { runBuildAnalysis } from "../build-analysis.js";
import { readClientBuildAssets } from "../build-metadata.js";
import { createBuildRouteOutput, writeBuildRouteManifests } from "../build-route-output.js";
import {
  writeGeneratedLlmsTxt,
  writeOpenApiBuildArtifacts,
  writePrerenderedPages,
} from "../build-static-output.js";

export {
  resolveGeneratedArtifactOutputPath,
  resolvePrerenderOutputPath,
} from "../build-static-output.js";

let prerenderHooksRegistered = false;

function registerPrerenderModuleHooks(): void {
  if (prerenderHooksRegistered) return;
  prerenderHooksRegistered = true;
  try {
    // Published layout: the hooks file is a sibling tsdown entry in dist/.
    register("./prerender-module-hooks.mjs", import.meta.url);
  } catch {
    // Source layout (running the CLI with type stripping from src/).
    register("../prerender-module-hooks.ts", import.meta.url);
  }
}

export default defineCommand({
  meta: {
    name: "build",
    description: "Production build (client + server)",
  },
  args: {
    analyze: {
      type: "boolean",
      description: "Print a per-route client JavaScript report after the build",
    },
    json: {
      type: "boolean",
      description: "Output the analyze report as JSON (implies --analyze)",
    },
    "budget-fail": {
      type: "boolean",
      default: true,
      // citty renders a `default: true` boolean under its negated name, so the
      // description has to read correctly next to `--no-budget-fail`.
      description: "Downgrade an exceeded client JS budget to a warning instead of failing",
    },
  },
  async run({ args }) {
    await runBuild(process.cwd(), {
      analyze: Boolean(args.analyze),
      analyzeJson: Boolean(args.json),
      budgetFail: Boolean(args["budget-fail"]),
    });
  },
});

export interface BuildResult {
  buildTarget: string | null;
}

interface BuildOptions {
  analyze?: boolean;
  analyzeJson?: boolean;
  budgetFail?: boolean;
}

export async function runBuild(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  const analyzeJson = Boolean(options.analyzeJson);
  const analyze = Boolean(options.analyze) || analyzeJson;
  const budgetFail = options.budgetFail ?? true;
  const logLevel = analyzeJson ? ("silent" as const) : undefined;
  const log = (message: string): void => {
    if (!analyzeJson) console.log(message);
  };

  log("\n  Building client...\n");
  await viteBuild({
    root,
    logLevel,
    build: {
      outDir: "dist",
      manifest: true,
      rollupOptions: {
        input: "virtual:pracht/client",
      },
    },
  });

  log("\n  Building server...\n");
  await viteBuild({
    root,
    logLevel,
    build: {
      outDir: "dist/server",
      rollupOptions: {
        input: "virtual:pracht/server",
      },
      ssr: true,
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

  const publicDir = resolve(root, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, clientDir, { recursive: true });
  }

  let buildTarget: string | null = null;
  if (existsSync(serverEntry)) {
    // Edge server bundles keep `cloudflare:*` imports external; stub them so
    // the bundle can be imported in Node for the prerender pass below.
    registerPrerenderModuleHooks();
    const serverMod = await import(pathToFileURL(serverEntry).href);
    buildTarget = typeof serverMod.buildTarget === "string" ? serverMod.buildTarget : null;
    const { prerenderApp } = serverMod;
    const { clientEntryUrl, clientEntryJs, islandsEntryJs, cssManifest, jsManifest } =
      readClientBuildAssets(root);

    const { pages, isgManifest } = await prerenderApp({
      app: serverMod.resolvedApp,
      clientEntryUrl: clientEntryUrl ?? undefined,
      islandsEntryUrl: serverMod.islandsEntryUrl ?? undefined,
      islandsBootstrapRequired: serverMod.islandsBootstrapRequired === true,
      cssManifest,
      jsManifest,
      registry: serverMod.registry,
      withISGManifest: true,
      concurrency: serverMod.prerenderConcurrency,
    });
    const cloudflareWorkersCacheEnabled =
      serverMod.buildTarget === "cloudflare" && serverMod.cloudflareWorkersCacheEnabled === true;
    const { edgeCachedIsgPaths, headersManifest, markdownManifest, staticPages } =
      createBuildRouteOutput(pages, isgManifest, {
        cloudflareWorkersCacheEnabled,
        netlifyIsgEnabled: serverMod.buildTarget === "netlify",
      });

    writePrerenderedPages(staticPages, { clientDir, root, log });

    // The server module only exports generateLlmsTxt when the vite plugin's
    // `llmsTxt` option is enabled — disabled builds skip this entirely.
    if (typeof serverMod.generateLlmsTxt === "function") {
      writeGeneratedLlmsTxt(await serverMod.generateLlmsTxt(), { clientDir, root, log });
    }

    // Companion artifact generators can inspect the bundled server graph and
    // return static files without coupling their authoring API to core. The
    // OpenAPI plugin uses this for /openapi.json and its optional docs page.
    const generatedStaticRoutes =
      typeof serverMod.generatePrachtOpenApiArtifacts === "function"
        ? writeOpenApiBuildArtifacts(await serverMod.generatePrachtOpenApiArtifacts(), {
            clientDir,
            root,
            log,
          })
        : [];

    writeBuildRouteManifests({
      buildTarget,
      clientDir,
      headersManifest,
      isgManifest,
      log,
      markdownManifest,
      root,
    });

    finalizeBuildAdapter({
      buildTarget,
      cloudflareWorkerEntrypointNames: serverMod.cloudflareWorkerEntrypointNames,
      cloudflareWorkersCacheEnabled,
      edgeCachedIsgPaths,
      generatedStaticRoutes,
      headersManifest,
      isgManifest,
      log,
      markdownManifest,
      nodeListener: serverMod.nodeListener,
      pages,
      root,
      vercelFunctionName: serverMod.vercelFunctionName,
      vercelRegions: serverMod.vercelRegions,
    });

    if (typeof serverMod.finalizePrachtBuild === "function") {
      await serverMod.finalizePrachtBuild({ clientDir, root });
    }

    const analysis = runBuildAnalysis({
      analyze,
      analyzeJson,
      budgetFail,
      budgets: (serverMod.budgets ?? {}) as Record<string, string | number>,
      clientDir,
      clientEntryJs,
      islandFiles: Array.isArray(serverMod.islandFiles) ? serverMod.islandFiles : [],
      islandsEntryJs,
      jsManifest,
      root,
      routes: serverMod.resolvedApp?.routes ?? [],
    });
    if (analysis.shouldFailBuild) {
      process.exitCode = 1;
      return { buildTarget };
    }
  }

  log("\n  Build complete.\n");
  return { buildTarget };
}
