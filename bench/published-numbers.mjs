#!/usr/bin/env node
/**
 * Keeps the bundle sizes quoted in the docs, the site and the README in step
 * with `bench/baseline.json`, the one place they are recorded.
 *
 *   node bench/published-numbers.mjs           fail if any published number is stale
 *   node bench/published-numbers.mjs --write   rewrite them from baseline.json
 *
 * `node bench/run.mjs --update` calls the writer, so re-recording the baseline
 * also updates every page that quotes it, and two PRs that both move bytes
 * conflict in `baseline.json` alone. Each entry below names a file, a pattern
 * whose capture groups are the quoted numbers, and the baseline values they
 * must equal. A pattern that stops matching — a reworded sentence, a renamed
 * row — is reported rather than skipped.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(benchDir, "..");

/** `8245` → `"8.1"`: KiB with one decimal, the unit every page quotes. */
export function kb(bytes) {
  return bytes === 0 ? "0" : (bytes / 1024).toFixed(1);
}

function rung(baseline, name) {
  const row = baseline.rungs.find((candidate) => candidate.rung === name);
  if (!row) throw new Error(`bench/baseline.json has no rung "${name}"`);
  return row;
}

const cold = (name) => (baseline) => kb(rung(baseline, name).coldGzipBytes);
const raw = (name) => (baseline) => kb(rung(baseline, name).bytes);
const coldBytes = (name) => (baseline) => String(rung(baseline, name).coldGzipBytes);
const preactPin = (_baseline, rootPackage) => rootPackage.devDependencies.preact;

/** Escapes a literal for use inside a pattern. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `| <label> | **<gzip> KB** | <raw> KB |` in the performance page's table. */
function performanceRow(label, name) {
  return {
    file: "examples/docs/src/routes/docs/performance.md",
    pattern: new RegExp(
      `^\\| ${literal(label)} \\| \\*\\*([\\d.]+) KB\\*\\* \\| ([\\d.]+) KB \\|`,
      "m",
    ),
    values: [cold(name), raw(name)],
  };
}

/** `| <label> | <gzip> KB |` in the why-pracht page's table. */
function whyRow(label, name) {
  return {
    file: "examples/docs/src/routes/docs/why-pracht.md",
    pattern: new RegExp(`^\\| ${literal(label)} \\| ([\\d.]+) KB \\|$`, "m"),
    values: [cold(name)],
  };
}

/** One rung of the home page's `LADDER` array: its label and its bar width. */
function homeLadder(mode, name) {
  return {
    file: "examples/docs/src/routes/home.tsx",
    pattern: new RegExp(`mode: ${literal(mode)},\\s+kb: "([\\d.]+) KB",\\s+bytes: (\\d+),`),
    values: [cold(name), coldBytes(name)],
  };
}

export const PUBLISHED = [
  performanceRow('`hydration: "none"`', "hydration: none"),
  performanceRow('`hydration: "islands"`', "hydration: islands"),
  performanceRow(
    '`hydration: "islands"`, islands navigation on',
    "hydration: islands, islands navigation on",
  ),
  performanceRow('`hydration: "full"`', "hydration: full"),
  performanceRow('`hydration: "full"`, prefetching off', "hydration: full, prefetch off"),
  performanceRow(
    '`hydration: "full"`, navigation guards off',
    "hydration: full, navigation guards off",
  ),
  performanceRow('`hydration: "full"`, rich data on', "hydration: full, rich data on"),
  performanceRow('`hydration: "full"` + `preact/compat`', "hydration: full + preact/compat"),
  {
    file: "examples/docs/src/routes/docs/performance.md",
    pattern: /`bench\/baseline\.json`, measured with Preact `([^`]+)`/,
    values: [preactPin],
  },
  whyRow('`hydration: "none"`', "hydration: none"),
  whyRow('`hydration: "islands"`', "hydration: islands"),
  whyRow('`hydration: "full"`', "hydration: full"),
  whyRow('`hydration: "full"` + `preact/compat`', "hydration: full + preact/compat"),
  {
    file: "README.md",
    pattern: /([\d.]+) KB gzip with islands, ([\d.]+) KB fully hydrated with the router/,
    values: [cold("hydration: islands"), cold("hydration: full")],
  },
  {
    file: "examples/docs/src/routes/home.tsx",
    pattern: /0 KB on a static route, ([\d.]+) KB gzip fully hydrated/,
    values: [cold("hydration: full")],
  },
  homeLadder(`'hydration: "none"'`, "hydration: none"),
  homeLadder(`'hydration: "islands"'`, "hydration: islands"),
  homeLadder(`'hydration: "full"'`, "hydration: full"),
  homeLadder('"full + preact/compat"', "hydration: full + preact/compat"),
];

/**
 * Compares (or, with `write`, rewrites) every published number. Returns one
 * message per stale number or unmatched pattern; empty means in step.
 */
export function syncPublishedNumbers({ write = false, root = rootDir } = {}) {
  const baseline = JSON.parse(readFileSync(join(root, "bench/baseline.json"), "utf8"));
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const sources = new Map();
  const problems = [];

  for (const entry of PUBLISHED) {
    if (!sources.has(entry.file)) {
      sources.set(entry.file, readFileSync(join(root, entry.file), "utf8"));
    }
    const source = sources.get(entry.file);
    // `d` records where each capture sits, so a rewrite touches only those.
    const match = new RegExp(entry.pattern.source, `${entry.pattern.flags}d`).exec(source);
    if (!match) {
      problems.push(`${entry.file}: nothing matches ${entry.pattern}`);
      continue;
    }

    const expected = entry.values.map((value) => value(baseline, rootPackage));
    const quoted = match.slice(1);
    if (quoted.every((value, index) => value === expected[index])) continue;

    if (!write) {
      problems.push(
        `${entry.file}: "${match[0].trim()}" quotes ${quoted.join(", ")}; baseline says ${expected.join(", ")}`,
      );
      continue;
    }

    let rewritten = "";
    let cursor = 0;
    for (let index = 1; index < match.indices.length; index += 1) {
      const [start, end] = match.indices[index];
      rewritten += source.slice(cursor, start) + expected[index - 1];
      cursor = end;
    }
    sources.set(entry.file, rewritten + source.slice(cursor));
  }

  if (write) {
    for (const [file, source] of sources) {
      if (source !== readFileSync(join(root, file), "utf8")) {
        writeFileSync(join(root, file), source);
      }
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes("--write");
  const problems = syncPublishedNumbers({ write });
  if (problems.length > 0) {
    console.error("Published bundle sizes disagree with bench/baseline.json:\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      write
        ? "\nThese patterns no longer match; update PUBLISHED in bench/published-numbers.mjs."
        : "\nRun `node bench/published-numbers.mjs --write` to rewrite them from the baseline.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      write
        ? "Published bundle sizes rewritten from bench/baseline.json."
        : "Published bundle sizes match bench/baseline.json.",
    );
  }
}
