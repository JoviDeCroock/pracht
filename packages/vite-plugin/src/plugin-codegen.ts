import { resolve } from "node:path";
import { PRACHT_CLIENT_MODULE_QUERY } from "./client-module-query.ts";
import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import { CLIENT_BROWSER_PATH, readClientBuildAssets } from "./plugin-assets.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";

export function createPrachtClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  return [
    'import { resolveApp, initClientRouter, readHydrationState } from "@pracht/core";',
    appImport,
    "",
    `const routeModules = import.meta.glob(${JSON.stringify(routeGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} });`,
    `const shellModules = import.meta.glob(${JSON.stringify(shellGlob)}, { query: ${JSON.stringify(PRACHT_CLIENT_MODULE_QUERY)} });`,
    "",
    "const resolvedApp = resolveApp(app);",
    "",
    "function normalizeModuleKey(key) {",
    '  return key.split("?")[0];',
    "}",
    "",
    "function findModuleKey(modules, file) {",
    "  if (file in modules) return file;",
    '  const suffix = file.replace(/^\\.\\//,"");',
    "  for (const key of Object.keys(modules)) {",
    "    const normalizedKey = normalizeModuleKey(key);",
    '    if (normalizedKey.endsWith("/" + suffix) || normalizedKey.endsWith(suffix)) return key;',
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
  const clientBuild = buildOptions.isBuild
    ? readClientBuildAssets(buildOptions.root)
    : { clientEntryUrl: null, cssManifest: {}, jsManifest: {} };
  const adapter = resolved.adapter;

  // The adapter tells us what extra imports it needs (e.g. handlePrachtRequest).
  // Always import prerenderApp so the CLI uses the same bundled copy of
  // @pracht/core (and therefore the same Preact context instances) as the
  // route/shell modules — avoids dual-copy issues during SSG prerendering.
  const prachtImports = adapter?.serverImports
    ? adapter.serverImports + '\nimport { prerenderApp } from "@pracht/core";'
    : 'import { resolveApp, resolveApiRoutes, prerenderApp } from "@pracht/core";';

  const appImport = isPagesMode
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  const source = [
    prachtImports,
    appImport,
    "",
    registrySource,
    "",
    "export const resolvedApp = resolveApp(app);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(adapter?.id ?? "node")};`,
    `export const clientEntryUrl = ${JSON.stringify(clientBuild.clientEntryUrl ?? CLIENT_BROWSER_PATH)};`,
    `export const cssManifest = ${JSON.stringify(clientBuild.cssManifest)};`,
    `export const jsManifest = ${JSON.stringify(clientBuild.jsManifest)};`,
    "export { prerenderApp };",
    "",
  ];

  if (adapter) {
    source.push(adapter.createServerEntryModule());
  }

  return source.join("\n");
}

export function createPrachtRegistryModuleSource(options: PrachtPluginOptions = {}): string {
  const resolved = resolveOptions(options);
  const isPagesMode = !!resolved.pagesDir;

  const routeGlob = isPagesMode
    ? `${resolved.pagesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`
    : `${resolved.routesDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  const shellGlob = isPagesMode
    ? `${resolved.pagesDir}/**/_app.{ts,tsx,js,jsx}`
    : `${resolved.shellsDir}/**/*.{ts,tsx,js,jsx,md,mdx}`;

  return [
    `export const routeModules = import.meta.glob(${JSON.stringify(routeGlob)});`,
    `export const shellModules = import.meta.glob(${JSON.stringify(shellGlob)});`,
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

function generatePagesAppInlineSource(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): string {
  const absPagesDir = resolve(root, options.pagesDir.slice(1));
  const pages = scanPagesDirectory(absPagesDir);
  const source = generatePagesManifestSource(pages, {
    pagesDir: absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  return source;
}
