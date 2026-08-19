import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";
import { build as viteBuild } from "vite";

import { readClientBuildAssets } from "../build-metadata.js";
import { writeVercelBuildOutput } from "../build-shared.js";
import {
  isStaticExportBuild,
  resolvePrerenderOutputPath,
  resolveStaticExportOutputPath,
  validateStaticExport,
  validateStaticExportOutputPaths,
  writeStaticExportArtifacts,
} from "../build-static.js";
import {
  collectBundleReport,
  evaluateBudgets,
  formatBudgetResults,
  formatBundleReport,
  formatBytes,
  shouldUseColor,
  type BundleReportRoute,
} from "../bundle-report.js";

export { resolvePrerenderOutputPath } from "../build-static.js";

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

// Mirrors getTimeRevalidateSeconds from @pracht/core without importing it:
// the CLI reads the manifest the built server bundle produced, so the entry
// shape (single policy or array) is the framework's RouteRevalidate.
function hasTimeRevalidate(revalidate: unknown): boolean {
  const policies = Array.isArray(revalidate) ? revalidate : [revalidate];
  return policies.some(
    (policy) =>
      typeof policy === "object" &&
      policy !== null &&
      (policy as { kind?: unknown }).kind === "time" &&
      typeof (policy as { seconds?: unknown }).seconds === "number" &&
      (policy as { seconds: number }).seconds > 0,
  );
}

function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}

function readContentArtifactHeaders(clientDir: string): Record<string, Record<string, string>> {
  const metadataPath = resolve(clientDir, "_pracht/content-headers.json");
  if (!existsSync(metadataPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  rmSync(metadataPath, { force: true });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The content artifact headers manifest is invalid.");
  }
  for (const [path, headers] of Object.entries(parsed)) {
    if (
      !path.startsWith("/") ||
      !headers ||
      typeof headers !== "object" ||
      Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== "string")
    ) {
      throw new Error("The content artifact headers manifest is invalid.");
    }
  }
  return parsed as Record<string, Record<string, string>>;
}

export function assertNoContentArtifactPathCollision(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  path: string,
  generator: string,
): void {
  const collision = findContentArtifactOutputCollision(contentArtifactHeaders, path.slice(1));
  if (!collision) return;
  throw new Error(
    `Content artifact ${JSON.stringify(collision)} collides with ${generator}. Configure a different content artifact path or disable one generator.`,
  );
}

export function assertNoContentArtifactOutputCollision(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  outputPath: string,
  generator: string,
): void {
  const collision = findContentArtifactOutputCollision(contentArtifactHeaders, outputPath);
  if (!collision) return;
  throw new Error(
    `Content artifact ${JSON.stringify(collision)} collides with ${generator}. Configure a different output path or disable one generator.`,
  );
}

function findContentArtifactOutputCollision(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  outputPath: string,
): string | undefined {
  return Object.keys(contentArtifactHeaders).find((path) =>
    portableOutputPathsCollide(path.slice(1), outputPath),
  );
}

export function assertNoPublicContentArtifactCollisions(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  publicDir: string,
): void {
  for (const path of Object.keys(contentArtifactHeaders)) {
    const publicPath = resolveGeneratedArtifactOutputPath(publicDir, path.slice(1));
    if (!existsSync(publicPath)) continue;
    throw new Error(
      `Content artifact ${JSON.stringify(path)} collides with ${JSON.stringify(`public${path}`)}. Remove or rename one of the files so generated artifact bytes and headers cannot diverge.`,
    );
  }
}

export function assertNoPrerenderedContentArtifactCollisions(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  clientDir: string,
  routePaths: readonly string[],
): void {
  const artifactOutputs = Object.keys(contentArtifactHeaders).map((path) => ({
    outputPath: path.slice(1),
    path,
  }));
  for (const routePath of routePaths) {
    const pageOutputPath = relative(
      resolve(clientDir),
      resolvePrerenderOutputPath(clientDir, routePath),
    )
      .split(sep)
      .join("/");
    const collision = artifactOutputs.find(({ outputPath }) =>
      portableOutputPathsCollide(outputPath, pageOutputPath),
    );
    if (!collision) continue;
    throw new Error(
      `Content artifact ${JSON.stringify(collision.path)} collides with the prerendered output for route ${JSON.stringify(routePath)}. Configure a different artifact path or route.`,
    );
  }
}

