import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";
import { createPrachtRegistryModuleSource } from "./plugin-registry-codegen.ts";
import { generatePagesAppInlineSource } from "./plugin-route-sources.ts";

/**
 * Adapter-neutral app metadata used by development tooling. Keeping this
 * separate from the server entry avoids evaluating worker-only imports (for
 * example `cloudflare:workers`) in Vite's Node SSR environment.
 */
export function createPrachtDevModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const resolved = resolveOptions(options);
  const appImport = resolved.pagesDir
    ? generatePagesAppInlineSource(resolved, buildOptions.root)
    : `import { app } from ${JSON.stringify(resolved.appFile)};`;

  return [
    'import { resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    appImport,
    "",
    createPrachtRegistryModuleSource(resolved),
    "",
    "export const resolvedApp = resolveApp(app);",
    `export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), ${JSON.stringify(resolved.apiDir)});`,
    `export const buildTarget = ${JSON.stringify(resolved.adapter?.id ?? "node")};`,
    "",
  ].join("\n");
}
