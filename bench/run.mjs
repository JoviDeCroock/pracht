#!/usr/bin/env node
/**
 * The pracht benchmark harness.
 *
 * Two kinds of number come out of here and they are treated differently:
 *
 * - **Bytes** are deterministic. The same commit on the same package versions
 *   emits byte-identical chunks, so they are recorded in `baseline.json` and
 *   `--check` fails when they drift. This is the part CI gates on.
 * - **Timings** are not. They move with machine load, and this repo is
 *   routinely built on a laptop running several workspaces at once. They are
 *   measured, reported with their spread, and never gated.
 *
 * Usage:
 *   node bench/run.mjs                 measure everything, print a table
 *   node bench/run.mjs --bytes-only    skip timings (deterministic, fast)
 *   node bench/run.mjs --check         fail when bytes drift from baseline.json
 *   node bench/run.mjs --update        rewrite baseline.json from this run
 *   node bench/run.mjs --json          emit the raw results
 *   node bench/run.mjs --iterations=5  timing samples per metric (default 3)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(benchDir, "..");
const cliBin = join(rootDir, "packages/cli/bin/pracht.js");
const baselinePath = join(benchDir, "baseline.json");

/**
 * One build per row. `env` is the only thing that varies between two builds of
 * the same fixture, which is what makes a rung-to-rung delta attributable.
 */
const BUILDS = [
  { id: "ladder", fixture: "ladder", env: {} },
  { id: "ladder-no-prefetch", fixture: "ladder", env: { PRACHT_BENCH_PREFETCH: "off" } },
  { id: "ladder-no-guards", fixture: "ladder", env: { PRACHT_BENCH_GUARDS: "off" } },
  { id: "compat", fixture: "compat", env: {} },
];

/** Rows of the published ladder, in the order a reader climbs them. */
const LADDER = [
  { rung: "hydration: none", build: "ladder", route: "/none" },
  { rung: "hydration: islands", build: "ladder", route: "/islands" },
  { rung: "hydration: full", build: "ladder", route: "/full" },
  { rung: "hydration: full, prefetch off", build: "ladder-no-prefetch", route: "/full" },
  { rung: "hydration: full, navigation guards off", build: "ladder-no-guards", route: "/full" },
  { rung: "hydration: full + preact/compat", build: "compat", route: "/full" },
];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const bytesOnly = flag("bytes-only");
const iterations = Number.parseInt(option("iterations", "3"), 10);

function fixtureDir(fixture) {
  return join(benchDir, "fixtures", fixture);
}

function runCli(fixture, cliArgs, env = {}) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [cliBin, ...cliArgs], {
      cwd: fixtureDir(fixture),
      env: { ...process.env, ...env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) {
        fail(new Error(`pracht ${cliArgs.join(" ")} in ${fixture} exited ${code}\n${stderr}`));
        return;
      }
      settle(stdout);
    });
  });
}

/** `--json` prints the report after the build log, so find where the JSON starts. */
function parseReport(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("no JSON report in build output");
  return JSON.parse(stdout.slice(start));
}

/**
 * Chunks the build emitted that the route report attributes to nothing.
 *
 * `pracht build --analyze` reports the chunks a route loads to hydrate. The
 * router additionally `import()`s some of its own runtime after hydration —
 * today that is the prefetch runtime — so those bytes reach the browser on a
 * hydrating route without appearing in any route total. Measuring them keeps
 * the published ladder from quietly understating a cold load.
 */
function collectUnattributed(fixture, report) {
  const attributed = new Set(report.shared.chunks.map((chunk) => chunk.url));
  for (const route of report.routes) {
    for (const chunk of route.chunks) attributed.add(chunk.url);
  }

  const assetsDir = join(fixtureDir(fixture), "dist/client/assets");
  const chunks = [];
  for (const name of readdirSync(assetsDir).sort()) {
    if (!name.endsWith(".js")) continue;
    if (attributed.has(`/assets/${name}`)) continue;
    const source = readFileSync(join(assetsDir, name));
    chunks.push({
      // Content hashes change with every source edit; the stem is the stable
      // identity a baseline can be compared against.
      name: name.replace(/-[A-Za-z0-9_-]{8}\.js$/, ".js"),
      bytes: source.byteLength,
      // Same defaults as the CLI's own report, so the two are comparable.
      gzipBytes: gzipSync(source).byteLength,
    });
  }
  return chunks;
}

async function freePort() {
  return await new Promise((settle, fail) => {
    const server = createServer();
    server.on("error", fail);
    // No host: the probe has to reserve the port on every family, because the
    // dev server binds localhost, which resolves to ::1 on macOS.
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => settle(port));
    });
  });
}

/**
 * Time from spawning `pracht dev` to the first fully-read HTML response.
 *
 * Cold: a fresh Vite cache directory per sample, so the number includes
 * dependency optimization and first-request compilation rather than measuring
 * a warm cache left behind by the previous sample.
 */
