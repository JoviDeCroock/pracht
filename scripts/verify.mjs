// Runs the full pre-commit verification with everything that can safely overlap
// overlapping. Sequential `build && format && lint && typecheck && test && e2e`
// spends most of its wall clock waiting on one core.
//
// `typecheck` runs beside the test suites because it is a single long tsc pass
// that asserts nothing about timing. `test` and `e2e` do NOT run beside each
// other: both already saturate every core, and some E2E specs assert on a
// pending state that lasts a few hundred milliseconds against a 5s timeout.
// Racing them turns those into flakes for no wall-clock gain.
//
//   node scripts/verify.mjs              build, then format/lint, then checks
//   node scripts/verify.mjs --skip-build reuse the dist/ from a previous build
//   node scripts/verify.mjs --skip-e2e   unit tests only (no browser needed)
//
// Formatting runs before the checks rather than beside them: oxfmt and oxlint
// rewrite files in place, and rewriting sources under a running test process
// would make the result depend on timing.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const skipE2e = args.has("--skip-e2e");

function run(name, command, commandArgs) {
  const startedAt = Date.now();
  return new Promise((resolveTask) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });

    child.on("error", (error) => {
      resolveTask({ name, ok: false, output: String(error), seconds: 0 });
    });
    child.on("close", (code) => {
      resolveTask({
        name,
        ok: code === 0,
        output,
        seconds: (Date.now() - startedAt) / 1000,
      });
    });
  });
}

function report(result) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`\n${"=".repeat(60)}\n${status}  ${result.name} (${result.seconds.toFixed(1)}s)`);
  // A passing lint/format run says nothing worth reading; a failing one does.
  if (!result.ok || process.env.VERIFY_VERBOSE) {
    console.log(result.output.trimEnd());
  }
  return result;
}

const results = [];

// 1. Build. The CLI tests compile against packages/*/dist, so a stale build
//    fails (or passes) for reasons that have nothing to do with the change.
if (!skipBuild) {
  results.push(report(await run("build", "pnpm", ["run", "build"])));
}

// 2. Formatters, which mutate the tree.
if (results.every((result) => result.ok)) {
  results.push(report(await run("format", "pnpm", ["run", "format"])));
  results.push(report(await run("lint", "pnpm", ["run", "lint"])));
}

// 3. Check the canonical basic example before the workspace-wide checks.
if (results.every((result) => result.ok)) {
  // Type generation reads the app graph through Vite, and its output is an
  // input to the example's dedicated TypeScript program.
  results.push(
    report(
      await run("basic generated types", "pnpm", [
        "--dir",
        "examples/basic",
        "run",
        "typegen:check",
      ]),
    ),
  );
  if (results.every((result) => result.ok)) {
    results.push(
      report(
        await run("basic generated typecheck", "pnpm", [
          "--dir",
          "examples/basic",
          "run",
          "typecheck",
        ]),
      ),
    );
  }
}

// 4. Typecheck alongside the test suites, which run one after the other.
if (results.every((result) => result.ok)) {
  const suites = (async () => {
    const finished = [run("test", "pnpm", ["run", "test"])];
    if (!skipE2e && (await finished[0]).ok) {
      finished.push(run("e2e", "pnpm", ["run", "e2e"]));
    }
    return Promise.all(finished);
  })();

  const typecheck = run("typecheck", "pnpm", ["run", "typecheck"]);
  for (const result of [await typecheck, ...(await suites)]) {
    results.push(report(result));
  }
}

const failed = results.filter((result) => !result.ok);
const total = results.reduce((sum, result) => sum + result.seconds, 0);
console.log(
  `\n${"=".repeat(60)}\n${failed.length === 0 ? "verify passed" : `verify failed: ${failed.map((result) => result.name).join(", ")}`} (${total.toFixed(1)}s of work)`,
);
process.exit(failed.length === 0 ? 0 : 1);
