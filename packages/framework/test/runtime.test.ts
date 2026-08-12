import { h } from "preact";
import { describe, expect, it } from "vitest";

import {
  Link,
  PrachtHttpError,
  defineApp,
  defineFont,
  handlePrachtRequest,
  prerenderApp,
  redirect,
  resolveApiRoutes,
  route,
  timeRevalidate,
  useLocation,
  useParams,
  useSearchParams,
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
            middleware: async ({ context }, next) => {
              (context as { allowed?: boolean }).allowed = true;
              return next();
            },
          }),
        },
      },
      request: new Request("http://localhost/api/health"),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ allowed: true });
  });

  it("fails closed when a registered middleware module has no `middleware` export", async () => {
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
            GET: async () => Response.json({ reached: true }),
          }),
        },
        middlewareModules: {
          // A renamed export, or a `default` export, used to be skipped
          // silently — so an auth gate wired in the manifest simply did not
          // run and the handler answered 200.
          "./middleware/api-auth.ts": async () =>
            ({
              default: async (_args: unknown, next: () => Promise<Response>) => next(),
            }) as never,
        },
      },
      request: new Request("http://localhost/api/health"),
    });

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("reached");
  });

  it("uses 303 for API middleware redirects on unsafe methods", async () => {
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
      apiRoutes: resolveApiRoutes(["/src/api/submit.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/submit.ts": async () => ({
            POST: async () => Response.json({ ok: true }),
          }),
        },
        middlewareModules: {
          "./middleware/api-auth.ts": async () => ({
            middleware: async ({ request }) => redirect("/login", { request }),
          }),
        },
      },
      request: new Request("http://localhost/api/submit", {
        method: "POST",
      }),
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });
});

