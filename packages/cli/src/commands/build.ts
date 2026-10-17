import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { defineCommand } from "citty";
import { build as viteBuild, type Plugin } from "vite";
import { matchRoutePath, planMarkdownFiles, routePathIsDynamic } from "@pracht/core";
import type { MarkdownFile, PrerenderedMarkdown } from "@pracht/core";

import { readBuildTrailingSlash, readClientBuildAssets } from "../build-metadata.js";
import { writeCloudflareAssetHeaders } from "../cloudflare-asset-headers.js";
import {
  findUnresolvedManifestModules,
  formatUnresolvedManifestModules,
} from "../manifest-modules.js";
import { resolveVercelRuntimeRoutes, writeVercelBuildOutput } from "../build-shared.js";
import {
  decodeStaticOutputPath,
  describeInlineCssOpportunity,
  isStaticExportBuild,
  resolveMarkdownFileOutputPath,
  resolvePrerenderOutputPath,
  resolveStaticExportOutputPath,
  validateStaticExport,
  validateStaticExportOutputPaths,
  writeStaticExportArtifacts,
} from "../build-static.js";
import {
  formatMarkdownSkipList,
  injectMarkdownAlternateLink,
  markdownFileHeaders,
  markdownFileHref,
  markdownFileHtmlReason,
} from "../markdown-files.js";
import {
  formatPrerenderBindingReads,
  takePrerenderBindingReads,
} from "../prerender-module-hooks.js";
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

/**
 * How many prerendered pages the build log names individually.
 *
 * Enough to see the shape of the output — the home page, a few list pages, the
 * first instances of a dynamic route — without a content site turning its build
 * into 5,000 lines of scrollback.
 */
const PRERENDER_LOG_LIMIT = 20;

/**
 * How many prerendered page lines to name, and the tail that stands in for the
 * rest.
 *
 * The decision is separated from the write loop so the arithmetic is testable
 * without running a build: the tail has to appear only when something was
 * actually elided, and its count has to agree with the total printed on the
 * line above. `limit` is a parameter rather than a captured constant so the
 * behaviour stays pinned if {@link PRERENDER_LOG_LIMIT} is retuned.
 */
export function planPrerenderLog(
  pageCount: number,
  limit: number,
): { named: number; tail: string | null } {
  const named = Math.min(pageCount, limit);
  return {
    named,
    tail: pageCount > named ? `    … and ${pageCount - named} more` : null,
  };
}

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

interface ContentRouteEntry {
  path: string;
  source: string;
}

interface ContentRoutesManifest {
  policy: "error" | "warn" | "ignore";
  collections: Record<string, readonly ContentRouteEntry[]>;
}

interface ContentBuildManifest {
  version: 1;
  artifacts: Record<string, Record<string, string>>;
  routes?: ContentRoutesManifest;
}

/**
 * Read and remove the content plugin's single versioned build contribution.
 * It is an internal channel and never reaches the published client output.
 */
export function readContentBuildManifest(clientDir: string): ContentBuildManifest | null {
  const manifestPath = resolve(clientDir, "_pracht/content-manifest.json");
  if (!existsSync(manifestPath)) return null;
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  rmSync(manifestPath, { force: true });
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { artifacts?: unknown }).artifacts !== "object" ||
    (parsed as { artifacts?: unknown }).artifacts === null ||
    Array.isArray((parsed as { artifacts?: unknown }).artifacts)
  ) {
    throw new Error("The content build manifest is invalid.");
  }
  const manifest = parsed as ContentBuildManifest;
  for (const [path, headers] of Object.entries(manifest.artifacts)) {
    if (
      !path.startsWith("/") ||
      !headers ||
      typeof headers !== "object" ||
      Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== "string")
    ) {
      throw new Error("The content build manifest is invalid.");
    }
  }
  if (Object.hasOwn(manifest, "routes") && manifest.routes !== undefined) {
    if (
      !manifest.routes ||
      typeof manifest.routes !== "object" ||
      Array.isArray(manifest.routes) ||
      !["error", "warn", "ignore"].includes(manifest.routes.policy) ||
      typeof manifest.routes.collections !== "object" ||
      manifest.routes.collections === null
    ) {
      throw new Error("The content build manifest is invalid.");
    }
    for (const entries of Object.values(manifest.routes.collections)) {
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            typeof entry.path !== "string" ||
            !entry.path.startsWith("/") ||
            typeof entry.source !== "string",
        )
      ) {
        throw new Error("The content build manifest is invalid.");
      }
    }
  }
  return manifest;
}

