import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defineApp, group, matchAppRoute, resolveApp, route } from "../src/index.ts";

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

/** Warnings resolveApp printed, without the `[pracht] ` prefix. */
function warnings(): string[] {
  return warn.mock.calls.map((call) => String(call[0]).replace(/^\[pracht\] /, ""));
}

describe("route declaration-order diagnostics", () => {
  it("warns when an earlier dynamic route shadows a static one", () => {
    const app = defineApp({
      routes: [
        route("/blog/:slug", "./routes/post.tsx", { id: "post" }),
        route("/blog/new", "./routes/new-post.tsx", { id: "new-post" }),
      ],
    });

    resolveApp(app);

    expect(warnings()).toEqual([
      'Route "/blog/new" (./routes/new-post.tsx) can never match: the earlier route "/blog/:slug" ' +
        "(./routes/post.tsx) matches every URL it does. Routes match in declaration order, so " +
        'declare "/blog/new" before "/blog/:slug".',
    ]);
    // Matching itself is unchanged: the first declared route still wins.
    expect(matchAppRoute(app, "/blog/new")?.route.id).toBe("post");
  });

  it("warns about duplicate paths and duplicate ids", () => {
    resolveApp(
      defineApp({
        routes: [
          route("/about", "./routes/about.tsx"),
          route("/about", "./routes/about-v2.tsx"),
          route("/team", "./routes/team.tsx", { id: "people" }),
          route("/staff", "./routes/staff.tsx", { id: "people" }),
        ],
      }),
    );

    expect(warnings()).toEqual([
      'Routes "/about" (./routes/about.tsx) and "/about" (./routes/about-v2.tsx) share the id "about". ' +
        "href() and <Link route> resolve the first one; give the other a unique `id`.",
      'Route "/about" (./routes/about-v2.tsx) can never match: the earlier route "/about" ' +
        "(./routes/about.tsx) matches every URL it does. Routes match in declaration order, so " +
        'declare "/about" before "/about".',
      'Routes "/team" (./routes/team.tsx) and "/staff" (./routes/staff.tsx) share the id "people". ' +
        "href() and <Link route> resolve the first one; give the other a unique `id`.",
    ]);
  });

  it("sees through group prefixes and catch-alls", () => {
    resolveApp(
      defineApp({
        routes: [
          group({ pathPrefix: "/:locale" }, [route("/", "./routes/home.tsx", { id: "home" })]),
          route("/docs/*", "./routes/docs.tsx", { id: "docs" }),
          route("/en", "./routes/english.tsx", { id: "english" }),
          route("/docs/intro/:part", "./routes/intro.tsx", { id: "intro" }),
        ],
      }),
    );

    expect(warnings()).toHaveLength(2);
    expect(warnings()[0]).toContain('Route "/en" (./routes/english.tsx) can never match');
    expect(warnings()[0]).toContain('"/:locale"');
    expect(warnings()[1]).toContain(
      'Route "/docs/intro/:part" (./routes/intro.tsx) can never match',
    );
  });

  it("stays quiet for routes that are only partly overlapped or declared first", () => {
    resolveApp(
      defineApp({
        routes: [
          route("/blog/new", "./routes/new-post.tsx", { id: "new-post" }),
          route("/blog/:slug", "./routes/post.tsx", { id: "post" }),
          route("/users/:id", "./routes/user.tsx", { id: "user" }),
          route("/:section/edit", "./routes/edit.tsx", { id: "edit" }),
          route("/files/:path*", "./routes/files.tsx", { id: "files" }),
          route("/files", "./routes/files-index.tsx", { id: "files-index" }),
          route("/", "./routes/home.tsx", { id: "home" }),
        ],
      }),
    );

    // `/files/:path*` matches `/files` too, so that one is reported; nothing else.
    expect(warnings()).toEqual([
      'Route "/files" (./routes/files-index.tsx) can never match: the earlier route "/files/:path*" ' +
        "(./routes/files.tsx) matches every URL it does. Routes match in declaration order, so " +
        'declare "/files" before "/files/:path*".',
    ]);
    expect(matchAppRoute(resolveApp(defineApp({ routes: [] })), "/")).toBeUndefined();
  });

  it("says each thing once however often the app is resolved", () => {
    const app = defineApp({
      routes: [route("/x/:id", "./routes/x.tsx"), route("/x/new", "./routes/x-new.tsx")],
    });

    resolveApp(app);
    resolveApp(app);
    resolveApp(resolveApp(app) as never);

    expect(warnings()).toHaveLength(1);
  });
});