describe("middleware wrap-around contract", () => {
  it("middleware that returns next() observes the terminal response", async () => {
    const app = defineApp({
      middleware: { trace: "./middleware/trace.ts" },
      routes: [route("/", "./routes/home.tsx", { middleware: ["trace"], render: "ssr" })],
    });

    let observedStatus: number | undefined;
    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/trace.ts": async () => ({
            middleware: async (_args, next) => {
              const res = await next();
              observedStatus = res.status;
              return res;
            },
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "ok"),
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(response.status).toBe(200);
    expect(observedStatus).toBe(200);
  });

  it("middleware can wrap try/catch/finally around next()", async () => {
    const app = defineApp({
      middleware: { wrap: "./middleware/wrap.ts" },
      routes: [route("/", "./routes/home.tsx", { middleware: ["wrap"], render: "ssr" })],
    });

    const events: string[] = [];
    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        middlewareModules: {
          "./middleware/wrap.ts": async () => ({
            middleware: async (_args, next) => {
              events.push("start");
              try {
                return await next();
              } catch (err) {
                events.push(`catch:${(err as Error).message}`);
                throw err;
              } finally {
                events.push("finally");
              }
            },
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "ok"),
            loader: async () => {
              throw new Error("boom");
            },
          }),
        },
      },
      request: new Request("http://localhost/"),
    });

    expect(response.status).toBe(500);
    expect(events).toEqual(["start", "catch:boom", "finally"]);
  });

  it("middleware that does not call next() short-circuits the chain", async () => {
    const app = defineApp({
      middleware: { gate: "./middleware/gate.ts" },
      routes: [route("/dashboard", "./routes/dashboard.tsx", { middleware: ["gate"] })],
    });

    let loaderRan = false;
    const response = await handlePrachtRequest({
      app,
      registry: {
        middlewareModules: {
          "./middleware/gate.ts": async () => ({
            middleware: async () =>
              new Response("nope", { status: 401, headers: { "content-type": "text/plain" } }),
          }),
        },
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "dashboard"),
            loader: async () => {
              loaderRan = true;
              return null;
            },
          }),
        },
      },
      request: new Request("http://localhost/dashboard"),
    });

    expect(response.status).toBe(401);
    expect(loaderRan).toBe(false);
  });

  it("throws when middleware calls next() multiple times", async () => {
    const app = defineApp({
      middleware: { bad: "./middleware/bad.ts" },
      routes: [route("/", "./routes/home.tsx", { middleware: ["bad"], render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        middlewareModules: {
          "./middleware/bad.ts": async () => ({
            middleware: async (_args, next) => {
              await next();
              return next();
            },
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "ok"),
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect((body as { error: { message: string } }).error.message).toMatch(
      /next\(\) multiple times/,
    );
  });

  it("throws when middleware does not return a Response", async () => {
    const app = defineApp({
      middleware: { bad: "./middleware/bad.ts" },
      routes: [route("/", "./routes/home.tsx", { middleware: ["bad"], render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      debugErrors: true,
      registry: {
        middlewareModules: {
          "./middleware/bad.ts": async () => ({
            middleware: async () => undefined as unknown as Response,
          }),
        },
        routeModules: {
          "./routes/home.tsx": async () => ({
            Component: () => h("main", null, "ok"),
          }),
        },
      },
      request: new Request("http://localhost/", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect((body as { error: { message: string } }).error.message).toMatch(
      /did not return a Response/,
    );
  });

  it("middleware sees mutations from earlier middleware in the chain", async () => {
    const app = defineApp({
      middleware: {
        first: "./middleware/first.ts",
        second: "./middleware/second.ts",
      },
      routes: [
        route("/dashboard", "./routes/dashboard.tsx", {
          middleware: ["first", "second"],
          render: "ssr",
        }),
      ],
    });

    let observed: { user?: string; trace?: string } = {};
    const response = await handlePrachtRequest({
      app,
      context: {} as { user?: string; trace?: string },
      registry: {
        middlewareModules: {
          "./middleware/first.ts": async () => ({
            middleware: async ({ context }, next) => {
              (context as { user?: string }).user = "jovi";
              return next();
            },
          }),
          "./middleware/second.ts": async () => ({
            middleware: async ({ context }, next) => {
              (context as { trace?: string }).trace = "abc";
              observed = { ...(context as { user?: string; trace?: string }) };
              return next();
            },
          }),
        },
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "dashboard"),
          }),
        },
      },
      request: new Request("http://localhost/dashboard"),
    });

    expect(response.status).toBe(200);
    expect(observed).toEqual({ user: "jovi", trace: "abc" });
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

describe("handlePrachtRequest short-circuit Responses", () => {
  it("treats a Response thrown by a loader as the answer, not a crash", async () => {
    // `throw redirect(...)` is what makes an auth gate composable: the decision
    // can live in a helper the loader awaits, where a `return` cannot escape.
    const app = defineApp({
      routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/dashboard.tsx": async () => ({
            Component: () => h("main", null, "never rendered"),
            loader: async ({ request }: { request: Request }) => {
              throw redirect("/login", { request });
            },
          }),
        },
      },
      request: new Request("http://localhost/dashboard"),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("treats a Response thrown by an API handler as the answer", async () => {
    const app = defineApp({ routes: [route("/", "./routes/home.tsx")] });

    const response = await handlePrachtRequest({
      apiRoutes: resolveApiRoutes(["/src/api/report.ts"]),
      app,
      registry: {
        apiModules: {
          "/src/api/report.ts": async () => ({
            GET: async () => {
              throw new Response("teapot", { status: 418 });
            },
          }),
        },
      },
      request: new Request("http://localhost/api/report"),
    });

    expect(response.status).toBe(418);
    await expect(response.text()).resolves.toBe("teapot");
  });

  it("still reports a thrown Error from a loader as a 500", async () => {
    const app = defineApp({
      routes: [route("/boom", "./routes/boom.tsx", { id: "boom", render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/boom.tsx": async () => ({
            Component: () => h("main", null, "never"),
            loader: async () => {
              throw new Error("loader exploded");
            },
          }),
        },
      },
      request: new Request("http://localhost/boom"),
    });

    expect(response.status).toBe(500);
  });
});

it("delivers a thrown redirect to a client navigation as route-state JSON", async () => {
  // Client navigations fetch with `redirect: "manual"`, so a raw 302 would
  // be opaque to them. The returned-Response path already encodes redirects
  // as JSON for route-state requests; the thrown path has to match.
  const app = defineApp({
    routes: [route("/dashboard", "./routes/dashboard.tsx", { id: "dashboard", render: "ssr" })],
  });

  const response = await handlePrachtRequest({
    app,
    registry: {
      routeModules: {
        "./routes/dashboard.tsx": async () => ({
          Component: () => h("main", null, "never rendered"),
          loader: async ({ request }: { request: Request }) => {
            throw redirect("/login", { request });
          },
        }),
      },
    },
    request: new Request("http://localhost/dashboard", {
      headers: { "x-pracht-route-state-request": "1" },
    }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ redirect: "/login" });
});

it("reports a failure while delivering a thrown Response as a 500", async () => {
  // The short-circuit runs inside the catch, where a further throw would
  // reject out of handlePrachtRequest instead of becoming a response. A
  // module-scope Response with a body, thrown twice, does exactly that.
  const shared = new Response(JSON.stringify({ data: null }), { status: 401 });
  const app = defineApp({
    routes: [route("/gate", "./routes/gate.tsx", { id: "gate", render: "ssr" })],
  });
  const send = () =>
    handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/gate.tsx": async () => ({
            Component: () => h("main", null, "never"),
            loader: async () => {
              throw shared;
            },
          }),
        },
      },
      request: new Request("http://localhost/gate", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

  // The adapter reads the body out to write the response; the second
  // delivery then finds the shared body disturbed. The point is that this
  // resolves to a 500 rather than rejecting out of handlePrachtRequest.
  const first = await send();
  expect(first.status).toBe(401);
  await first.text();

  const second = await send();
  expect(second.status).toBe(500);
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

  it("includes merged font head fragments in route-state responses", async () => {
    const font = defineFont({ family: "Route Font", src: "/fonts/route.woff2" });
    const app = defineApp({
      routes: [route("/font", "./routes/font.tsx", { render: "ssr" })],
    });
    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/font.tsx": async () => ({
            Component: () => null,
            head: () => ({ fonts: [font] }),
          }),
        },
      },
      request: new Request("http://localhost/font", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    const json = (await response.json()) as Record<string, any>;
    expect(json.fontHead.css).toContain('font-family:"Route Font"');
    expect(json.fontHead.preloadLinks).toEqual(font.preloadLinks);
  });

  it("uses a route loaderCache duration for successful route-state data", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", loaderCache: 3600 })],
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
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    await expect(response.json()).resolves.toEqual({ data: { plan: "MVP" } });
  });

  it.each([false, 0] as const)("treats loaderCache %s as no-store", async (loaderCache) => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", loaderCache })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => h("main", null, "MVP"),
            loader: async () => ({ plan: "MVP" }),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves an explicit loader Response cache policy", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", loaderCache: 3600 })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => h("main", null, "MVP"),
            loader: async () =>
              Response.json(
                { data: { plan: "MVP" } },
                { headers: { "cache-control": "private, max-age=5" } },
              ),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("private, max-age=5");
  });

  it("applies a route loaderCache duration to loader Response data", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", loaderCache: 3600 })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => h("main", null, "MVP"),
            loader: async () => Response.json({ data: { plan: "MVP" } }),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    await expect(response.json()).resolves.toEqual({ data: { plan: "MVP" } });
  });

  it("keeps loader Response errors out of the route loaderCache policy", async () => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr", loaderCache: 3600 })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => h("main", null, "MVP"),
            loader: async () => Response.json({ error: { message: "nope" } }, { status: 500 }),
          }),
        },
      },
      request: new Request("http://localhost/pricing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
    });

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("treats _data=1 query parameter as a route-state request", async () => {
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
      request: new Request("http://localhost/pricing?_data=1"),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ data: { plan: "MVP" } });
  });

  it("strips _data param from the URL passed to loaders", async () => {
    let capturedUrl: URL | undefined;
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/pricing.tsx": async () => ({
            Component: () => h("main", null, "test"),
            loader: async (args: { url: URL }) => {
              capturedUrl = args.url;
              return {};
            },
          }),
        },
      },
      request: new Request("http://localhost/pricing?_data=1"),
    });

    expect(response.status).toBe(200);
    expect(capturedUrl?.searchParams.has("_data")).toBe(false);
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
            middleware: async ({ request }) => redirect("/", { request }),
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

