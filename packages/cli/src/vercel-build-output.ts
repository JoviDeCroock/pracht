import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ISGManifestEntry } from "@pracht/core/server";

import {
  createVercelFunctionConfig,
  createVercelOutputConfig,
  type VercelRegions,
} from "./vercel-output-config.js";
import {
  assertNoVercelPrerenderFunctionCollisions,
  writeVercelPrerenderFunctions,
} from "./vercel-prerender-output.js";

export interface VercelBuildOutputOptions {
  functionName?: string;
  headersManifest?: Record<string, Record<string, string>>;
  isgManifest: Record<string, ISGManifestEntry>;
  /** Prerendered routes whose module exports `markdown`. */
  markdownRoutes?: string[];
  revalidateToken?: string;
  regions?: VercelRegions;
  root: string;
  staticRoutes: string[];
}

/** Compose the Vercel Build Output API directory from an existing Pracht build. */
export function writeVercelBuildOutput({
  functionName,
  headersManifest = {},
  isgManifest,
  markdownRoutes = [],
  revalidateToken = process.env.PRACHT_REVALIDATE_TOKEN || randomBytes(32).toString("hex"),
  regions,
  root,
  staticRoutes,
}: VercelBuildOutputOptions): string {
  const outputDir = join(root, ".vercel/output");
  const staticDir = join(outputDir, "static");
  const functionsDir = join(outputDir, "functions");
  const resolvedFunctionName = functionName || "render";
  const functionDir = join(functionsDir, `${resolvedFunctionName}.func`);
  const isgRoutes = Object.keys(isgManifest);

  assertNoVercelPrerenderFunctionCollisions({
    functionDir,
    functionName: resolvedFunctionName,
    functionsDir,
    isgRoutes,
  });

  rmSync(outputDir, { force: true, recursive: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(join(root, "dist/client"), staticDir, { recursive: true });
  cpSync(join(root, "dist/server"), functionDir, { recursive: true });
  writeFileSync(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(createVercelFunctionConfig({ regions }), null, 2)}\n`,
    "utf-8",
  );

  writeVercelPrerenderFunctions({
    functionDir,
    functionsDir,
    headersManifest,
    isgManifest,
    regions,
    revalidateToken,
    staticDir,
  });

  writeFileSync(
    join(outputDir, "config.json"),
    `${JSON.stringify(
      createVercelOutputConfig({
        functionName,
        headersManifest,
        isgRoutes,
        markdownRoutes,
        staticRoutes,
      }),
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return ".vercel/output";
}
