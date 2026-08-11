import { describe, expect, it } from "vitest";

import { isPageSource, isRouteSource } from "../src/verification-helpers.ts";

describe("route source detection", () => {
  it("excludes declaration files from built-in and configured route extensions", () => {
    expect(isRouteSource("src/routes/route.d.ts")).toBe(false);
    expect(isRouteSource("src/routes/route.d.ts", [".ts"])).toBe(false);
    expect(isPageSource("src/pages/route.d.ts", [".ts"])).toBe(false);
  });

  it("includes built-in and configured route extensions", () => {
    expect(isRouteSource("src/routes/route.tsx")).toBe(true);
    expect(isRouteSource("src/routes/route.md")).toBe(true);
    expect(isRouteSource("src/routes/route.custom", [".custom"])).toBe(true);
  });
});
