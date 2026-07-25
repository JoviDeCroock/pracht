import { h } from "preact";
import type { ComponentChildren } from "preact";
import { describe, expect, it } from "vitest";

import {
  defineApp,
  handlePrachtRequest,
  matchAppRoute,
  notFound,
  PrachtHttpError,
  prerenderApp,
  resolveApp,
  route,
} from "../src/index.ts";

const NOT_FOUND_ROUTE_ID = "__pracht_not_found__";

function parseHydrationState(html: string) {
  const match = html.match(
    /<script id="pracht-state" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error("Hydration state script not found");
  }

  return JSON.parse(match[1]) as { routeId: string; url: string };
}

function createApp() {
  return defineApp({
    shells: {
      public: "./shells/public.tsx",
    },
    routes: [route("/", "./routes/home.tsx", { shell: "public" })],
    notFound: { component: "./routes/not-found.tsx", shell: "public" },
  });
}

const registry = {
  routeModules: {
    "./routes/home.tsx": async () => ({ Component: () => h("main", null, "home") }),
    "./routes/not-found.tsx": async () => ({
      Component: () => h("h1", null, "Page not found"),
    }),
  },
  shellModules: {
    "./shells/public.tsx": async () => ({
      Shell: ({ children }: { children?: ComponentChildren }) =>
        h("div", { id: "shell" }, children),
    }),
  },
};

describe("app-level notFound page", () => {
  it("renders with a 404 status when no route matches", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/missing"),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<h1>Page not found</h1>");
    // Rendered inside its configured shell.
    expect(html).toContain('<div id="shell">');
  });

  it("keeps the plain-text 404 when the app declares no notFound page", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handlePrachtRequest({
      app,
      registry,
      request: new Request("http://localhost/missing"),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toBe("Not found");
  });

  it("never participates in route matching", () => {
    const app = createApp();
    const resolved = resolveApp(app);

    expect(resolved.routes.map((entry) => entry.file)).toEqual(["./routes/home.tsx"]);
    expect(resolved.notFound?.id).toBe(NOT_FOUND_ROUTE_ID);
    expect(matchAppRoute(app, "/missing")).toBeUndefined();
    expect(matchAppRoute(app, "/logo.png")).toBeUndefined();
    expect(matchAppRoute(app, "/(not found)")).toBeUndefined();
  });

  it("hydrates under a reserved route id at the requested url", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      clientEntryUrl: "/client.js",
      request: new Request("http://localhost/missing?ref=nav"),
    });

    const state = parseHydrationState(await response.text());
    expect(state.routeId).toBe(NOT_FOUND_ROUTE_ID);
    expect(state.url).toBe("/missing?ref=nav");
  });

  it("runs its own loader and middleware", async () => {
    const app = defineApp({
      middleware: {
        stamp: "./middleware/stamp.ts",
      },
      routes: [route("/", "./routes/home.tsx")],
      notFound: { component: "./routes/not-found.tsx", middleware: ["stamp"] },
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/stamp.ts": async () => ({
            middleware: async (_args: unknown, next: () => Promise<Response>) => {
              const result = await next();
              result.headers.set("x-not-found-middleware", "ran");
              return result;
            },
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({ Component: () => null }),
          "./routes/not-found.tsx": async () => ({
            Component: ({ data }: { data: { suggestion: string } }) =>
              h("p", null, `Try ${data.suggestion}`),
            loader: async () => ({ suggestion: "/" }),
          }),
        },
      },
      request: new Request("http://localhost/missing"),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-not-found-middleware")).toBe("ran");
    await expect(response.text()).resolves.toContain("Try /");
  });

  it("keeps JSON 404s for route-state requests", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/missing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.text()).resolves.toContain('"status":404');
  });

  it("keeps the plain-text 404 for non-GET requests", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry,
      request: new Request("http://localhost/missing", { method: "POST" }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("keeps the 404 status for a markdown representation", async () => {
    const response = await handlePrachtRequest({
      app: createApp(),
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
            markdown: "# Page not found\n",
          }),
        },
      },
      request: new Request("http://localhost/missing", {
        headers: { accept: "text/markdown" },
      }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    await expect(response.text()).resolves.toBe("# Page not found\n");
  });

  it("is not prerendered as a page of its own", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx", { render: "ssg" })],
      notFound: "./routes/not-found.tsx",
    });

    const pages = await prerenderApp({ app, registry });
    expect(pages.map((page) => page.path)).toEqual(["/"]);
  });

  it("reports an unknown shell name with a suggestion", () => {
    expect(() =>
      resolveApp(
        defineApp({
          shells: { public: "./shells/public.tsx" },
          routes: [],
          notFound: { component: "./routes/not-found.tsx", shell: "pubic" },
        }),
      ),
    ).toThrow(/Did you mean "public"/);
  });
});

describe("notFound() thrown from a loader", () => {
  it("renders the app notFound page", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
      notFound: "./routes/not-found.tsx",
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            loader: async () => {
              throw notFound("Post not found");
            },
          }),
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("<h1>Page not found</h1>");
  });

  it("yields to a route ErrorBoundary", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
      notFound: "./routes/not-found.tsx",
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }: { error: Error }) =>
              h("p", null, `Boundary: ${error.message}`),
            loader: async () => {
              throw notFound("Post not found");
            },
          }),
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Boundary: Post not found");
    expect(html).not.toContain("Page not found");
  });

  it("leaves non-404 errors on the normal error path", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
      notFound: "./routes/not-found.tsx",
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => null,
            loader: async () => {
              throw new PrachtHttpError(503, "Upstream down");
            },
          }),
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.not.toContain("Page not found");
  });

  it("does not recurse when the notFound page itself throws a 404", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
      notFound: "./routes/not-found.tsx",
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({ Component: () => null }),
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
            loader: async () => {
              throw notFound("still missing");
            },
          }),
        },
      },
      request: new Request("http://localhost/missing"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("still missing");
  });

  it("renders for a 404 thrown by middleware", async () => {
    const app = defineApp({
      middleware: { guard: "./middleware/guard.ts" },
      routes: [route("/admin", "./routes/admin.tsx", { middleware: ["guard"] })],
      notFound: "./routes/not-found.tsx",
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/guard.ts": async () => ({
            middleware: async () => {
              throw notFound();
            },
          }),
        },
        routeModules: {
          "./routes/admin.tsx": async () => ({ Component: () => h("main", null, "admin") }),
          "./routes/not-found.tsx": async () => ({
            Component: () => h("h1", null, "Page not found"),
          }),
        },
      },
      request: new Request("http://localhost/admin"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("<h1>Page not found</h1>");
  });
});
