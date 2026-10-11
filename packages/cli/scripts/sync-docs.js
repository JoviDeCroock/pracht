#!/usr/bin/env node

/**
 * Package build step: copies the public docs site pages into `docs/` for
 * `pracht docs` and the dev-mcp docs tools. See `docs-bundle.js` for the
 * transformation. The output directory is gitignored.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDocsBundle, writeDocsBundle } from "./docs-bundle.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(packageRoot, "../..");
const sourceDir = resolve(repoRoot, "examples/docs/src/routes/docs");
const shellFile = resolve(repoRoot, "examples/docs/src/shells/docs.tsx");
const targetDir = join(packageRoot, "docs");

if (!existsSync(sourceDir)) {
  console.error(`sync-docs: missing source directory ${sourceDir}`);
  process.exit(1);
}

const bundle = buildDocsBundle({ sourceDir, shellFile });
if (bundle.pages.length === 0) {
  console.error(`sync-docs: no .md pages found in ${sourceDir}`);
  process.exit(1);
}
writeDocsBundle(bundle, targetDir);
console.log(`sync-docs: copied ${bundle.pages.length} docs pages into packages/cli/docs`);
