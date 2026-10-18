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
 *   node bench/run.mjs --requests=2000 requests per server probe (default 1000)
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { syncPublishedNumbers } from "./published-numbers.mjs";
import { writeScaleApp } from "./scale-app.mjs";

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
  { id: "ladder-rich-data", fixture: "ladder", env: { PRACHT_BENCH_RICH_DATA: "on" } },
  {
    id: "ladder-islands-navigation",
    fixture: "ladder",
    env: { PRACHT_BENCH_ISLANDS_NAVIGATION: "on" },
  },
  { id: "compat", fixture: "compat", env: {} },
];

/** Rows of the published ladder, in the order a reader climbs them. */
const LADDER = [
  { rung: "hydration: none", build: "ladder", route: "/none" },
  { rung: "hydration: islands", build: "ladder", route: "/islands" },
  {
    rung: "hydration: islands, islands navigation on",
    build: "ladder-islands-navigation",
    route: "/islands",
  },
  { rung: "hydration: full", build: "ladder", route: "/full" },
  { rung: "hydration: full, prefetch off", build: "ladder-no-prefetch", route: "/full" },
  { rung: "hydration: full, navigation guards off", build: "ladder-no-guards", route: "/full" },
  { rung: "hydration: full, rich data on", build: "ladder-rich-data", route: "/full" },
  { rung: "hydration: full + preact/compat", build: "compat", route: "/full" },
];

/**
 * Route counts for the route-scale fixture (`scale-app.mjs`). Each one is a
 * separate build of the same generated app; the measured row is the
 * full-hydration `/` route, so the difference between two rows is what the
 * extra routes add to every page.
 */
const ROUTE_SCALE = [50, 500];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const match = args.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};

const bytesOnly = flag("bytes-only");
const iterations = Number.parseInt(option("iterations", "3"), 10);
const probeRequests = Number.parseInt(option("requests", "1000"), 10);

function fixtureDir(fixture) {
  return join(benchDir, "fixtures", fixture);
}

function runCli(cwd, cliArgs, env = {}) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [cliBin, ...cliArgs], {
      cwd,
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
        fail(new Error(`pracht ${cliArgs.join(" ")} in ${cwd} exited ${code}\n${stderr}`));
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
function collectUnattributed(appDir, report) {
  const attributed = new Set(report.shared.chunks.map((chunk) => chunk.url));
  for (const route of report.routes) {
    for (const chunk of route.chunks) attributed.add(chunk.url);
  }

  const assetsDir = join(appDir, "dist/client/assets");
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

/** One measured row: a route's hydration chunks plus the router's lazy runtime. */
function measureRoute(report, routePath, unattributedChunks, label) {
  const route = report.routes.find((candidate) => candidate.path === routePath);
  if (!route) throw new Error(`${label} has no route ${routePath}`);
  // The lazily-imported runtime hangs off the client router, and only a
  // full-hydration route loads that. `hydration: "none"` ships nothing, and
  // the islands bootstrap deliberately imports neither the router nor the
  // prefetch runtime, so neither carries these bytes.
  const lazy = (route.hydration ?? "full") === "full" ? unattributedChunks : [];
  const lazyGzipBytes = lazy.reduce((total, chunk) => total + chunk.gzipBytes, 0);
  return {
    hydration: route.hydration ?? "full",
    bytes: route.totalBytes,
    gzipBytes: route.totalGzipBytes,
    lazyGzipBytes,
    lazyChunks: lazy.map((chunk) => chunk.name),
    coldGzipBytes: route.totalGzipBytes + lazyGzipBytes,
  };
}

const BYTE_KEYS = ["bytes", "gzipBytes", "lazyGzipBytes", "coldGzipBytes"];

/** Drift lines between measured rows and their baseline, matched by `rung`. */
function compareRows(measured, expected = []) {
  const drift = [];
  for (const row of measured) {
    const baseline = expected.find((candidate) => candidate.rung === row.rung);
    if (!baseline) {
      drift.push(`${row.rung}: not in baseline`);
      continue;
    }
    for (const key of BYTE_KEYS) {
      if (baseline[key] !== row[key]) {
        const delta = row[key] - baseline[key];
        drift.push(
          `${row.rung}: ${key} ${baseline[key]} → ${row[key]} (${delta > 0 ? "+" : ""}${delta})`,
        );
      }
    }
  }
  for (const baseline of expected) {
    if (!measured.some((row) => row.rung === baseline.rung)) {
      drift.push(`${baseline.rung}: in baseline but not measured`);
    }
  }
  return drift;
}

const baselineRow = ({ rung, hydration, bytes, gzipBytes, lazyGzipBytes, coldGzipBytes }) => ({
  rung,
  hydration,
  bytes,
  gzipBytes,
  lazyGzipBytes,
  coldGzipBytes,
});

/** Runs `ssr-probe.mjs` against one built app, in a process of its own. */
function probeServer(appDir) {
  return new Promise((settle, fail) => {
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        join(benchDir, "ssr-probe.mjs"),
        join(appDir, "dist/server/server.js"),
        String(probeRequests),
      ],
      {
        cwd: appDir,
        env: { ...process.env, NODE_ENV: "production" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code !== 0) {
        fail(new Error(`server probe in ${appDir} exited ${code}\n${stderr}`));
        return;
      }
      settle(JSON.parse(stdout.trim().split("\n").at(-1)));
    });
  });
}

