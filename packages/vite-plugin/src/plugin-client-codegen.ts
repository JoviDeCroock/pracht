import { createWebmcpBootstrapSource } from "./capability-browser-codegen.ts";
import { PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import { hasWebmcpCapabilities } from "./plugin-capabilities.ts";
import { createApplyRouteLoaderHintsSource } from "./plugin-codegen-route-hints.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";
import {
  createNonFullHydrationExcludes,
  createRouteLoaderHintsForVirtualModules,
  generatePagesAppInlineSource,
} from "./plugin-route-sources.ts";

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
