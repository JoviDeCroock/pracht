import { describe, expect, it } from "vitest";

import {
  buildHref,
  createHref,
  defineApp,
  group,
  matchApiRoute,
  matchAppRoute,
  matchRoutePath,
  resolveApiRoutes,
  resolveApp,
  route,
  routePathIsDynamic,
  timeRevalidate,
} from "../src/index.ts";

describe("resolveApp", () => {
  it("flattens groups and applies inherited metadata", () => {
    const app = defineApp({
      shells: {
        public: "./shells/public.tsx",
      },
      middleware: {
        auth: "./middleware/auth.ts",
      },
      routes: [
        group({ pathPrefix: "/app", shell: "public", middleware: ["auth"] }, [
          route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
        ]),
      ],
    });

    const resolved = resolveApp(app);

    expect(resolved.routes).toHaveLength(1);
    expect(resolved.routes[0]).toMatchObject({
      file: "./routes/dashboard.tsx",
      middleware: ["auth"],
      middlewareFiles: ["./middleware/auth.ts"],
      path: "/app/dashboard",
      render: "ssr",
      shell: "public",
      shellFile: "./shells/public.tsx",
    });
  });

  it("inherits loader cache durations and allows routes to opt out", () => {
    const app = defineApp({
      routes: [
        group({ loaderCache: 300 }, [
          route("/cached", "./routes/cached.tsx"),
          route("/fresh", "./routes/fresh.tsx", { loaderCache: false }),
        ]),
      ],
    });

    const resolved = resolveApp(app);

    expect(resolved.routes[0].loaderCache).toBe(300);
    expect(resolved.routes[1].loaderCache).toBe(false);
  });

  it("inherits and de-duplicates route-scoped capabilities", () => {
    const app = defineApp({
      capabilities: {
        "notes.search": "./capabilities/notes-search.ts",
        "notes.create": "./capabilities/notes-create.ts",
      },
      routes: [
        group({ capabilities: ["notes.search"] }, [
          route("/notes", "./routes/notes.tsx", {
            capabilities: ["notes.search", "notes.create"],
          }),
        ]),
      ],
    });

    expect(resolveApp(app).routes[0]?.capabilities).toEqual(["notes.search", "notes.create"]);
  });

  it("rejects unknown route-scoped capabilities with a suggestion", () => {
    const app = defineApp({
      capabilities: { "notes.search": "./capabilities/notes-search.ts" },
      routes: [route("/notes", "./routes/notes.tsx", { capabilities: ["notes.serach"] })],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown capability "notes.serach" for route "/notes". Did you mean "notes.search"?',
    );
  });

  it("rejects route-scoped capabilities on hydration none routes", () => {
    const app = defineApp({
      capabilities: { "notes.search": "./capabilities/notes-search.ts" },
      routes: [
        route("/notes", "./routes/notes.tsx", {
          capabilities: ["notes.search"],
          hydration: "none",
        }),
      ],
    });

    expect(() => resolveApp(app)).toThrow(/Page tools require browser JavaScript/);
  });

  it("rejects unknown route meta keys with a suggestion", () => {
    const app = defineApp({
      middleware: { auth: "./middleware/auth.ts" },
      // A typo here used to resolve to a route with no middleware at all,
      // while `pracht verify`, the graph snapshot, and `requireMiddleware()`
      // constraints all still reported the route as guarded.
      routes: [route("/dashboard", "./routes/dashboard.tsx", { middlware: ["auth"] } as never)],
    });

    expect(() => resolveApp(app)).toThrow(
      /Unknown option "middlware" for route "\/dashboard"\. Did you mean "middleware"\?/,
    );
  });

  it("rejects unknown group meta keys", () => {
    const app = defineApp({
      middleware: { auth: "./middleware/auth.ts" },
      routes: [
        group({ middlewares: ["auth"] } as never, [route("/dashboard", "./routes/dashboard.tsx")]),
      ],
    });

    expect(() => resolveApp(app)).toThrow(
      /Unknown option "middlewares" for group at "\/"\. Did you mean "middleware"\?/,
    );
  });

  it("rejects unknown notFound config keys", () => {
    expect(() =>
      defineApp({
        notFound: { component: "./routes/not-found.tsx", shel: "public" } as never,
        routes: [],
      }),
    ).toThrow(/Unknown option "shel" for the notFound page\./);
  });

  it("stays idempotent — re-resolving a resolved app does not reject derived fields", () => {
    const app = defineApp({
      shells: { public: "./shells/public.tsx" },
      routes: [group({ shell: "public" }, [route("/", "./routes/home.tsx", { render: "ssg" })])],
    });

    const once = resolveApp(app);
    const twice = resolveApp(once as never);

    expect(twice.routes).toEqual(once.routes);
  });

  it("rejects invalid loader cache durations", () => {
    const app = defineApp({
      routes: [route("/invalid", "./routes/invalid.tsx", { loaderCache: -1 })],
    });

    expect(() => resolveApp(app)).toThrow(
      'Invalid loaderCache for route "/invalid": expected false or a non-negative integer number of seconds.',
    );
  });
});

describe("resolveApp wiring errors", () => {
  it("throws with a did-you-mean hint for unknown shell names", () => {
    const app = defineApp({
      shells: {
        public: "./shells/public.tsx",
        app: "./shells/app.tsx",
      },
      routes: [group({ shell: "pubic" }, [route("/", "./routes/home.tsx")])],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.',
    );
  });

  it("throws without a suggestion when no shell name is close", () => {
    const app = defineApp({
      shells: { public: "./shells/public.tsx" },
      routes: [route("/", "./routes/home.tsx", { shell: "dashboard" })],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown shell "dashboard" for route "/". Registered shells: public.',
    );
  });

  it("reports when no shells are registered at all", () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx", { shell: "public" })],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown shell "public" for route "/". No shells are registered in defineApp().',
    );
  });

  it("throws with a did-you-mean hint for unknown middleware names", () => {
    const app = defineApp({
      middleware: {
        auth: "./middleware/auth.ts",
        logging: "./middleware/logging.ts",
      },
      routes: [route("/admin", "./routes/admin.tsx", { middleware: ["auht"] })],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown middleware "auht" for route "/admin". Did you mean "auth"? Registered middleware: auth, logging.',
    );
  });

  it("validates api middleware names", () => {
    const app = defineApp({
      middleware: { auth: "./middleware/auth.ts" },
      api: { middleware: ["athu"] },
      routes: [],
    });

    expect(() => resolveApp(app)).toThrow(
      'Unknown middleware "athu" for api routes. Did you mean "auth"? Registered middleware: auth.',
    );
  });
});

describe("route() with RouteConfig object", () => {
  it("accepts an object config with component and loader", () => {
    const app = defineApp({
      routes: [
        route("/dashboard", {
          component: "./routes/dashboard.tsx",
          loader: "./server/dashboard-loader.ts",
          markdown: true,
          render: "ssr",
        }),
      ],
    });

    const resolved = resolveApp(app);

    expect(resolved.routes).toHaveLength(1);
    expect(resolved.routes[0]).toMatchObject({
      file: "./routes/dashboard.tsx",
      loaderFile: "./server/dashboard-loader.ts",
      markdown: true,
      render: "ssr",
    });
  });

  it("works without loader", () => {
    const app = defineApp({
      routes: [
        route("/about", {
          component: "./routes/about.tsx",
          render: "ssg",
        }),
      ],
    });

    const resolved = resolveApp(app);

    expect(resolved.routes[0]).toMatchObject({
      file: "./routes/about.tsx",
      render: "ssg",
    });
    expect(resolved.routes[0].loaderFile).toBeUndefined();
  });
});

describe("typed route href helpers", () => {
  const app = resolveApp(
    defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home" }),
        route("/products/:id", "./routes/product.tsx", { id: "product" }),
        route("/docs/*", "./routes/docs.tsx", { id: "docs" }),
      ],
    }),
  );

  it("builds hrefs for static, dynamic, and catch-all routes", () => {
    expect(buildHref(app.routes, "home")).toBe("/");
    expect(buildHref(app.routes, "product", { params: { id: "hello world" } })).toBe(
      "/products/hello%20world",
    );
    expect(buildHref(app.routes, "docs", { params: { "*": "guides/intro" } })).toBe(
      "/docs/guides/intro",
    );
  });

  it("serializes search params and hash fragments", () => {
    expect(
      buildHref(app.routes, "product", {
        params: { id: 42 },
        search: { ref: "home", tag: ["new", "sale"], empty: null },
        hash: "details",
      }),
    ).toBe("/products/42?ref=home&tag=new&tag=sale#details");
  });

  it("throws for unknown, missing, and extra params", () => {
    expect(() => buildHref(app.routes, "missing")).toThrow(/Unknown pracht route id/);
    expect(() => buildHref(app.routes, "prduct")).toThrow(
      'Unknown pracht route id "prduct". Did you mean "product"? Registered route ids: home, product, docs.',
    );
    expect(() => buildHref(app.routes, "product")).toThrow(/Missing route param: id/);
    expect(() => buildHref(app.routes, "product", { params: { id: "1", extra: "x" } })).toThrow(
      /Unexpected route param: extra/,
    );
  });

  it("creates reusable href helpers", () => {
    const href = createHref(app.routes);
    expect(href("product", { params: { id: "1" }, search: "tab=details" })).toBe(
      "/products/1?tab=details",
    );
  });
});

