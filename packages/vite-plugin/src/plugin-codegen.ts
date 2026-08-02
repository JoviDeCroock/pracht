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

  // Base directory for relative manifest refs: the app manifest file's
  // directory (refs like "./routes/home.tsx" are written relative to it).
  const appFilePosix = resolved.appFile.replace(/\\/g, "/").replace(/^\.\//, "");
  const appFileAbs = appFilePosix.startsWith("/") ? appFilePosix : `/${appFilePosix}`;
  const appDir = appFileAbs.replace(/\/[^/]*$/, "") || "/";

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
    `const APP_DIR = ${JSON.stringify(appDir)};`,
    "",
    "// Manifest refs are written relative to the app manifest file",
    '// ("./routes/home.tsx") while import.meta.glob keys are root-absolute',
    '// ("/src/routes/home.tsx"). Both sides canonicalize against APP_DIR —',
    "// known at build time — replacing the previous runtime suffix index.",
    "function canonicalModuleKey(path) {",
    '  const raw = path.split("?")[0];',
    '  const joined = raw.startsWith("/") ? raw : APP_DIR + "/" + raw;',
    "  const parts = [];",
    '  for (const segment of joined.split("/")) {',
    '    if (!segment || segment === ".") continue;',
    '    if (segment === "..") parts.pop();',
    "    else parts.push(segment);",
    "  }",
    '  return "/" + parts.join("/");',
    "}",
    "",
    "const moduleKeyIndexes = new WeakMap();",
    "function getModuleKeyIndex(modules) {",
    "  let index = moduleKeyIndexes.get(modules);",
    "  if (index) return index;",
    "  index = new Map();",
    "  for (const key of Object.keys(modules)) index.set(canonicalModuleKey(key), key);",
    "  moduleKeyIndexes.set(modules, index);",
    "  return index;",
    "}",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    "  const key = getModuleKeyIndex(modules).get(canonicalModuleKey(file));",
    "  if (key != null) return key;",
    "  if (import.meta.env?.DEV) {",
    "    // Dev-only lenient fallback so refs that never canonicalize (written",
    "    // relative to a file other than the app manifest) keep working while",
    "    // the console error tells the author to fix them — production builds",
    "    // resolve strictly and drop this branch.",
    '    const suffix = "/" + file.split("?")[0].replace(/^\\.?\\//, "");',
    "    for (const candidate of Object.keys(modules)) {",
    "      if (canonicalModuleKey(candidate).endsWith(suffix)) {",
    "        console.error(",
    "          `[pracht] Module ref ${JSON.stringify(file)} only resolved by suffix matching ` +",
    "            `against ${JSON.stringify(candidate)}. Write manifest refs relative to the app ` +",
    '            `manifest file (e.g. "./routes/home.tsx") — suffix matching is disabled in ` +',
    "            `production builds.`,",
    "        );",
    "        return candidate;",
    "      }",
    "    }",
    "  }",
    "  return null;",
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
  const llmsTxtConfig = resolveLlmsTxtConfig(resolved, buildOptions.root);

  // The adapter tells us what extra imports it needs (e.g. handlePrachtRequest).
  // Always import prerenderApp so the CLI uses the same bundled copy of
  // @pracht/core/server (and therefore the same Preact context instances) as the
  // route/shell modules — avoids dual-copy issues during SSG prerendering.
  let prachtImports = adapter?.serverImports
    ? adapter.serverImports + '\nimport { prerenderApp } from "@pracht/core/server";'
    : 'import { resolveApp, resolveApiRoutes, prerenderApp } from "@pracht/core/server";';
  if (llmsTxtConfig) {
    prachtImports += '\nimport { buildLlmsTxt } from "@pracht/core/server";';
  }

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
    ...(llmsTxtConfig
      ? [
          "// llms.txt (https://llmstxt.org) generated from the resolved app graph.",
          "// `pracht build` writes it to dist/client/llms.txt; the dev SSR",
          "// middleware serves it at /llms.txt.",
          `const llmsTxtConfig = ${JSON.stringify(llmsTxtConfig)};`,
          "export const generateLlmsTxt = () =>",
          "  buildLlmsTxt({ ...llmsTxtConfig, apiRoutes, app: resolvedApp, registry });",
        ]
      : []),
    "",
  ];

  if (adapter) {
    source.push(adapter.createServerEntryModule());
  }

  return source.join("\n");
}

interface ResolvedLlmsTxtConfig {
  title: string;
  description?: string;
  origin?: string;
  include?: string[];
}

/**
 * Fill llms.txt title/description from the app's package.json when the user
 * did not set them explicitly. Returns null when the feature is disabled so
 * the server module codegen stays byte-for-byte unchanged.
 */
function resolveLlmsTxtConfig(
  resolved: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): ResolvedLlmsTxtConfig | null {
  if (!resolved.llmsTxt) return null;

  let pkg: { name?: unknown; description?: unknown } = {};
  try {
    pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf-8"));
  } catch {}

  const config: ResolvedLlmsTxtConfig = {
    title: resolved.llmsTxt.title ?? (typeof pkg.name === "string" && pkg.name ? pkg.name : "App"),
  };
  const description =
    resolved.llmsTxt.description ??
    (typeof pkg.description === "string" && pkg.description ? pkg.description : undefined);
  if (description) config.description = description;
  if (resolved.llmsTxt.origin) config.origin = resolved.llmsTxt.origin;
  if (resolved.llmsTxt.include) config.include = resolved.llmsTxt.include;
  return config;
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
