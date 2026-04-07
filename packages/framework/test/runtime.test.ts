import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  ViactHttpError,
  defineApp,
  handleViactRequest,
  resolveApiRoutes,
  route,
} from "../src/index.ts";

describe("handleViactRequest actions", () => {
  it("translates redirect envelopes into HTTP redirects with headers", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx")],
    });

    const response = await handleViactRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => null,
            action: async () => ({
              headers: { "set-cookie": "viact=1" },
              redirect: "/done",
            }),
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: {
          origin: "http://localhost",
        },
        method: "POST",
      }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/done");
    expect(response.headers.get("set-cookie")).toBe("viact=1");
  });
});

describe("handleViactRequest API middleware", () => {
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

    const response = await handleViactRequest({
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

describe("handleViactRequest with separate data modules", () => {
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

    const response = await handleViactRequest({
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

  it("resolves action from a separate dataModule via actionFile", async () => {
    const app = defineApp({
      routes: [
        route("/dashboard", {
          component: "./routes/dashboard.tsx",
          action: "./server/dashboard-action.ts",
        }),
      ],
    });

    const response = await handleViactRequest({
      app,
      registry: {
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "dashboard"),
          }),
        },
        dataModules: {
          "./server/dashboard-action.ts": async () => ({
            action: async () => ({ ok: true, data: { created: true } }),
          }),
        },
      },
      request: new Request("http://localhost/dashboard", {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ ok: true, data: { created: true } });
  });

  it("falls back to route module loader when no loaderFile is set", async () => {
    const app = defineApp({
      routes: [route("/home", "./routes/home.tsx", { render: "ssr" })],
    });

    const response = await handleViactRequest({
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

describe("handleViactRequest ErrorBoundary", () => {
  it("renders the route error boundary for loader failures", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handleViactRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new ViactHttpError(404, "Post not found");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("Error: Post not found");
  });

  it("returns a route-state error payload for loader failures", async () => {
    const app = defineApp({
      routes: [route("/posts/:slug", "./routes/post.tsx")],
    });

    const response = await handleViactRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Error: ${error.message}`),
            loader: async () => {
              throw new ViactHttpError(404, "Post not found");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing", {
        headers: {
          "x-viact-route-state-request": "1",
        },
      }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        message: "Post not found",
        name: "ViactHttpError",
        status: 404,
      },
    });
  });
});