function printRows(title, rows) {
  const width = Math.max(title.length, ...rows.map((row) => row.rung.length));
  console.log("");
  console.log(
    `${title.padEnd(width)}  ${"Gzip".padStart(9)}  ${"Raw".padStart(9)}  ${"+ lazy".padStart(9)}`,
  );
  for (const row of rows) {
    console.log(
      `${row.rung.padEnd(width)}  ${formatBytes(row.gzipBytes).padStart(9)}  ${formatBytes(
        row.bytes,
      ).padStart(9)}  ${formatBytes(row.coldGzipBytes).padStart(9)}`,
    );
  }
}

function printResults(results) {
  if (flag("json")) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  printRows("Rung", results.rungs);
  printRows("Route scale, `/`", results.routeScale);
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
  }
  if (results.server) {
    console.log("");
    console.log(`Server (${probeRequests} requests per row, 8 in flight, built Node handler)`);
    for (const probe of results.server) {
      for (const row of probe.results) {
        const label = `${probe.routes} routes, ${row.kind}`.padEnd(32);
        const failures = row.failures > 0 ? `  (${row.failures} failed)` : "";
        console.log(
          `  ${label} ${String(row.requestsPerSecond).padStart(6)} req/s  ` +
            `${String(row.retainedBytesPerRequest).padStart(6)} B retained per request${failures}`,
        );
      }
    }
  }
  if (results.timings) {
    console.log("  Timings and heap figures are machine-dependent and are never gated in CI.");
  }
  console.log("");
}

async function main() {
  const reports = {};
  const unattributed = {};

  for (const build of BUILDS) {
    process.stderr.write(`building ${build.id}…\n`);
    const appDir = fixtureDir(build.fixture);
    const stdout = await runCli(appDir, ["build", "--json"], build.env);
    reports[build.id] = parseReport(stdout);
    unattributed[build.id] = collectUnattributed(appDir, reports[build.id]);
  }

  const rungs = LADDER.map((entry) => ({
    rung: entry.rung,
    build: entry.build,
    route: entry.route,
    ...measureRoute(reports[entry.build], entry.route, unattributed[entry.build], entry.build),
  }));

  // The route-scale apps are generated in the gitignored `bench/.scale/` and
  // removed at the end; they borrow the ladder fixture's installed
  // dependencies. They must sit inside the checkout: the bundler orders
  // modules by absolute path, so an app outside it (a temp directory) sorts
  // differently against `packages/` depending on where the checkout lives,
  // and the gated gzip bytes move with it.
  const scaleRoot = join(benchDir, ".scale");
  rmSync(scaleRoot, { force: true, recursive: true });
  try {
    const routeScale = [];
    const scaleApps = [];
    for (const routeCount of ROUTE_SCALE) {
      process.stderr.write(`building ${routeCount}-route app…\n`);
      const appDir = join(scaleRoot, String(routeCount));
      writeScaleApp(appDir, routeCount, join(fixtureDir("ladder"), "node_modules"));
      const report = parseReport(await runCli(appDir, ["build", "--json"]));
      scaleApps.push({ routeCount, appDir });
      routeScale.push({
        rung: `hydration: full, ${routeCount} routes`,
        routes: routeCount,
        route: "/",
        ...measureRoute(
          report,
          "/",
          collectUnattributed(appDir, report),
          `${routeCount}-route app`,
        ),
      });
    }

    const results = { rungs, routeScale, timings: null, server: null };

    if (!bytesOnly) {
      process.stderr.write("timing production build…\n");
      const buildTime = await sample("build", iterations, async () => {
        const started = performance.now();
        await runCli(fixtureDir("ladder"), ["build"]);
        return performance.now() - started;
      });
      process.stderr.write("timing dev first render…\n");
      const devFirstRender = await sample("dev", iterations, () =>
        measureDevFirstRender("ladder", "/full"),
      );
      results.timings = { iterations, buildTime, devFirstRender };

      results.server = [];
      for (const { routeCount, appDir } of scaleApps) {
        process.stderr.write(`probing the ${routeCount}-route server…\n`);
        results.server.push(await probeServer(appDir));
      }
    }

    printResults(results);

    if (flag("update")) {
      const baseline = {
        note: "Byte sizes are deterministic for a given commit. Regenerate with `node bench/run.mjs --bytes-only --update`.",
        rungs: rungs.map(baselineRow),
        routeScale: routeScale.map((row) => ({ routes: row.routes, ...baselineRow(row) })),
      };
      writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`Wrote ${baselinePath}`);
      // The docs, site and README quote these numbers; rewrite them from the
      // baseline just written so they cannot be left behind.
      const unmatched = syncPublishedNumbers({ write: true });
      if (unmatched.length > 0) {
        console.error("\nSome published bundle sizes could not be located:\n");
        for (const line of unmatched) console.error(`  ${line}`);
        console.error("\nUpdate PUBLISHED in bench/published-numbers.mjs.\n");
        process.exitCode = 1;
      } else {
        console.log("Rewrote the published bundle sizes from it.");
      }
    }

    if (flag("check")) {
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      const drift = [
        ...compareRows(rungs, baseline.rungs),
        ...compareRows(routeScale, baseline.routeScale),
      ];
      if (drift.length > 0) {
        console.error("\nClient bytes drifted from bench/baseline.json:\n");
        for (const line of drift) console.error(`  ${line}`);
        console.error(
          "\nIf the change is intended, run `pnpm bench:update` and commit the result: it" +
            " rewrites bench/baseline.json and every published number that quotes it.\n",
        );
        process.exitCode = 1;
        return;
      }
      console.log("Client bytes match bench/baseline.json.");
    }
  } finally {
    rmSync(scaleRoot, { force: true, recursive: true });
  }
}

await main();
