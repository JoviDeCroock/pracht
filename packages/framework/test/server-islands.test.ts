import { h, type ComponentChildren } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, group, handlePrachtRequest, route, useServerIslandData } from "../src/index.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";
import {
  _resetServerIslandsForTesting,
  readServerIslandBindingsFromDevServer,
  registerServerIslandModules,
  setServerIslandBindings,
  setServerIslandsClientEntryUrl,
} from "../src/server-islands-server.ts";
import type {
  MiddlewareFn,
  ServerIslandLoaderArgs,
  RenderMode,
  HydrationMode,
} from "../src/index.ts";

afterEach(() => {
  _resetServerIslandsForTesting();
  _resetIslandsForTesting();
});

interface VisitorContext {
  visitor?: string;
}

const SERVER_ISLANDS_ENTRY = "/assets/server-islands-client-test.js";

function Visitor({ greeting }: { greeting: string }) {
  const data = useServerIslandData<{ visitor: string | null }>();
  return h("p", { class: "visitor" }, data.visitor ? `${greeting}, ${data.visitor}` : "Signed out");
}

function Counter({ start = 0 }: { start?: number }) {
  return h("button", null, `Count: ${start}`);
}

function readVisitorCookie(request: Request): string | undefined {
  return /(?:^|;\s*)visitor=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
}

// Reads the cookie into context, the way a session middleware would.
const visitorMiddleware: MiddlewareFn<VisitorContext> = ({ request, context }, next) => {
  const visitor = readVisitorCookie(request);
  if (visitor) context.visitor = visitor;
  return next();
};

interface Setup {
  loader?: (args: ServerIslandLoaderArgs<VisitorContext, { greeting: string }>) => unknown;
  middleware?: MiddlewareFn<VisitorContext>;
  withIsland?: boolean;
}

function registerVisitorServerIsland(setup: Setup = {}) {
  const loader = vi.fn(
    setup.loader ??
      (({ context }: ServerIslandLoaderArgs<VisitorContext>) => ({
        visitor: context.visitor ?? null,
      })),
  );
  function ServerIsland(props: { greeting: string }) {
    return setup.withIsland
      ? h("div", null, h(Visitor, props), h(Counter, { start: 3 }))
      : h(Visitor, props);
  }
  registerServerIslandModules({
    "/src/server-islands/Visitor.tsx": { default: ServerIsland, loader },
  });
  setServerIslandsClientEntryUrl(SERVER_ISLANDS_ENTRY);
  // Both routes of `createApp()` render `./routes/page.tsx`, which renders it.
  setServerIslandBindings({ "./routes/page.tsx": ["/src/server-islands/Visitor.tsx"] });
  return { ServerIsland, loader };
}

function createApp(render: RenderMode, hydration?: HydrationMode) {
  return defineApp({
    middleware: { visitor: "./middleware/visitor.ts" },
    routes: [
      group({ middleware: ["visitor"] }, [
        route("/products/:id", "./routes/page.tsx", {
          render,
          ...(hydration ? { hydration } : {}),
        }),
      ]),
      route("/public", "./routes/page.tsx", { render: "ssr" }),
    ],
  });
}

function createRegistry(Component: () => ComponentChildren, middleware = visitorMiddleware) {
  return {
    routeModules: {
      "./routes/page.tsx": async () => ({ Component }),
    },
    middlewareModules: {
      "./middleware/visitor.ts": async () => ({ middleware }),
    },
  };
}

function serverIslandRequest(
  params: Record<string, string>,
  headers: Record<string, string> = { "x-pracht-server-island": "1" },
): Request {
  const query = new URLSearchParams(params);
  return new Request(`http://localhost/__pracht/server-island?${query}`, { headers });
}