function portableOutputPathsCollide(left: string, right: string): boolean {
  const key = (value: string) =>
    value
      .split("/")
      .map((segment) => segment.normalize("NFC").toLowerCase())
      .join("/");
  const leftKey = key(left);
  const rightKey = key(right);
  return (
    leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)
  );
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
      // The server bundle is build tooling (prerender + adapter entry), never
      // the deployed asset root, so a second copy of `public/` here is dead
      // weight -- and any asset-rewriting plugin would process it twice.
      copyPublicDir: false,
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
  const contentArtifactHeaders = readContentArtifactHeaders(clientDir);

  const publicDir = resolve(root, "public");
  if (existsSync(publicDir)) {
    assertNoPublicContentArtifactCollisions(contentArtifactHeaders, publicDir);
  }

  // `public/` is deliberately not re-copied here: the client build already
  // emitted it (Vite honours a custom `publicDir` and `build.copyPublicDir`
  // there) and the move above carried it into dist/client. Copying the source
  // files over that output would overwrite whatever a build plugin rewrote on
  // the way out -- an image optimizer's compressed copies, for one.

  let buildTarget: string | null = null;
  if (existsSync(serverEntry)) {
    // Edge server bundles keep `cloudflare:*` imports external; stub them so
    // the bundle can be imported in Node for the prerender pass below.
    registerPrerenderModuleHooks();
    const serverMod = await import(pathToFileURL(serverEntry).href);
    buildTarget = typeof serverMod.buildTarget === "string" ? serverMod.buildTarget : null;
    const buildBase = typeof serverMod.buildBase === "string" ? serverMod.buildBase : "/";
    const isStaticExport = isStaticExportBuild(serverMod);
    if (isStaticExport) {
      // Fail closed before prerendering: a static export has no server, so
      // Request-runtime routes/features and network-exposed capabilities are
      // build errors (with every offender listed at once).
      await validateStaticExport(serverMod);
    }
    const { prerenderApp } = serverMod;
    // Asset URLs in prerendered documents must carry the deploy base; the
    // server bundle reports the one Vite resolved.
    const { clientEntryUrl, clientEntryJs, islandsEntryJs, cssManifest, jsManifest } =
      readClientBuildAssets(root, buildBase);

    const { pages, isgManifest } = await prerenderApp({
      staticExport: isStaticExport,
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
    if (isStaticExport) {
      // getStaticPaths() can produce paths that are absent from the manifest.
      // Validate the concrete set before writing even the first page.
      validateStaticExportOutputPaths(pages, serverMod);
    }
    const headersManifest: Record<string, Record<string, string>> = {
      ...Object.fromEntries(
        pages.map((page: { path: string; headers?: Record<string, string> }) => [
          page.path,
          page.headers ?? {},
        ]),
      ),
      ...contentArtifactHeaders,
    };
    const markdownManifest: Record<string, true> = Object.fromEntries(
      pages
        .filter((page: { markdown?: boolean }) => page.markdown)
        .map((page: { path: string }) => [page.path, true]),
    );

    // With Workers Caching enabled, time-revalidated ISG pages are rendered
    // on demand and cached at the edge. A prerendered static snapshot would
    // be served ahead of the Worker and never revalidate, so it must not be
    // emitted. Webhook-only ISG routes are not edge-cached — they keep their
    // snapshot and revalidate through the worker-managed Cache API path.
    const cloudflareWorkersCacheEnabled =
      serverMod.buildTarget === "cloudflare" && serverMod.cloudflareWorkersCacheEnabled === true;
    const edgeCachedIsgPaths = cloudflareWorkersCacheEnabled
      ? Object.keys(isgManifest).filter((path) => hasTimeRevalidate(isgManifest[path]?.revalidate))
      : [];
    // Netlify serves every ISG path through the function and the durable CDN
    // cache — the handler checks the ISG manifest before the bundled static
    // output, so a snapshot would only ever be reachable at its literal
    // `/index.html` URL, where it would serve the build-time copy forever.
    const netlifyIsgPaths =
      serverMod.buildTarget === "netlify" ? Object.keys(isgManifest) : ([] as string[]);
    const skippedSnapshotPaths = new Set([...edgeCachedIsgPaths, ...netlifyIsgPaths]);
    const staticPages =
      skippedSnapshotPaths.size > 0
        ? pages.filter((page: { path: string }) => !skippedSnapshotPaths.has(page.path))
        : pages;

    assertNoPrerenderedContentArtifactCollisions(
      contentArtifactHeaders,
      clientDir,
      staticPages.map((page: { path: string }) => page.path),
    );

    if (staticPages.length > 0) {
      log(`\n  Prerendering ${staticPages.length} SSG/ISG route(s)...\n`);
      for (const page of staticPages) {
        // Static exports write to the decoded path (the host resolves the URL
        // itself); serverful adapters keep the encoded form their own static
        // lookup matches against.
        const filePath = isStaticExport
          ? resolveStaticExportOutputPath(clientDir, page.path)
          : resolvePrerenderOutputPath(clientDir, page.path);

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, page.html, "utf-8");
        log(`    ${page.path} → ${filePath.replace(root + "/", "")}`);
      }
    }

    // The server module only exports generateLlmsTxt when the vite plugin's
    // `llmsTxt` option is enabled — disabled builds skip this entirely.
    if (typeof serverMod.generateLlmsTxt === "function") {
      assertNoContentArtifactPathCollision(
        contentArtifactHeaders,
        "/llms.txt",
        "Pracht's core llms.txt generator",
      );
      // Vite copies `public/` into the client output before this runs, so a
      // hand-authored `public/llms.txt` is about to be overwritten. Silently
      // discarding a file the user wrote is the worst outcome; say so.
      if (existsSync(resolve(root, "public/llms.txt"))) {
        log(
          "\n  Warning: public/llms.txt is overwritten by the generated llms.txt.\n" +
            "  Remove it, or disable the plugin's `llmsTxt` option to hand-author the file.",
        );
      }
      const llmsTxt: string = await serverMod.generateLlmsTxt();
      writeFileSync(resolve(clientDir, "llms.txt"), llmsTxt, "utf-8");
      log("\n  llms.txt → dist/client/llms.txt\n");
    }

    const generatedStaticRoutes: string[] = [];

    // Companion artifact generators can inspect the bundled server graph and
    // return static files without coupling their authoring API to core. The
    // OpenAPI plugin uses this for /openapi.json and its optional docs page.
    if (typeof serverMod.generatePrachtOpenApiArtifacts === "function") {
      const generated = await serverMod.generatePrachtOpenApiArtifacts();
      const artifacts = Array.isArray(generated?.artifacts) ? generated.artifacts : [];
      const seenOutputPaths = new Set<string>();
      for (const artifact of artifacts) {
        if (
          !artifact ||
          typeof artifact.outputPath !== "string" ||
          typeof artifact.content !== "string"
        ) {
          throw new Error("OpenAPI generator returned an invalid build artifact.");
        }
        assertNoContentArtifactOutputCollision(
          contentArtifactHeaders,
          artifact.outputPath,
          `OpenAPI artifact ${JSON.stringify(artifact.outputPath)}`,
        );
        const filePath = resolveGeneratedArtifactOutputPath(clientDir, artifact.outputPath);
        if (seenOutputPaths.has(filePath)) {
          throw new Error(
            `OpenAPI generator returned duplicate output path ${JSON.stringify(artifact.outputPath)}.`,
          );
        }
        seenOutputPaths.add(filePath);
        if (
          typeof artifact.path === "string" &&
          artifact.path.startsWith("/") &&
          artifact.outputPath ===
            (artifact.path === "/" ? "index.html" : `${artifact.path.slice(1)}/index.html`)
        ) {
          generatedStaticRoutes.push(artifact.path);
        }
        if (existsSync(filePath)) {
          log(
            `\n  Warning: OpenAPI artifact ${artifact.outputPath} replaces an existing public/build file.\n`,
          );
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, artifact.content, "utf-8");
        log(`\n  OpenAPI → dist/client/${artifact.outputPath}\n`);
      }

      const warnings = Array.isArray(generated?.warnings) ? generated.warnings : [];
      for (const warning of warnings) {
        const method = typeof warning?.method === "string" ? `${warning.method} ` : "";
        const path = typeof warning?.path === "string" ? warning.path : "unknown route";
        const message = typeof warning?.message === "string" ? warning.message : String(warning);
        log(`  OpenAPI warning: ${method}${path}: ${message}\n`);
      }
    }

    if (Object.keys(headersManifest).length > 0) {
      const headersManifestJson = `${JSON.stringify(headersManifest, null, 2)}\n`;
      writeFileSync(
        resolve(root, "dist/server/headers-manifest.json"),
        headersManifestJson,
        "utf-8",
      );
      // Only the Cloudflare worker reads this from the client output (it
      // fetches /_pracht/headers.json through the assets binding); every other
      // target reads dist/server. A static export has no runtime at all, so
      // publishing it would ship the full route list and header policy as
      // permanently dead bytes in the deployable directory.
      if (!isStaticExport) {
        mkdirSync(resolve(clientDir, "_pracht"), { recursive: true });
        writeFileSync(resolve(clientDir, "_pracht/headers.json"), headersManifestJson, "utf-8");
      }
    }

    // Always emit this manifest, including for SSR-only apps with no
    // prerendered pages. An absent file means "legacy/custom entry" to the
    // adapters and deliberately preserves their old conservative fallback;
    // `{}` is the authoritative proof that no static route serves Markdown.
    const markdownManifestJson = `${JSON.stringify(markdownManifest, null, 2)}\n`;
    writeFileSync(
      resolve(root, "dist/server/markdown-manifest.json"),
      markdownManifestJson,
      "utf-8",
    );
    // Same as headers.json above: Cloudflare's worker is the only reader of
    // the client copy, and a static export has no worker.
    if (!isStaticExport) {
      mkdirSync(resolve(clientDir, "_pracht"), { recursive: true });
      writeFileSync(resolve(clientDir, "_pracht/markdown.json"), markdownManifestJson, "utf-8");
    }

    if (Object.keys(isgManifest).length > 0) {
      const isgManifestPath = resolve(root, "dist/server/isg-manifest.json");
      const isgManifestJson = `${JSON.stringify(isgManifest, null, 2)}\n`;
      writeFileSync(isgManifestPath, isgManifestJson, "utf-8");
      if (buildTarget === "cloudflare") {
        // Only the Cloudflare worker runtime reads the manifest from the
        // static assets (via readPrachtISGManifest). On other targets the
        // client dir is served publicly, so writing it there would leak the
        // ISG route list and revalidation policies.
        mkdirSync(resolve(clientDir, "_pracht"), { recursive: true });
        writeFileSync(resolve(clientDir, "_pracht/isg.json"), isgManifestJson, "utf-8");
      }
      log(
        `\n  ISG manifest → dist/server/isg-manifest.json (${Object.keys(isgManifest).length} route(s))\n`,
      );
    }

    if (isStaticExport) {
      await writeStaticExportArtifacts({
        clientDir,
        pages,
        serverMod,
        log,
      });

      if (Object.keys(markdownManifest).length > 0) {
        log(
          "  Note: routes exporting `markdown` rely on server-side content negotiation. " +
            "A static host always answers with the HTML file; agents requesting " +
            "`Accept: text/markdown` get HTML. Publish .md files under public/ instead " +
            "when a raw-markdown corpus matters.\n",
        );
      }

      log(
        "\n  Static export complete → deploy dist/client/ to any static host " +
          "(dist/server/ is build tooling only).\n",
      );
    }

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
        base: buildBase,
        functionName: serverMod.vercelFunctionName,
        isgManifest,
        headersManifest,
        markdownRoutes: Object.keys(markdownManifest),
        regions: serverMod.vercelRegions,
        root,
        staticAssetRoutes: Object.keys(contentArtifactHeaders),
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

export function resolveGeneratedArtifactOutputPath(clientDir: string, outputPath: string): string {
  if (
    !outputPath ||
    outputPath.includes("\0") ||
    outputPath.includes("\\") ||
    isAbsolute(outputPath)
  ) {
    throw new Error(
      `Refusing to write generated artifact with unsafe output path ${JSON.stringify(outputPath)}.`,
    );
  }

  const root = resolve(clientDir);
  const filePath = resolve(root, outputPath);
  const relativePath = relative(root, filePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Refusing to write generated artifact ${JSON.stringify(outputPath)} outside dist/client.`,
    );
  }
  return filePath;
}
