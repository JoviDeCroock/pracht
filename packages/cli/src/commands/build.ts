import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";
import { build as viteBuild } from "vite";

import { readClientBuildAssets } from "../build-metadata.js";
import { createBuildRouteOutput, writeBuildRouteManifests } from "../build-route-output.js";
import { writeVercelBuildOutput } from "../build-shared.js";
import {
  writeGeneratedLlmsTxt,
  writeOpenApiBuildArtifacts,
  writePrerenderedPages,
} from "../build-static-output.js";
import {
  collectBundleReport,
  evaluateBudgets,
  formatBudgetResults,
  formatBundleReport,
  formatBytes,
  shouldUseColor,
  type BundleReportRoute,
} from "../bundle-report.js";

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

function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

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

    if (serverMod.buildTarget === "cloudflare") {
      if (cloudflareWorkersCacheEnabled && edgeCachedIsgPaths.length > 0) {
        log(
          `\n  ISG via Workers Caching: ${edgeCachedIsgPaths.length} route(s) render on demand and revalidate at the edge. Requires "cache": { "enabled": true } in wrangler config.\n`,
        );
      }

      // workerd validates every named export of the deployed entry module as
      // an entrypoint and rejects the build metadata (buildTarget, manifests,
      // resolvedApp, ...) that server.js exports for the prerender pass
      // above. Deploy a thin wrapper that re-exports only the default
      // handler and the Cloudflare entrypoint classes.
      const entrypointNames: string[] = Array.isArray(serverMod.cloudflareWorkerEntrypointNames)
        ? serverMod.cloudflareWorkerEntrypointNames
        : [];
      const deployEntryLines = [
        ...(entrypointNames.length > 0
          ? [`export { ${entrypointNames.join(", ")} } from "./server.js";`]
          : []),
        'export { default } from "./server.js";',
        "",
      ];
      writeFileSync(resolve(root, "dist/server/worker.js"), deployEntryLines.join("\n"), "utf-8");

      log("\n  Cloudflare worker → dist/server/worker.js\n");
      log("  Deploy with: wrangler deploy\n");
    }

    if (serverMod.buildTarget === "vercel") {
      // ISG routes deploy as Node serverless functions that re-export
      // `nodeListener` from the bundle; catch a custom server entry that
      // doesn't provide it here instead of at request time in production.
      if (Object.keys(isgManifest).length > 0 && typeof serverMod.nodeListener !== "function") {
        throw new Error(
          "The Vercel server entry does not export `nodeListener`, which the ISG routes' " +
            "serverless functions import. Generate the entry with `vercelAdapter()` or export " +
            "`createVercelNodeListener(handle)` from your custom entry module.",
        );
      }

      const outputPath = writeVercelBuildOutput({
        functionName: serverMod.vercelFunctionName,
        isgManifest,
        headersManifest,
        markdownRoutes: Object.keys(markdownManifest),
        regions: serverMod.vercelRegions,
        root,
        staticRoutes: [
          ...pages
            .map((page: { path: string }) => page.path)
            .filter((path: string) => !(path in isgManifest)),
          ...generatedStaticRoutes,
        ],
      });

      log(`\n  Vercel build output → ${outputPath}\n`);
    }

    if (typeof serverMod.finalizePrachtBuild === "function") {
      await serverMod.finalizePrachtBuild({ clientDir, root });
    }

    const budgets = (serverMod.budgets ?? {}) as Record<string, string | number>;
    const hasBudgets = Object.keys(budgets).length > 0;

    if (analyze || hasBudgets) {
      const routes = (serverMod.resolvedApp?.routes ?? []) as BundleReportRoute[];
      const report = collectBundleReport({
        routes,
        jsManifest,
        clientEntryJs,
        islandsEntryJs,
        islandFiles: Array.isArray(serverMod.islandFiles) ? serverMod.islandFiles : [],
        clientDir,
      });
      const evaluation = hasBudgets ? evaluateBudgets(report, budgets) : null;
      const color = shouldUseColor();

      if (analyzeJson) {
        console.log(
          JSON.stringify(
            {
              shared: report.shared,
              routes: report.routes,
              ...(evaluation ? { budgets: evaluation } : {}),
            },
            null,
            2,
          ),
        );
      } else if (analyze) {
        console.log(`\n${indentBlock(formatBundleReport(report, { color }))}\n`);
      }

      if (evaluation) {
        writeFileSync(
          resolve(root, "dist/server/budget-report.json"),
          `${JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              budgets,
              results: evaluation.results,
              unmatched: evaluation.unmatched,
              ok: evaluation.ok,
            },
            null,
            2,
          )}\n`,
          "utf-8",
        );

        if (!analyzeJson) {
          console.log(`\n${indentBlock(formatBudgetResults(evaluation, { color }))}\n`);
        }

        if (!evaluation.ok) {
          const failed = evaluation.results.filter((result) => !result.ok);
          const summary = failed
            .map(
              (result) =>
                `${result.path} (${formatBytes(result.gzipBytes)} gzip > ${formatBytes(result.limitBytes)})`,
            )
            .join(", ");
          if (budgetFail) {
            console.error(`\n  Build failed: client JS budget exceeded for ${summary}.\n`);
            process.exitCode = 1;
            return { buildTarget };
          }
          if (!analyzeJson) {
            console.warn(
              `\n  Warning: client JS budget exceeded for ${summary} (--no-budget-fail).\n`,
            );
          }
        }
      }
    }
  }

  log("\n  Build complete.\n");
  return { buildTarget };
}