describe("handlePrachtRequest head metadata", () => {
  it("renders JSON-LD scripts and ignores unsafe attribute names", async () => {
    const app = defineApp({
      routes: [route("/article", "./routes/article.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/article.tsx": async () => ({
            Component: () => h("main", null, "article"),
            head: () => ({
              link: [
                {
                  href: "/article",
                  onload: "alert(1)",
                  rel: "canonical",
                  'x onclick="alert(1)': "bad",
                },
              ],
              meta: [
                {
                  content: "safe",
                  name: "description",
                  "bad name": "dropped",
                },
              ],
              script: [
                {
                  children: JSON.stringify({
                    "@context": "https://schema.org",
                    headline: "</script><script>alert(1)</script>",
                  }),
                  onload: "alert(1)",
                  type: "application/ld+json",
                },
              ],
            }),
          }),
        },
      },
      request: new Request("http://localhost/article"),
    });

    const html = await response.text();
    expect(html).toContain('<meta content="safe" name="description">');
    expect(html).toContain('<link href="/article" rel="canonical">');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain("\\u003c/script\\u003e");
    expect(html).not.toContain("bad name");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onload");
    expect(html).not.toContain("</script><script>");
  });

  it("keeps head() JavaScript children with bare operators syntactically valid", async () => {
    // Untyped head() script entries are JavaScript, where `\uXXXX` escaping
    // outside string literals is a syntax error. Only HTML parser breakout
    // sequences (`</script`, `<script`, `<!--`) are neutralized.
    const source = 'window.__flags = window.a && window.b; console.log("</script>");';
    const app = defineApp({
      routes: [route("/js", "./routes/js.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/js.tsx": async () => ({
            Component: () => h("main", null, "js"),
            head: () => ({
              script: [{ children: source, id: "flags" }],
            }),
          }),
        },
      },
      request: new Request("http://localhost/js"),
    });

    const html = await response.text();
    const inner = html.match(/<script id="flags">([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(inner).toContain("window.a && window.b");
    expect(inner).toContain('console.log("</\\u0073cript>");');
    expect(() => new Function(inner)).not.toThrow();
  });
});

describe("handlePrachtRequest speculation rules", () => {
  it("emits a speculationrules script for opted-in routes", async () => {
    const app = defineApp({
      routes: [
        route("/", "./routes/home.tsx", { render: "ssr", speculation: "prefetch" }),
        route("/article/:slug", "./routes/article.tsx", {
          render: "ssr",
          speculation: "prerender",
        }),
        route("/contact", "./routes/contact.tsx", { render: "ssr" }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({ Component: () => h("main", null, "home") }),
          "./routes/article.tsx": async () => ({ Component: () => h("main", null, "article") }),
          "./routes/contact.tsx": async () => ({ Component: () => h("main", null, "contact") }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await response.text();
    const match = html.match(/<script type="speculationrules">([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();

    const rules = JSON.parse(
      (match?.[1] ?? "")
        .replace(/\\u003c/g, "<")
        .replace(/\\u003e/g, ">")
        .replace(/\\u0026/g, "&"),
    ) as Record<string, Array<{ where: { href_matches: string[] } }>>;

    expect(rules.prefetch?.[0].where.href_matches).toEqual(["/"]);
    expect(rules.prerender?.[0].where.href_matches).toEqual(["/article/:slug"]);
    // The opt-out route is not present in any rule
    const allHrefs = [...(rules.prefetch ?? []), ...(rules.prerender ?? [])].flatMap(
      (rule) => rule.where.href_matches,
    );
    expect(allHrefs).not.toContain("/contact");
  });

  it("omits the speculationrules script when no route opts in", async () => {
    const app = defineApp({
      routes: [route("/", "./routes/home.tsx", { render: "ssr" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/home.tsx": async () => ({ Component: () => h("main", null, "home") }),
        },
      },
      request: new Request("http://localhost/"),
    });

    const html = await response.text();
    expect(html).not.toContain('type="speculationrules"');
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

  it("emits a preload link for route state when an SPA route has a loader", async () => {
    const app = defineApp({
      shells: { app: "./shells/app.tsx" },
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
          }),
        },
      },
      request: new Request("http://localhost/settings"),
    });

    const html = await response.text();
    expect(html).toContain(
      '<link rel="preload" as="fetch" href="/settings?_data=1" crossorigin="anonymous">',
    );
  });

  it("does not emit a preload link for SPA routes without a loader", async () => {
    const app = defineApp({
      shells: { app: "./shells/app.tsx" },
      routes: [route("/settings", "./routes/settings.tsx", { render: "spa", shell: "app" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/settings.tsx": async () => ({
            Component: () => h("main", null, "No loader"),
          }),
        },
        shellModules: {
          "./shells/app.tsx": async () => ({
            Shell: ({ children }) => h("div", { class: "app-shell" }, children),
          }),
        },
      },
      request: new Request("http://localhost/settings"),
    });

    const html = await response.text();
    expect(html).not.toContain("preload");
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

  it("preloads the client entry's own static import closure without duplicates", async () => {
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
        "virtual:pracht/client": ["/assets/runtime-abc123.js", "/assets/vendor-abc123.js"],
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

    // The chunk the entry statically imports is preloaded even though no
    // route/shell references it — the browser would otherwise discover it
    // only after parsing the entry.
    expect(page.html).toContain('<link rel="modulepreload" href="/assets/runtime-abc123.js">');
    // Shared urls between the entry closure and route/shell chunks stay deduped.
    expect(page.html.match(/href="\/assets\/vendor-abc123\.js"/g)).toHaveLength(1);
    // The entry itself is loaded via <script src>, never preloaded.
    expect(page.html).not.toContain('<link rel="modulepreload" href="/assets/client-abc123.js">');
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
    expect(page.markdown).toBe(false);
  });

  it("records markdown support independently of user-defined Vary headers", async () => {
    const app = defineApp({
      routes: [
        route("/html", "./routes/html.tsx", { render: "ssg" }),
        route("/markdown", "./routes/markdown.tsx", { render: "ssg" }),
      ],
    });

    const pages = await prerenderApp({
      app,
      registry: {
        routeModules: {
          "/src/routes/html.tsx": async () => ({
            Component: () => h("main", null, "HTML"),
            headers: () => ({ vary: "Accept" }),
          }),
          "/src/routes/markdown.tsx": async () => ({
            Component: () => h("main", null, "Markdown"),
            markdown: "# Markdown\n",
          }),
        },
      },
    });

    expect(Object.fromEntries(pages.map((page) => [page.path, page.markdown]))).toEqual({
      "/html": false,
      "/markdown": true,
    });
  });

  it("records middleware-provided markdown declared in route metadata", async () => {
    const app = defineApp({
      routes: [
        route("/guide/:page", "./routes/guide.tsx", {
          markdown: true,
          middleware: ["markdown"],
          render: "ssg",
        }),
      ],
      middleware: { markdown: "./middleware/markdown.ts" },
    });

    const pages = await prerenderApp({
      app,
      registry: {
        middlewareModules: {
          "/src/middleware/markdown.ts": async () => ({
            middleware: (_args, next) => next(),
          }),
        },
        routeModules: {
          "/src/routes/guide.tsx": async () => ({
            Component: () => h("main", null, "Guide"),
            getStaticPaths: () => [{ page: "one" }, { page: "two" }],
          }),
        },
      },
    });

    expect(pages.map((page) => ({ markdown: page.markdown, path: page.path }))).toEqual([
      { markdown: true, path: "/guide/one" },
      { markdown: true, path: "/guide/two" },
    ]);
  });

  it.each([
    ["authorization", "Bearer secret"],
    ["proxy-authenticate", 'Basic realm="proxy"'],
    ["set-cookie", "session=abc; Path=/; HttpOnly"],
    ["www-authenticate", 'Basic realm="admin"'],
    ["x-api-key", "secret"],
  ])("rejects %s document headers on SSG pages", async (name, value) => {
    const app = defineApp({
      routes: [route("/pricing", "./routes/pricing.tsx", { render: "ssg" })],
    });

    await expect(
      prerenderApp({
        app,
        registry: {
          routeModules: {
            "/src/routes/pricing.tsx": async () => ({
              Component: () => h("main", null, "Pricing"),
              headers: () => ({ [name]: value }),
            }),
          },
        },
      }),
    ).rejects.toThrow(
      `Refusing to prerender SSG route "/pricing" because its document headers include "${name}"`,
    );
  });

  it("rejects dangerous shell document headers on ISG pages", async () => {
    const app = defineApp({
      routes: [
        route("/pricing", "./routes/pricing.tsx", {
          render: "isg",
          revalidate: timeRevalidate(60),
          shell: "public",
        }),
      ],
      shells: {
        public: "./shells/public.tsx",
      },
    });

    await expect(
      prerenderApp({
        app,
        registry: {
          routeModules: {
            "/src/routes/pricing.tsx": async () => ({
              Component: () => h("main", null, "Pricing"),
            }),
          },
          shellModules: {
            "/src/shells/public.tsx": async () => ({
              headers: () => ({ "set-cookie": "shared=1; Path=/" }),
              Shell: ({ children }) => h("section", null, children),
            }),
          },
        },
      }),
    ).rejects.toThrow(
      'Refusing to prerender ISG route "/pricing" because its document headers include "set-cookie"',
    );
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

  it("provides URLSearchParams during SSR", async () => {
    const app = defineApp({
      routes: [route("/about", "./routes/about.tsx", { render: "ssr" })],
    });

    function SearchDisplay() {
      const searchParams = useSearchParams();
      return h("span", null, `${searchParams.get("tab")}|${searchParams.getAll("tag").join(",")}`);
    }

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/about.tsx": async () => ({
            Component: () => h("main", null, h(SearchDisplay, null)),
          }),
        },
      },
      request: new Request("http://localhost/about?tab=team&tag=a&tag=b"),
    });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("team|a,b");
  });

  it("returns a read-only search params view", async () => {
    const app = defineApp({
      routes: [route("/about", "./routes/about.tsx", { render: "ssr" })],
    });
    let observedSearchParams: ReturnType<typeof useSearchParams> | undefined;

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/about.tsx": async () => ({
            Component: () => {
              observedSearchParams = useSearchParams();
              return h("main", null, observedSearchParams.get("tab"));
            },
          }),
        },
      },
      request: new Request("http://localhost/about?tab=team"),
    });

    expect(response.status).toBe(200);
    expect(observedSearchParams?.get("tab")).toBe("team");
    expect(() => (observedSearchParams as URLSearchParams).set("tab", "other")).toThrow(
      /read-only/,
    );

    type SearchParamsHasSet = "set" extends keyof ReturnType<typeof useSearchParams> ? true : false;
    const searchParamsHasSet: SearchParamsHasSet = false;
    expect(searchParamsHasSet).toBe(false);
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

  it("allows route links inside error boundaries", async () => {
    const app = defineApp({
      routes: [
        route("/", "./routes/home.tsx", { id: "home" }),
        route("/posts/:slug", "./routes/post.tsx", { id: "post" }),
      ],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: () => h(Link, { route: "home" }, "Back home"),
            loader: async () => {
              throw new PrachtHttpError(404, "Post not found");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain('<a href="/">Back home</a>');
  });

  it("renders the shell error boundary when a route boundary is absent", async () => {
    const app = defineApp({
      shells: {
        app: "./shells/app.tsx",
      },
      routes: [route("/posts/:slug", "./routes/post.tsx", { shell: "app" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            loader: async () => {
              throw new PrachtHttpError(404, "Post not found");
            },
          }),
        },
        shellModules: {
          "./shells/app.tsx": async () => ({
            ErrorBoundary: ({ error }) => h("p", null, `Shell error: ${error.message}`),
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("<section><p>Shell error: Post not found</p></section>");
  });

  it("prefers route error boundaries over shell error boundaries", async () => {
    const app = defineApp({
      shells: {
        app: "./shells/app.tsx",
      },
      routes: [route("/posts/:slug", "./routes/post.tsx", { shell: "app" })],
    });

    const response = await handlePrachtRequest({
      app,
      registry: {
        routeModules: {
          "./routes/post.tsx": async () => ({
            Component: () => h("main", null, "post"),
            ErrorBoundary: ({ error }) => h("p", null, `Route error: ${error.message}`),
            loader: async () => {
              throw new PrachtHttpError(404, "Post not found");
            },
          }),
        },
        shellModules: {
          "./shells/app.tsx": async () => ({
            ErrorBoundary: ({ error }) => h("p", null, `Shell error: ${error.message}`),
            Shell: ({ children }) => h("section", null, children),
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Route error: Post not found");
    expect(html).not.toContain("Shell error");
  });

  it("exposes debug details in plain SSR errors when no boundary is available", async () => {
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
            loader: async () => {
              throw new Error("plain debug details");
            },
          }),
        },
      },
      request: new Request("http://localhost/posts/missing"),
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("plain debug details");
    expect(body).toContain('"phase": "loader"');
    expect(body).toContain('"routeFile": "./routes/post.tsx"');
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
            middleware: async ({ context }, next) => {
              (context as { user?: string }).user = "jovi";
              return next();
            },
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
        middleware: async (
          { context }: { context: Record<string, boolean> },
          next: () => Promise<Response>,
        ) => {
          executionOrder.push(id);
          context[`${id}-ran`] = true;
          return next();
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
            middleware: async (
              _args: { context: Record<string, unknown> },
              next: () => Promise<Response>,
            ) => {
              middlewareStarted = true;
              await mwGate.promise;
              return next();
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