interface ContentRoutePattern {
  path: string;
  servesUnprerenderedPaths: boolean;
}

export function collectContentRoutePatterns(
  routes: readonly ContentArtifactPageRoute[],
  staticExport: boolean,
  hasSpaFallback = false,
): ContentRoutePattern[] {
  return routes.map((route) => {
    const dynamic = routePathIsDynamic(route.path);
    return {
      path: route.path,
      servesUnprerenderedPaths:
        !staticExport || !dynamic || (route.render === "spa" && hasSpaFallback),
    };
  });
}

export function collectUnroutedContentDocuments(
  manifest: ContentRoutesManifest,
  routePatterns: readonly (string | ContentRoutePattern)[],
  concretePagePaths: readonly string[],
): Array<{ collection: string; path: string; source: string }> {
  const served = new Set(concretePagePaths);
  const unrouted: Array<{ collection: string; path: string; source: string }> = [];
  for (const [collection, entries] of Object.entries(manifest.collections)) {
    for (const entry of entries) {
      if (served.has(entry.path)) continue;
      const matchingRoute = routePatterns.find((pattern) =>
        Boolean(matchRoutePath(typeof pattern === "string" ? pattern : pattern.path, entry.path)),
      );
      if (
        matchingRoute &&
        (typeof matchingRoute === "string" || matchingRoute.servesUnprerenderedPaths)
      ) {
        continue;
      }
      unrouted.push({ collection, path: entry.path, source: entry.source });
    }
  }
  return unrouted;
}

export function formatUnroutedContentDocuments(
  unrouted: readonly { collection: string; path: string; source: string }[],
): string {
  const lines = unrouted.map(
    ({ collection, path, source }) =>
      `    ${path} (collection ${JSON.stringify(collection)}, ${source})`,
  );
  return [
    unrouted.length === 1
      ? "1 content document generates a route no app route serves:"
      : `${unrouted.length} content documents generate routes no app route serves:`,
    ...lines,
    "",
    "  These documents still reach every artifact generator, so llms.txt and raw",
    "  source assets advertise URLs that answer 404. Register them in the app",
    "  manifest, exclude them with the collection's `route()` callback, or pass",
    '  `unroutedDocuments: "ignore"` to prachtContent() for a data-only collection.',
  ].join("\n");
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

function collectPublicFiles(publicDir: string): string[] {
  const publicFiles: string[] = [];
  const collect = (directory: string, ancestorDirectories: ReadonlySet<string>): void => {
    const realDirectory = realpathSync.native(directory);
    if (ancestorDirectories.has(realDirectory)) return;

    const nextAncestorDirectories = new Set(ancestorDirectories);
    nextAncestorDirectories.add(realDirectory);

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      if (statSync(absolutePath).isDirectory()) {
        collect(absolutePath, nextAncestorDirectories);
        continue;
      }
      publicFiles.push(relative(publicDir, absolutePath).split(sep).join("/"));
    }
  };
  collect(publicDir, new Set());
  return publicFiles;
}

export function assertNoPublicContentMetadataCollisions(
  publicDir: string,
  publicDirLabel = "public",
): void {
  const publicFiles = collectPublicFiles(publicDir);
  const reservedMetadataPaths = ["_pracht/content-manifest.json"];
  const collision = publicFiles.find((publicFile) =>
    reservedMetadataPaths.some((metadataPath) =>
      portableOutputPathsCollide(metadataPath, publicFile),
    ),
  );
  if (!collision) return;
  throw new Error(
    `${JSON.stringify(`${publicDirLabel}/${collision}`)} collides with Pracht's internal content build manifests. Remove or rename the public file so it cannot replace build metadata.`,
  );
}

