import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { h } from "preact";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineApp,
  resolveApiRoutes,
  route,
  timeRevalidate,
  webhookRevalidate,
} from "@pracht/core";

import {
  createNetlifyHandler,
  createNetlifyServerEntryModule,
  netlifyAdapter,
  netlifyRouteCacheTag,
  resolveNetlifyStaticDir,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  delete process.env.PRACHT_REVALIDATE_TOKEN;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pracht-netlify-"));
  tempDirs.push(dir);
  return dir;
}

describe("createNetlifyServerEntryModule", () => {
  it("loads build manifests, context, and the Netlify purge helper", () => {
    const source = createNetlifyServerEntryModule({
      createContextFrom: "/src/server/context.ts",
      staleWhileRevalidate: 60,
      staticMaxAge: 120,
    });

    expect(source).toContain(
      'import { createContext as createPrachtContext } from "/src/server/context.ts";',
    );
    expect(source).toContain('readManifest("markdown-manifest.json", undefined)');
    expect(source).toContain("purgeNetlifyCache");
    expect(source).not.toContain('from "@netlify/functions"');
    expect(source).toContain('"staleWhileRevalidate":60');
    expect(source).toContain("islandsBootstrapRequired");
  });
});

describe("netlifyAdapter", () => {
  it("emits a catch-all Functions v2 wrapper with asset exclusions", async () => {
    const root = await tempDir();
    const adapter = netlifyAdapter({
      excludedPath: ["/content/*"],
      functionName: "site",
    });
    const plugin = adapter.vitePlugins?.()[0];
    expect(plugin).toBeDefined();

    const configResolved = plugin?.configResolved;
    if (typeof configResolved !== "function") throw new Error("missing configResolved hook");
    await configResolved.call(
      {} as never,
      {
        root,
        build: { ssr: true },
      } as never,
    );
    const closeBundle = plugin?.closeBundle;
    if (typeof closeBundle !== "function") throw new Error("missing closeBundle hook");
    await closeBundle.call({} as never);

    const source = await readFile(join(root, "netlify/functions/site.mjs"), "utf-8");
    expect(source).toContain('"path": "/*"');
    expect(source).toContain('"/assets/*"');
    expect(source).toContain('"/content/*"');
    expect(source).toContain('"dist/client/**"');
    expect(source).toContain('import handler from "../../dist/server/server.js"');
  });
});

