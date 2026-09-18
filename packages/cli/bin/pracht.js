#!/usr/bin/env node

// Node version preflight. It has to live here, ahead of any static import of
// the CLI itself: the modern built-ins pracht and Vite use (`util.styleText`,
// added in Node 22) are imported at the top of their modules, and an ESM
// import is instantiated before a single line of the entry runs. On an old
// Node that surfaces as `The requested module 'node:util' does not provide an
// export named 'styleText'` — a SyntaxError naming an export, never a version.
// Reading `process.versions.node` first turns it into one actionable line.
// Only `node:fs` and the sibling check are imported here, and neither uses
// anything a supported-but-old Node lacks.
import { readFileSync } from "node:fs";

import { unsupportedNodeMessage } from "./node-version.js";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const message = unsupportedNodeMessage(process.versions.node, manifest.engines?.node ?? ">=22.18");

if (message) {
  console.error(message);
  process.exit(1);
}

await import("../dist/index.mjs");