describe("matchRoutePath", () => {
  it("shares the runtime matcher for static, dynamic, and catch-all paths", () => {
    expect(matchRoutePath("/docs/:slug", "/docs/guide")).toEqual({ slug: "guide" });
    expect(matchRoutePath("/docs/:rest*", "/docs/guides/intro")).toEqual({
      rest: "guides/intro",
    });
    expect(matchRoutePath("/docs/:rest*", "/docs")).toEqual({ rest: "" });
    expect(matchRoutePath("/docs/:slug", "/other/guide")).toBeNull();
    expect(matchRoutePath("/docs/:slug", "/docs/%E0")).toBeNull();
    expect(routePathIsDynamic("/docs/guide")).toBe(false);
    expect(routePathIsDynamic("/docs/:slug")).toBe(true);
    expect(routePathIsDynamic("/docs/:rest*")).toBe(true);
  });
});

describe("matchAppRoute", () => {
  const app = defineApp({
    routes: [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/blog/:slug", "./routes/post.tsx", {
        render: "isg",
        revalidate: timeRevalidate(60),
      }),
      route("/docs/*", "./routes/docs.tsx", { render: "ssr" }),
      route("/:path*", "./routes/not-found.tsx", { render: "ssr" }),
    ],
  });

  it("matches static routes", () => {
    const match = matchAppRoute(app, "/");

    expect(match?.route.file).toBe("./routes/home.tsx");
    expect(match?.params).toEqual({});
  });

  it("matches dynamic params", () => {
    const match = matchAppRoute(app, "/blog/hello-world");

    expect(match?.route.file).toBe("./routes/post.tsx");
    expect(match?.params).toEqual({ slug: "hello-world" });
  });

  it("matches catch-all routes", () => {
    const match = matchAppRoute(app, "/docs/guides/intro");

    expect(match?.route.file).toBe("./routes/docs.tsx");
    expect(match?.params).toEqual({ "*": "guides/intro" });
  });

  it("matches named catch-all routes", () => {
    const match = matchAppRoute(app, "/missing/deep/path");

    expect(match?.route.file).toBe("./routes/not-found.tsx");
    expect(match?.params).toEqual({ path: "missing/deep/path" });
  });

  it("returns null for malformed percent-encoded dynamic params", () => {
    const match = matchAppRoute(app, "/blog/%E0");

    expect(match).toBeUndefined();
  });

  it("decodes valid percent-encoded dynamic params", () => {
    const match = matchAppRoute(app, "/blog/hello%20world");

    expect(match?.route.file).toBe("./routes/post.tsx");
    expect(match?.params).toEqual({ slug: "hello world" });
  });
});

