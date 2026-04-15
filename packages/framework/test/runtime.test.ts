import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  PrachtHttpError,
  defineApp,
  handlePrachtRequest,
  prerenderApp,
  resolveApiRoutes,
  route,
  useLocation,
  useParams,
} from "../src/index.ts";

function parseHydrationState(html: string) {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error("Hydration state script not found");
  }

  return JSON.parse(match[1]) as {
    error?: {
      diagnostics?: Record<string, unknown>;
      message: string;
      name: string;
      status: number;
    } | null;
  };
}

describe("handlePrachtRequest rejects non-GET on page routes", () => {
  it("returns 405 for POST to a page route", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
          }),
        },
      },
      request: new Request("http://localhost/", {
        method: "POST",
      }),
    });

    expect(response.status).toBe(405);
  });
});

describe("handlePrachtRequest API middleware", () => {
  it("runs configured API middleware before handlers", async () => {
    const app = defineApp({
      api: {
        middleware: ["apiAuth"],
      },
      middleware: {
        apiAuth: "./middleware/api-auth.ts",
      },
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/health.ts": async () => ({
            GET: async ({ context }) => Response.json(context),
          }),
        },
        middlewareModules: {
          "./middleware/api-auth.ts": async () => ({
            middleware: async () => ({
              context: { allowed: true },
            }),
          }),
        },
      },
      request: new Request("http://localhost/api/health"),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true });
  });
});

describe("handlePrachtRequest API default handlers", () => {
  it("falls back to a default export that branches on request.method", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/widgets/[id].ts"]),
      app,
      context: { traceId: "ctx-1" },
      registry: {
        apiModules: {
          "/src/api/widgets/[id].ts": async () => ({
            default: async ({ context, params, request, route }) => {
              if (request.method === "PATCH") {
                return Response.json({
                  id: params.id,
                  method: request.method,
                  routePath: route.path,
                  traceId: context.traceId,
                });
              }

              return new Response("Method not allowed", { status: 405 });
            },
          }),
        },
      },
      request: new Request("http://localhost/api/widgets/42", {
        method: "PATCH",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: "42",
      method: "PATCH",
      routePath: "/api/widgets/:id",
      traceId: "ctx-1",
    });
  });

  it("prefers named HTTP method handlers over a default export", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/health.ts": async () => ({
            default: async () => new Response("default"),
            GET: async () => new Response("named"),
          }),
        },
      },
      request: new Request("http://localhost/api/health"),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("named");
  });
});

describe("handlePrachtRequest API errors", () => {
  it("returns structured api diagnostics when debugErrors is enabled", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/health.ts"]),
      app,
      debugErrors: true,
      registry: {
        apiModules: {
          "/src/api/health.ts": async () => ({
            GET: async () => {
              throw new Error("api exploded");
            },
          }),
        },
      },
      request: new Request("http://localhost/api/health"),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        diagnostics: {
          middlewareFiles: [],
          phase: "api",
          routeFile: "/src/api/health.ts",
          routePath: "/api/health",
          status: 500,
        },
        message: "api exploded",
        name: "Error",
        status: 500,
      },
    });
  });
});

describe("handlePrachtRequest with separate data modules", () => {
  it("resolves loader from a separate dataModule via loaderFile", async () => {
    const app = defineApp({
      routes: [
        route("/dashboard", {
          component: "./routes/dashboard.tsx",
          loader: "./server/dashboard-loader.ts",
          render: "ssr",
        }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: ({ data }) => h("main", null, `Hello ${(data as any).user}`),
          }),
        },
        dataModules: {
          "./server/dashboard-loader.ts": async () => ({
            loader: async () => ({ user: "Jovi" }),
          }),
        },
      },
      request: new Request("http://localhost/dashboard"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Hello Jovi");
  });

  it("returns 405 for POST to a page route with separate loader", async () => {
    const app = defineApp({
      routes: [
        route("/dashboard", {
          component: "./routes/dashboard.tsx",
          loader: "./server/dashboard-loader.ts",
          render: "ssr",
        }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "dashboard"),
          }),
        },
        dataModules: {
          "./server/dashboard-loader.ts": async () => ({
            loader: async () => ({ user: "Jovi" }),
          }),
        },
      },
      request: new Request("http://localhost/dashboard", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    });

    expect(response.status).toBe(405);
  });

  it("falls back to route module loader when no loaderFile is set", async () => {
    const app = defineApp({
      routes: [route("/home", "./routes/home.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: ({ data }) => h("main", null, `Hello ${(data as any).name}`),
            loader: async () => ({ name: "inline" }),
          }),
        },
      },
      request: new Request("http://localhost/home"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Hello inline");
  });
});