async function measureDevFirstRender(fixture, route) {
  const port = await freePort();
  const cacheDir = mkdtempSync(join(tmpdir(), "pracht-bench-"));
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [cliBin, "dev", "--port", String(port), "--cache-dir", cacheDir],
    {
      cwd: fixtureDir(fixture),
      env: {
        ...process.env,
        NO_COLOR: "1",
        PORT: String(port),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-strip-types"]
          .filter(Boolean)
          .join(" "),
      },
      stdio: "ignore",
    },
  );

  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`dev server for ${fixture} never answered`);
      try {
        const response = await fetch(`http://localhost:${port}${route}`);
        if (response.ok) {
          await response.text();
          return performance.now() - started;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((settle) => setTimeout(settle, 25));
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((settle) => child.on("close", settle));
    rmSync(cacheDir, { force: true, recursive: true });
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Discards the first sample. The first build of a fixture populates Vite's
 * dependency cache and the OS page cache; including it would measure the
 * machine's cold state rather than the framework.
 */
async function sample(label, iterationCount, measure) {
  const samples = [];
  for (let index = 0; index <= iterationCount; index += 1) {
    const value = await measure();
    if (index > 0) samples.push(value);
    process.stderr.write(`  ${label} ${index}/${iterationCount}\r`);
  }
  process.stderr.write(`${" ".repeat(40)}\r`);
  return {
    medianMs: Math.round(median(samples)),
    minMs: Math.round(Math.min(...samples)),
    maxMs: Math.round(Math.max(...samples)),
    samples: samples.map((value) => Math.round(value)),
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

async function main() {
  const reports = {};
  const unattributed = {};

  for (const build of BUILDS) {
    process.stderr.write(`building ${build.id}…\n`);
    const stdout = await runCli(build.fixture, ["build", "--json"], build.env);
    reports[build.id] = parseReport(stdout);
    unattributed[build.id] = collectUnattributed(build.fixture, reports[build.id]);
  }

  const rungs = LADDER.map((entry) => {
    const report = reports[entry.build];
    const route = report.routes.find((candidate) => candidate.path === entry.route);
    if (!route) throw new Error(`${entry.build} has no route ${entry.route}`);
    // The lazily-imported runtime hangs off the client router, and only a
    // full-hydration route loads that. `hydration: "none"` ships nothing, and
    // the islands bootstrap deliberately imports neither the router nor the
    // prefetch runtime, so neither carries these bytes.
    const lazy = (route.hydration ?? "full") === "full" ? unattributed[entry.build] : [];
    const lazyGzipBytes = lazy.reduce((total, chunk) => total + chunk.gzipBytes, 0);
    return {
      rung: entry.rung,
      build: entry.build,
      route: entry.route,
      hydration: route.hydration ?? "full",
      bytes: route.totalBytes,
      gzipBytes: route.totalGzipBytes,
      lazyGzipBytes,
      lazyChunks: lazy.map((chunk) => chunk.name),
      coldGzipBytes: route.totalGzipBytes + lazyGzipBytes,
    };
  });

  const results = { rungs, timings: null };

  if (!bytesOnly) {
    process.stderr.write("timing production build…\n");
    const buildTime = await sample("build", iterations, async () => {
      const started = performance.now();
      await runCli("ladder", ["build"]);
      return performance.now() - started;
    });
    process.stderr.write("timing dev first render…\n");
    const devFirstRender = await sample("dev", iterations, () =>
      measureDevFirstRender("ladder", "/full"),
    );
    results.timings = { iterations, buildTime, devFirstRender };
  }

  if (flag("json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const width = Math.max(...rungs.map((rung) => rung.rung.length));
    console.log("");
    console.log(
      `${"Rung".padEnd(width)}  ${"Gzip".padStart(9)}  ${"Raw".padStart(9)}  ${"+ lazy".padStart(9)}`,
    );
    for (const rung of rungs) {
      console.log(
        `${rung.rung.padEnd(width)}  ${formatBytes(rung.gzipBytes).padStart(9)}  ${formatBytes(
          rung.bytes,
        ).padStart(9)}  ${formatBytes(rung.coldGzipBytes).padStart(9)}`,
      );
    }
    if (results.timings) {
      const { buildTime, devFirstRender } = results.timings;
      console.log("");
      console.log(`Timings (median of ${iterations}, first sample discarded)`);
      console.log(
        `  production build      ${buildTime.medianMs} ms  (${buildTime.minMs}–${buildTime.maxMs})`,
      );
      console.log(
        `  dev first render      ${devFirstRender.medianMs} ms  (${devFirstRender.minMs}–${devFirstRender.maxMs})`,
      );
      console.log("  Timings are machine-dependent and are never gated in CI.");
    }
    console.log("");
  }

  if (flag("update")) {
    const baseline = {
      note: "Byte sizes are deterministic for a given commit. Regenerate with `node bench/run.mjs --update`.",
      rungs: rungs.map(({ rung, hydration, bytes, gzipBytes, lazyGzipBytes, coldGzipBytes }) => ({
        rung,
        hydration,
        bytes,
        gzipBytes,
        lazyGzipBytes,
        coldGzipBytes,
      })),
    };
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote ${baselinePath}`);
  }

  if (flag("check")) {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    const drift = [];
    for (const rung of rungs) {
      const expected = baseline.rungs.find((candidate) => candidate.rung === rung.rung);
      if (!expected) {
        drift.push(`${rung.rung}: not in baseline`);
        continue;
      }
      for (const key of ["bytes", "gzipBytes", "lazyGzipBytes", "coldGzipBytes"]) {
        if (expected[key] !== rung[key]) {
          drift.push(
            `${rung.rung}: ${key} ${expected[key]} → ${rung[key]} (${
              rung[key] > expected[key] ? "+" : ""
            }${rung[key] - expected[key]})`,
          );
        }
      }
    }
    for (const expected of baseline.rungs) {
      if (!rungs.some((rung) => rung.rung === expected.rung)) {
        drift.push(`${expected.rung}: in baseline but not measured`);
      }
    }
    if (drift.length > 0) {
      console.error("\nClient bytes drifted from bench/baseline.json:\n");
      for (const line of drift) console.error(`  ${line}`);
      console.error(
        "\nIf the change is intended, run `node bench/run.mjs --bytes-only --update` and" +
          " include the new baseline in the commit — and update the published numbers in" +
          " examples/docs/src/routes/docs/performance.md.\n",
      );
      process.exitCode = 1;
      return;
    }
    console.log("Client bytes match bench/baseline.json.");
  }
}

await main();
