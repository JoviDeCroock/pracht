import { describe, expect, it } from "vitest";

import { isModuleSource, isPageSource, isRouteSource } from "../src/verification-helpers.ts";

describe("route source detection", () => {
  it("excludes declaration files from built-in and configured route extensions", () => {
    expect(isRouteSource("src/routes/route.d.ts")).toBe(false);
    expect(isRouteSource("src/routes/route.d.ts", [".ts"])).toBe(false);
    expect(isPageSource("src/pages/route.d.ts", [".ts"])).toBe(false);
  });

  it("excludes colocated tests and mocks", () => {
    expect(isRouteSource("src/routes/home.test.tsx")).toBe(false);
    expect(isPageSource("src/pages/blog/post.spec.ts")).toBe(false);
    expect(isModuleSource("src/api/health.test.ts")).toBe(false);
    expect(isModuleSource("src/api/__tests__/helpers.ts")).toBe(false);
    expect(isModuleSource("src/server/__mocks__/db.ts")).toBe(false);
    expect(isModuleSource("src/api/health.ts")).toBe(true);
    expect(isModuleSource("src/api/contest.ts")).toBe(true);
  });

  it("includes built-in and configured route extensions", () => {
    expect(isRouteSource("src/routes/route.tsx")).toBe(true);
    expect(isRouteSource("src/routes/route.tsrx")).toBe(true);
    expect(isRouteSource("src/routes/route.md")).toBe(true);
    expect(isRouteSource("src/routes/route.custom", [".custom"])).toBe(true);
  });
});
