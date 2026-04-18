#!/usr/bin/env node

import { run } from "../src/index.js";

run().catch((error) => {
  const code = error && error.code === 2 ? 2 : 1;
  console.error(code === 2 ? error.message : "Failed to create a pracht app.");
  if (code !== 2) {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(code);
});
