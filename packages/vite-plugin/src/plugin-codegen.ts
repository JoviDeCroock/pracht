import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  readClientBuildAssets,
} from "./plugin-assets.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";
import { createRouteLoaderHints } from "./route-loader-hints.ts";
import { createWebmcpBootstrapSource, hasWebmcpCapabilities } from "./plugin-capabilities.ts";

const ROUTE_MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".mdx", ".tsrx"]);
const NON_FULL_HYDRATION_RE = /hydration\s*:\s*["'](?:islands|none)["']/;
const FULL_HYDRATION_RE = /hydration\s*:\s*["']full["']/;
const PAGES_NON_FULL_HYDRATION_RE = /export\s+const\s+HYDRATION\s*=\s*["'](?:islands|none)["']/;

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function findMatching(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function scanFiles(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      scanFiles(abs, files);
    } else if (ROUTE_MODULE_EXTENSIONS.has(extname(entry))) {
      files.push(abs);
    }
  }
}

function createNonFullHydrationExcludes(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): string[] {
  const excludes = new Set<string>();

  if (resolved.pagesDir) {
    const files: string[] = [];
    scanFiles(resolve(root, resolved.pagesDir.replace(/^\//, "")), files);
    for (const file of files) {
      try {
        if (PAGES_NON_FULL_HYDRATION_RE.test(readFileSync(file, "utf-8"))) {
          excludes.add(
            `!/${toPosixPath(file).replace(toPosixPath(root).replace(/\/$/, "") + "/", "")}`,
          );
        }
      } catch {}
    }
    return [...excludes];
  }

  const appFile = resolve(root, resolved.appFile.replace(/^\//, ""));
  let source: string;
  try {
    source = readFileSync(appFile, "utf-8");
  } catch {
    return [];
  }
  const groups: Array<{ start: number; end: number; nonFull: boolean }> = [];
  for (const match of source.matchAll(/\bgroup\s*\(/g)) {
    const parenStart = match.index! + match[0].lastIndexOf("(");
    const parenEnd = findMatching(source, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const args = source.slice(parenStart + 1, parenEnd);
    const arrayStart = source.indexOf("[", parenStart);
    if (arrayStart === -1 || arrayStart > parenEnd) continue;
    const arrayEnd = findMatching(source, arrayStart, "[", "]");
    if (arrayEnd === -1) continue;
    groups.push({
      start: arrayStart,
      end: arrayEnd,
      nonFull: NON_FULL_HYDRATION_RE.test(args.split("[")[0] ?? ""),
    });
  }

  const appDir = dirname(appFile);
  const routeRe =
    /\broute\s*\(\s*[^,]+,\s*(?:(?:\(\s*\)\s*=>\s*import\s*\(\s*)?["']([^"']+)["']\s*\)?|["']([^"']+)["'])/g;
  for (const match of source.matchAll(routeRe)) {
    const fileRef = match[1] ?? match[2];
    const callStart = match.index!;
    const parenStart = source.indexOf("(", callStart);
    const parenEnd = findMatching(source, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const callSource = source.slice(parenStart, parenEnd);
    const ownNonFull = NON_FULL_HYDRATION_RE.test(callSource);
    const ownFull = FULL_HYDRATION_RE.test(callSource);
    const inheritedNonFull = groups
      .filter((group) => group.start < callStart && callStart < group.end)
      .sort((a, b) => b.start - a.start)[0]?.nonFull;
    if (ownFull || (!ownNonFull && inheritedNonFull !== true)) continue;
    const abs = resolve(appDir, fileRef);
    excludes.add(`!/${toPosixPath(abs).replace(toPosixPath(root).replace(/\/$/, "") + "/", "")}`);
  }

  return [...excludes];
}

export function createPrachtClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  const routeLoaderHints = createRouteLoaderHintsForVirtualModules(resolved, buildOptions.root);

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  // Main route/shell globs. `.tsrx` is globbed separately *without* the
  // `?pracht-client` query suffix — the upstream `@tsrx/vite-plugin-preact`
  // plugin only matches ids by bare `.tsrx` extension, and the server-only
  // export stripping pass already catches these files via the route/shell
  // directory check during client builds.
  const dirPrefix = isPagesMode ? resolved.pagesDir : resolved.routesDir;
  const routeGlob = `${dirPrefix}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const routeTsrxGlob = `${dirPrefix}/**/*.tsrx`;
  const routeExcludes = createNonFullHydrationExcludes(resolved, buildOptions.root);
  const routeGlobPattern = routeExcludes.length > 0 ? [routeGlob, ...routeExcludes] : routeGlob;
  const routeTsrxGlobPattern =
    routeExcludes.length > 0 ? [routeTsrxGlob, ...routeExcludes] : routeTsrxGlob;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const shellTsrxGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.tsrx`
    : `${resolved.shellsDir}/**/*.tsrx`;

  return [
    'import { resolveApp, initClientRouter, readHydrationState } from "@pracht/core/client";',
    appImport,
    "",
    `const routeLoaderHints = ${JSON.stringify(routeLoaderHints)};`,
    `const routeModules = {`,
    `  ...import.meta.glob(${JSON.stringify(routeGlobPattern)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
    `  ...import.meta.glob(${JSON.stringify(routeTsrxGlobPattern)}),`,
    `};`,
    `const shellModules = {`,
    `  ...import.meta.glob(${JSON.stringify(shellGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
    `  ...import.meta.glob(${JSON.stringify(shellTsrxGlob)}),`,
    `};`,
    "",
    "const resolvedApp = resolveApp(app);",
    "applyRouteLoaderHints(resolvedApp, routeLoaderHints);",
    "",
    ...createApplyRouteLoaderHintsSource(),
    "function normalizeModuleKey(key) {",
    '  return key.split("?")[0].replace(/^\\.?\\//, "");',
    "}",
    "",
    "const moduleKeyIndexes = new WeakMap();",
    "function getModuleKeyIndex(modules) {",
    "  let index = moduleKeyIndexes.get(modules);",
    "  if (index) return index;",
    "  index = new Map();",
    "  for (const key of Object.keys(modules)) {",
    "    const normalized = normalizeModuleKey(key);",
    "    if (!normalized) continue;",
    "    if (!index.has(normalized)) index.set(normalized, key);",
    '    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {',
    "      const suffix = normalized.slice(i + 1);",
    "      if (suffix && !index.has(suffix)) index.set(suffix, key);",
    "    }",
    "  }",
    "  moduleKeyIndexes.set(modules, index);",
    "  return index;",
    "}",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    "  return getModuleKeyIndex(modules).get(normalizeModuleKey(file)) ?? null;",
    "}",
    "",
    "const state = readHydrationState();",
    'const root = document.getElementById("pracht-root");',
    "if (state && root) {",
    "  initClientRouter({",
    "    app: resolvedApp,",
    "    routeModules,",
    "    shellModules,",
    "    initialState: state,",
    "    root,",
    "    findModuleKey,",
    "  });",
    "}",
    "",
    // WebMCP page-tool registration — only emitted when at least one
    // capability opts in, so apps without WebMCP exposure ship zero extra bytes.
    ...(hasWebmcpCapabilities(resolved, buildOptions.root) ? createWebmcpBootstrapSource() : []),
  ].join("\n");
}

/**
 * Source of `virtual:pracht/islands-client` — the tiny bootstrap loaded by
 * `hydration: "islands"` routes. It deliberately does NOT import the app
 * manifest, the router, or the full client runtime: it only scans the DOM
 * for island markers and hydrates the islands present on the page.
 */
export function createPrachtIslandsClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const islandsGlob = `${resolved.islandsDir}/**/*.{ts,tsx,js,jsx}`;

  return [
    'import { hydrateIslands } from "@pracht/core/islands-client";',
    "",
    `const islandModules = import.meta.glob(${JSON.stringify(islandsGlob)});`,
    "",
    "hydrateIslands({ modules: islandModules });",
    "",
    // Islands pages skip the full client runtime, so the bootstrap pulls in
    // the WebMCP shim itself when a capability opts in.
    ...(hasWebmcpCapabilities(resolved, buildOptions.root) ? createWebmcpBootstrapSource() : []),
  ].join("\n");
}

export function createPrachtServerModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: {
    root?: string;
    isBuild?: boolean;
  } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;
  const registrySource = createPrachtRegistryModuleSource(resolved);
  const routeLoaderHints = createRouteLoaderHintsForVirtualModules(resolved, buildOptions.root);
  const clientBuild = buildOptions.isBuild
    ? readClientBuildAssets(buildOptions.root)
    : { clientEntryUrl: null, islandsEntryUrl: null, cssManifest: {}, jsManifest: {} };
  const adapter = resolved.adapter;

  // The adapter tells us what extra imports it needs (e.g. handlePrachtRequest).
  // Always import prerenderApp so the CLI uses the same bundled copy of
  // @pracht/core/server (and therefore the same Preact context instances) as the
  // route/shell modules — avoids dual-copy issues during SSG prerendering.
  const prachtImports = adapter?.serverImports
    ? adapter.serverImports + '\nimport { prerenderApp } from "@pracht/core/server";'
    : 'import { resolveApp, resolveApiRoutes, prerenderApp } from "@pracht/core/server";';

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  // In dev the islands bootstrap is served from a stable path; in production
  // builds the hashed entry URL comes from the client build manifest (null
  // when the app has no islands directory).
  const islandsEntryUrl = buildOptions.isBuild
    ? clientBuild.islandsEntryUrl
    : ISLANDS_CLIENT_BROWSER_PATH;
  const islandsGlob = `${resolved.islandsDir}/**/*.{ts,tsx,js,jsx}`;

  const source = [
    prachtImports,
    'import { registerServerIslands, setIslandsClientEntryUrl } from "@pracht/core/server";',
    appImport,
    "",
    `const routeLoaderHints = ${JSON.stringify(routeLoaderHints)};`,
    ...createApplyRouteLoaderHintsSource(),
    registrySource,
    "",
    "// Islands are registered eagerly so the server renderer can detect their",
    "// vnodes during islands-mode renders.",
    `const islandModules = import.meta.glob(${JSON.stringify(islandsGlob)}, { eager: true });`,
    "registerServerIslands(islandModules);",
    `setIslandsClientEntryUrl(${JSON.stringify(islandsEntryUrl ?? undefined)});`,
    "export const islandFiles = Object.keys(islandModules);",
    "",
    "export const resolvedApp = resolveApp(app);",
    "applyRouteLoaderHints(resolvedApp, routeLoaderHints);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const clientEntryUrl = ${JSON.stringify(clientBuild.clientEntryUrl ?? CLIENT_BROWSER_PATH)};`,
    `export const islandsEntryUrl = ${JSON.stringify(islandsEntryUrl ?? null)};`,
    `export const cssManifest = ${JSON.stringify(clientBuild.cssManifest)};`,
    `export const jsManifest = ${JSON.stringify(clientBuild.jsManifest)};`,
    `export const prerenderConcurrency = ${JSON.stringify(resolved.prerenderConcurrency)};`,
    `export const budgets = ${JSON.stringify(resolved.budgets)};`,
    "export { prerenderApp };",
    "",
  ];

  if (adapter) {
    source.push(adapter.createServerEntryModule());
  }

  return source.join("\n");
}

function createApplyRouteLoaderHintsSource(): string[] {
  return [
    "function applyRouteLoaderHints(resolvedApp, routeLoaderHints) {",
    "  for (const route of resolvedApp.routes) {",
    "    const hint = routeLoaderHints[route.file];",
    "    if (hint === true) {",
    "      route.hasLoader = true;",
    "    } else if (typeof route.hasLoader === 'undefined' && typeof hint === 'boolean') {",
    "      route.hasLoader = hint;",
    "    }",
    "  }",
    "}",
    "",
  ];
}

function createRouteLoaderHintsForVirtualModules(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): Record<string, boolean> {
  if (options.pagesDir) {
    const pages = scanPagesDirectory(resolve(root, options.pagesDir.slice(1)));
    const hints: Record<string, boolean> = {};
    for (const page of pages) {
      const key = `${options.pagesDir}/${page.relativePath.replace(/\\/g, "/")}`;
      hints[key] = !!page.hasLoader;
    }
    return hints;
  }

  const appFileAbs = resolve(root, options.appFile.slice(1));
  const appFileDir = dirname(appFileAbs);
  const routesDirAbs = resolve(root, options.routesDir.slice(1));
  return createRouteLoaderHints(routesDirAbs, {
    appFileDir,
    rootRelativePrefix: options.routesDir,
  });
}

export function createPrachtRegistryModuleSource(options: PrachtPluginOptions = {}): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const routeTsrxGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.tsrx`
    : `${resolved.routesDir}/**/*.tsrx`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;
  const shellTsrxGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.tsrx`
    : `${resolved.shellsDir}/**/*.tsrx`;

  return [
    `export const routeModules = {`,
    `  ...import.meta.glob(${JSON.stringify(routeGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(routeTsrxGlob)}),`,
    `};`,
    `export const shellModules = {`,
    `  ...import.meta.glob(${JSON.stringify(shellGlob)}),`,
    `  ...import.meta.glob(${JSON.stringify(shellTsrxGlob)}),`,
    `};`,
    `export const middlewareModules = import.meta.glob(${JSON.stringify(`${resolved.middlewareDir}/**/*.{ts,tsx,js,jsx}`)});`,
    `export const apiModules = import.meta.glob(${JSON.stringify(`${resolved.apiDir}/**/*.{ts,js,tsx,jsx}`)});`,
    `export const dataModules = import.meta.glob(${JSON.stringify(`${resolved.serverDir}/**/*.{ts,js,tsx,jsx}`)});`,
    `export const capabilityModules = import.meta.glob(${JSON.stringify(`${resolved.capabilitiesDir}/**/*.{ts,js,tsx,jsx}`)});`,
    "",
    "export const registry = {",
    "  routeModules,",
    "  shellModules,",
    "  middlewareModules,",
    "  apiModules,",
    "  dataModules,",
    "  capabilityModules,",
    "};",
  ].join("\n");
}

const pagesAppSourceCache = new Map<string, string>();

export function clearPagesAppSourceCache(): void {
  pagesAppSourceCache.clear();
}

function generatePagesAppInlineSource(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): string {
  const absPagesDir = resolve(root, options.pagesDir.slice(1));
  const cacheKey = JSON.stringify({
    absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  const cached = pagesAppSourceCache.get(cacheKey);
  if (cached) return cached;

  const pages = scanPagesDirectory(absPagesDir);
  const source = generatePagesManifestSource(pages, {
    pagesDir: absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  pagesAppSourceCache.set(cacheKey, source);
  return source;
}
