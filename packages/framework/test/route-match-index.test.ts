import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  matchApiRoute,
  matchAppRoute,
  resolveApiRoutes,
  resolveApp,
  route,
} from "../src/index.ts";
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

describe("percent-escape case on the server", () => {
  it("matches a static segment written with lower-case escapes in either case", () => {
    const app = appOf(["/caf%c3%a9", "/posts/:slug"]);
    for (const pathname of ["/caf%c3%a9", "/caf%C3%A9", "/caf%C3%a9"]) {
      expect(matchIndexedResolvedRoute(app, pathname)?.route.id).toBe("r0");
    }
    expect(matchIndexedResolvedRoute(app, "/cafe")).toBeUndefined();
    expect(matchIndexedResolvedRoute(appOf(["/caf%C3%A9"]), "/caf%c3%a9")?.route.id).toBe("r0");
  });

  it("matches either case in the linear page and API scans too", () => {
    const app = appOf(["/about", "/caf%c3%a9", "/posts/:slug"]);
    for (const pathname of ["/caf%c3%a9", "/caf%C3%A9"]) {
      expect(matchAppRoute(app, pathname)?.route.id).toBe("r1");
    }
    expect(matchAppRoute(app, "/cafe")).toBeUndefined();
    const api = resolveApiRoutes(["/src/api/caf%C3%A9.ts", "/src/api/plain.ts"]);
    expect(matchApiRoute(api, "/api/caf%c3%a9")?.route.file).toBe("/src/api/caf%C3%A9.ts");
    expect(matchApiRoute(api, "/api/plain")?.route.file).toBe("/src/api/plain.ts");
  });
});
