import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";
import { build as viteBuild } from "vite";

import { readClientBuildAssets } from "../build-metadata.js";
import { writeVercelBuildOutput } from "../build-shared.js";
import {
  collectBundleReport,
  evaluateBudgets,
  formatBudgetResults,
  formatBundleReport,
  formatBytes,
  shouldUseColor,
  type BundleReportRoute,
} from "../bundle-report.js";

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
      description:
        "Fail the build when a client JS budget is exceeded (--no-budget-fail to disable)",
    },
  },
  async run({ args }) {
    const root = process.cwd();
    const analyzeJson = Boolean(args.json);
    const analyze = Boolean(args.analyze) || analyzeJson;
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

    if (existsSync(serverEntry)) {
      const serverMod = await import(pathToFileURL(serverEntry).href);
      const { prerenderApp } = serverMod;
      const { clientEntryUrl, clientEntryJs, cssManifest, jsManifest } =
        readClientBuildAssets(root);

      const { pages, isgManifest } = await prerenderApp({
        app: serverMod.resolvedApp,
        clientEntryUrl: clientEntryUrl ?? undefined,
        cssManifest,
        jsManifest,
        registry: serverMod.registry,
        withISGManifest: true,
        concurrency: serverMod.prerenderConcurrency,
      });
      const headersManifest: Record<string, Record<string, string>> = Object.fromEntries(
        pages.map((page: { path: string; headers?: Record<string, string> }) => [
          page.path,
          page.headers ?? {},
        ]),
      );

      if (pages.length > 0) {
        log(`\n  Prerendering ${pages.length} SSG/ISG route(s)...\n`);
        for (const page of pages) {
          const filePath = resolvePrerenderOutputPath(clientDir, page.path);

          mkdirSync(dirname(filePath), { recursive: true });
          writeFileSync(filePath, page.html, "utf-8");
          log(`    ${page.path} → ${filePath.replace(root + "/", "")}`);
        }
      }

      if (Object.keys(headersManifest).length > 0) {
        const headersManifestJson = `${JSON.stringify(headersManifest, null, 2)}\n`;
        writeFileSync(
          resolve(root, "dist/server/headers-manifest.json"),
          headersManifestJson,
          "utf-8",
        );
        mkdirSync(resolve(clientDir, "_pracht"), { recursive: true });
        writeFileSync(resolve(clientDir, "_pracht/headers.json"), headersManifestJson, "utf-8");
      }

      if (Object.keys(isgManifest).length > 0) {
        const isgManifestPath = resolve(root, "dist/server/isg-manifest.json");
        writeFileSync(isgManifestPath, JSON.stringify(isgManifest, null, 2), "utf-8");
        log(
          `\n  ISG manifest → dist/server/isg-manifest.json (${Object.keys(isgManifest).length} route(s))\n`,
        );
      }

      if (serverMod.buildTarget === "cloudflare") {
        if (Object.keys(isgManifest).length > 0) {
          console.warn(
            "\n  Warning: Cloudflare adapter currently serves prerendered ISG HTML as static assets and does not perform runtime revalidation. Use SSR/SSG on Cloudflare, or deploy ISG routes to Node until Cloudflare ISG support is added.\n",
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
        const outputPath = writeVercelBuildOutput({
          functionName: serverMod.vercelFunctionName,
          isgRoutes: Object.keys(isgManifest),
          headersManifest,
          regions: serverMod.vercelRegions,
          root,
          staticRoutes: pages
            .map((page: { path: string }) => page.path)
            .filter((path: string) => !(path in isgManifest)),
        });

        log(`\n  Vercel build output → ${outputPath}\n`);
      }

      const budgets = (serverMod.budgets ?? {}) as Record<string, string | number>;
      const hasBudgets = Object.keys(budgets).length > 0;

      if (analyze || hasBudgets) {
        const routes = (serverMod.resolvedApp?.routes ?? []) as BundleReportRoute[];
        const report = collectBundleReport({
          routes,
          jsManifest,
          clientEntryJs,
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
            if (args["budget-fail"]) {
              console.error(`\n  Build failed: client JS budget exceeded for ${summary}.\n`);
              process.exitCode = 1;
              return;
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
  },
});

function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

export function resolvePrerenderOutputPath(clientDir: string, routePath: string): string {
  if (routePath.includes("\0")) {
    throw new Error(`Refusing to write prerendered route "${routePath}" with a NUL byte.`);
  }

  const root = resolve(clientDir);
  const filePath =
    routePath === "/" ? resolve(root, "index.html") : resolve(root, `.${routePath}`, "index.html");
  const relativePath = relative(root, filePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to write prerendered route "${routePath}" outside dist/client (${filePath}).`,
    );
  }

  return filePath;
}
