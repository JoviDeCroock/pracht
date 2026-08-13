import { hasWebmcpCapabilities } from "./plugin-capabilities.ts";
import { createApplyRouteLoaderHintsSource } from "./plugin-codegen-route-hints.ts";
import { resolveLlmsTxtConfig } from "./plugin-llms-txt-config.ts";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  readClientBuildAssets,
} from "./plugin-assets.ts";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";
import { createPrachtRegistryModuleSource } from "./plugin-registry-codegen.ts";
import {
  createRouteLoaderHintsForVirtualModules,
  generatePagesAppInlineSource,
} from "./plugin-route-sources.ts";

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
  const islandsBootstrapRequired = hasWebmcpCapabilities(resolved, buildOptions.root);

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
    `export const islandsBootstrapRequired = ${JSON.stringify(islandsBootstrapRequired)};`,
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
