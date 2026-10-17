import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, matchAppRoute, resolveApp, route } from "../src/index.ts";
import { matchRouteSegments, splitPathSegments } from "../src/route-matching.ts";
import type { ResolvedPrachtApp } from "../src/types.ts";

beforeEach(() => {
  // Shadowed routes are the point of several tables here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The declaration-order scan the index has to agree with. */
function scan(app: ResolvedPrachtApp, pathname: string): string | undefined {
  const target = splitPathSegments(pathname);
  for (const candidate of app.routes) {
    if (matchRouteSegments(candidate.segments, target)) return candidate.id;
  }
  return undefined;
}

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

    expect(matchAppRoute(app, "/blog/new")?.route.id).toBe("r0");
    expect(matchAppRoute(app, "/blog/new")?.params).toEqual({ slug: "new" });
    expect(matchAppRoute(app, "/")?.route.id).toBe("r2");
    expect(matchAppRoute(app, "/about")?.route.id).toBe("r3");
    expect(matchAppRoute(app, "/docs/a/b")?.route.id).toBe("r3");
    expect(matchAppRoute(appOf(["/about", "/:slug"]), "/about")?.route.id).toBe("r0");
    expect(matchAppRoute(appOf(["/a/:id", "/a/b"]), "/a/b/c")).toBeUndefined();
  });

  it("agrees with a declaration-order scan on generated tables", () => {
    const pool = ["a", "b", "c", ":x", ":y", "*", ":rest*", "a%20b"];
    const targets = ["a", "b", "c", "d", "a%20b", "%E0%A4%A"];
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let table = 0; table < 400; table += 1) {
      const paths: string[] = [];
      for (let index = 0, count = 1 + random(10); index < count; index += 1) {
        const segments: string[] = [];
        for (let depth = 0, length = random(4); depth < length; depth += 1) {
          segments.push(pool[random(pool.length)]!);
        }
        paths.push(`/${segments.join("/")}`);
      }
      const app = appOf(paths);
      for (let probe = 0; probe < 20; probe += 1) {
        const segments: string[] = [];
        for (let depth = 0, length = random(5); depth < length; depth += 1) {
          segments.push(targets[random(targets.length)]!);
        }
        const pathname = `/${segments.join("/")}`;
        expect(matchAppRoute(app, pathname)?.route.id, `${pathname} in ${paths.join(" ")}`).toBe(
          scan(app, pathname),
        );
      }
    }
  });
});