describe("API route matching", () => {
  it("excludes TypeScript declaration files from API route discovery", () => {
    const routes = resolveApiRoutes(["/src/api/types.d.ts", "/src/api/health.ts"]);

    expect(routes.map(({ file, path }) => ({ file, path }))).toEqual([
      { file: "/src/api/health.ts", path: "/api/health" },
    ]);
  });

  it("sorts static api routes ahead of dynamic routes", () => {
    const routes = resolveApiRoutes(["/src/api/users/[id].ts", "/src/api/users/me.ts"]);

    expect(routes[0]?.file).toBe("/src/api/users/me.ts");
    expect(routes[1]?.file).toBe("/src/api/users/[id].ts");
  });

  it("prefers static api routes over dynamic params during matching", () => {
    const routes = resolveApiRoutes(["/src/api/users/[id].ts", "/src/api/users/me.ts"]);

    const staticMatch = matchApiRoute(routes, "/api/users/me");
    const dynamicMatch = matchApiRoute(routes, "/api/users/42");

    expect(staticMatch?.route.file).toBe("/src/api/users/me.ts");
    expect(staticMatch?.params).toEqual({});
    expect(dynamicMatch?.route.file).toBe("/src/api/users/[id].ts");
    expect(dynamicMatch?.params).toEqual({ id: "42" });
  });

  it("resolves catch-all api routes to a wildcard path", () => {
    const [route] = resolveApiRoutes(["/src/api/files/[...path].ts"]);

    expect(route?.path).toBe("/api/files/*");
  });

  it("matches catch-all api routes and exposes the rest as a param", () => {
    const routes = resolveApiRoutes([
      "/src/api/files/[...path].ts",
      "/src/api/files/readme.ts",
      "/src/api/files/[id].ts",
    ]);

    const staticMatch = matchApiRoute(routes, "/api/files/readme");
    const dynamicMatch = matchApiRoute(routes, "/api/files/42");
    const catchAllMatch = matchApiRoute(routes, "/api/files/docs/getting-started");

    expect(staticMatch?.route.file).toBe("/src/api/files/readme.ts");
    expect(dynamicMatch?.route.file).toBe("/src/api/files/[id].ts");
    expect(dynamicMatch?.params).toEqual({ id: "42" });
    expect(catchAllMatch?.route.file).toBe("/src/api/files/[...path].ts");
    expect(catchAllMatch?.params).toEqual({ "*": "docs/getting-started" });
  });
});
