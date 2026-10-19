import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Seam guard for ISG snapshots: what a regenerated page keeps, which headers
// are stripped, and how its cache key names the build live in core
// `revalidation.ts`. Each rule fails on the next per-adapter copy.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const ADAPTER_SOURCES = [
  "packages/adapter-node/src",
  "packages/adapter-cloudflare/src",
  "packages/adapter-netlify/src",
  "packages/adapter-vercel/src",
  "packages/adapter-static/src",
];

function offenders(pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        readFileSync(full, "utf-8")
          .split("\n")
          .forEach((line, index) => {
            if (pattern.test(line)) {
              hits.push(`${relative(repoRoot, full)}:${index + 1}: ${line.trim()}`);
            }
          });
      }
    }
  };
  for (const dir of ADAPTER_SOURCES) walk(resolve(repoRoot, dir));
  return hits;
}

describe("ISG snapshot seam", () => {
  it("adapters strip secret-shaped headers through stripISGSecretHeaders or captureISGSnapshot", () => {
    expect(offenders(/isDangerousPrerenderHeader/)).toEqual([]);
  });

  it("adapters keep no list of transfer headers of their own", () => {
    expect(offenders(/TRANSFER_HEADERS/)).toEqual([]);
  });

  it("no adapter writes private ISG bookkeeping headers into a stored page", () => {
    expect(
      offenders(
        /\.set\(\s*(ISG_DOCUMENT_CACHE_CONTROL_HEADER|"x-pracht-isg-(cache-control|generated-at)")/,
      ),
    ).toEqual([]);
  });

  it("ISG cache keys are built by isgCacheKeyPath", () => {
    expect(offenders(/__pracht\/isg-build/)).toEqual([]);
  });
});
