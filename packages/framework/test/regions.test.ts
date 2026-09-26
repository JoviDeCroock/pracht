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
  registerServerRegions,
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

  it("runs the middleware of the route the path names, not the embedding one", async () => {
    // `/public` has no `visitor` middleware: the caller picks the route, so a
    // region must authorize from context rather than rely on a route's gate.
    const { response } = await request(
      regionRequest(
        { ...params, path: "/public" },
        { "x-pracht-region": "1", cookie: "visitor=Ada" },
      ),
    );

    expect(await response.text()).toBe('<p class="visitor">Signed out</p>');
  });
});