export function assertNoPublicContentArtifactCollisions(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  publicDir: string,
  publicDirLabel = "public",
): void {
  const publicFiles = collectPublicFiles(publicDir);

  for (const path of Object.keys(contentArtifactHeaders)) {
    const artifactOutput = path.slice(1);
    const collision = publicFiles.find((publicFile) =>
      portableOutputPathsCollide(artifactOutput, publicFile),
    );
    if (!collision) continue;
    throw new Error(
      `Content artifact ${JSON.stringify(path)} collides with ${JSON.stringify(`${publicDirLabel}/${collision}`)}. Remove or rename one of the files so generated artifact bytes and headers cannot diverge.`,
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

interface ContentArtifactPageRoute {
  path: string;
  render?: string;
}

interface ContentArtifactApiRoute {
  path: string;
}

export function assertNoRequestRouteContentArtifactCollisions(
  contentArtifactHeaders: Record<string, Record<string, string>>,
  pageRoutes: readonly ContentArtifactPageRoute[],
  apiRoutes: readonly ContentArtifactApiRoute[],
  concretePagePaths: readonly string[],
): void {
  const routeOwners = [
    ...pageRoutes
      .filter((route) => route.render !== "ssg")
      .map((route) => ({
        description: `${route.render ?? "request-time"} page route`,
        path: route.path,
      })),
    ...apiRoutes.map((route) => ({ description: "API route", path: route.path })),
    ...concretePagePaths.map((path) => ({ description: "generated page route", path })),
  ];

  for (const artifactPath of Object.keys(contentArtifactHeaders)) {
    const artifactKey = portablePathKey(artifactPath);
    const collision = routeOwners.find(({ path }) => {
      const routeKey = portablePathKey(path);
      const indexKey = portablePathKey(`${path === "/" ? "" : path}/index.html`);
      return artifactKey === routeKey || artifactKey === indexKey;
    });
    if (!collision) continue;
    throw new Error(
      `Content artifact ${JSON.stringify(artifactPath)} collides with ${collision.description} ${JSON.stringify(collision.path)}. Configure a different artifact path or route.`,
    );
  }
}

export function expandContentArtifactHeaders(
  contentArtifactHeaders: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
  const expanded = { ...contentArtifactHeaders };
  for (const [path, headers] of Object.entries(contentArtifactHeaders)) {
    if (!path.endsWith("/index.html")) continue;
    const cleanPath = path.slice(0, -"/index.html".length) || "/";
    expanded[cleanPath] ??= headers;
  }
  return expanded;
}

function portablePathKey(value: string): string {
  return value
    .split("/")
    .map((segment) => segment.normalize("NFC").toLowerCase())
    .join("/");
}

function portableOutputPathsCollide(left: string, right: string): boolean {
  const leftKey = portablePathKey(left);
  const rightKey = portablePathKey(right);
  return (
    leftKey === rightKey || leftKey.startsWith(`${rightKey}/`) || rightKey.startsWith(`${leftKey}/`)
  );
}

export interface BuildResult {
  buildTarget: string | null;
}

export function reportBuildWarning(message: string, json: boolean): void {
  if (json) console.error(message);
  else console.log(message);
}

/**
 * Splits a Worker module's exports into what workerd accepts beside `default`
 * (handlers and entrypoint classes: functions and non-null objects) and what
 * it rejects at startup (every other value).
 */
export function splitCloudflareWorkerExports(exports: Iterable<[string, unknown]>): {
  entrypointNames: string[];
  droppedNames: string[];
} {
  const entrypointNames: string[] = [];
  const droppedNames: string[] = [];
  for (const [name, value] of exports) {
    if (name === "default") continue;
    if (typeof value === "function" || (typeof value === "object" && value !== null)) {
      entrypointNames.push(name);
    } else {
      droppedNames.push(name);
    }
  }
  return { entrypointNames, droppedNames };
}

/**
 * How to deploy a Cloudflare build. The Cloudflare Vite plugin writes
 * dist/server/wrangler.json plus a `.wrangler/deploy/config.json` redirect
 * that plain `wrangler deploy` follows. The adapter removes the redirect when
 * the user's config defines named environments and the build selected none,
 * so `wrangler deploy --env <name>` keeps reading the user's own config.
 */
export function describeCloudflareDeploy(root: string): string {
  const generated = readGeneratedWranglerEnvironments(resolve(root, "dist/server/wrangler.json"));
  if (generated && existsSync(resolve(root, ".wrangler/deploy/config.json"))) {
    return "  Deploy with: wrangler deploy (uses the generated dist/server/wrangler.json)\n";
  }
  if (generated && generated.defined.length > 0 && !generated.target) {
    return (
      "  Deploy with: wrangler deploy --env <name> (reads your wrangler config, whose main must be dist/server/worker.js),\n" +
      "  or rebuild with CLOUDFLARE_ENV=<name> to deploy the generated dist/server/wrangler.json.\n"
    );
  }
  return "  Deploy with: wrangler deploy\n";
}

function readGeneratedWranglerEnvironments(
  file: string,
): { defined: unknown[]; target: unknown } | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const config = JSON.parse(readFileSync(file, "utf-8")) as {
      definedEnvironments?: unknown;
      targetEnvironment?: unknown;
    };
    return {
      defined: Array.isArray(config.definedEnvironments) ? config.definedEnvironments : [],
      target: config.targetEnvironment,
    };
  } catch {
    return undefined;
  }
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

  let publicDir = resolve(root, "public");
  const capturePublicDir: Plugin = {
    name: "pracht:capture-public-dir",
    configResolved(config) {
      publicDir = config.publicDir;
    },
  };

  log("\n  Building client...\n");
  await viteBuild({
    root,
    logLevel,
    plugins: [capturePublicDir],
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
  const publicDirLabel = relative(root, publicDir).split(sep).join("/") || ".";
  if (publicDir && existsSync(publicDir)) {
    assertNoPublicContentMetadataCollisions(publicDir, publicDirLabel);
  }
  const contentBuildManifest = readContentBuildManifest(clientDir);
  const contentArtifactHeaders = contentBuildManifest?.artifacts ?? {};
  const contentRoutes = contentBuildManifest?.routes;

  if (publicDir && existsSync(publicDir)) {
    assertNoPublicContentArtifactCollisions(contentArtifactHeaders, publicDir, publicDirLabel);
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
    const buildTrailingSlash = readBuildTrailingSlash(serverMod);
    const isStaticExport = isStaticExportBuild(serverMod);
    const unresolvedModules = await findUnresolvedManifestModules(serverMod);
    if (unresolvedModules.length > 0) {
      throw new Error(formatUnresolvedManifestModules(unresolvedModules));
    }
    if (isStaticExport) {
      // Fail closed before prerendering: a static export has no server, so
      // Request-runtime routes/features and network-exposed capabilities are
      // build errors (with every offender listed at once).
      await validateStaticExport(serverMod);
    }
    if (isStaticExport && buildTrailingSlash === "never") {
      reportBuildWarning(
        '\n  Warning: trailingSlash: "never" with a static export. Each page is written as ' +
          "<path>/index.html, which most static hosts serve at /<path>/ and redirect /<path> to. " +
          'Use trailingSlash: "always", or a host configured to serve /<path> without a redirect.\n',
        analyzeJson,
      );
    }
    const { prerenderApp } = serverMod;
    // Asset URLs in prerendered documents must carry the deploy base; the
    // server bundle reports the one Vite resolved.
    const { clientEntryUrl, clientEntryJs, islandsEntryJs, cssManifest, jsManifest } =
      readClientBuildAssets(root, buildBase);

    // The server module's manifest additionally carries the routes that are
    // absent from the client bundle, whose CSS the server build emitted. The
    // freshly read client entries are layered on top: they are the ones
    // rebuilt against the deploy base.
    const pageCssManifest = { ...serverMod.cssManifest, ...cssManifest };

    // Static exports write decoded paths (the host resolves the URL itself);
    // serverful adapters keep the encoded form their own static lookup uses.
    const resolveMarkdownOutput = (markdownPath: string): string =>
      isStaticExport
        ? resolveMarkdownFileOutputPath(clientDir, decodeStaticOutputPath(markdownPath))
        : resolveMarkdownFileOutputPath(clientDir, markdownPath);
    const markdownFilesEnabled = serverMod.markdownFiles !== false;

    // Cloudflare bindings read while prerendering resolve to undefined; name
    // them so a page built from missing data is not silent.
    const bindingReads = takePrerenderBindingReads();
    const reportBindingReads = (): void => {
      const report = formatPrerenderBindingReads(bindingReads);
      if (report) reportBuildWarning(`\n  Warning: ${report}\n`, analyzeJson);
      bindingReads.clear();
    };
    const failWithBindingReads = (error: unknown): never => {
      reportBindingReads();
      throw error;
    };

    const { pages, isgManifest } = await prerenderApp({
      staticExport: isStaticExport,
      app: serverMod.resolvedApp,
      clientEntryUrl: clientEntryUrl ?? undefined,
      islandsEntryUrl: serverMod.islandsEntryUrl ?? undefined,
      islandsBootstrapRequired: serverMod.islandsBootstrapRequired === true,
      apiRoutes: serverMod.apiRoutes,
      cssManifest: pageCssManifest,
      cssContentManifest: serverMod.cssContentManifest,
      jsManifest,
      registry: serverMod.registry,
      withISGManifest: true,
      concurrency: serverMod.prerenderConcurrency,
    }).catch(failWithBindingReads);
    if (isStaticExport) {
      // getStaticPaths() can produce paths that are absent from the manifest.
      // Validate the concrete set before writing even the first page.
      validateStaticExportOutputPaths(pages, serverMod);
    }
    assertNoRequestRouteContentArtifactCollisions(
      contentArtifactHeaders,
      serverMod.resolvedApp?.routes ?? [],
      serverMod.apiRoutes ?? [],
      pages.map((page: { path: string }) => page.path),
    );

    // Reconcile the content registry against the app manifest. The registry
    // discovers sources from the filesystem while routes are registered by
    // hand, so a source added without a matching route silently publishes a
    // dead URL into every artifact that indexes the collection.
    if (contentRoutes) {
      const unrouted = collectUnroutedContentDocuments(
        contentRoutes,
        collectContentRoutePatterns(
          serverMod.resolvedApp?.routes ?? [],
          isStaticExport,
          Boolean(serverMod.staticExportConfig?.fallback),
        ),
        pages.map((page: { path: string }) => page.path),
      );
      if (unrouted.length > 0) {
        const report = formatUnroutedContentDocuments(unrouted);
        if (contentRoutes.policy === "error") throw new Error(report);
        const warning = `\n  Warning: ${report}\n`;
        reportBuildWarning(warning, analyzeJson);
      }
    }
    const expandedContentArtifactHeaders = expandContentArtifactHeaders(contentArtifactHeaders);
    const contentArtifactCleanRoutes = Object.keys(expandedContentArtifactHeaders).filter(
      (path) => !(path in contentArtifactHeaders),
    );
    const headersManifest: Record<string, Record<string, string>> = {
      ...Object.fromEntries(
        pages.map((page: { path: string; headers?: Record<string, string> }) => [
          page.path,
          page.headers ?? {},
        ]),
      ),
      ...expandedContentArtifactHeaders,
    };
    const markdownManifest: Record<string, true> = Object.fromEntries(
      pages
        .filter((page: { markdown?: boolean }) => page.markdown)
        .map((page: { path: string }) => [page.path, true]),
    );

    // `<path>.md` files. Planned before any page is written, while dist/client
    // holds only `public/`, Vite's assets, and content artifacts — a file
    // already there is never replaced — so each page's HTML can link its file.
    const markdownFiles: MarkdownFile[] = [];
    const markdownFileSkips: { pagePath: string; reason: string }[] = [];
    if (markdownFilesEnabled) {
      const plan = await planMarkdownFiles({
        app: serverMod.resolvedApp,
        apiRoutes: serverMod.apiRoutes,
        registry: serverMod.registry,
        pages: pages.map((page: { path: string }) => page.path),
        fileExists: (markdownPath) => existsSync(resolveMarkdownOutput(markdownPath)),
      });
      markdownFileSkips.push(...plan.skipped);
      const pagesByPath = new Map<string, { headers?: Record<string, string>; html: string }>(
        pages.map((page: { path: string; headers?: Record<string, string>; html: string }) => [
          page.path,
          page,
        ]),
      );
      const candidates: MarkdownFile[] = [];
      for (const file of plan.files) {
        const page = pagesByPath.get(file.pagePath);
        if (!page) continue;
        // A page kept out of indexes or shared caches gets no public copy.
        const served = markdownFileHeaders(page.headers);
        const reason = "reason" in served ? served.reason : markdownFileHtmlReason(page.html);
        if (reason !== undefined) {
          markdownFileSkips.push({ pagePath: file.pagePath, reason });
          continue;
        }
        candidates.push(file);
      }
      // The file is published only when the page's own URL answers a
      // build-time `Accept: text/markdown` request with Markdown: loaders and
      // middleware that withhold it at runtime keep it out of the build too.
      const replayed: PrerenderedMarkdown[] =
        typeof serverMod.prerenderMarkdown === "function"
          ? await serverMod
              .prerenderMarkdown({
                app: serverMod.resolvedApp,
                apiRoutes: serverMod.apiRoutes,
                registry: serverMod.registry,
                paths: candidates.map((file) => file.pagePath),
                concurrency: serverMod.prerenderConcurrency,
              })
              .catch(failWithBindingReads)
          : candidates.map((file) => ({
              pagePath: file.pagePath,
              reason: "the server bundle cannot replay Markdown requests",
            }));
      const replayedByPath = new Map(replayed.map((result) => [result.pagePath, result]));
      for (const file of candidates) {
        const result = replayedByPath.get(file.pagePath);
        if (!result || "reason" in result) {
          markdownFileSkips.push({
            pagePath: file.pagePath,
            reason: result?.reason ?? "no Markdown response",
          });
          continue;
        }
        const served = markdownFileHeaders(result.headers);
        if ("reason" in served) {
          markdownFileSkips.push({ pagePath: file.pagePath, reason: served.reason });
          continue;
        }
        const page = pagesByPath.get(file.pagePath)!;
        headersManifest[file.markdownPath] = served.headers;
        page.html = injectMarkdownAlternateLink(
          page.html,
          markdownFileHref(buildBase, file.markdownPath),
        );
        markdownFiles.push({ ...file, source: result.source });
      }
    } else if (isStaticExport) {
      for (const pagePath of Object.keys(markdownManifest)) {
        markdownFileSkips.push({ pagePath, reason: "`markdownFiles: false`" });
      }
    }

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
      const prerenderLog = planPrerenderLog(staticPages.length, PRERENDER_LOG_LIMIT);
      let logged = 0;
      for (const page of staticPages) {
        // Static exports write to the decoded path (the host resolves the URL
        // itself); serverful adapters keep the encoded form their own static
        // lookup matches against.
        const filePath = isStaticExport
          ? resolveStaticExportOutputPath(clientDir, page.path)
          : resolvePrerenderOutputPath(clientDir, page.path);

        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, page.html, "utf-8");
        // One line per page is a useful build log for a marketing site and
        // 5,000 lines of scrollback for a content site. The count above
        // already states the total, so the tail is noise rather than
        // information — but say how much was elided rather than trailing off.
        if (logged < prerenderLog.named) {
          log(`    ${page.path} → ${filePath.replace(root + "/", "")}`);
          logged += 1;
        }
      }
      if (prerenderLog.tail) {
        log(prerenderLog.tail);
      }
    }
    reportBindingReads();

    const markdownFileOutputs: string[] = [];
    for (const file of markdownFiles) {
      const filePath = resolveMarkdownOutput(file.markdownPath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.source, "utf-8");
      markdownFileOutputs.push(relative(clientDir, filePath).split(sep).join("/"));
    }
    if (markdownFileOutputs.length > 0) {
      log(
        `\n  Markdown → ${markdownFileOutputs.length} .md file(s) next to their SSG pages (e.g. dist/client/${markdownFileOutputs[0]})\n`,
      );
    }
    if (markdownFileSkips.length > 0) {
      // A static host cannot negotiate, so there the file is the only Markdown.
      const fallback = isStaticExport
        ? "a static host answers `Accept: text/markdown` with HTML"
        : "they still answer `Accept: text/markdown`";
      log(
        `\n  Note: no .md file for ${markdownFileSkips.length} Markdown-capable page(s); ${fallback}: ` +
          `${formatMarkdownSkipList(markdownFileSkips)}.\n`,
      );
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
      const llmsTxt: string = await serverMod.generateLlmsTxt({
        markdownFiles: markdownFiles.map((file) => file.pagePath),
      });
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

    // The URL shape the build was made for, for hosting platforms and deploy
    // tooling that configure their own static-file routing (a CDN's
    // trailing-slash handling has to agree with the app's, or the two
    // redirect each other). No pracht runtime reads it.
    writeFileSync(
      resolve(root, "dist/server/routing.json"),
      `${JSON.stringify({ base: buildBase, trailingSlash: buildTrailingSlash }, null, 2)}\n`,
      "utf-8",
    );

    // Every page's stylesheets, keyed by route or shell file. No runtime reads
    // this: it is the one place where the mapping for routes outside the client
    // bundle survives the build, so `pracht inspect` and anything auditing CSS
    // weight is not left reading the client manifest, which by construction
    // has no entry for a route that ships no JavaScript.
    writeFileSync(
      resolve(root, "dist/server/css-manifest.json"),
      `${JSON.stringify(pageCssManifest, null, 2)}\n`,
      "utf-8",
    );

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

    if (buildTarget === "cloudflare") {
      const assetHeaders = writeCloudflareAssetHeaders(
        clientDir,
        publicDir,
        headersManifest,
        publicDirLabel,
      );
      if (assetHeaders.warning && !analyzeJson) {
        console.warn(`\n  Warning: ${assetHeaders.warning}\n`);
      }
      if (assetHeaders.skipped.length > 0 && !analyzeJson) {
        console.warn(
          `\n  Warning: dist/client/_headers cannot match ${assetHeaders.skipped.join(", ")} ` +
            "exactly, so Cloudflare serves them with the /assets/* immutable policy instead of " +
            "their build headers. Rename them or keep them out of /assets/.\n",
        );
      }
    }

    if (isStaticExport) {
      await writeStaticExportArtifacts({
        clientDir,
        pages,
        serverMod,
        log,
      });

      const inlineCssTip = describeInlineCssOpportunity({ clientDir, pages });
      if (inlineCssTip) log(`\n${inlineCssTip}`);

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

      // The adapter builds the Worker entry to dist/server/worker.js, next to
      // the Cloudflare plugin's generated wrangler.json. workerd accepts only
      // handlers and entrypoint classes as that module's exports, so when it
      // re-exports anything else from the app's Worker module (or an older
      // adapter emitted only server.js, whose build metadata workerd rejects),
      // write a thin entry re-exporting just those from server.js instead.
      const workerEntryPath = resolve(root, "dist/server/worker.js");
      const builtWorkerEntry = existsSync(workerEntryPath);
      const legacyEntrypointNames: unknown[] = Array.isArray(
        serverMod.cloudflareWorkerEntrypointNames,
      )
        ? serverMod.cloudflareWorkerEntrypointNames
        : [];
      const deployExports: Array<[string, unknown]> = builtWorkerEntry
        ? Object.entries(await import(pathToFileURL(workerEntryPath).href))
        : Object.entries(serverMod).filter(([name]) => legacyEntrypointNames.includes(name));
      const { entrypointNames, droppedNames } = splitCloudflareWorkerExports(deployExports);
      if (!builtWorkerEntry || droppedNames.length > 0) {
        const deployEntryLines = [
          ...(entrypointNames.length > 0
            ? [`export { ${entrypointNames.join(", ")} } from "./server.js";`]
            : []),
          'export { default } from "./server.js";',
          "",
        ];
        writeFileSync(workerEntryPath, deployEntryLines.join("\n"), "utf-8");
      }
      if (droppedNames.length > 0) {
        log(
          `\n  Left ${droppedNames.join(", ")} out of dist/server/worker.js: a Worker module may only export handlers and entrypoint classes.`,
        );
      }

      log("\n  Cloudflare worker → dist/server/worker.js\n");
      log(describeCloudflareDeploy(root));
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
        markdownFiles: markdownFileOutputs,
        markdownRoutes: Object.keys(markdownManifest),
        regions: serverMod.vercelRegions,
        root,
        runtimeRoutes: resolveVercelRuntimeRoutes(serverMod.resolvedApp?.agents),
        // Markdown files are exact-path static files like content artifacts;
        // listing them applies their headers-manifest entry on Vercel.
        staticAssetRoutes: [
          ...Object.keys(contentArtifactHeaders),
          ...markdownFiles.map((file) => file.markdownPath),
        ],
        staticRoutes: [
          ...pages
            .map((page: { path: string }) => page.path)
            .filter((path: string) => !(path in isgManifest)),
          ...generatedStaticRoutes,
          ...contentArtifactCleanRoutes,
        ],
        trailingSlash: buildTrailingSlash,
        pageRoutes: pages.map((page: { path: string }) => page.path),
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
