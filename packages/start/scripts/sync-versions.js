#!/usr/bin/env node

/**
 * Records the current version of every sibling `@pracht/*` package in
 * `fallback-versions.json`, so a published create-pracht that cannot reach the
 * registry still scaffolds the ranges it was released alongside. Runs as part
 * of the package build; the file is gitignored.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FALLBACK_VERSIONS_FILE, collectWorkspaceVersionRanges } from "../src/versions.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const ranges = collectWorkspaceVersionRanges(resolve(packageRoot, ".."));

if (!ranges["@pracht/core"]) {
  console.error("sync-versions: no @pracht/core next to this package");
  process.exit(1);
}

writeFileSync(resolve(packageRoot, FALLBACK_VERSIONS_FILE), `${JSON.stringify(ranges, null, 2)}\n`);
console.log(
  `sync-versions: recorded ${Object.keys(ranges).length} package versions in ${FALLBACK_VERSIONS_FILE}`,
);
