import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, resolveApp, route } from "../src/index.ts";
import { matchIndexedResolvedRoute } from "../src/route-matching.ts";
import type { ResolvedPrachtApp } from "../src/types.ts";

beforeEach(() => {
  // Shadowed routes are the point of several tables here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function appOf(paths: string[]): ResolvedPrachtApp {
  return resolveApp(
    defineApp({
      routes: paths.map((path, index) =>
        route(path, `./routes/r${index}.tsx`, { id: `r${index}` }),
      ),
    }),
  );
}

describe("server route matching", () => {
  it("keeps declaration order between static and dynamic routes", () => {
    const app = appOf(["/blog/:slug", "/blog/new", "/", "/*", "/about", "/docs/:page*"]);

    expect(matchIndexedResolvedRoute(app, "/blog/new")?.route.id).toBe("r0");
    expect(matchIndexedResolvedRoute(app, "/blog/new")?.params).toEqual({ slug: "new" });
    expect(matchIndexedResolvedRoute(app, "/")?.route.id).toBe("r2");
    expect(matchIndexedResolvedRoute(app, "/about")?.route.id).toBe("r3");
    expect(matchIndexedResolvedRoute(app, "/docs/a/b")?.route.id).toBe("r3");
    expect(matchIndexedResolvedRoute(appOf(["/about", "/:slug"]), "/about")?.route.id).toBe("r0");
    expect(matchIndexedResolvedRoute(appOf(["/a/:id", "/a/b"]), "/a/b/c")).toBeUndefined();
  });
});
