#!/usr/bin/env node
/**
 * Runs several package scripts at once and fails if any of them does.
 *
 * Usage:
 *   node scripts/run-parallel.mjs <package-dir> <script> [...scripts]
 *
 * `pnpm run a && pnpm run b && ...` pays a fresh Node and Vite startup per
 * step on a machine with cores to spare. Output is buffered per script and
 * printed only for the ones that fail, so interleaved logs never appear.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [packageDir, ...scripts] = process.argv.slice(2);

if (!packageDir || scripts.length === 0) {
  console.error("Usage: run-parallel.mjs <package-dir> <script> [...scripts]");
  process.exit(1);
}

const cwd = resolve(process.cwd(), packageDir);

const results = await Promise.all(
  scripts.map(
    (script) =>
      new Promise((resolveTask) => {
        const child = spawn("pnpm", ["run", script], {
          cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.on("error", (error) => resolveTask({ script, ok: false, output: String(error) }));
        child.on("close", (code) => resolveTask({ script, ok: code === 0, output }));
      }),
  ),
);

const failed = results.filter((result) => !result.ok);
for (const result of failed) {
  console.error(`\n${result.script} failed\n${result.output.trimEnd()}`);
}
process.exit(failed.length === 0 ? 0 : 1);
