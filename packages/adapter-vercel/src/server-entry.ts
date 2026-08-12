import type { VercelServerEntryModuleOptions } from "./types.js";

export function createVercelServerEntryModule(
  options: VercelServerEntryModuleOptions = {},
): string {
  const functionName = options.functionName ?? "render";
  const regions = options.regions;
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";

  return [
    contextImport,
    `export const vercelFunctionName = ${JSON.stringify(functionName)};`,
    `export const vercelRegions = ${JSON.stringify(regions ?? null)};`,
    "",
    "export default async function handle(request, context) {",
    "  const handler = createVercelEdgeHandler({",
    "    app: resolvedApp,",
    "    registry,",
    "    apiRoutes,",
    "    clientEntryUrl: clientEntryUrl ?? undefined,",
    "    islandsEntryUrl: islandsEntryUrl ?? undefined,",
    "    islandsBootstrapRequired,",
    "    cssManifest,",
    "    jsManifest,",
    "    createContext: createPrachtContext,",
    "  });",
    "  return handler(request, context);",
    "}",
    "",
    "// Entry point of the Node serverless functions emitted for ISG routes;",
    "// Vercel rejects `.prerender-config.json` next to an edge function.",
    "export const nodeListener = createVercelNodeListener(handle);",
    "",
  ].join("\n");
}
