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
  type McpAuthConfig,
  webhookRevalidate,
} from "@pracht/core";

import {
  createNetlifyHandler,
  createNetlifyServerEntryModule,
  finalizeNetlifyBuild,
  netlifyAdapter,
  netlifyRouteCacheTag,
  resolveNetlifyStaticDir,
} from "../src/index.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
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
    expect(source).toContain("cssContentManifest,");
    expect(source).toContain("finalizePrachtBuild");
    expect(source).toContain("finalizeNetlifyBuild(root,");
    expect(source).toContain("buildBase");
    expect(source).toContain("resolvedApp.agents?.mcp?.auth");
  });
});

describe("netlifyAdapter", () => {
  it("emits a catch-all Functions v2 wrapper with asset exclusions", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/client/assets"), { recursive: true });
    await mkdir(join(root, "dist/client/_pracht"), { recursive: true });
    await mkdir(join(root, "dist/client/content"), { recursive: true });
    await mkdir(join(root, "dist/client/docs"), { recursive: true });
    await mkdir(join(root, "dist/client/exact/child"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(join(root, "dist/client/assets/app.js"), "asset");
    await writeFile(join(root, "dist/client/_pracht/headers.json"), "{}");
    await writeFile(join(root, "dist/client/content/manual.pdf"), "content");
    await writeFile(join(root, "dist/client/docs/index.html"), "docs");
    await writeFile(join(root, "dist/client/exact/index.html"), "exact");
    await writeFile(join(root, "dist/client/exact/child/index.html"), "child");
    await writeFile(join(root, "dist/client/robots.txt"), "User-agent: *");
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({
        "/assets/search.data": {
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
        "/docs": { "content-type": "text/html; charset=utf-8", vary: "Accept" },
      }),
    );
    const options = {
      excludedPath: ["/content/*", "/exact"],
      functionName: "site",
    };
    const adapter = netlifyAdapter(options);
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

    let source = await readFile(join(root, "netlify/functions/site.mjs"), "utf-8");
    expect(source).toContain('"path": "/*"');
    expect(source).toContain('"/assets/*"');
    expect(source).toContain('"/content/*"');
    expect(source).toContain('"../../dist/client/**"');
    expect(source).toContain('"!../../dist/client/assets/**"');
    expect(source).toContain('"!../../dist/client/_pracht/**"');
    expect(source).toContain('"!../../dist/client/content/**"');
    expect(source).not.toContain('"!../../dist/client/exact/index.html"');
    expect(source).not.toContain('"!../../dist/client/exact/**"');
    expect(source).toContain('import handler from "../../dist/server/server.js"');

    await finalizeNetlifyBuild(root, options);
    source = await readFile(join(root, "netlify/functions/site.mjs"), "utf-8");
    expect(source).toContain('"../../dist/client/_headers"');
    expect(source).toContain('"../../dist/client/docs/index.html"');
    expect(source).toContain('"../../dist/client/robots.txt"');
    expect(source).not.toContain('"../../dist/client/**"');
    expect(source).toContain('"!../../dist/client/assets/**"');
    expect(source).toContain('"!../../dist/client/_pracht/**"');
    expect(source).toContain('"!../../dist/client/content/**"');
    expect(source).not.toContain("dist/client/assets/app.js");
    expect(source).not.toContain("dist/client/_pracht/headers.json");
    expect(source).not.toContain("dist/client/content/manual.pdf");
    // URLPattern `/exact` does not exclude `/exact/` or
    // `/exact/index.html`, so those requests can still reach the function.
    expect(source).toContain('"../../dist/client/exact/index.html"');
    expect(source).toContain('"../../dist/client/exact/child/index.html"');
    expect(source).toContain('import handler from "../../dist/server/server.js"');

    // Excluded paths bypass the function, so the static layer needs the
    // immutable asset policy and default security headers via `_headers`.
    const headersFile = await readFile(join(root, "dist/client/_headers"), "utf-8");
    expect(headersFile).toContain(
      "/assets/*\n  Cache-Control: public, max-age=31536000, immutable",
    );
    expect(headersFile).toContain("/content/*");
    expect(headersFile).toContain("  X-Content-Type-Options: nosniff");
    expect(headersFile).toContain("  X-Frame-Options: SAMEORIGIN");
    // `/assets/*` already applies `X-Content-Type-Options` to this path, and
    // Netlify concatenates repeated header names across matching rules instead
    // of letting the more specific one win.
    expect(headersFile).toContain(
      "/assets/search.data\n  content-type: application/json; charset=utf-8\n",
    );
    expect(headersFile).not.toContain("  x-content-type-options: nosniff");
    // `/docs` is not excluded, so the function serves it and applies the same
    // manifest at runtime. A rule here would be a rule per prerendered page.
    expect(headersFile).not.toContain("\n/docs\n");
    expect(headersFile).not.toContain("  vary: Accept");
  });

  it("rejects build header rules that could inject _headers entries", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({ "/assets/search.data": { "x-safe\n/evil": "injected" } }),
    );

    await expect(finalizeNetlifyBuild(root)).rejects.toThrow(/Invalid header/);
  });

  it.each(["/docs/*", "/docs/:slug"])(
    "warns and skips exact build headers that Netlify would broaden for %s",
    async (pathname) => {
      const root = await tempDir();
      await mkdir(join(root, "dist/server"), { recursive: true });
      await writeFile(
        join(root, "dist/server/headers-manifest.json"),
        JSON.stringify({
          [pathname]: { "cache-control": "public, max-age=60" },
          "/assets/feed.data": { "content-type": "application/json" },
        }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await finalizeNetlifyBuild(root);

      // A `getStaticPaths()` slug may legitimately contain `*`, so the build
      // drops the unrepresentable rule instead of failing — and never widens
      // it to the other paths the pattern would match.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(pathname)));
      const headersFile = await readFile(join(root, "dist/client/_headers"), "utf-8");
      expect(headersFile).not.toContain(pathname);
      expect(headersFile).not.toContain("max-age=60");
      expect(headersFile).toContain("/assets/feed.data\n  content-type: application/json");
    },
  );

  it("keeps header-less prerendered paths that Netlify cannot match exactly", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/server"), { recursive: true });
    // `pracht build` lists every prerendered page in the headers manifest,
    // including the header-less ones that were never going to emit a rule.
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({
        "/docs/a*b": {},
        "/assets/feed.data": { "content-type": "application/json" },
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await finalizeNetlifyBuild(root);

    expect(warn).not.toHaveBeenCalled();
    const headersFile = await readFile(join(root, "dist/client/_headers"), "utf-8");
    expect(headersFile).not.toContain("/docs/a*b");
    expect(headersFile).toContain("/assets/feed.data\n  content-type: application/json");
  });

  it("keeps every build header rule when an exclusion pattern is not exactly matchable", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({ "/docs": { "content-type": "text/html; charset=utf-8" } }),
    );

    // Netlify's pattern syntax is richer than what the adapter evaluates. A
    // redundant rule costs bytes; a dropped one costs a statically served
    // artifact its media type, so an unreadable exclusion keeps every rule.
    await finalizeNetlifyBuild(root, { excludedPath: ["/docs/*.html"] });

    await expect(readFile(join(root, "dist/client/_headers"), "utf-8")).resolves.toContain(
      "/docs\n  content-type: text/html; charset=utf-8",
    );
  });

  it("rejects malformed headers on paths Netlify cannot match exactly", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({ "/docs/a*b": { "x-safe\n/evil": "injected" } }),
    );

    await expect(finalizeNetlifyBuild(root)).rejects.toThrow(/Invalid header/);
  });

  it("preserves hand-authored _headers copied from the default publicDir", async () => {
    const root = await tempDir();
    await mkdir(join(root, "public"), { recursive: true });
    await mkdir(join(root, "dist/client"), { recursive: true });
    const publicHeaders = "/assets/*\n  X-Custom: 1\n";
    await writeFile(join(root, "public/_headers"), publicHeaders);
    await writeFile(join(root, "dist/client/_headers"), publicHeaders);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const plugin = netlifyAdapter().vitePlugins?.()[0];
    const configResolved = plugin?.configResolved;
    if (typeof configResolved !== "function") throw new Error("missing configResolved hook");
    await configResolved.call({} as never, { root, build: { ssr: true } } as never);
    const closeBundle = plugin?.closeBundle;
    if (typeof closeBundle !== "function") throw new Error("missing closeBundle hook");
    await closeBundle.call({} as never);

    await expect(readFile(join(root, "dist/client/_headers"), "utf-8")).resolves.toBe(
      publicHeaders,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dist/client/_headers"));
  });

  it("ignores public/_headers when a custom publicDir did not copy it", async () => {
    const root = await tempDir();
    await mkdir(join(root, "public"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    await writeFile(join(root, "public/_headers"), "/unrelated/*\n  X-Custom: 1\n");
    await writeFile(
      join(root, "dist/server/headers-manifest.json"),
      JSON.stringify({ "/assets/feed.data": { "content-type": "application/json" } }),
    );

    await finalizeNetlifyBuild(root);

    await expect(readFile(join(root, "dist/client/_headers"), "utf-8")).resolves.toContain(
      "/assets/feed.data\n  content-type: application/json",
    );
  });

  it("preserves hand-authored _headers copied from a custom Vite publicDir", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/client"), { recursive: true });
    await mkdir(join(root, "dist/server"), { recursive: true });
    const customHeaders = "/legal/*\n  X-Custom: 1\n";
    await writeFile(join(root, "dist/client/_headers"), customHeaders);
    await writeFile(join(root, "dist/server/headers-manifest.json"), "{}");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await finalizeNetlifyBuild(root, {}, "/app/");

    await expect(readFile(join(root, "dist/client/_headers"), "utf-8")).resolves.toBe(
      customHeaders,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dist/client/_headers"));
  });

  it("bundles framework assets when a deploy base prevents static bypasses", async () => {
    const root = await tempDir();
    await mkdir(join(root, "dist/client/assets"), { recursive: true });
    await mkdir(join(root, "dist/client/_pracht"), { recursive: true });
    await mkdir(join(root, "dist/client/images"), { recursive: true });
    await writeFile(join(root, "dist/client/assets/app.js"), "asset");
    await writeFile(join(root, "dist/client/_pracht/headers.json"), "{}");
    await writeFile(join(root, "dist/client/images/hero.png"), "image");

    const options = { excludedPath: ["/images/*"] };
    const plugin = netlifyAdapter(options).vitePlugins?.()[0];
    const configResolved = plugin?.configResolved;
    if (typeof configResolved !== "function") throw new Error("missing configResolved hook");
    await configResolved.call({} as never, { root, base: "/app/", build: { ssr: true } } as never);
    const closeBundle = plugin?.closeBundle;
    if (typeof closeBundle !== "function") throw new Error("missing closeBundle hook");
    await closeBundle.call({} as never);

    let source = await readFile(join(root, "netlify/functions/pracht.mjs"), "utf-8");
    expect(source).not.toContain('"/assets/*"');
    expect(source).not.toContain('"/_pracht/*"');
    expect(source).toContain('"/images/*"');
    expect(source).toContain('"../../dist/client/**"');
    expect(source).not.toContain('"!../../dist/client/assets/**"');
    expect(source).not.toContain('"!../../dist/client/_pracht/**"');
    expect(source).not.toContain('"!../../dist/client/images/**"');

    await finalizeNetlifyBuild(root, options, "/app/");
    source = await readFile(join(root, "netlify/functions/pracht.mjs"), "utf-8");
    expect(source).toContain('"../../dist/client/assets/app.js"');
    expect(source).toContain('"../../dist/client/_pracht/headers.json"');
    expect(source).toContain('"../../dist/client/images/hero.png"');
    expect(await readFile(join(root, "dist/client/_headers"), "utf-8")).toContain("/images/*");
  });

  it("rejects excludedPath patterns that could inject _headers rules", () => {
    // A newline inside a pattern would let one entry write arbitrary header
    // rules for arbitrary paths in the generated plain-text `_headers` file.
    expect(() => netlifyAdapter({ excludedPath: ["/a\n/b\n  X-Evil: 1"] })).toThrow(/excludedPath/);
    expect(() => netlifyAdapter({ excludedPath: ["/spaced path/*"] })).toThrow(/excludedPath/);
    expect(() => netlifyAdapter({ excludedPath: ["images/*"] })).toThrow(/excludedPath/);
    expect(() => netlifyAdapter({ excludedPath: ["/images/*"] })).not.toThrow();
  });

  it("allows OAuth metadata exclusions when the app does not enable MCP auth", () => {
    expect(() => netlifyAdapter({ excludedPath: ["/.well-known/*"] })).not.toThrow();
  });

  it("rejects excludedPath patterns that shadow enabled OAuth metadata", async () => {
    const root = await tempDir();
    const mcpAuth = {
      resource: "https://example.com/mcp",
      authorizationServers: ["https://auth.example"],
      verify: "./server/mcp-token.ts",
    } satisfies McpAuthConfig;
    for (const pattern of [
      "/*",
      "/mcp",
      "/:endpoint",
      "/.well-known/*",
      "/.well-known/oauth-*",
      "/.well-known/:document",
      "/:directory/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      await expect(
        finalizeNetlifyBuild(root, { excludedPath: [pattern] }, "/", mcpAuth),
      ).rejects.toThrow(/OAuth-protected MCP endpoint or protected-resource metadata handler/);
    }

    await expect(
      finalizeNetlifyBuild(root, { excludedPath: ["/*.css"] }, "/", mcpAuth),
    ).resolves.toBeUndefined();

    await expect(
      finalizeNetlifyBuild(root, { excludedPath: ["/app/*"] }, "/", {
        ...mcpAuth,
        resource: "https://example.com/app/mcp",
      }),
    ).rejects.toThrow(/OAuth-protected MCP endpoint/);
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
    await writeFile(join(dir, "legal terms.txt"), "Terms");
    await writeFile(join(dir, "café.txt"), "Coffee");
    await writeFile(join(dir, "robots.txt"), "User-agent: *");
    return dir;
  }

  it("serves OAuth metadata before a colliding static file", async () => {
    const staticDir = await createStaticBuild();
    const metadataDir = join(staticDir, ".well-known/oauth-protected-resource");
    await mkdir(metadataDir, { recursive: true });
    await writeFile(join(metadataDir, "mcp"), "stale metadata");
    const handler = createNetlifyHandler({
      app: defineApp({
        agents: {
          mcp: {
            auth: {
              resource: "https://example.com/mcp",
              authorizationServers: ["https://auth.example"],
              verify: "./server/mcp-token.ts",
            },
          },
        },
        routes: [],
      }),
      staticDir,
    });

    const response = await handler(
      new Request("https://example.com/.well-known/oauth-protected-resource/mcp"),
      {},
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: "https://example.com/mcp" });
  });

  it("serves static and regenerated ISG routes beneath the deploy base", async () => {
    vi.stubEnv("BASE_URL", "/app/");
    vi.resetModules();
    const { createNetlifyHandler: createBaseHandler } = await import("../src/index.ts");
    const staticDir = await createStaticBuild();
    const contextRequests: string[] = [];
    seenPricingRequests.length = 0;
    const handler = createBaseHandler({
      app,
      registry,
      staticDir,
      isgManifest: { "/pricing": { revalidate: [timeRevalidate(60), webhookRevalidate()] } },
      createContext({ request }) {
        contextRequests.push(request.url);
        return {};
      },
    });

    const bareBase = await handler(
      new Request("https://example.com/app?ref=campaign"),
      {} as never,
    );
    expect(bareBase.status).toBe(308);
    expect(bareBase.headers.get("location")).toBe("/app/?ref=campaign");

    const staticResponse = await handler(new Request("https://example.com/app/guide"), {} as never);
    expect(staticResponse.status).toBe(200);
    expect(await staticResponse.text()).toContain("static guide");

    const isgResponse = await handler(
      new Request("https://example.com/app/pricing?visitor=1"),
      {} as never,
    );
    expect(isgResponse.status).toBe(200);
    expect(contextRequests).toEqual(["https://example.com/app/pricing"]);
    expect(seenPricingRequests.map((request) => request.url)).toEqual([
      "https://example.com/app/pricing",
    ]);
  });

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
    // Netlify-Vary owns Pracht's custom route-state transport, while the
    // standard Vary header remains responsible for content negotiation.
    expect(response.headers.get("netlify-vary")).toBe(
      "query=_data,header=x-pracht-route-state-request",
    );
  });

  it("applies generated headers to non-HTML static assets", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      headersManifest: {
        "/robots.txt": { "content-type": "text/markdown; charset=utf-8" },
      },
      registry,
      staticDir,
    });

    const response = await handler(new Request("https://example.com/robots.txt"), {});
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  });

  it("does not fragment non-Markdown documents on Accept", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      markdownManifest: { "/guide": true },
      registry,
      staticDir,
    });

    const response = await handler(new Request("https://example.com/"), {});
    expect(await response.text()).toBe("<html>home</html>");
    expect(response.headers.get("netlify-vary")).toBe(
      "query=_data,header=x-pracht-route-state-request",
    );
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

  it.each(["cloudflare-cdn-cache-control", "surrogate-control", "vercel-cdn-cache-control"])(
    "does not treat %s as a Netlify SSG cache policy",
    async (header) => {
      const staticDir = await createStaticBuild();
      const handler = createNetlifyHandler({
        app,
        headersManifest: {
          "/guide": { [header]: "public, max-age=600" },
        },
        registry,
        staticDir,
      });

      const response = await handler(new Request("https://example.com/guide"), {});
      expect(response.headers.get(header)).toBe("public, max-age=600");
      expect(response.headers.get("netlify-cdn-cache-control")).toBe(
        "public, durable, max-age=31536000",
      );
    },
  );

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

  it("serves percent-encoded static filenames without decoding path separators", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({ app, registry, staticDir });

    const spaced = await handler(new Request("https://example.com/legal%20terms.txt"), {});
    expect(spaced.status).toBe(200);
    expect(await spaced.text()).toBe("Terms");

    const unicode = await handler(new Request("https://example.com/caf%C3%A9.txt"), {});
    expect(unicode.status).toBe(200);
    expect(await unicode.text()).toBe("Coffee");

    const encodedSeparator = await handler(new Request("https://example.com/assets%2Fapp.js"), {});
    expect(encodedSeparator.status).toBe(404);
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
    await expect(state.json()).resolves.toEqual({
      data: { page: "guide" },
      fontHead: { preloadLinks: [], css: "" },
    });
  });

  it("uses one Netlify-Vary policy for cached HTML and Markdown representations", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      headersManifest: {
        "/guide": { "cache-control": "public, max-age=300", vary: "Accept" },
      },
      markdownManifest: { "/guide": true },
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/guide.tsx": async () => ({
            default: () => h("main", null, "guide"),
            headers: () => ({ "cache-control": "public, max-age=300" }),
            markdown: "# Guide",
          }),
        },
      },
      staticDir,
    });

    const html = await handler(new Request("https://example.com/guide?lang=en"), {});
    const markdown = await handler(
      new Request("https://example.com/guide?lang=en", {
        headers: { accept: "text/markdown" },
      }),
      {},
    );

    expect(html.headers.get("netlify-vary")).toBe(
      "query=_data,header=x-pracht-route-state-request",
    );
    expect(markdown.headers.get("netlify-vary")).toBe(html.headers.get("netlify-vary"));
    expect(markdown.headers.get("netlify-cdn-cache-control")).toBe("public, max-age=300, durable");
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
    expect(response.headers.get("netlify-vary")).toBe(
      "query=_data,header=x-pracht-route-state-request",
    );

    const trailingSlash = await handler(
      new Request("https://example.com/pricing/?visitor=2", {
        headers: { cookie: "session=another-visitor" },
      }),
      {},
    );
    expect(trailingSlash.status).toBe(308);
    expect(trailingSlash.headers.get("location")).toBe("/pricing?visitor=2");
    expect(seenPricingRequests).toHaveLength(1);
  });

  it("keeps cached ISG HTML apart from route-state and Markdown variants", async () => {
    const handler = createNetlifyHandler({
      app,
      isgManifest: {
        "/pricing": {
          revalidate: [timeRevalidate(60), webhookRevalidate()],
        },
      },
      markdownManifest: {},
      registry,
    });
    const response = await handler(new Request("https://example.com/pricing"), {});
    expect(response.headers.get("netlify-vary")).toBe(
      "query=_data,header=x-pracht-route-state-request",
    );

    // The route-state variant itself must never enter the durable cache.
    const state = await handler(
      new Request("https://example.com/pricing", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      {},
    );
    expect(state.headers.get("content-type")).toContain("application/json");
    expect(state.headers.has("netlify-cdn-cache-control")).toBe(false);
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

  it("applies the Netlify ISG policy beside another platform's cache header", async () => {
    const handler = createNetlifyHandler({
      app,
      isgManifest: {
        "/pricing": {
          revalidate: timeRevalidate(60),
        },
      },
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/pricing.tsx": async () => ({
            default: () => h("main", null, "pricing"),
            headers: () => ({ "vercel-cdn-cache-control": "public, max-age=600" }),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/pricing"), {});
    expect(response.headers.get("vercel-cdn-cache-control")).toBe("public, max-age=600");
    expect(response.headers.get("netlify-cdn-cache-control")).toBe(
      "public, durable, max-age=60, stale-while-revalidate=31536000",
    );
  });

  it("honors zero-length Netlify cache windows", async () => {
    const staticDir = await createStaticBuild();
    const handler = createNetlifyHandler({
      app,
      cache: { staleWhileRevalidate: 0, staticMaxAge: 0 },
      isgManifest: {
        "/pricing": {
          revalidate: timeRevalidate(60),
        },
      },
      registry,
      staticDir,
    });

    const ssg = await handler(new Request("https://example.com/guide"), {});
    expect(ssg.headers.get("netlify-cdn-cache-control")).toBe("public, durable, max-age=0");

    const isg = await handler(new Request("https://example.com/pricing"), {});
    expect(isg.headers.get("netlify-cdn-cache-control")).toBe(
      "public, durable, max-age=60, stale-while-revalidate=0",
    );
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
    // An explicit Netlify policy is user-owned end to end — no synthesized vary.
    expect(response.headers.has("netlify-vary")).toBe(false);
  });

  it("keeps promoted public SSR documents apart from route-state fetches", async () => {
    const handler = createNetlifyHandler({
      app,
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/dashboard.tsx": async () => ({
            default: () => h("main", null, "dashboard"),
            headers: () => ({ "cache-control": "public, max-age=300" }),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/dashboard"), {});
    expect(response.headers.get("netlify-cdn-cache-control")).toBe("public, max-age=300, durable");
    // Promotion makes the response CDN-cacheable, so the cached entry must not
    // shadow header-transport route-state fetches. `query` keeps Netlify's
    // default full-query cache key for dynamic routes.
    expect(response.headers.get("netlify-vary")).toBe("query,header=x-pracht-route-state-request");
  });

  it("never lets a route-state-shaped request's response enter the shared cache", async () => {
    // The route exports a public browser policy. A `?_data=1` request without
    // browser provenance renders the full HTML document — cached under the
    // same CDN key the first-party JSON fetch uses (`Netlify-Vary: query`
    // cannot see who asked), so a cross-site `<a href="/dashboard?_data=1">`
    // could otherwise poison every later client navigation with HTML.
    const handler = createNetlifyHandler({
      app,
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/dashboard.tsx": async () => ({
            default: () => h("main", null, "dashboard"),
            headers: () => ({ "cache-control": "public, max-age=300" }),
          }),
        },
      },
    });

    const crossSiteData = await handler(
      new Request("https://example.com/dashboard?_data=1", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      {},
    );
    expect(crossSiteData.headers.get("content-type")).toContain("text/html");
    expect(crossSiteData.headers.get("netlify-cdn-cache-control")).toBe("private");

    const headerTransport = await handler(
      new Request("https://example.com/dashboard", {
        headers: { "x-pracht-route-state-request": "1" },
      }),
      {},
    );
    expect(headerTransport.headers.get("netlify-cdn-cache-control") ?? "private").toBe("private");
  });

  it("refuses to promote a public policy whose response is not shareable", async () => {
    // `Cache-Control: public` alone makes Netlify's CDN store the response, so
    // a per-visitor render (Set-Cookie / Vary: Cookie) must say `private` in
    // the CDN's own header — promotion would replay one visitor's document and
    // cookie to everyone.
    const apiRoutes = resolveApiRoutes(["/src/api/session.ts"]);
    const handler = createNetlifyHandler({
      apiRoutes,
      app: defineApp({ routes: [] }),
      registry: {
        apiModules: {
          "/src/api/session.ts": async () => ({
            GET: () =>
              new Response("{}", {
                headers: {
                  "cache-control": "public, max-age=600",
                  "content-type": "application/json",
                  "set-cookie": "session=one-visitor; Path=/; HttpOnly",
                },
              }),
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/api/session"), {});
    expect(response.headers.get("netlify-cdn-cache-control")).toBe("private");
    expect(response.headers.get("set-cookie")).toBe("session=one-visitor; Path=/; HttpOnly");
    expect(response.headers.get("cache-control")).toBe("public, max-age=600");

    const varyHandler = createNetlifyHandler({
      app,
      registry: {
        ...registry,
        routeModules: {
          ...registry.routeModules,
          "/src/routes/dashboard.tsx": async () => ({
            default: () => h("main", null, "dashboard"),
            headers: () => ({ "cache-control": "public, max-age=300", vary: "Cookie" }),
          }),
        },
      },
    });
    const varied = await varyHandler(new Request("https://example.com/dashboard"), {});
    expect(varied.headers.get("netlify-cdn-cache-control")).toBe("private");
  });

  it("preserves multiple Set-Cookie headers on dynamic responses", async () => {
    const apiRoutes = resolveApiRoutes(["/src/api/login.ts"]);
    const handler = createNetlifyHandler({
      apiRoutes,
      app: defineApp({ routes: [] }),
      registry: {
        apiModules: {
          "/src/api/login.ts": async () => ({
            GET: () => {
              const headers = new Headers({ "content-type": "application/json" });
              headers.append("set-cookie", "a=1; Path=/; HttpOnly");
              headers.append("set-cookie", "b=2; Path=/; HttpOnly");
              return new Response("{}", { headers });
            },
          }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/api/login"), {});
    expect(response.headers.getSetCookie()).toEqual([
      "a=1; Path=/; HttpOnly",
      "b=2; Path=/; HttpOnly",
    ]);
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

  it("normalizes trailing-slash paths before purging tagged ISG responses", async () => {
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
        body: JSON.stringify({ paths: ["/pricing/"] }),
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
      revalidated: ["/pricing/"],
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

describe("null-body response headers", () => {
  it.each([
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
    ["GET", 304],
  ])("strips content-length from a null-body %s %s response", async (method, status) => {
    const respond = () =>
      new Response(null, {
        status,
        headers: { "content-length": "42", "x-test": "kept" },
      });
    const handler = createNetlifyHandler({
      apiRoutes: resolveApiRoutes(["/src/api/empty.ts"]),
      app: defineApp({ routes: [] }),
      registry: {
        apiModules: {
          "/src/api/empty.ts": async () => ({ GET: respond, HEAD: respond }),
        },
      },
    });

    const response = await handler(new Request("https://example.com/api/empty", { method }), {});

    expect(response.status).toBe(status);
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-test")).toBe("kept");
    expect(response.body).toBeNull();
  });
});
