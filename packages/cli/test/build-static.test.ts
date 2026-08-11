import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defineCapability } from "@pracht/capabilities";
import type { PrerenderResult, ResolvedRoute, RouteSegment } from "@pracht/core/server";
import type { ModuleRegistry } from "@pracht/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertStaticBuildSupported,
  assertStaticCapabilitiesSupported,
  normalizeStaticHost,
  resolveStaticOutputPath,
  writeStaticBuildOutput,
} from "../src/build-static.ts";

function makeRoute(path: string, overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    file: `./routes${path}.tsx`,
    middleware: [],
    middlewareFiles: [],
    path,
    render: "ssg",
    segments: testRouteSegments(path),
    ...overrides,
  } as ResolvedRoute;
}

function testRouteSegments(path: string): RouteSegment[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) return { type: "param", name: segment.slice(1) };
      return { type: "static", value: segment };
    });
}

function makePage(path: string, overrides: Partial<PrerenderResult> = {}): PrerenderResult {
  return {
    html: `<html><!--${path}--></html>`,
    markdown: false,
    path,
    render: "ssg",
    ...overrides,
  };
}

describe("assertStaticBuildSupported", () => {
  it("accepts prerenderable routes", () => {
    expect(() =>
      assertStaticBuildSupported({
        routes: [
          makeRoute("/"),
          makeRoute("/docs/:slug"),
          makeRoute("/dashboard", { render: "spa", hasLoader: false }),
          makeRoute("/projects/:id", { render: "spa", hasLoader: false }),
        ],
      }),
    ).not.toThrow();
  });

  it("reports every route needing a runtime in one error", () => {
    let message = "";
    try {
      assertStaticBuildSupported(
        {
          routes: [
            makeRoute("/", { render: "ssr" }),
            makeRoute("/pricing", { render: "isg" }),
            makeRoute("/ok"),
          ],
        },
        [{ path: "/api/health", file: "/src/api/health.ts", segments: [] }],
      );
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('render: "ssr"');
    expect(message).toContain('render: "isg"');
    expect(message).toContain("/api/health");
    expect(message).not.toContain("/ok —");
  });

  it("rejects a loader on a dynamic SPA route, which has no per-URL render", () => {
    expect(() =>
      assertStaticBuildSupported({
        routes: [makeRoute("/projects/:id", { render: "spa", hasLoader: true })],
      }),
    ).toThrow(/one fallback document/);
  });

  it("allows a loader on a SPA route with a concrete path", () => {
    expect(() =>
      assertStaticBuildSupported({
        routes: [makeRoute("/dashboard", { render: "spa", hasLoader: true })],
      }),
    ).not.toThrow();
  });

  it("rejects request-time agent policy", () => {
    expect(() =>
      assertStaticBuildSupported({
        agents: { mcp: {} },
        routes: [makeRoute("/")],
      }),
    ).toThrow(/defineApp\(\{ agents \}\)/);
  });

  it("rejects HTTP capabilities but allows private build-time capabilities", async () => {
    const privateCapability = makeCapability();
    const exposedCapability = makeCapability({ expose: { http: true } });
    const app = {
      capabilities: {
        "notes.private": "./capabilities/private.ts",
        "notes.search": "./capabilities/search.ts",
      },
      middleware: {},
    };
    const registry: ModuleRegistry = {
      capabilityModules: {
        "./capabilities/private.ts": async () => ({ default: privateCapability }),
        "./capabilities/search.ts": async () => ({ default: exposedCapability }),
      },
    };

    await expect(assertStaticCapabilitiesSupported(app, registry)).rejects.toThrow(/notes\.search/);

    await expect(
      assertStaticCapabilitiesSupported(
        { ...app, capabilities: { "notes.private": "./capabilities/private.ts" } },
        registry,
      ),
    ).resolves.toBeUndefined();
  });
});

function makeCapability(overrides: Record<string, unknown> = {}) {
  return defineCapability({
    title: "Capability",
    description: "A capability.",
    input: { type: "object", properties: {}, additionalProperties: false },
    output: { type: "object", properties: {} },
    effect: "read",
    async run() {
      return {};
    },
    ...overrides,
  } as Parameters<typeof defineCapability>[0]);
}

describe("resolveStaticOutputPath", () => {
  const clientDir = resolve("/tmp/pracht-app/dist/client");

  it("resolves paths inside the published directory", () => {
    expect(resolveStaticOutputPath(clientDir, "/_pracht/state/docs/a/index.json")).toBe(
      resolve(clientDir, "_pracht/state/docs/a/index.json"),
    );
  });

  it("rejects traversal", () => {
    expect(() => resolveStaticOutputPath(clientDir, "/../../secrets.json")).toThrow(/outside/);
  });

  it("rejects NUL bytes", () => {
    expect(() => resolveStaticOutputPath(clientDir, "/a\0b.json")).toThrow(/NUL byte/);
  });
});

describe("writeStaticBuildOutput", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  function createRoot(): { root: string; clientDir: string } {
    const root = mkdtempSync(join(tmpdir(), "pracht-static-output-"));
    roots.push(root);
    const clientDir = join(root, "dist/client");
    mkdirSync(clientDir, { recursive: true });
    return { root, clientDir };
  }

  const pages: PrerenderResult[] = [
    makePage("/", { routeState: '{"data":{"n":1}}' }),
    makePage("/about", {
      headers: {
        "x-demo": "1",
        "content-type": "text/html",
        vary: "Accept, x-pracht-route-state-request, Origin",
      },
    }),
    makePage("/projects/_", {
      render: "spa",
      fallbackFor: "/projects/:id",
      html: "<html><!--spa--></html>",
    }),
  ];
  const notFound = makePage("/__pracht_not_found__", { render: "not-found" });

  it("writes snapshots, fallbacks, and 404.html", () => {
    const { root, clientDir } = createRoot();

    const output = writeStaticBuildOutput({
      clientDir,
      headersManifest: {
        "/about": {
          "x-demo": "1",
          "content-type": "text/html",
          vary: "Accept, x-pracht-route-state-request, Origin",
        },
      },
      host: "generic",
      notFound,
      pages,
      root,
    });

    expect(output.routeStateCount).toBe(1);
    expect(readFileSync(join(clientDir, "_pracht/state/index.json"), "utf-8")).toBe(
      '{"data":{"n":1}}',
    );
    expect(readFileSync(join(clientDir, "_pracht/spa/projects-id.html"), "utf-8")).toContain("spa");
    expect(readFileSync(join(clientDir, "404.html"), "utf-8")).toContain("not_found");
    expect(output.spaFallbacks).toEqual([
      {
        pattern: "/projects/:id",
        regex: "^/projects/[^/]+/?$",
        destination: "/_pracht/spa/projects-id.html",
      },
    ]);

    // The manifest stays out of the published directory.
    const manifest = JSON.parse(
      readFileSync(join(root, "dist/server/static-manifest.json"), "utf-8"),
    );
    expect(manifest.notFound).toBe("/404.html");
    expect(manifest.headers[0].headers["x-content-type-options"]).toBe("nosniff");
    // Entity headers belong to whoever serves the file.
    const aboutRule = manifest.headers.find((rule: { source: string }) => rule.source === "/about");
    expect(aboutRule.headers).toEqual({ "x-demo": "1", vary: "Origin" });
  });

  it("writes Netlify _headers and _redirects", () => {
    const { root, clientDir } = createRoot();
    mkdirSync(join(root, ".vercel/output"), { recursive: true });
    writeFileSync(join(root, ".vercel/output/stale.txt"), "stale");
    writeFileSync(join(root, ".vercel/project.json"), "{}\n");

    writeStaticBuildOutput({
      clientDir,
      headersManifest: {},
      host: "netlify",
      notFound,
      pages,
      root,
    });

    expect(readFileSync(join(clientDir, "_redirects"), "utf-8")).toBe(
      "/projects/:id  /_pracht/spa/projects-id.html  200\n",
    );
    const headers = readFileSync(join(clientDir, "_headers"), "utf-8");
    expect(headers).toContain("/*\n  permissions-policy:");
    expect(headers).toContain("/assets/*\n  cache-control: public, max-age=31536000, immutable");
    expect(existsSync(join(root, ".vercel/output"))).toBe(false);
    expect(existsSync(join(root, ".vercel/project.json"))).toBe(true);
  });

  it("writes a functionless Vercel build output", () => {
    const { root, clientDir } = createRoot();

    const output = writeStaticBuildOutput({
      clientDir,
      headersManifest: {},
      host: "vercel",
      notFound,
      pages,
      root,
    });

    expect(output.outputPath).toBe(".vercel/output");
    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8"));
    expect(config.version).toBe(3);
    // Header rules must not consume the request.
    expect(config.routes[0]).toMatchObject({ src: "/(.*)", continue: true });

    const order = config.routes.map((route: Record<string, unknown>) =>
      route.handle ? `handle:${route.handle}` : (route.src as string),
    );
    // A real file under /projects/* has to win over the SPA fallback, so the
    // fallback is only reached once the filesystem has missed.
    expect(order.indexOf("handle:filesystem")).toBeLessThan(order.indexOf("^/projects/[^/]+/?$"));
    expect(order.indexOf("^/projects/[^/]+/?$")).toBeLessThan(order.indexOf("handle:error"));
    expect(config.routes.at(-1)).toEqual({ src: "/(.*)", status: 404, dest: "/404.html" });
    expect(existsSyncSafe(join(root, ".vercel/output/functions"))).toBe(false);
  });

  it("warns that a dynamic SPA route's headers() cannot be applied", () => {
    const { root, clientDir } = createRoot();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeStaticBuildOutput({
      clientDir,
      headersManifest: {},
      host: "generic",
      pages: [
        makePage("/projects/_", {
          render: "spa",
          fallbackFor: "/projects/:id",
          headers: { "x-demo": "1" },
        }),
      ],
      root,
    });

    expect(warn.mock.calls.flat().join(" ")).toContain("/projects/:id");
  });
});

describe("normalizeStaticHost", () => {
  it("keeps known hosts and falls back to generic", () => {
    expect(normalizeStaticHost("netlify")).toBe("netlify");
    expect(normalizeStaticHost("vercel")).toBe("vercel");
    expect(normalizeStaticHost(undefined)).toBe("generic");
    expect(normalizeStaticHost("surge")).toBe("generic");
  });
});

function existsSyncSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EISDIR";
  }
}