describe("server island rendering in documents", () => {
  it("emits a pending placeholder with the fallback and the swap script on cached pages", async () => {
    const { ServerIsland, loader } = registerVisitorServerIsland();
    const Page = () =>
      h("main", null, h(ServerIsland as never, { greeting: "Hi", fallback: h("i", null, "…") }));

    const response = await handlePrachtRequest({
      app: createApp("ssg", "none"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7", { headers: { cookie: "visitor=Ada" } }),
    });
    const html = await response.text();

    expect(html).toContain(
      '<pracht-server-island island="/src/server-islands/Visitor.tsx" style="display:contents" ' +
        'props="{&quot;greeting&quot;:&quot;Hi&quot;}" pending><i>…</i></pracht-server-island>',
    );
    expect(html).toContain(`<script type="module" src="${SERVER_ISLANDS_ENTRY}"></script>`);
    // The shared document never runs the server island, and never sees the visitor.
    expect(loader).not.toHaveBeenCalled();
    expect(html).not.toContain("Ada");
  });

  it("adds nothing to a page that renders no server island", async () => {
    registerVisitorServerIsland();

    const response = await handlePrachtRequest({
      app: createApp("ssg", "none"),
      registry: createRegistry(() => h("main", null, "plain")),
      request: new Request("http://localhost/products/7"),
    });
    const html = await response.text();

    expect(html).not.toContain("pracht-server-island");
    expect(html).not.toContain("<script");
  });

  it("renders the server island inline on SSR pages with the page's middleware context", async () => {
    const { ServerIsland, loader } = registerVisitorServerIsland();
    const Page = () => h("main", null, h(ServerIsland as never, { greeting: "Welcome back" }));

    const response = await handlePrachtRequest({
      app: createApp("ssr", "none"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7", { headers: { cookie: "visitor=Ada" } }),
    });
    const html = await response.text();

    expect(html).toContain(
      '<pracht-server-island island="/src/server-islands/Visitor.tsx" style="display:contents" ' +
        'props="{&quot;greeting&quot;:&quot;Welcome back&quot;}"><p class="visitor">Welcome back, Ada</p></pracht-server-island>',
    );
    expect(html).not.toContain("pending");
    expect(html).not.toContain(SERVER_ISLANDS_ENTRY);
    expect(loader).toHaveBeenCalledOnce();
    const args = loader.mock.calls[0][0];
    expect(args.props).toEqual({ greeting: "Welcome back" });
    expect(args.params).toEqual({ id: "7" });
    expect(args.url.pathname).toBe("/products/7");
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("renders the fallback and reports when an inline server island fails", async () => {
    const { ServerIsland } = registerVisitorServerIsland({
      loader: () => {
        throw new Error("server island exploded");
      },
    });
    const Page = () =>
      h(
        "main",
        null,
        h("h1", null, "Page"),
        h(ServerIsland as never, { greeting: "Hi", fallback: "later" }),
      );
    const onRouteError = vi.fn();

    const response = await handlePrachtRequest({
      app: createApp("ssr"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7"),
      onRouteError,
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("<h1>Page</h1>");
    expect(html).toContain(
      'props="{&quot;greeting&quot;:&quot;Hi&quot;}">later</pracht-server-island>',
    );
    expect(onRouteError).toHaveBeenCalledOnce();
    expect(onRouteError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onRouteError.mock.calls[0][2]).toMatchObject({
      phase: "render",
      serverIslandFile: "/src/server-islands/Visitor.tsx",
    });
  });

  it("captures islands inside an inline server island on islands pages", async () => {
    registerServerIslands({ "/src/islands/Counter.tsx": { default: Counter } });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
    const { ServerIsland } = registerVisitorServerIsland({ withIsland: true });
    const Page = () => h("main", null, h(ServerIsland as never, { greeting: "Hi" }));

    const response = await handlePrachtRequest({
      app: createApp("ssr", "islands"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7"),
    });
    const html = await response.text();

    expect(html).toContain('<pracht-island island="/src/islands/Counter.tsx"');
    expect(html).toContain('<script type="module" src="/assets/islands-client-test.js"></script>');
  });

  it("leaves the swap script to the client runtime on full-hydration pages", async () => {
    const { ServerIsland } = registerVisitorServerIsland();
    const Page = () => h(ServerIsland as never, { greeting: "Hi" });

    const response = await handlePrachtRequest({
      app: createApp("ssg"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7"),
      clientEntryUrl: "/assets/client.js",
    });
    const html = await response.text();

    expect(html).toContain("pending></pracht-server-island>");
    expect(html).not.toContain(SERVER_ISLANDS_ENTRY);
  });

  it("rejects children and non-serializable props", async () => {
    const { ServerIsland } = registerVisitorServerIsland();

    const withChildren = await handlePrachtRequest({
      app: createApp("ssr"),
      registry: createRegistry(() =>
        h(ServerIsland as never, { greeting: "Hi" }, h("b", null, "x")),
      ),
      request: new Request("http://localhost/products/7"),
      debugErrors: true,
      onRouteError: () => {},
    });
    expect(withChildren.status).toBe(500);
    expect(await withChildren.text()).toContain("received children");

    const withFunction = await handlePrachtRequest({
      app: createApp("ssr"),
      registry: createRegistry(() =>
        h(ServerIsland as never, { greeting: "Hi", onClick: () => {} }),
      ),
      request: new Request("http://localhost/products/7"),
      debugErrors: true,
      onRouteError: () => {},
    });
    expect(withFunction.status).toBe(500);
    expect(await withFunction.text()).toContain(
      'Server island "Visitor" (/src/server-islands/Visitor.tsx) received a prop that is not JSON-serializable: props.onClick is a function',
    );
  });
});

describe("server island endpoint", () => {
  const params = {
    island: "/src/server-islands/Visitor.tsx",
    path: "/products/7?ref=home",
    props: JSON.stringify({ greeting: "Hi" }),
  };

  async function request(req: Request, setup: Setup = {}, render: RenderMode = "ssg") {
    const registered = registerVisitorServerIsland(setup);
    const onRouteError = vi.fn();
    const response = await handlePrachtRequest({
      app: createApp(render, setup.withIsland ? "islands" : undefined),
      registry: createRegistry(() => null, setup.middleware),
      request: req,
      onRouteError,
    });
    return { response, onRouteError, ...registered };
  }

  it("runs the page route's middleware, then the loader, and answers private HTML", async () => {
    const { response, loader } = await request(
      serverIslandRequest(params, { "x-pracht-server-island": "1", cookie: "visitor=Ada" }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<p class="visitor">Hi, Ada</p>');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const args = loader.mock.calls[0][0];
    // The loader sees the page it renders for, with the visitor's cookies.
    expect(args.url.href).toBe("http://localhost/products/7?ref=home");
    expect(args.request.url).toBe("http://localhost/products/7?ref=home");
    expect(args.request.headers.get("cookie")).toBe("visitor=Ada");
    expect(args.params).toEqual({ id: "7" });
    expect(args.context).toEqual({ visitor: "Ada" });
    expect(args.props).toEqual({ greeting: "Hi" });
  });

  it("keeps no-store even when middleware marks the response cacheable", async () => {
    const { response } = await request(serverIslandRequest(params), {
      middleware: async (_args, next) => {
        const res = await next();
        res.headers.set("cache-control", "public, max-age=3600");
        return res;
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("answers 204 when middleware short-circuits, so the page keeps its fallback", async () => {
    const { response, loader } = await request(serverIslandRequest(params), {
      middleware: () => new Response(null, { status: 302, headers: { location: "/login" } }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("answers 204 when the loader returns a Response", async () => {
    const { response } = await request(serverIslandRequest(params), {
      loader: () => new Response("nope", { status: 401 }),
    });

    expect(response.status).toBe(204);
  });

  it("reports a failing loader and answers 500", async () => {
    const { response, onRouteError } = await request(serverIslandRequest(params), {
      loader: () => {
        throw new Error("boom");
      },
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(onRouteError).toHaveBeenCalledOnce();
    expect(onRouteError.mock.calls[0][1]).toBe("/products/7?ref=home");
    expect(onRouteError.mock.calls[0][2]).toMatchObject({
      phase: "loader",
      serverIslandFile: "/src/server-islands/Visitor.tsx",
      routePath: "/products/:id",
    });
  });

  it("tells the swap script to load the islands bootstrap on islands pages", async () => {
    registerServerIslands({ "/src/islands/Counter.tsx": { default: Counter } });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
    const { response } = await request(serverIslandRequest(params), { withIsland: true });

    expect(response.headers.get("x-pracht-islands")).toBe("/assets/islands-client-test.js");
    expect(await response.text()).toContain('<pracht-island island="/src/islands/Counter.tsx"');
  });

  it("rejects requests a page script would never send", async () => {
    const cases: Array<[Request, number]> = [
      [serverIslandRequest(params, {}), 400],
      [serverIslandRequest({ ...params, island: "/src/server-islands/Missing.tsx" }), 404],
      [serverIslandRequest({ ...params, props: "[1]" }), 400],
      [serverIslandRequest({ ...params, props: "{not json" }), 400],
      [serverIslandRequest({ ...params, props: JSON.stringify({ pad: "x".repeat(5000) }) }), 413],
      [serverIslandRequest({ ...params, path: "//evil.example/products/7" }), 400],
      [serverIslandRequest({ ...params, path: "https://evil.example/" }), 400],
      [serverIslandRequest({ ...params, path: "/\t/evil.example/products/7" }), 400],
      [serverIslandRequest({ ...params, path: "/nowhere" }), 404],
      [
        new Request(`http://localhost/__pracht/server-island?${new URLSearchParams(params)}`, {
          method: "POST",
          headers: { "x-pracht-server-island": "1" },
        }),
        405,
      ],
    ];

    for (const [req, status] of cases) {
      const { response, loader } = await request(req);
      expect({ url: req.url, status: response.status }).toEqual({ url: req.url, status });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(loader).not.toHaveBeenCalled();
      _resetServerIslandsForTesting();
    }
  });

  it("is not an endpoint at all in an app without server islands", async () => {
    const response = await handlePrachtRequest({
      app: createApp("ssg"),
      registry: createRegistry(() => null),
      request: serverIslandRequest(params),
    });

    // The app's own not-found answer, not the endpoint's "Unknown server island".
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/island/i);
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("runs the middleware of the route the path names when that route renders the server island", async () => {
    // `/public` renders the same page module without the `visitor` middleware.
    // Its server island answers exactly what the page would have rendered inline.
    const { response } = await request(
      serverIslandRequest(
        { ...params, path: "/public" },
        { "x-pracht-server-island": "1", cookie: "visitor=Ada" },
      ),
    );

    expect(await response.text()).toBe('<p class="visitor">Signed out</p>');
  });
});

describe("server island endpoint route binding", () => {
  const ADMIN_STATS = "/src/server-islands/AdminStats.tsx";
  const ORG_DATA = "/src/server-islands/OrgData.tsx";
  const CART = "/src/server-islands/Cart.tsx";

  // Registry keys are what `import.meta.glob` produces; the manifest names
  // modules relative to it, and the runtime resolves one to the other.
  const BINDINGS = {
    "/src/routes/admin.tsx": [ADMIN_STATS],
    "/src/routes/org.tsx": [ORG_DATA],
    "/src/shells/site.tsx": [CART],
  };

  const hasCookie = (request: Request, pattern: RegExp) =>
    pattern.test(request.headers.get("cookie") ?? "");
  const redirectHome = () => new Response(null, { status: 302, headers: { location: "/" } });

  function setup(
    bindings: Parameters<typeof setServerIslandBindings>[0] | "dev" | null = BINDINGS,
  ) {
    const loaders = {
      adminStats: vi.fn(() => ({ revenue: "SECRET-REVENUE" })),
      orgData: vi.fn(({ params }: ServerIslandLoaderArgs) => ({ secret: `org-${params.org}` })),
      cart: vi.fn(() => ({ count: 3 })),
    };
    const middleware = {
      admin: vi.fn<MiddlewareFn>(({ request }, next) =>
        hasCookie(request, /role=admin/) ? next() : redirectHome(),
      ),
      org: vi.fn<MiddlewareFn>(({ request, params }, next) =>
        hasCookie(request, new RegExp(`org=${params.org}(;|$)`)) ? next() : redirectHome(),
      ),
    };
    function AdminStats() {
      return h("p", null, useServerIslandData<{ revenue: string }>().revenue);
    }
    function OrgData() {
      return h("p", null, useServerIslandData<{ secret: string }>().secret);
    }
    function Cart() {
      return h("p", null, `Cart (${useServerIslandData<{ count: number }>().count})`);
    }
    registerServerIslandModules({
      [ADMIN_STATS]: { default: AdminStats, loader: loaders.adminStats },
      [ORG_DATA]: { default: OrgData, loader: loaders.orgData },
      [CART]: { default: Cart, loader: loaders.cart },
    });
    if (bindings === "dev") readServerIslandBindingsFromDevServer();
    else if (bindings !== null) setServerIslandBindings(bindings);

    const app = defineApp({
      shells: { site: "./shells/site.tsx", plain: "./shells/plain.tsx" },
      middleware: { admin: "./middleware/admin.ts", org: "./middleware/org.ts" },
      routes: [
        route("/admin", "./routes/admin.tsx", { render: "ssg", middleware: ["admin"] }),
        route("/static", "./routes/static.tsx", { render: "ssg" }),
        route("/org/:org/dash", "./routes/org.tsx", { render: "ssg", middleware: ["org"] }),
        route("/invite/:org", "./routes/invite.tsx", { render: "ssg" }),
        // One page module under two shells: only the `site` shell renders Cart.
        group({ shell: "site" }, [route("/news", "./routes/news.tsx", { render: "ssg" })]),
        group({ shell: "plain" }, [route("/plain-news", "./routes/news.tsx", { render: "ssg" })]),
      ],
    });
    const page = async () => ({ Component: () => null });
    const shell = async () => ({
      Shell: ({ children }: { children: ComponentChildren }) => children,
    });
    const registry = {
      routeModules: Object.fromEntries(
        ["admin", "static", "org", "invite", "news"].map((name) => [
          `/src/routes/${name}.tsx`,
          page,
        ]),
      ),
      shellModules: { "/src/shells/site.tsx": shell, "/src/shells/plain.tsx": shell },
      middlewareModules: {
        "/src/middleware/admin.ts": async () => ({ middleware: middleware.admin }),
        "/src/middleware/org.ts": async () => ({ middleware: middleware.org }),
      },
    };
    const send = (query: Record<string, string>, headers: Record<string, string> = {}) =>
      handlePrachtRequest({
        app,
        registry,
        request: serverIslandRequest(query, { "x-pracht-server-island": "1", ...headers }),
      });
    return { loaders, middleware, send };
  }

  async function snapshot(response: Response) {
    const headers = Object.fromEntries(response.headers);
    delete headers.date;
    return { status: response.status, body: await response.text(), headers };
  }

  it("refuses a gated page's server island under a route that does not render it", async () => {
    // The exploit: AdminStats is rendered only on /admin, behind `admin`
    // middleware, and its loader does no check of its own.
    const { loaders, middleware, send } = setup();

    const refused = await send({ island: ADMIN_STATS, path: "/static" });
    const unknown = await send({ island: "/src/server-islands/Nope.tsx", path: "/static" });

    expect(refused.status).toBe(404);
    // Identical to a server island that does not exist: nothing to probe for.
    expect(await snapshot(refused)).toEqual(await snapshot(unknown));
    expect(loaders.adminStats).not.toHaveBeenCalled();
    expect(middleware.admin).not.toHaveBeenCalled();
  });

  it("runs a bound server island behind its own route's middleware", async () => {
    const { loaders, send } = setup();

    const anonymous = await send({ island: ADMIN_STATS, path: "/admin" });
    expect(anonymous.status).toBe(204);
    expect(loaders.adminStats).not.toHaveBeenCalled();

    const admin = await send({ island: ADMIN_STATS, path: "/admin" }, { cookie: "role=admin" });
    expect(admin.status).toBe(200);
    expect(await admin.text()).toBe("<p>SECRET-REVENUE</p>");
  });

  it("never hands a server island params from a route that does not render it", async () => {
    // OrgData trusts `params.org` because /org/:org/dash checks membership;
    // /invite/:org has the same param and no such check.
    const { loaders, send } = setup();

    const viaInvite = await send({ island: ORG_DATA, path: "/invite/victim" });
    expect(viaInvite.status).toBe(404);

    const viaDash = await send(
      { island: ORG_DATA, path: "/org/victim/dash" },
      { cookie: "org=mine" },
    );
    expect(viaDash.status).toBe(204);
    expect(loaders.orgData).not.toHaveBeenCalled();

    const member = await send({ island: ORG_DATA, path: "/org/mine/dash" }, { cookie: "org=mine" });
    expect(await member.text()).toBe("<p>org-mine</p>");
  });

  it("binds a shell's server island to the routes using that shell only", async () => {
    const { send } = setup();

    expect((await send({ island: CART, path: "/news" })).status).toBe(200);
    // The same page module under a shell that does not render Cart.
    expect((await send({ island: CART, path: "/plain-news" })).status).toBe(404);
    expect((await send({ island: CART, path: "/static" })).status).toBe(404);
  });

  it("refuses every server island when no bindings were installed or they do not parse", async () => {
    for (const bindings of [
      null,
      "not json",
      "__PRACHT_SERVER_ISLAND_BINDINGS__",
      "[]",
      '{"a":1}',
    ]) {
      const { loaders, send } = setup(bindings);
      const response = await send({ island: CART, path: "/news" });
      expect({ bindings, status: response.status }).toEqual({ bindings, status: 404 });
      expect(loaders.cart).not.toHaveBeenCalled();
      _resetServerIslandsForTesting();
    }
  });

  it("gives an unknown and an unbound server island the same answer for every malformed request", async () => {
    const { send } = setup();
    const malformed: Array<Record<string, string>> = [
      { path: "/static", props: "[1]" },
      { path: "/static", props: JSON.stringify({ pad: "x".repeat(5000) }) },
      { path: "//evil.example/admin" },
      { path: "/nowhere" },
    ];

    for (const query of malformed) {
      const known = await snapshot(await send({ ...query, island: ADMIN_STATS }));
      const unknown = await snapshot(
        await send({ ...query, island: "/src/server-islands/Nope.tsx" }),
      );
      expect(known).toEqual(unknown);
    }
  });

  it("ignores a client-sent development bindings header in a built app", async () => {
    const { loaders, send } = setup();

    const response = await send(
      { island: ADMIN_STATS, path: "/static" },
      {
        "x-pracht-dev-server-island-bindings": JSON.stringify({
          "/src/routes/static.tsx": [ADMIN_STATS],
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(loaders.adminStats).not.toHaveBeenCalled();
  });

  it("reads development bindings from the dev server's header, and nothing else", async () => {
    const { loaders, middleware, send } = setup("dev");
    const header = (bindings: object) => ({
      "x-pracht-dev-server-island-bindings": JSON.stringify(bindings),
      cookie: "role=admin",
    });

    expect(
      (await send({ island: ADMIN_STATS, path: "/admin" }, { cookie: "role=admin" })).status,
    ).toBe(404);
    expect(
      (
        await send(
          { island: ADMIN_STATS, path: "/admin" },
          header({ "/src/routes/static.tsx": [ADMIN_STATS] }),
        )
      ).status,
    ).toBe(404);

    const bound = await send({ island: ADMIN_STATS, path: "/admin" }, header(BINDINGS));
    expect(bound.status).toBe(200);
    // Middleware and the loader never see the header.
    const [args] = middleware.admin.mock.calls[0]!;
    expect(args.request.headers.has("x-pracht-dev-server-island-bindings")).toBe(false);
    expect(loaders.adminStats).toHaveBeenCalledOnce();
  });
});
