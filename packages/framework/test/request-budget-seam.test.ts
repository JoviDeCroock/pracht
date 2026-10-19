import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// One request has one budget: `createRequestBudget` in
// `@pracht/capabilities/server/internal`. A second signal per request runs a
// second, independent budget, and the static `AbortSignal` helpers bring back
// the retention it exists to avoid: a timeout signal cannot be cancelled, and
// a composite signal with a listener lives until one of its sources aborts.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const REQUEST_PATHS = ["packages/framework/src", "packages/capabilities/src/server"];
const BUDGET_HOME = "packages/capabilities/src/server/request-budget.ts";

function sources(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

function offenders(pattern: RegExp, skip?: string): string[] {
  const found: string[] = [];
  for (const dir of REQUEST_PATHS) {
    for (const file of sources(dir)) {
      if (file === skip) continue;
      readFileSync(join(repoRoot, file), "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (pattern.test(line)) found.push(`${file}:${index + 1}`);
        });
    }
  }
  return found;
}

describe("the request budget seam", () => {
  it("scans the request paths it guards", () => {
    expect(sources(REQUEST_PATHS[1]!)).toContain(BUDGET_HOME);
    expect(sources(REQUEST_PATHS[0]!).length).toBeGreaterThan(50);
  });

  it("uses no static AbortSignal timeout or composition on a request path", () => {
    expect(offenders(/AbortSignal\s*\.\s*(?:any|timeout)\s*\(/)).toEqual([]);
  });

  it("has one budget implementation", () => {
    expect(offenders(/function\s+create\w*Budget\b/, BUDGET_HOME)).toEqual([]);
  });
});
