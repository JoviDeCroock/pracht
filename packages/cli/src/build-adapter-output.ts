import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { BuildOutputLogger } from "./build-static-output.js";
import { writeVercelBuildOutput, type VercelBuildOutputOptions } from "./vercel-build-output.js";

interface AdapterBuildPage {
  path: string;
}

export interface FinalizeBuildAdapterOptions {
  buildTarget: string | null;
  cloudflareWorkerEntrypointNames: unknown;
  cloudflareWorkersCacheEnabled: boolean;
  edgeCachedIsgPaths: readonly string[];
  generatedStaticRoutes: readonly string[];
  headersManifest: NonNullable<VercelBuildOutputOptions["headersManifest"]>;
  isgManifest: VercelBuildOutputOptions["isgManifest"];
  log: BuildOutputLogger;
  markdownManifest: Record<string, true>;
  nodeListener: unknown;
  pages: readonly AdapterBuildPage[];
  root: string;
  vercelFunctionName?: string;
  vercelRegions?: string | string[];
}

export function finalizeBuildAdapter(options: FinalizeBuildAdapterOptions): void {
  if (options.buildTarget === "cloudflare") {
    writeCloudflareDeployEntry(options);
    return;
  }
  if (options.buildTarget === "vercel") {
    writeVercelAdapterOutput(options);
  }
}

function writeCloudflareDeployEntry(options: FinalizeBuildAdapterOptions): void {
  if (options.cloudflareWorkersCacheEnabled && options.edgeCachedIsgPaths.length > 0) {
    options.log(
      `\n  ISG via Workers Caching: ${options.edgeCachedIsgPaths.length} route(s) render on demand and revalidate at the edge. Requires "cache": { "enabled": true } in wrangler config.\n`,
    );
  }

  // workerd treats every named export as an entrypoint. Keep build metadata on
  // server.js for prerendering, but deploy a narrow public worker module.
  const entrypointNames: string[] = Array.isArray(options.cloudflareWorkerEntrypointNames)
    ? options.cloudflareWorkerEntrypointNames
    : [];
  const deployEntryLines = [
    ...(entrypointNames.length > 0
      ? [`export { ${entrypointNames.join(", ")} } from "./server.js";`]
      : []),
    'export { default } from "./server.js";',
    "",
  ];
  writeFileSync(
    resolve(options.root, "dist/server/worker.js"),
    deployEntryLines.join("\n"),
    "utf-8",
  );

  options.log("\n  Cloudflare worker → dist/server/worker.js\n");
  options.log("  Deploy with: wrangler deploy\n");
}

function writeVercelAdapterOutput(options: FinalizeBuildAdapterOptions): void {
  // Native ISR routes import nodeListener from the bundle. Fail at build time
  // instead of shipping a serverless function that fails on its first request.
  if (Object.keys(options.isgManifest).length > 0 && typeof options.nodeListener !== "function") {
    throw new Error(
      "The Vercel server entry does not export `nodeListener`, which the ISG routes' " +
        "serverless functions import. Generate the entry with `vercelAdapter()` or export " +
        "`createVercelNodeListener(handle)` from your custom entry module.",
    );
  }

  const outputPath = writeVercelBuildOutput({
    functionName: options.vercelFunctionName,
    isgManifest: options.isgManifest,
    headersManifest: options.headersManifest,
    markdownRoutes: Object.keys(options.markdownManifest),
    regions: options.vercelRegions,
    root: options.root,
    staticRoutes: [
      ...options.pages.map((page) => page.path).filter((path) => !(path in options.isgManifest)),
      ...options.generatedStaticRoutes,
    ],
  });
  options.log(`\n  Vercel build output → ${outputPath}\n`);
}
