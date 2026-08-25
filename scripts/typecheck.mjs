// Runs every TypeScript program in the repo at once, incrementally.
//
// `tsc --noEmit && tsc -p <fixture> && tsc -p examples/showcase` is three full
// re-checks in a row on a machine with ten cores. The programs are independent
// on purpose — generated `declare module` registrations are global to a
// program, so each app keeps its own (see examples/showcase/tsconfig.json) —
// which is exactly what makes them safe to run side by side.
//
// Each program also gets its own `.tsbuildinfo`, so a run that only touched one
// package re-checks that package's files instead of the whole graph.
// `tsBuildInfoFile` has to be passed per invocation rather than set in
// tsconfig.json: the programs all extend the root config, and a relative path
// declared there resolves against the root, so they would share one file and
// invalidate each other every run.
//
//   node scripts/typecheck.mjs          check every program
//   node scripts/typecheck.mjs --clean  drop the incremental state first
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const buildInfoDir = resolve(repoRoot, "node_modules/.cache/pracht-tsbuildinfo");
const tsc = resolve(repoRoot, "node_modules/typescript/bin/tsc");

const PROGRAMS = [
  { name: "workspace", project: "tsconfig.json" },
  { name: "cloudflare-fixture", project: "packages/cli/test/fixtures/cloudflare-runtime-import" },
  { name: "showcase", project: "examples/showcase" },
  { name: "basic", project: "examples/basic" },
];

const args = new Set(process.argv.slice(2));
if (args.has("--clean")) rmSync(buildInfoDir, { force: true, recursive: true });
mkdirSync(buildInfoDir, { recursive: true });

if (!existsSync(tsc)) {
  console.error(`typecheck: cannot find TypeScript at ${tsc}`);
  process.exit(1);
}

function check({ name, project }) {
  return new Promise((resolveTask) => {
    const child = spawn(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--project",
        project,
        "--incremental",
        "--tsBuildInfoFile",
        resolve(buildInfoDir, `${name}.tsbuildinfo`),
      ],
      { cwd: repoRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => resolveTask({ name, ok: false, output: String(error) }));
    child.on("close", (code) => resolveTask({ name, ok: code === 0, output }));
  });
}

const results = await Promise.all(PROGRAMS.map(check));
const failed = results.filter((result) => !result.ok);
for (const result of failed) {
  console.error(`\ntypecheck failed: ${result.name}\n${result.output.trimEnd()}`);
}
process.exit(failed.length === 0 ? 0 : 1);
