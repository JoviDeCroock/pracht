import { describe, expect, it } from "vitest";

import { dynamicParamNames, hasDynamicSegments } from "../src/commands/generate-paths.ts";
import { buildManifestRouteModuleSource } from "../src/commands/generate-source.ts";

describe("generate route-pattern helpers", () => {
  it("reads dynamic segments the way the route matcher does", () => {
    expect(hasDynamicSegments("/")).toBe(false);
    expect(hasDynamicSegments("/blog/archive")).toBe(false);
    expect(hasDynamicSegments("/blog/:slug")).toBe(true);
    expect(hasDynamicSegments("/docs/*")).toBe(true);
    expect(hasDynamicSegments("/docs/:path*")).toBe(true);
  });

  it("names a getStaticPaths param after each dynamic segment", () => {
    expect(dynamicParamNames("/blog/:year/:slug")).toEqual(["year", "slug"]);
    expect(dynamicParamNames("/docs/*")).toEqual(["slug"]);
    // A named catch-all is keyed by its name, not `path*`.
    expect(dynamicParamNames("/docs/:path*")).toEqual(["path"]);
  });

  it("generates a getStaticPaths stub a named catch-all can compile", () => {
    const source = buildManifestRouteModuleSource({
      includeErrorBoundary: false,
      includeLoader: false,
      includeStaticPaths: true,
      routePath: "/docs/:path*",
      title: "Docs",
    });
    expect(source).toContain('{ path: "example-path" }');
    expect(source).not.toContain("path*");
  });
});
