import { h, type ComponentChildren } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineApp, group, handlePrachtRequest, route, useRegionData } from "../src/index.ts";
import {
  _resetIslandsForTesting,
  registerServerIslands,
  setIslandsClientEntryUrl,
} from "../src/islands-server.ts";
import {
  _resetRegionsForTesting,
  readRegionBindingsFromDevServer,
  registerServerRegions,
  setRegionBindings,
  setRegionsClientEntryUrl,
} from "../src/regions-server.ts";
import type { MiddlewareFn, RegionLoaderArgs, RenderMode, HydrationMode } from "../src/index.ts";

afterEach(() => {
  _resetRegionsForTesting();
  _resetIslandsForTesting();
});

interface VisitorContext {
  visitor?: string;
}

const REGIONS_ENTRY = "/assets/regions-client-test.js";

function Visitor({ greeting }: { greeting: string }) {
  const data = useRegionData<{ visitor: string | null }>();
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
  loader?: (args: RegionLoaderArgs<VisitorContext, { greeting: string }>) => unknown;
  middleware?: MiddlewareFn<VisitorContext>;
  withIsland?: boolean;
}

function registerVisitorRegion(setup: Setup = {}) {
  const loader = vi.fn(
    setup.loader ??
      (({ context }: RegionLoaderArgs<VisitorContext>) => ({ visitor: context.visitor ?? null })),
  );
  function Region(props: { greeting: string }) {
    return setup.withIsland
      ? h("div", null, h(Visitor, props), h(Counter, { start: 3 }))
      : h(Visitor, props);
  }
  registerServerRegions({ "/src/regions/Visitor.tsx": { default: Region, loader } });
  setRegionsClientEntryUrl(REGIONS_ENTRY);
  // Both routes of `createApp()` render `./routes/page.tsx`, which renders it.
  setRegionBindings({ "./routes/page.tsx": ["/src/regions/Visitor.tsx"] });
  return { Region, loader };
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

function regionRequest(
  params: Record<string, string>,
  headers: Record<string, string> = { "x-pracht-region": "1" },
): Request {
  const query = new URLSearchParams(params);
  return new Request(`http://localhost/__pracht/region?${query}`, { headers });
}

describe("region rendering in documents", () => {
  it("emits a pending placeholder with the fallback and the swap script on cached pages", async () => {
    const { Region, loader } = registerVisitorRegion();
    const Page = () =>
      h("main", null, h(Region as never, { greeting: "Hi", fallback: h("i", null, "…") }));

    const response = await handlePrachtRequest({
      app: createApp("ssg", "none"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7", { headers: { cookie: "visitor=Ada" } }),
    });
    const html = await response.text();

    expect(html).toContain(
      '<pracht-region region="/src/regions/Visitor.tsx" style="display:contents" ' +
        'props="{&quot;greeting&quot;:&quot;Hi&quot;}" pending><i>…</i></pracht-region>',
    );
    expect(html).toContain(`<script type="module" src="${REGIONS_ENTRY}"></script>`);
    // The shared document never runs the region, and never sees the visitor.
    expect(loader).not.toHaveBeenCalled();
    expect(html).not.toContain("Ada");
  });

  it("adds nothing to a page that renders no region", async () => {
    registerVisitorRegion();

    const response = await handlePrachtRequest({
      app: createApp("ssg", "none"),
      registry: createRegistry(() => h("main", null, "plain")),
      request: new Request("http://localhost/products/7"),
    });
    const html = await response.text();

    expect(html).not.toContain("pracht-region");
    expect(html).not.toContain("<script");
  });

  it("renders the region inline on SSR pages with the page's middleware context", async () => {
    const { Region, loader } = registerVisitorRegion();
    const Page = () => h("main", null, h(Region as never, { greeting: "Welcome back" }));

    const response = await handlePrachtRequest({
      app: createApp("ssr", "none"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7", { headers: { cookie: "visitor=Ada" } }),
    });
    const html = await response.text();

    expect(html).toContain(
      '<pracht-region region="/src/regions/Visitor.tsx" style="display:contents" ' +
        'props="{&quot;greeting&quot;:&quot;Welcome back&quot;}"><p class="visitor">Welcome back, Ada</p></pracht-region>',
    );
    expect(html).not.toContain("pending");
    expect(html).not.toContain(REGIONS_ENTRY);
    expect(loader).toHaveBeenCalledOnce();
    const args = loader.mock.calls[0][0];
    expect(args.props).toEqual({ greeting: "Welcome back" });
    expect(args.params).toEqual({ id: "7" });
    expect(args.url.pathname).toBe("/products/7");
    expect(args.signal).toBeInstanceOf(AbortSignal);
  });

  it("renders the fallback and reports when an inline region fails", async () => {
    const { Region } = registerVisitorRegion({
      loader: () => {
        throw new Error("region exploded");
      },
    });
    const Page = () =>
      h(
        "main",
        null,
        h("h1", null, "Page"),
        h(Region as never, { greeting: "Hi", fallback: "later" }),
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
    expect(html).toContain('props="{&quot;greeting&quot;:&quot;Hi&quot;}">later</pracht-region>');
    expect(onRouteError).toHaveBeenCalledOnce();
    expect(onRouteError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onRouteError.mock.calls[0][2]).toMatchObject({
      phase: "render",
      regionFile: "/src/regions/Visitor.tsx",
    });
  });

  it("captures islands inside an inline region on islands pages", async () => {
    registerServerIslands({ "/src/islands/Counter.tsx": { default: Counter } });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
    const { Region } = registerVisitorRegion({ withIsland: true });
    const Page = () => h("main", null, h(Region as never, { greeting: "Hi" }));

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
    const { Region } = registerVisitorRegion();
    const Page = () => h(Region as never, { greeting: "Hi" });

    const response = await handlePrachtRequest({
      app: createApp("ssg"),
      registry: createRegistry(Page),
      request: new Request("http://localhost/products/7"),
      clientEntryUrl: "/assets/client.js",
    });
    const html = await response.text();

    expect(html).toContain("pending></pracht-region>");
    expect(html).not.toContain(REGIONS_ENTRY);
  });

  it("rejects children and non-serializable props", async () => {
    const { Region } = registerVisitorRegion();

    const withChildren = await handlePrachtRequest({
      app: createApp("ssr"),
      registry: createRegistry(() => h(Region as never, { greeting: "Hi" }, h("b", null, "x"))),
      request: new Request("http://localhost/products/7"),
      debugErrors: true,
      onRouteError: () => {},
    });
    expect(withChildren.status).toBe(500);
    expect(await withChildren.text()).toContain("received children");

    const withFunction = await handlePrachtRequest({
      app: createApp("ssr"),
      registry: createRegistry(() => h(Region as never, { greeting: "Hi", onClick: () => {} })),
      request: new Request("http://localhost/products/7"),
      debugErrors: true,
      onRouteError: () => {},
    });
    expect(withFunction.status).toBe(500);
    expect(await withFunction.text()).toContain(
      'Region "Visitor" (/src/regions/Visitor.tsx) received a prop that is not JSON-serializable: props.onClick is a function',
    );
  });
});

describe("region endpoint", () => {
  const params = {
    region: "/src/regions/Visitor.tsx",
    path: "/products/7?ref=home",
    props: JSON.stringify({ greeting: "Hi" }),
  };

  async function request(req: Request, setup: Setup = {}, render: RenderMode = "ssg") {
    const registered = registerVisitorRegion(setup);
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
      regionRequest(params, { "x-pracht-region": "1", cookie: "visitor=Ada" }),
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
    const { response } = await request(regionRequest(params), {
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
    const { response, loader } = await request(regionRequest(params), {
      middleware: () => new Response(null, { status: 302, headers: { location: "/login" } }),
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("location")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("answers 204 when the loader returns a Response", async () => {
    const { response } = await request(regionRequest(params), {
      loader: () => new Response("nope", { status: 401 }),
    });

    expect(response.status).toBe(204);
  });

  it("reports a failing loader and answers 500", async () => {
    const { response, onRouteError } = await request(regionRequest(params), {
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
      regionFile: "/src/regions/Visitor.tsx",
      routePath: "/products/:id",
    });
  });

  it("tells the swap script to load the islands bootstrap on islands pages", async () => {
    registerServerIslands({ "/src/islands/Counter.tsx": { default: Counter } });
    setIslandsClientEntryUrl("/assets/islands-client-test.js");
    const { response } = await request(regionRequest(params), { withIsland: true });

    expect(response.headers.get("x-pracht-islands")).toBe("/assets/islands-client-test.js");
    expect(await response.text()).toContain('<pracht-island island="/src/islands/Counter.tsx"');
  });

  it("rejects requests a page script would never send", async () => {
    const cases: Array<[Request, number]> = [
      [regionRequest(params, {}), 400],
      [regionRequest({ ...params, region: "/src/regions/Missing.tsx" }), 404],
      [regionRequest({ ...params, props: "[1]" }), 400],
      [regionRequest({ ...params, props: "{not json" }), 400],
      [regionRequest({ ...params, props: JSON.stringify({ pad: "x".repeat(5000) }) }), 413],
      [regionRequest({ ...params, path: "//evil.example/products/7" }), 400],
      [regionRequest({ ...params, path: "https://evil.example/" }), 400],
      [regionRequest({ ...params, path: "/\t/evil.example/products/7" }), 400],
      [regionRequest({ ...params, path: "/nowhere" }), 404],
      [
        new Request(`http://localhost/__pracht/region?${new URLSearchParams(params)}`, {
          method: "POST",
          headers: { "x-pracht-region": "1" },
        }),
        405,
      ],
    ];

    for (const [req, status] of cases) {
      const { response, loader } = await request(req);
      expect({ url: req.url, status: response.status }).toEqual({ url: req.url, status });
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(loader).not.toHaveBeenCalled();
      _resetRegionsForTesting();
    }
  });

  it("is not an endpoint at all in an app without regions", async () => {
    const response = await handlePrachtRequest({
      app: createApp("ssg"),
      registry: createRegistry(() => null),
      request: regionRequest(params),
    });

    // The app's own not-found answer, not the endpoint's "Unknown region".
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/region/i);
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("runs the middleware of the route the path names when that route renders the region", async () => {
    // `/public` renders the same page module without the `visitor` middleware.
    // Its region answers exactly what the page would have rendered inline.
    const { response } = await request(
      regionRequest(
        { ...params, path: "/public" },
        { "x-pracht-region": "1", cookie: "visitor=Ada" },
      ),
    );

    expect(await response.text()).toBe('<p class="visitor">Signed out</p>');
  });
});

describe("region endpoint route binding", () => {
  const ADMIN_STATS = "/src/regions/AdminStats.tsx";
  const ORG_DATA = "/src/regions/OrgData.tsx";
  const CART = "/src/regions/Cart.tsx";

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

  function setup(bindings: Parameters<typeof setRegionBindings>[0] | "dev" | null = BINDINGS) {
    const loaders = {
      adminStats: vi.fn(() => ({ revenue: "SECRET-REVENUE" })),
      orgData: vi.fn(({ params }: RegionLoaderArgs) => ({ secret: `org-${params.org}` })),
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
      return h("p", null, useRegionData<{ revenue: string }>().revenue);
    }
    function OrgData() {
      return h("p", null, useRegionData<{ secret: string }>().secret);
    }
    function Cart() {
      return h("p", null, `Cart (${useRegionData<{ count: number }>().count})`);
    }
    registerServerRegions({
      [ADMIN_STATS]: { default: AdminStats, loader: loaders.adminStats },
      [ORG_DATA]: { default: OrgData, loader: loaders.orgData },
      [CART]: { default: Cart, loader: loaders.cart },
    });
    if (bindings === "dev") readRegionBindingsFromDevServer();
    else if (bindings !== null) setRegionBindings(bindings);

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
        request: regionRequest(query, { "x-pracht-region": "1", ...headers }),
      });
    return { loaders, middleware, send };
  }

  async function snapshot(response: Response) {
    const headers = Object.fromEntries(response.headers);
    delete headers.date;
    return { status: response.status, body: await response.text(), headers };
  }

  it("refuses a gated page's region under a route that does not render it", async () => {
    // The exploit: AdminStats is rendered only on /admin, behind `admin`
    // middleware, and its loader does no check of its own.
    const { loaders, middleware, send } = setup();

    const refused = await send({ region: ADMIN_STATS, path: "/static" });
    const unknown = await send({ region: "/src/regions/Nope.tsx", path: "/static" });

    expect(refused.status).toBe(404);
    // Identical to a region that does not exist: nothing to probe for.
    expect(await snapshot(refused)).toEqual(await snapshot(unknown));
    expect(loaders.adminStats).not.toHaveBeenCalled();
    expect(middleware.admin).not.toHaveBeenCalled();
  });

  it("runs a bound region behind its own route's middleware", async () => {
    const { loaders, send } = setup();

    const anonymous = await send({ region: ADMIN_STATS, path: "/admin" });
    expect(anonymous.status).toBe(204);
    expect(loaders.adminStats).not.toHaveBeenCalled();

    const admin = await send({ region: ADMIN_STATS, path: "/admin" }, { cookie: "role=admin" });
    expect(admin.status).toBe(200);
    expect(await admin.text()).toBe("<p>SECRET-REVENUE</p>");
  });

  it("never hands a region params from a route that does not render it", async () => {
    // OrgData trusts `params.org` because /org/:org/dash checks membership;
    // /invite/:org has the same param and no such check.
    const { loaders, send } = setup();

    const viaInvite = await send({ region: ORG_DATA, path: "/invite/victim" });
    expect(viaInvite.status).toBe(404);

    const viaDash = await send(
      { region: ORG_DATA, path: "/org/victim/dash" },
      { cookie: "org=mine" },
    );
    expect(viaDash.status).toBe(204);
    expect(loaders.orgData).not.toHaveBeenCalled();

    const member = await send({ region: ORG_DATA, path: "/org/mine/dash" }, { cookie: "org=mine" });
    expect(await member.text()).toBe("<p>org-mine</p>");
  });

  it("binds a shell's region to the routes using that shell only", async () => {
    const { send } = setup();

    expect((await send({ region: CART, path: "/news" })).status).toBe(200);
    // The same page module under a shell that does not render Cart.
    expect((await send({ region: CART, path: "/plain-news" })).status).toBe(404);
    expect((await send({ region: CART, path: "/static" })).status).toBe(404);
  });

  it("refuses every region when no bindings were installed or they do not parse", async () => {
    for (const bindings of [null, "not json", "__PRACHT_REGION_BINDINGS__", "[]", '{"a":1}']) {
      const { loaders, send } = setup(bindings);
      const response = await send({ region: CART, path: "/news" });
      expect({ bindings, status: response.status }).toEqual({ bindings, status: 404 });
      expect(loaders.cart).not.toHaveBeenCalled();
      _resetRegionsForTesting();
    }
  });

  it("gives an unknown and an unbound region the same answer for every malformed request", async () => {
    const { send } = setup();
    const malformed: Array<Record<string, string>> = [
      { path: "/static", props: "[1]" },
      { path: "/static", props: JSON.stringify({ pad: "x".repeat(5000) }) },
      { path: "//evil.example/admin" },
      { path: "/nowhere" },
    ];

    for (const query of malformed) {
      const known = await snapshot(await send({ ...query, region: ADMIN_STATS }));
      const unknown = await snapshot(await send({ ...query, region: "/src/regions/Nope.tsx" }));
      expect(known).toEqual(unknown);
    }
  });

  it("ignores a client-sent development bindings header in a built app", async () => {
    const { loaders, send } = setup();

    const response = await send(
      { region: ADMIN_STATS, path: "/static" },
      {
        "x-pracht-dev-region-bindings": JSON.stringify({ "/src/routes/static.tsx": [ADMIN_STATS] }),
      },
    );

    expect(response.status).toBe(404);
    expect(loaders.adminStats).not.toHaveBeenCalled();
  });

  it("reads development bindings from the dev server's header, and nothing else", async () => {
    const { loaders, middleware, send } = setup("dev");
    const header = (bindings: object) => ({
      "x-pracht-dev-region-bindings": JSON.stringify(bindings),
      cookie: "role=admin",
    });

    expect(
      (await send({ region: ADMIN_STATS, path: "/admin" }, { cookie: "role=admin" })).status,
    ).toBe(404);
    expect(
      (
        await send(
          { region: ADMIN_STATS, path: "/admin" },
          header({ "/src/routes/static.tsx": [ADMIN_STATS] }),
        )
      ).status,
    ).toBe(404);

    const bound = await send({ region: ADMIN_STATS, path: "/admin" }, header(BINDINGS));
    expect(bound.status).toBe(200);
    // Middleware and the loader never see the header.
    const [args] = middleware.admin.mock.calls[0]!;
    expect(args.request.headers.has("x-pracht-dev-region-bindings")).toBe(false);
    expect(loaders.adminStats).toHaveBeenCalledOnce();
  });
});