describe("createNetlifyHandler", () => {
  const app = defineApp({
    routes: [
      route("/guide", "./routes/guide.tsx", { render: "ssg" }),
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg",
        revalidate: [timeRevalidate(60), webhookRevalidate()],
      }),
    ],
  });
  const seenPricingRequests: Request[] = [];
  const registry = {
    routeModules: {
      "/src/routes/guide.tsx": async () => ({
        default: () => h("main", null, "guide"),
        loader: () => ({ page: "guide" }),
        markdown: "# Guide",
      }),
      "/src/routes/dashboard.tsx": async () => ({
        default: () => h("main", null, "dashboard"),
      }),
      "/src/routes/pricing.tsx": async () => ({
        default: () => h("main", null, "pricing"),
        loader: ({ request }: { request: Request }) => {
          seenPricingRequests.push(request);
          return {};
        },
      }),
    },
  };

  async function createStaticBuild(): Promise<string> {
    const dir = await tempDir();
    await mkdir(join(dir, "guide"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "index.html"), "<html>home</html>");
    await writeFile(join(dir, "guide/index.html"), "<html>static guide</html>");
    await writeFile(join(dir, "assets/app.js"), "export default 1");
    await writeFile(join(dir, "robots.txt"), "User-agent: *");
    return dir;
  }

  it("serves prerendered HTML with route headers and durable caching", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      headersManifest: { "/guide": { "x-route": "guide", vary: "Accept" } },
      markdownManifest: { "/guide": true },
      registry,
      staticDir,
    });

    const response = await handler(new Request("https://example.com/guide"), {});
    expect(await response.text()).toBe("<html>static guide</html>");
    expect(response.headers.get("x-route")).toBe("guide");
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("netlify-cdn-cache-control")).toContain("durable");
    expect(response.headers.get("netlify-vary")).toBe("query=_data");
  });

  it("keeps an explicit SSG cache policy authoritative", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      headersManifest: {
        "/guide": {
          "cache-control": "no-store",
          "netlify-vary": "query=preview",
        },
      },
      registry,
      staticDir,
    });

    const response = await handler(new Request("https://example.com/guide"), {});
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("netlify-cdn-cache-control")).toBe(false);
    expect(response.headers.get("netlify-vary")).toBe("query=preview");
  });

  it("serves exact assets with their MIME type when the function receives them", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({ app, registry, staticDir });
    const response = await handler(new Request("https://example.com/assets/app.js"), {});

    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(await response.text()).toBe("export default 1");
  });

  it("does not mark unhashed public files immutable", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({ app, registry, staticDir });
    const response = await handler(new Request("https://example.com/robots.txt"), {});

    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(await response.text()).toBe("User-agent: *");
  });

  it("bypasses static HTML for negotiated Markdown and route-state requests", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      markdownManifest: { "/guide": true },
      registry,
      staticDir,
    });

    const markdown = await handler(
      new Request("https://example.com/guide", {
        headers: { accept: "text/markdown" },
      }),
      {},
    );
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toBe("# Guide");

    const state = await handler(
      new Request("https://example.com/guide", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      {},
    );
    await expect(state.json()).resolves.toEqual({ data: { page: "guide" } });
  });

  it("fails closed against heuristic caching for dynamic SSR", async () => {
    const handler = createNetlifyHandler({ app, registry });
    const response = await handler(new Request("https://example.com/dashboard"), {});
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.has("netlify-cdn-cache-control")).toBe(false);
  });

  it("renders ISG from a sanitized request and stamps durable cache metadata", async () => {
    seenPricingRequests.length = 0;
    const handler = createNetlifyHandler({
      app,
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      registry,
    });
    const response = await handler(
      new Request("https://example.com/pricing?visitor=1", {
        headers: {
          authorization: "Bearer visitor",
          cookie: "session=visitor",
        },
      }),
      {},
    );

    expect(seenPricingRequests).toHaveLength(1);
    expect(seenPricingRequests[0].url).toBe("https://example.com/pricing");
    expect(seenPricingRequests[0].headers.get("cookie")).toBeNull();
    expect(seenPricingRequests[0].headers.get("authorization")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("netlify-cdn-cache-control")).toContain("max-age=60");
    expect(response.headers.get("netlify-cache-tag")).toContain(netlifyRouteCacheTag("/pricing"));
    expect(response.headers.get("netlify-vary")).toBe("query=_data");
  });

  it("sanitizes visitor-specific Netlify context before shared ISG renders", async () => {
    const platformContext = {
      cookies: {
        delete: vi.fn(),
        get: vi.fn(() => "visitor-session"),
        set: vi.fn(),
      },
      customVisitorValue: "visitor-specific",
      geo: { city: "Brussels" },
      ip: "203.0.113.7",
      requestId: "visitor-request-id",
      site: { id: "site-id" },
      url: new URL("https://example.com/pricing?visitor=1"),
      waitUntil(this: unknown, _promise: Promise<unknown>) {
        expect(this).toBe(platformContext);
      },
    };
    let seenContext: Record<string, unknown> | undefined;
    const handler = createNetlifyHandler({
      app,
      createContext: ({ context }) => {
        seenContext = context;
        context.waitUntil?.(Promise.resolve());
        return context;
      },
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      registry,
    });

    const response = await handler(
      new Request("https://example.com/pricing?visitor=1", {
        headers: { cookie: "session=visitor" },
      }),
      platformContext,
    );

    expect(response.headers.get("netlify-cdn-cache-control")).toContain("public, durable");
    expect(seenContext).toMatchObject({
      cookies: expect.any(Object),
      geo: {},
      ip: "",
      requestId: "",
      site: { id: "site-id" },
      url: new URL("https://example.com/pricing"),
    });
    const sharedCookies = seenContext?.cookies as
      | { get(name: string): string | undefined }
      | undefined;
    expect(sharedCookies?.get("session")).toBeUndefined();
    expect(seenContext).not.toHaveProperty("customVisitorValue");
    expect(seenContext).not.toHaveProperty("next");
    expect(platformContext.cookies.get).not.toHaveBeenCalled();
  });

  it("rejects cookie mutations while rendering shared ISG output", async () => {
    const handler = createNetlifyHandler({
      app,
      createContext: ({ context }) => {
        (context.cookies as { set(name: string, value: string): void }).set("session", "value");
        return context;
      },
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      registry,
    });

    await expect(
      handler(new Request("https://example.com/pricing"), {
        cookies: { set: vi.fn() },
      }),
    ).rejects.toThrow("Netlify cookies cannot be changed while rendering a shared ISG response");
  });

  it("keeps cacheable custom ISG policies tagged for webhook purges", async () => {
    const handler = createNetlifyHandler({
      app,
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/pricing.tsx": async () => ({
            default: () => h("main", null, "pricing"),
            headers: () => ({
              "cache-control": "public, max-age=600",
              "netlify-cache-tag": "app:pricing",
              "netlify-vary": "query=preview",
            }),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/pricing"), {});
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");
    expect(response.headers.has("netlify-cdn-cache-control")).toBe(false);
    expect(response.headers.get("netlify-cache-tag")).toBe(
      `app:pricing,pracht:isg,${netlifyRouteCacheTag("/pricing")}`,
    );
    expect(response.headers.get("netlify-vary")).toBe("query=preview");
  });

  it("does not add a private browser policy beside an explicit Netlify policy", async () => {
    const handler = createNetlifyHandler({
      app,
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/dashboard.tsx": async () => ({
            default: () => h("main", null, "dashboard"),
            headers: () => ({ "netlify-cdn-cache-control": "public, max-age=300" }),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/dashboard"), {});
    expect(response.headers.has("cache-control")).toBe(false);
    expect(response.headers.get("netlify-cdn-cache-control")).toBe("public, max-age=300");
  });

  it("purges tagged ISG responses through the authenticated webhook", async () => {
    process.env.PRACHT_REVALIDATE_TOKEN = "secret";
    const purgeCache = vi.fn(async () => undefined);
    const handler = createNetlifyHandler({
      app,
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      purgeCache,
      registry,
    });
    const response = await handler(
      new Request("https://example.com/__pracht/revalidate", {
        body: JSON.stringify({ paths: ["/pricing"] }),
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        method: "POST",
      }),
      {},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      failed: [],
      revalidated: ["/pricing"],
      skipped: [],
    });
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [netlifyRouteCacheTag("/pricing")],
    });
  });

  it("passes Netlify context through createContext", async () => {
    const apiRoutes = resolveApiRoutes(["/src/api/region.ts"]);
    const handler = createNetlifyHandler({
      apiRoutes,
      app: defineApp({ routes: [] }),
      createContext: ({ context }) => ({ region: context.region }),
      registry: {
        apiModules: {
          "/src/api/region.ts": async () => ({
            GET: ({ context }: { context: { region: string } }) =>
              Response.json({ region: context.region }),
          }),
        },
      },
    });
    const response = await handler(new Request("https://example.com/api/region"), {
      region: "eu-west",
    });
    await expect(response.json()).resolves.toEqual({ region: "eu-west" });
  });
});

describe("resolveNetlifyStaticDir", () => {
  it("selects the first existing client directory, including SSR-only builds", async () => {
    const parent = await tempDir();
    const missing = join(parent, "missing");
    const present = await tempDir();
    await expect(resolveNetlifyStaticDir([missing, present])).resolves.toBe(present);
  });
});
