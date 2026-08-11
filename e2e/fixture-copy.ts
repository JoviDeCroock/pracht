import { relative } from "node:path";

const excludedFixtureEntries = new Set([
  ".netlify",
  ".vercel",
  ".wrangler",
  "dist",
  "netlify",
  "test-results",
]);

/** Keep generated output and local runtime state out of disposable fixture copies. */
export function shouldCopyFixtureRelativePath(path: string): boolean {
  const [topLevelEntry] = path.split(/[\\/]/);
  return !excludedFixtureEntries.has(topLevelEntry);
}

export function fixtureCopyFilter(fixtureRoot: string): (source: string) => boolean {
  return (source) => shouldCopyFixtureRelativePath(relative(fixtureRoot, source));
}