describe("handlePrachtRequest route component exports", () => {
  it("renders a function default export while preserving named loader exports", async () => {
    const app = defineApp({
      routes: [route("/home", "./routes/home.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            default: ({ data }) => h("main", null, `Hello ${(data as any).name}`),
            loader: async () => ({ name: "default export" }),
          }),
        },
      },
      request: new Request("http://localhost/home"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Hello default export");
  });
});

describe("handlePrachtRequest cache variance", () => {
  it("adds a route-state vary header to HTML responses", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
      },
      request: new Request("http://localhost/pricing"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toContain("x-pracht-route-state-request");
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("defaults route-state responses to no-store and varies on the route-state header", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("vary")).toContain("x-pracht-route-state-request");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ data: { plan: "MVP" } });
  });

  it("encodes middleware redirects as JSON for route-state requests", async () => {
    const app = defineApp({
      middleware: {
        auth: "./middleware/auth.ts",
      },
      routes: [route("/dashboard", "./routes/dashboard.tsx", { middleware: ["auth"] })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/auth.ts": async () => ({
            middleware: async () => ({ redirect: "/" }),
          }),
        },
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "dashboard"),
          }),
        },
      },
      request: new Request("http://localhost/dashboard", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ redirect: "/" });
  });
});

describe("handlePrachtRequest document headers", () => {
  it("merges shell and route headers for document responses", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", shell: "public" })],
      shells: {
        public: "./shells/public.tsx",
      },
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            headers: ({ data }) => ({
              "x-plan": (data as { plan: string }).plan,
              "x-scope": "route",
            }),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
        shellModules: {
          "./shells/public.tsx": async () => ({
            headers: () => ({
              "content-security-policy": "default-src 'self'",
              "x-scope": "shell",
              "x-shell": "public",
            }),
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
      request: new Request("http://localhost/pricing"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(response.headers.get("x-shell")).toBe("public");
    expect(response.headers.get("x-plan")).toBe("MVP");
    expect(response.headers.get("x-scope")).toBe("route");
    expect(response.headers.get("vary")).toContain("x-pracht-route-state-request");
  });

  it("does not apply document headers to route-state JSON responses", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", shell: "public" })],
      shells: {
        public: "./shells/public.tsx",
      },
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            headers: () => ({ "x-route": "pricing" }),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
        shellModules: {
          "./shells/public.tsx": async () => ({
            headers: () => ({ "x-shell": "public" }),
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-route")).toBeNull();
    expect(response.headers.get("x-shell")).toBeNull();
    await expect(response.json()).resolves.toEqual({ data: { plan: "MVP" } });
  });
});

describe("handlePrachtRequest SPA shell fallback", () => {
  it("renders shell chrome and loading UI for SPA routes without serializing loader data", async () => {
    const app = defineApp({
      shells: {
        app: "./shells/app.tsx",
      },
      routes: [route("/settings", "./routes/settings.tsx", { render: "spa", shell: "app" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/settings.tsx": async () => ({
            Component: ({ data }) => h("main", null, `Hello ${(data as any).user}`),
            loader: async () => ({ user: "secret-user" }),
          }),
        },
        shellModules: {
          "./shells/app.tsx": async () => ({
            Shell: ({ children }) => h("div", { class: "app-shell" }, children),
            Loading: () => h("p", null, "Loading settings..."),
          }),
        },
      },
      request: new Request("http://localhost/settings"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("app-shell");
    expect(html).toContain("Loading settings...");
    expect(html).toContain('"pending":true');
    expect(html).not.toContain("secret-user");
  });
});

describe("prerenderApp", () => {
  it("injects the production client entry and modulepreload hints into prerendered HTML", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssg", shell: "public" })],
      shells: {
        public: "./shells/public.tsx",
      },
    });

    const [page] = await prerenderApp({
      app,
      clientEntryUrl: "/assets/client-abc123.js",
      jsManifest: {
        "src/routes/pricing.tsx": ["/assets/pricing-abc123.js", "/assets/vendor-abc123.js"],
        "src/shells/public.tsx": ["/assets/public-abc123.js", "/assets/vendor-abc123.js"],
      },
      registry: {
        routeModules: {
          "/src/routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
        shellModules: {
          "/src/shells/public.tsx": async () => ({
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
    });

    expect(page.path).toBe("/pricing");
    expect(page.html).toContain('<script type="module" src="/assets/client-abc123.js"></script>');
    expect(page.html).toContain('<link rel="modulepreload" href="/assets/public-abc123.js">');
    expect(page.html).toContain('<link rel="modulepreload" href="/assets/pricing-abc123.js">');
    expect(page.html).toContain('<link rel="modulepreload" href="/assets/vendor-abc123.js">');
  });

  it("preserves document headers on prerendered pages", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssg", shell: "public" })],
      shells: {
        public: "./shells/public.tsx",
      },
    });

    const [page] = await prerenderApp({
      app,
      registry: {
        routeModules: {
          "/src/routes/pricing.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { plan: string }).plan),
            headers: ({ data }) => ({ "x-plan": (data as { plan: string }).plan }),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
        shellModules: {
          "/src/shells/public.tsx": async () => ({
            headers: () => ({ "content-security-policy": "default-src 'self'" }),
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
    });

    expect(page.path).toBe("/pricing");
    expect(page.headers).toMatchObject({
      "content-security-policy": "default-src 'self'",
      "x-plan": "MVP",
    });
  });

  it("renders multiple static paths concurrently", async () => {
    const app = defineApp({
      routes: [route("/products/:id", "./routes/product.tsx", { render: "ssg" })],
    });

    let activeLoaders = 0;
    let maxConcurrentLoaders = 0;

    const pages = await prerenderApp({
      app,
      registry: {
        routeModules: {
          "/src/routes/product.tsx": async () => ({
            Component: ({ data }) => h("main", null, (data as { id: string }).id),
            getStaticPaths: () => [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
            loader: async ({ params }) => {
              activeLoaders += 1;
              maxConcurrentLoaders = Math.max(maxConcurrentLoaders, activeLoaders);
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
              activeLoaders -= 1;
              return { id: params.id };
            },
          }),
        },
      },
    });

    expect(pages).toHaveLength(4);
    expect(maxConcurrentLoaders).toBeGreaterThan(1);
  });
});

describe("useParams", () => {
  it("provides route params to nested components during SSR", async () => {
    const app = defineApp({
      routes: [route("/products/:id", "./routes/product.tsx", { render: "ssr" })],
    });

    function NestedParamsDisplay() {
      const params = useParams();
      return h("span", { class: "params-id" }, params.id ?? "none");
    }

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/product.tsx": async () => ({
            Component: () => h("main", null, h(NestedParamsDisplay, null)),
            loader: async () => ({ name: "Widget" }),
          }),
        },
      },
      request: new Request("http://localhost/products/42"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("42");
  });

  it("provides empty params for static routes during SSR", async () => {
    const app = defineApp({
      routes: [route("/home", "./routes/home.tsx", { render: "ssr" })],
    });

    function NestedParamsDisplay() {
      const params = useParams();
      const keys = Object.keys(params);
      return h("span", null, `keys:${keys.length}`);
    }

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, h(NestedParamsDisplay, null)),
          }),
        },
      },
      request: new Request("http://localhost/home"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("keys:0");
  });
});

describe("useLocation", () => {
  it("provides pathname and search separately during SSR", async () => {
    const app = defineApp({
      routes: [route("/about", "./routes/about.tsx", { render: "ssr" })],
    });

    function LocationDisplay() {
      const { pathname, search } = useLocation();
      return h("span", null, `${pathname}|${search}`);
    }

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/about.tsx": async () => ({
            Component: () => h("main", null, h(LocationDisplay, null)),
          }),
        },
      },
      request: new Request("http://localhost/about?tab=team"),
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("/about|?tab=team");
  });
});

describe("handlePrachtRequest ErrorBoundary", () => {
  it("renders the route error boundary for loader failures", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new PrachtHttpError(404, "Post not found");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("Error: Post not found");
  });

  it("sanitizes unexpected 5xx loader failures in SSR output and hydration state", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new Error("Database credentials invalid");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Error: Internal Server Error");
    expect(html).not.toContain("Database credentials invalid");
  });

  it("returns a route-state error payload for loader failures", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new PrachtHttpError(404, "Post not found");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Post not found",
        name: "PrachtHttpError",
        status: 404,
      },
    });
  });

  it("includes structured loader diagnostics in debug route-state responses", async () => {
    const app = defineApp({
      middleware: {
        auth: "./middleware/auth.ts",
      },
      shells: {
        blog: "./shells/blog.tsx",
      },
      routes: [
        route("/posts/:slug", {
          component: "./routes/post.tsx",
          id: "post-show",
          loader: "./server/post-loader.ts",
          middleware: ["auth"],
          render: "ssr",
          shell: "blog",
        }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        dataModules: {
          "./server/post-loader.ts": async () => ({
            loader: async () => {
              throw new Error("loader exploded");
            },
          }),
        },
        middlewareModules: {
          "./middleware/auth.ts": async () => ({
            middleware: async () => ({ context: { user: "jovi" } }),
          }),
        },
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        diagnostics: {
          loaderFile: "./server/post-loader.ts",
          middlewareFiles: ["./middleware/auth.ts"],
          phase: "loader",
          routeFile: "./routes/post.tsx",
          routeId: "post-show",
          routePath: "/posts/:slug",
          shellFile: "./shells/blog.tsx",
          status: 500,
        },
        message: "loader exploded",
        name: "Error",
        status: 500,
      },
    });
  });

  it("catches middleware failures and serializes middleware diagnostics", async () => {
    const app = defineApp({
      middleware: {
        auth: "./middleware/auth.ts",
      },
      routes: [
        route("/posts/:slug", "./routes/post.tsx", {
          id: "post-show",
          middleware: ["auth"],
          render: "ssr",
        }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        middlewareModules: {
          "./middleware/auth.ts": async () => ({
            middleware: async () => {
              throw new Error("auth missing");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        diagnostics: {
          middlewareFiles: ["./middleware/auth.ts"],
          phase: "middleware",
          routeFile: "./routes/post.tsx",
          routeId: "post-show",
          routePath: "/posts/:slug",
          status: 500,
        },
        message: "auth missing",
        name: "Error",
        status: 500,
      },
    });
  });

  it("sanitizes unexpected 5xx loader failures in route-state responses", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new Error("token parse failed");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Internal Server Error",
        name: "Error",
        status: 500,
      },
    });
  });

  it("sanitizes explicit 5xx PrachtHttpError messages by default", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new PrachtHttpError(503, "Upstream token service failed");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Internal Server Error",
        name: "Error",
        status: 503,
      },
    });
  });

  it("can expose raw server errors when debugErrors is enabled", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new Error("debug details");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-pracht-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {
        diagnostics: {
          loaderFile: "./routes/post.tsx",
          middlewareFiles: [],
          phase: "loader",
          routeFile: "./routes/post.tsx",
          routeId: "posts-slug",
          routePath: "/posts/:slug",
          status: 500,
        },
        message: "debug details",
        name: "Error",
        status: 500,
      },
    });
  });

  it("does not infer debug error exposure from NODE_ENV", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    try {
      const response = await handlePrachtRequest({
        app,
        registry: {
          routeModules: {
            "./routes/post.tsx": async () => ({
              Component: () => h("main", null, "post"),
              ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
              loader: async () => {
                throw new Error("env details");
              },
            }),
          },
        },
        request: new Request("http://localhost/posts/missing", {
          headers: {
            "x-pracht-route-state-request": "1",
          },
        }),
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: {
          message: "Internal Server Error",
          name: "Error",
          status: 500,
        },
      });
    } finally {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  });

  it("stores render diagnostics in SSR hydration state when debugErrors is enabled", async () => {
    const app = defineApp({
      shells: {
        blog: "./shells/blog.tsx",
      },
      routes: [
        route("/posts/:slug", "./routes/post.tsx", {
          id: "post-show",
          render: "ssr",
          shell: "blog",
        }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            head: async () => {
              throw new Error("head exploded");
            },
          }),
        },
        shellModules: {
          "./shells/blog.tsx": async () => ({
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Error: head exploded");
    expect(parseHydrationState(html)).toMatchObject({
      error: {
        diagnostics: {
          middlewareFiles: [],
          phase: "render",
          routeFile: "./routes/post.tsx",
          routeId: "post-show",
          routePath: "/posts/:slug",
          shellFile: "./shells/blog.tsx",
          status: 500,
        },
        message: "head exploded",
        name: "Error",
        status: 500,
      },
    });
  });
});

describe("handlePrachtRequest pipeline parallelism", () => {
  function defer<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  async function drainMicrotasks() {
    // Yield to the event loop twice so any already-scheduled promise chains
    // have a chance to advance to their first await point.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  it("resolves middleware module imports in parallel even though execution stays ordered", async () => {
    const app = defineApp({
      middleware: {
        a: "./middleware/a.ts",
        b: "./middleware/b.ts",
        c: "./middleware/c.ts",
      },
      routes: [
        route("/", "./routes/home.tsx", {
          middleware: ["a", "b", "c"],
          render: "ssr",
        }),
      ],
    });

    const importStarted: Record<string, boolean> = { a: false, b: false, c: false };
    const gates = {
      a: defer<void>(),
      b: defer<void>(),
      c: defer<void>(),
    };
    const executionOrder: string[] = [];

    const makeMiddleware = (id: "a" | "b" | "c") => async () => {
      importStarted[id] = true;
      await gates[id].promise;
      return {
        middleware: async ({ context }: { context: Record<string, boolean> }) => {
          executionOrder.push(id);
          return { context: { ...context, [`${id}-ran`]: true } };
        },
      };
    };

    const responsePromise = handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/a.ts": makeMiddleware("a"),
          "./middleware/b.ts": makeMiddleware("b"),
          "./middleware/c.ts": makeMiddleware("c"),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "ok"),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    await drainMicrotasks();

    // Under the parallelized chain, every middleware's dynamic-import function
    // has been kicked off before any of them resolve. Under the old serial
    // code only `a` would have started here.
    expect(importStarted).toEqual({ a: true, b: true, c: true });

    // Resolve gates out-of-order to prove execution is still left-to-right.
    gates.c.resolve();
    gates.b.resolve();
    gates.a.resolve();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(executionOrder).toEqual(["a", "b", "c"]);
  });

  it("starts route and shell module imports in parallel with the middleware chain", async () => {
    const app = defineApp({
      middleware: {
        auth: "./middleware/auth.ts",
      },
      shells: {
        app: "./shells/app.tsx",
      },
      routes: [
        route("/", "./routes/home.tsx", {
          middleware: ["auth"],
          render: "ssr",
          shell: "app",
        }),
      ],
    });

    let middlewareStarted = false;
    let routeModuleImportStarted = false;
    let shellModuleImportStarted = false;
    const mwGate = defer<void>();

    const response = handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/auth.ts": async () => ({
            middleware: async ({ context }: { context: Record<string, unknown> }) => {
              middlewareStarted = true;
              await mwGate.promise;
              return { context };
            },
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => {
            routeModuleImportStarted = true;
            return {
              Component: () => h("main", null, "ok"),
            };
          },
        },
        shellModules: {
          "./shells/app.tsx": async () => {
            shellModuleImportStarted = true;
            return {
              Shell: ({ children }: { children: unknown }) => h("div", null, children as any),
            };
          },
        },
      },
      request: new Request("http://localhost/"),
    });

    await drainMicrotasks();

    // While middleware is still blocked on its gate, the route and shell
    // module importers have already been invoked. Under the old serial
    // pipeline, neither would have been touched yet — the route import
    // waited for middleware to resolve, and the shell import waited for the
    // loader.
    expect(middlewareStarted).toBe(true);
    expect(routeModuleImportStarted).toBe(true);
    expect(shellModuleImportStarted).toBe(true);

    mwGate.resolve();
    const res = await response;
    expect(res.status).toBe(200);
  });
});
