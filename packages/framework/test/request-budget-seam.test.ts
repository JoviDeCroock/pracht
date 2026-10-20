import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// One request has one budget: `createRequestBudget` in
// `@pracht/capabilities/server/internal`. A second signal per request runs a
// second, independent budget, and the static `AbortSignal` helpers bring back
// the retention it exists to avoid: a timeout signal cannot be cancelled, and
// a composite signal with a listener lives until one of its sources aborts.

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const REQUEST_PATHS = [
  "packages/framework/src",
  "packages/capabilities/src/server",
  ...readdirSync(join(repoRoot, "packages"))
    .filter(
      (name) => name.startsWith("adapter-") && existsSync(join(repoRoot, "packages", name, "src")),
    )
    .map((name) => `packages/${name}/src`),
];
const BUDGET_HOME = "packages/capabilities/src/server/request-budget.ts";

function sources(dir: string): string[] {
  return readdirSync(join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(dir, file));
}

/**
 * Files allowed a timer that aborts a controller, and why. Each must still
 * hold one, so an entry cannot outlive the code it excuses.
 */
const TIMED_ABORT_EXCEPTIONS: Record<string, string> = {
  // An outbound fetch whose result is cached per origin and shared by later
  // requests, so it must not stop when the request that started it does.
  "packages/capabilities/src/server/agent-auth.ts": "signature-agent directory fetch",
};

// A timer whose callback aborts something: `setTimeout(() => c.abort(...))`
// or a named callback a few lines long. This is a hand-rolled budget.
const TIMED_ABORT_RE = /setTimeout\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\{?[^;]{0,160}?\.abort\(/g;

function timedAborts(): string[] {
  const found: string[] = [];
  for (const dir of REQUEST_PATHS) {
    for (const file of sources(dir)) {
      if (file === BUDGET_HOME) continue;
      const text = readFileSync(join(repoRoot, file), "utf8");
      if (!/new\s+AbortController\s*\(/.test(text)) continue;
      if (text.match(TIMED_ABORT_RE)) found.push(file);
    }
  }
  return found;
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

  it("recognizes a hand-rolled AbortController timeout", () => {
    const source = `const c = new AbortController();
      const t = setTimeout(
        () => c.abort(new DOMException("timed out", "TimeoutError")),
        5000,
      );`;
    expect(source.match(TIMED_ABORT_RE)).toHaveLength(1);
    expect("setTimeout(() => { controller.abort(); }, 10)".match(TIMED_ABORT_RE)).toHaveLength(1);
    expect("setTimeout(resolve, 10)".match(TIMED_ABORT_RE)).toBeNull();
  });

  it("aborts no AbortController from a timer outside the budget", () => {
    const found = timedAborts();
    expect(found.filter((file) => !(file in TIMED_ABORT_EXCEPTIONS))).toEqual([]);
    // An exception that no longer holds a timed abort is stale.
    expect(Object.keys(TIMED_ABORT_EXCEPTIONS).filter((file) => !found.includes(file))).toEqual([]);
  });

  it("has one budget implementation", () => {
    expect(offenders(/function\s+create\w*Budget\b/, BUDGET_HOME)).toEqual([]);
  });
});
