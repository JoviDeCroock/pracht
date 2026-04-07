import { describe, expect, it } from "vitest";

import {
  defineApp,
  group,
  matchAppRoute,
  resolveApp,
  route,
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
});

describe("route() with RouteConfig object", () => {
  it("accepts an object config with component and loader", () => {
    const app = defineApp({
      routes: [
        route("/dashboard", {
          component: "./routes/dashboard.tsx",
          loader: "./server/dashboard-loader.ts",
          render: "ssr",
        }),
      ],
    });

    const resolved = resolveApp(app);

    expect(resolved.routes).toHaveLength(1);
    expect(resolved.routes[0]).toMatchObject({
      file: "./routes/dashboard.tsx",
      loaderFile: "./server/dashboard-loader.ts",
      render: "ssr",
    });
  });

  it("works without loader and action", () => {
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
    expect(resolved.routes[0].actionFile).toBeUndefined();
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
});
