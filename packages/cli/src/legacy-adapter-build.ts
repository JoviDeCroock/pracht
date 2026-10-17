import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ISGManifestEntry } from "@pracht/core";

import {
  describeVercelRouteBudget,
  resolveVercelRuntimeRoutes,
  writeVercelBuildOutput,
} from "./build-shared.js";
import { writeCloudflareAssetHeaders } from "./cloudflare-asset-headers.js";

/**
 * What `pracht build` passes to an adapter's `finalizeBuild`. Mirrors
 * `PrachtAdapterBuildContext` in `@pracht/vite-plugin`, which the CLI does not
 * depend on.
 */
export interface AdapterBuildContext {
  root: string;
  clientDir: string;
  publicDir: string;
  publicDirLabel: string;
  base: string;
  trailingSlash: "ignore" | "never" | "always";
  frameworkVersion: string;
  serverEntry: Readonly<Record<string, unknown>>;
  pages: readonly string[];
  onDemandPages: readonly string[];
  isgManifest: Readonly<Record<string, ISGManifestEntry>>;
  headersManifest: Readonly<Record<string, Record<string, string>>>;
  markdownRoutes: readonly string[];
  markdownFiles: readonly { path: string; outputPath: string }[];
  contentArtifacts: readonly string[];
  staticRoutes: readonly string[];
  log(message: string): void;
  warn(message: string): void;
}

/** The part of a `PrachtAdapter` the build reads. */
export interface BuildAdapter {
  id?: unknown;
  finalizeBuild?(context: AdapterBuildContext): void | Promise<void>;
}

/**
 * The Cloudflare and Vercel deploy steps for adapter releases that predate
 * `finalizeBuild`. Newer releases run their own copy, so this is removable
 * once the CLI requires them.
 */
export async function finalizeLegacyAdapterBuild(
  buildTarget: "cloudflare" | "vercel",
  context: AdapterBuildContext,
): Promise<void> {
  if (buildTarget === "cloudflare") await finalizeLegacyCloudflareBuild(context);
  else finalizeLegacyVercelBuild(context);
}

async function finalizeLegacyCloudflareBuild(context: AdapterBuildContext): Promise<void> {
  const { clientDir, isgManifest, root, serverEntry } = context;

  if (Object.keys(isgManifest).length > 0) {
    // Only the Cloudflare worker runtime reads the manifest from the static
    // assets (via readPrachtISGManifest).
    mkdirSync(resolve(clientDir, "_pracht"), { recursive: true });
    writeFileSync(
      resolve(clientDir, "_pracht/isg.json"),
      `${JSON.stringify(isgManifest, null, 2)}\n`,
      "utf-8",
    );
  }

  const assetHeaders = writeCloudflareAssetHeaders(
    clientDir,
    context.publicDir,
    { ...context.headersManifest },
    context.publicDirLabel,
  );
  if (assetHeaders.warning) context.warn(`\n  Warning: ${assetHeaders.warning}\n`);
  if (assetHeaders.skipped.length > 0) {
    context.warn(
      `\n  Warning: dist/client/_headers cannot match ${assetHeaders.skipped.join(", ")} ` +
        "exactly, so Cloudflare serves them with the /assets/* immutable policy instead of " +
        "their build headers. Rename them or keep them out of /assets/.\n",
    );
  }

  if (serverEntry.cloudflareWorkersCacheEnabled === true && context.onDemandPages.length > 0) {
    context.log(
      `\n  ISG via Workers Caching: ${context.onDemandPages.length} route(s) render on demand and revalidate at the edge. Requires "cache": { "enabled": true } in wrangler config.\n`,
    );
  }

  // workerd accepts only handlers and entrypoint classes as the Worker
  // module's exports, so when the built entry re-exports anything else (or an
  // older adapter emitted only server.js, whose build metadata workerd
  // rejects), write a thin entry re-exporting just those from server.js.
  const workerEntryPath = resolve(root, "dist/server/worker.js");
  const builtWorkerEntry = existsSync(workerEntryPath);
  const legacyEntrypointNames: unknown[] = Array.isArray(
    serverEntry.cloudflareWorkerEntrypointNames,
  )
    ? serverEntry.cloudflareWorkerEntrypointNames
    : [];
  const deployExports: Array<[string, unknown]> = builtWorkerEntry
    ? Object.entries(await import(pathToFileURL(workerEntryPath).href))
    : Object.entries(serverEntry).filter(([name]) => legacyEntrypointNames.includes(name));
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
    context.log(
      `\n  Left ${droppedNames.join(", ")} out of dist/server/worker.js: a Worker module may only export handlers and entrypoint classes.`,
    );
  }

  context.log("\n  Cloudflare worker → dist/server/worker.js\n");
  context.log(describeCloudflareDeploy(root));
}

function finalizeLegacyVercelBuild(context: AdapterBuildContext): void {
  const { isgManifest, serverEntry } = context;
  // ISG routes deploy as Node serverless functions that re-export
  // `nodeListener` from the bundle; catch a custom server entry that
  // doesn't provide it here instead of at request time in production.
  if (Object.keys(isgManifest).length > 0 && typeof serverEntry.nodeListener !== "function") {
    throw new Error(
      "The Vercel server entry does not export `nodeListener`, which the ISG routes' " +
        "serverless functions import. Generate the entry with `vercelAdapter()` or export " +
        "`createVercelNodeListener(handle)` from your custom entry module.",
    );
  }

  const resolvedApp = serverEntry.resolvedApp as
    | { agents?: Parameters<typeof resolveVercelRuntimeRoutes>[0] }
    | undefined;
  const { outputPath, routeCount } = writeVercelBuildOutput({
    base: context.base,
    functionName:
      typeof serverEntry.vercelFunctionName === "string"
        ? serverEntry.vercelFunctionName
        : undefined,
    isgManifest: { ...isgManifest },
    headersManifest: { ...context.headersManifest },
    markdownFiles: context.markdownFiles.map((file) => file.outputPath),
    markdownRoutes: [...context.markdownRoutes],
    regions: serverEntry.vercelRegions as string | string[] | undefined,
    root: context.root,
    runtimeRoutes: resolveVercelRuntimeRoutes(resolvedApp?.agents),
    // Markdown files are exact-path static files like content artifacts;
    // listing them applies their headers-manifest entry on Vercel.
    staticAssetRoutes: [
      ...context.contentArtifacts,
      ...context.markdownFiles.map((file) => file.path),
    ],
    staticRoutes: [
      ...context.pages.filter((path) => !(path in isgManifest)),
      ...context.staticRoutes,
    ],
    trailingSlash: context.trailingSlash,
    pageRoutes: [...context.pages],
  });

  context.log(`\n  Vercel build output → ${outputPath}\n`);
  const routeBudget = describeVercelRouteBudget(routeCount);
  if (routeBudget) context.warn(`\n  Warning: ${routeBudget}\n`);
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
