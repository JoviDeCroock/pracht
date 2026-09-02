// Runs the full pre-commit verification with everything that can safely overlap
// overlapping. Sequential `build && format && lint && typecheck && test && e2e`
// spends most of its wall clock waiting on one core.
//
// The suite is CPU-bound, not scheduling-bound: on a ten-core machine the wall
// clock tracks total work far more closely than it tracks the shape of the
// dependency graph. So the two things that matter are not doing work twice
// (`scripts/build.mjs` and `scripts/typecheck.mjs` are both incremental) and
// not leaving cores idle.
//
// Typecheck, the example's generated-type check, and the unit tests all run
// together: none of them asserts anything about timing. `test` and `e2e` do NOT
// run beside each other. Both already saturate every core, and some E2E specs
// assert on a pending state that lasts a few hundred milliseconds against a 5s
// timeout. Racing them turns those into flakes for no wall-clock gain.
//
//   node scripts/verify.mjs               build, then format/lint, then checks
//   node scripts/verify.mjs --skip-build  reuse the dist/ from a previous build
//   node scripts/verify.mjs --force-build rebuild every package, cache or not
//   node scripts/verify.mjs --skip-e2e    unit tests only (no browser needed)
//   node scripts/verify.mjs --check       report formatting/lint, never rewrite
//
// Formatting runs before the checks rather than beside them: oxfmt and oxlint
// rewrite files in place, and rewriting sources under a running test process
// would make the result depend on timing. `--check` swaps both for their
// read-only equivalents (`format:check` and `oxlint` without `--fix`) so the
// same gate can run somewhere a dirty tree is a failure rather than a fixup.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableParallelism, loadavg } from "node:os";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const forceBuild = args.has("--force-build");
const skipE2e = args.has("--skip-e2e");
const checkOnly = args.has("--check");
const startedAt = Date.now();

function run(name, command, commandArgs, env = process.env) {
  const taskStartedAt = Date.now();
  return new Promise((resolveTask) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env,
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
        seconds: (Date.now() - taskStartedAt) / 1000,
      });
    });
  });
}

const results = [];

function report(result) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`\n${"=".repeat(60)}\n${status}  ${result.name} (${result.seconds.toFixed(1)}s)`);
  // A passing lint/format run says nothing worth reading; a failing one does.
  if (!result.ok || process.env.VERIFY_VERBOSE) {
    console.log(result.output.trimEnd());
  }
  results.push(result);
  return result;
}

const ok = () => results.every((result) => result.ok);

/** Report each task the moment it settles, so a long group still shows progress. */
function reportAsSettled(tasks) {
  return Promise.all(tasks.map((task) => task.then(report)));
}

// 1. Build. The CLI tests compile against packages/*/dist, so a stale build
//    fails (or passes) for reasons that have nothing to do with the change.
//    scripts/build.mjs rebuilds only the packages whose inputs changed, so this
//    is close to free on the common "edited one package" run.
if (!skipBuild) {
  report(await run("build", "node", ["./scripts/build.mjs", ...(forceBuild ? ["--force"] : [])]));
}

// 2. Formatters, which mutate the tree — unless `--check` asked for the
//    read-only equivalents.
if (ok()) {
  report(
    checkOnly
      ? await run("format:check", "pnpm", ["run", "format:check"])
      : await run("format", "pnpm", ["run", "format"]),
  );
}
if (ok()) {
  report(
    checkOnly
      ? await run("lint:check", "pnpm", ["exec", "oxlint", "."])
      : await run("lint", "pnpm", ["run", "lint"]),
  );
}

// 3. Every check that only reads the tree, together. Type generation reads the
//    app graph through Vite; in `--check` mode it writes nothing, so it does
//    not race the TypeScript program that consumes its committed output.
if (ok()) {
  const parallelism = availableParallelism();
  const oneMinuteLoad = loadavg()[0];
  const saturated = oneMinuteLoad >= parallelism * 2;
  const unitWorkers = Math.max(1, Math.floor(parallelism / 2));
  const testEnv = saturated
    ? {
        ...process.env,
        VITEST_MAX_THREADS: process.env.VITEST_MAX_THREADS ?? String(unitWorkers),
        VITEST_MIN_THREADS: process.env.VITEST_MIN_THREADS ?? "1",
      }
    : process.env;
  const checks = [
    () => run("typecheck", "node", ["./scripts/typecheck.mjs"]),
    () => run("basic generated types", "pnpm", ["--dir", "examples/basic", "run", "typegen:check"]),
    () => run("test", "pnpm", ["run", "test"], testEnv),
    // Client bytes are a CI gate (.github/workflows/ci.yml) and drift silently
    // otherwise. Four fixture builds, ~5s of work, and it reads the same
    // packages/*/dist the build above just produced.
    () => run("bench:check", "pnpm", ["run", "bench:check"]),
  ];

  if (saturated) {
    console.log(
      `verify: load ${oneMinuteLoad.toFixed(1)} across ${parallelism} cores; ` +
        `serializing checks and limiting Vitest to ${testEnv.VITEST_MAX_THREADS} workers`,
    );
    for (const check of checks) {
      report(await check());
      if (!ok()) break;
    }
  } else {
    await reportAsSettled(checks.map((check) => check()));
  }
}

// 4. E2E last and alone: it needs the whole machine to stay off the timing
//    assertions described above.
if (ok() && !skipE2e) {
  report(await run("e2e", "pnpm", ["run", "e2e"]));
}

const failed = results.filter((result) => !result.ok);
const work = results.reduce((sum, result) => sum + result.seconds, 0);
const wall = (Date.now() - startedAt) / 1000;
console.log(
  `\n${"=".repeat(60)}\n${
    failed.length === 0 ? "verify passed" : `verify failed: ${failed.map((r) => r.name).join(", ")}`
  } (${wall.toFixed(1)}s wall, ${work.toFixed(1)}s of work)`,
);
process.exit(failed.length === 0 ? 0 : 1);
