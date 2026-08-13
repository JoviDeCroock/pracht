import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { getTimeRevalidateSeconds, type ISGManifestEntry } from "@pracht/core/server";

import {
  createVercelNodeFunctionConfig,
  routeToPrerenderFunctionName,
  routeToStaticHtmlPath,
  VERCEL_NODE_ENTRY_FILE,
  VERCEL_NODE_ENTRY_SOURCE,
  type VercelRegions,
} from "./vercel-output-config.js";

export interface VercelPrerenderOutputOptions {
  functionDir: string;
  functionsDir: string;
  headersManifest: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  regions?: VercelRegions;
  revalidateToken: string;
  staticDir: string;
}

/** Validate route/function identity before the output directory is replaced. */
export function assertNoVercelPrerenderFunctionCollisions({
  functionDir,
  functionName,
  functionsDir,
  isgRoutes,
}: {
  functionDir: string;
  functionName: string;
  functionsDir: string;
  isgRoutes: string[];
}): void {
  for (const route of isgRoutes) {
    const prerenderName = routeToPrerenderFunctionName(route);
    const routeFunctionDir = join(functionsDir, `${prerenderName}.func`);
    if (routeFunctionDir !== functionDir) continue;

    throw new Error(
      `Cannot emit Vercel ISG route ${JSON.stringify(route)} because its prerender function ${JSON.stringify(`${prerenderName}.func`)} collides with the main edge function ${JSON.stringify(`${functionName}.func`)}. Rename the route or configure vercelAdapter({ functionName: "..." }) with a non-conflicting name.`,
    );
  }
}

/** Materialize shared Node ISR functions and their prerender configuration. */
export function writeVercelPrerenderFunctions({
  functionDir,
  functionsDir,
  headersManifest,
  isgManifest,
  regions,
  revalidateToken,
  staticDir,
}: VercelPrerenderOutputOptions): void {
  // The first ISG route materializes the Node function; the rest symlink to it
  // so that N ISG paths don't each duplicate the server bundle.
  let sharedNodeFunctionDir: string | undefined;

  for (const [route, entry] of Object.entries(isgManifest)) {
    const prerenderName = routeToPrerenderFunctionName(route);
    const routeFunctionDir = join(functionsDir, `${prerenderName}.func`);
    if (sharedNodeFunctionDir) {
      linkVercelPrerenderFunction({ routeFunctionDir, sharedNodeFunctionDir });
    } else {
      writeVercelPrerenderFunction({ functionDir, regions, routeFunctionDir });
      sharedNodeFunctionDir = routeFunctionDir;
    }

    const configPath = join(functionsDir, `${prerenderName}.prerender-config.json`);
    const fallbackName = `${basename(prerenderName)}.prerender-fallback.html`;
    const fallbackPath = join(dirname(configPath), fallbackName);
    const staticHtmlPath = join(staticDir, routeToStaticHtmlPath(route).slice(1));
    if (existsSync(staticHtmlPath)) {
      mkdirSync(dirname(fallbackPath), { recursive: true });
      cpSync(staticHtmlPath, fallbackPath);
      rmSync(staticHtmlPath, { force: true });
    }

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          allowQuery: [],
          bypassToken: revalidateToken,
          expiration: getTimeRevalidateSeconds(entry.revalidate) ?? false,
          fallback: existsSync(fallbackPath) ? fallbackName : undefined,
          initialHeaders: headersManifest[route],
          initialStatus: 200,
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
  }
}

/**
 * Emit the Serverless Function ISG routes render through. It gets its own copy
 * of the server bundle rather than linking to the edge function's: Node
 * resolves a symlinked module at its real path, so a linked `server.js` would
 * be typed by the edge function directory — which carries no ESM
 * `package.json` — and fail to parse as CommonJS.
 */
function writeVercelPrerenderFunction({
  functionDir,
  regions,
  routeFunctionDir,
}: {
  functionDir: string;
  regions?: VercelRegions;
  routeFunctionDir: string;
}): void {
  mkdirSync(dirname(routeFunctionDir), { recursive: true });
  cpSync(functionDir, routeFunctionDir, { recursive: true });

  // The bundle is ESM and Vite emits no `package.json` beside it, so without
  // this Node would load `server.js` as CommonJS and fail to parse it.
  writeFileSync(
    join(routeFunctionDir, "package.json"),
    `${JSON.stringify({ type: "module" }, null, 2)}\n`,
    "utf-8",
  );
  writeFileSync(join(routeFunctionDir, VERCEL_NODE_ENTRY_FILE), VERCEL_NODE_ENTRY_SOURCE, "utf-8");
  writeFileSync(
    join(routeFunctionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelNodeFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );
}

function linkVercelPrerenderFunction({
  routeFunctionDir,
  sharedNodeFunctionDir,
}: {
  routeFunctionDir: string;
  sharedNodeFunctionDir: string;
}): void {
  mkdirSync(dirname(routeFunctionDir), { recursive: true });
  // Vercel resolves symlinked `.func` directories; fall back to a copy where
  // symlinks aren't available (e.g. Windows without the required privileges).
  try {
    symlinkSync(
      relative(dirname(routeFunctionDir), sharedNodeFunctionDir),
      routeFunctionDir,
      "dir",
    );
  } catch {
    cpSync(sharedNodeFunctionDir, routeFunctionDir, { recursive: true });
  }
}

function basename(value: string): string {
  const segments = value.split("/");
  return segments[segments.length - 1] || "index";
}
