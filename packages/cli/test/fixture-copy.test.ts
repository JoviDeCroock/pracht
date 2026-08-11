import { describe, expect, it } from "vitest";

import { shouldCopyFixtureRelativePath } from "../../../e2e/fixture-copy.ts";

describe("isolated E2E fixture copies", () => {
  it.each(["dist", ".vercel", ".wrangler", "test-results"])(
    "excludes %s and its children with either path separator",
    (entry) => {
      expect(shouldCopyFixtureRelativePath(entry)).toBe(false);
      expect(shouldCopyFixtureRelativePath(`${entry}/nested/output.js`)).toBe(false);
      expect(shouldCopyFixtureRelativePath(`${entry}\\nested\\output.js`)).toBe(false);
    },
  );

  it("keeps source files whose later path segments resemble generated output", () => {
    expect(shouldCopyFixtureRelativePath("src/dist/fixture.ts")).toBe(true);
    expect(shouldCopyFixtureRelativePath("src\\dist\\fixture.ts")).toBe(true);
  });
});
