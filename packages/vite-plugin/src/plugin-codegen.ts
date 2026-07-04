import { dirname, resolve } from "node:path";
import { PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import { CLIENT_BROWSER_PATH, readClientBuildAssets } from "./plugin-assets.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";
import { createRouteLoaderHints } from "./route-loader-hints.ts";

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
    `  ...import.meta.glob(${JSON.stringify(routeGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} }),`,
    `  ...import.meta.glob(${JSON.stringify(routeTsrxGlob)}),`,
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
    : { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
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

  const source = [
    prachtImports,
    appImport,
    "",
    `const routeLoaderHints = ${JSON.stringify(routeLoaderHints)};`,
    ...createApplyRouteLoaderHintsSource(),
    registrySource,
    "",
    "export const resolvedApp = resolveApp(app);",
    "applyRouteLoaderHints(resolvedApp, routeLoaderHints);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const clientEntryUrl = ${JSON.stringify(clientBuild.clientEntryUrl ?? CLIENT_BROWSER_PATH)};`,
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
    "",
    "export const registry = {",
    "  routeModules,",
    "  shellModules,",
    "  middlewareModules,",
    "  apiModules,",
    "  dataModules,",
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
