import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isStaticExportBuild,
  resolveRouteStateOutputPath,
  validateStaticExport,
  writeStaticExportArtifacts,
} from "../src/build-static.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-build-static-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("validateStaticExport", () => {
  it("accepts an app with only ssg/spa routes, no API routes, no exposed capabilities", async () => {
    await expect(
      validateStaticExport({
        resolvedApp: {
          capabilities: {
            private: "/src/capabilities/private.ts",
          },
          routes: [
            { hasLoader: true, middlewareFiles: [], path: "/", render: "ssg" },
            { hasLoader: false, middlewareFiles: [], path: "/app", render: "spa" },
          ],
        },
        apiRoutes: [],
        registry: {
          capabilityModules: {
            "/src/capabilities/private.ts": async () => ({
              default: { expose: null },
            }),
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed on ssr and isg routes, naming each one", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        routes: [
          { path: "/", render: "ssg" },
          { path: "/dashboard", render: "ssr" },
          { path: "/pricing", render: "isg" },
          // No render at all defaults to SSR at request time.
          { path: "/implicit" },
        ],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("/dashboard");
    expect(message).toContain('render: "ssr"');
    expect(message).toContain("/pricing");
    expect(message).toContain('render: "isg"');
    expect(message).toContain("/implicit");
    expect(message).toContain("@pracht/adapter-node");
    expect(message).not.toContain("- / (");
  });

  it("fails closed on SPA loaders, including routes whose loader status is unknown", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        routes: [
          { hasLoader: false, path: "/client-only", render: "spa" },
          { hasLoader: true, path: "/with-loader", render: "spa" },
          { path: "/unknown-loader", render: "spa" },
        ],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("/with-loader");
    expect(message).toContain("/unknown-loader");
    expect(message).not.toContain("/client-only");
    expect(message).toContain("Static SPA routes must be loaderless");
  });

  it("fails closed on route middleware for SSG and SPA routes", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        routes: [
          {
            hasLoader: true,
            middlewareFiles: ["/src/middleware/content.ts"],
            path: "/article",
            render: "ssg",
          },
          {
            hasLoader: false,
            middlewareFiles: ["/src/middleware/auth.ts"],
            path: "/dashboard",
            render: "spa",
          },
        ],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("/article");
    expect(message).toContain("/dashboard");
    expect(message).toContain("static host has no request runtime");
  });

  it("fails closed on notFound middleware", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        notFound: {
          middlewareFiles: ["/src/middleware/auth.ts"],
          path: "/__pracht-not-found__",
          render: "ssg",
        },
        routes: [{ hasLoader: false, middlewareFiles: [], path: "/", render: "spa" }],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/__pracht-not-found__");
    expect((error as Error).message).toContain("static host has no request runtime");
  });

  it("fails closed when notFound cannot adopt the requested URL", async () => {
    for (const hydration of ["islands", "none"] as const) {
      const error = await validateStaticExport({
        resolvedApp: {
          notFound: {
            hydration,
            middlewareFiles: [],
            path: "/__pracht-not-found__",
            render: "ssr",
          },
          routes: [{ hasLoader: false, middlewareFiles: [], path: "/", render: "ssg" }],
        },
      }).catch((thrown: Error) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`hydration: "${hydration}"`);
      expect((error as Error).message).toContain("must use full hydration");
      expect((error as Error).message).toContain("real URL");
    }
  });

  it("fails closed on API routes", async () => {
    const error = await validateStaticExport({
      resolvedApp: { routes: [{ path: "/", render: "ssg" }] },
      apiRoutes: [{ path: "/api/health" }, { path: "/api/users/:id" }],
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/api/health");
    expect((error as Error).message).toContain("/api/users/:id");
  });

  it("fails closed on capabilities exposed over http/mcp/webmcp", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        capabilities: {
          "notes.search": "./capabilities/search.ts",
          "notes.private": "./capabilities/private.ts",
        },
        routes: [{ path: "/", render: "ssg" }],
      },
      registry: {
        capabilityModules: {
          "/src/capabilities/search.ts": async () => ({
            default: { expose: { http: { method: "POST" }, mcp: true, webmcp: false } },
          }),
          "/src/capabilities/private.ts": async () => ({
            default: { expose: null },
          }),
        },
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("notes.search");
    expect((error as Error).message).toContain("./capabilities/search.ts");
    expect((error as Error).message).toContain("http, mcp");
    expect((error as Error).message).not.toContain("notes.private");
  });

  it("ignores capability files that are not registered in the app manifest", async () => {
    await expect(
      validateStaticExport({
        resolvedApp: { capabilities: {}, routes: [{ path: "/", render: "ssg" }] },
        registry: {
          capabilityModules: {
            "/src/capabilities/unused.ts": async () => ({
              default: { expose: { http: true } },
            }),
          },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a registered capability cannot be imported", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        capabilities: { "notes.search": "/src/capabilities/search.ts" },
        routes: [{ path: "/", render: "ssg" }],
      },
      registry: {
        capabilityModules: {
          "/src/capabilities/search.ts": async () => {
            throw new Error("missing build environment");
          },
        },
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("notes.search");
    expect((error as Error).message).toContain("missing build environment");
    expect((error as Error).message).toContain("cannot be validated safely");
  });

  it("fails closed when a registered capability module is missing", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        capabilities: { "notes.search": "/src/capabilities/search.ts" },
        routes: [{ path: "/", render: "ssg" }],
      },
      registry: { capabilityModules: {} },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("registered module was not found");
  });

  it("fails closed when a registered module has no default capability export", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        capabilities: { "notes.search": "/src/capabilities/search.ts" },
        routes: [{ path: "/", render: "ssg" }],
      },
      registry: {
        capabilityModules: {
          "/src/capabilities/search.ts": async () => ({}),
        },
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("module has no default capability export");
  });

  it("fails closed on routes under the reserved /_pracht namespace", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        routes: [{ path: "/_pracht/state/sneaky", render: "ssg" }],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("/_pracht/state/sneaky");
    expect((error as Error).message).toContain("reserved");
  });

  it("aggregates every problem into one error", async () => {
    const error = await validateStaticExport({
      resolvedApp: { routes: [{ path: "/x", render: "ssr" }] },
      apiRoutes: [{ path: "/api/x" }],
    }).catch((thrown: Error) => thrown);

    const message = (error as Error).message;
    expect(message).toContain("/x");
    expect(message).toContain("/api/x");
  });
});

describe("isStaticExportBuild", () => {
  it("uses the adapter's staticTarget metadata instead of its id", () => {
    expect(isStaticExportBuild({ staticTarget: true })).toBe(true);
    expect(isStaticExportBuild({ staticTarget: false })).toBe(false);
    expect(isStaticExportBuild({})).toBe(false);
  });
});

describe("resolveRouteStateOutputPath", () => {
  it("mirrors the client URL scheme", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(resolveRouteStateOutputPath(clientDir, "/")).toBe(
      resolve(clientDir, "_pracht/state/index.json"),
    );
    expect(resolveRouteStateOutputPath(clientDir, "/blog/hello")).toBe(
      resolve(clientDir, "_pracht/state/blog/hello/index.json"),
    );
  });

  it("keeps percent-encoded params inside the state tree", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(resolveRouteStateOutputPath(clientDir, "/posts/caf%C3%A9")).toBe(
      resolve(clientDir, "_pracht/state/posts/caf%C3%A9/index.json"),
    );
  });

  it("refuses traversal out of the state tree", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(() => resolveRouteStateOutputPath(clientDir, "/../../etc/passwd")).toThrow(/outside/);
    expect(() => resolveRouteStateOutputPath(clientDir, "/..")).toThrow(/outside/);
  });

  it("refuses NUL bytes and backslashes", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(() => resolveRouteStateOutputPath(clientDir, "/a\0b")).toThrow(/unsafe/);
    expect(() => resolveRouteStateOutputPath(clientDir, "/a\\b")).toThrow(/unsafe/);
  });
});

describe("writeStaticExportArtifacts", () => {
  it("writes state files, 404.html, and the configured fallback", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];
    let fallbackNotFoundData: unknown;

    const result = await writeStaticExportArtifacts({
      clientDir,
      pages: [
        { path: "/", routeState: '{"data":{"a":1}}' },
        { path: "/about", routeState: '{"data":{"b":2}}' },
        { path: "/plain" },
      ],
      serverMod: {
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () =>
          '<!DOCTYPE html><html><body>404<script id="pracht-state" type="application/json">{"data":{"message":"Built custom 404"}}</script></body></html>',
        renderStaticFallbackHtml: (notFoundData) => {
          fallbackNotFoundData = notFoundData;
          return "<!DOCTYPE html><html><body>fallback</body></html>";
        },
      },
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ stateFileCount: 2, wrote404: true, fallbackFile: "200.html" });
    expect(readFileSync(resolve(clientDir, "_pracht/state/index.json"), "utf-8")).toBe(
      '{"data":{"a":1}}',
    );
    expect(readFileSync(resolve(clientDir, "_pracht/state/about/index.json"), "utf-8")).toBe(
      '{"data":{"b":2}}',
    );
    expect(existsSync(resolve(clientDir, "_pracht/state/plain/index.json"))).toBe(false);
    expect(readFileSync(resolve(clientDir, "404.html"), "utf-8")).toContain("404");
    expect(readFileSync(resolve(clientDir, "200.html"), "utf-8")).toContain("fallback");
    expect(fallbackNotFoundData).toEqual({ message: "Built custom 404" });
  });

  it("skips 404.html when the app has no notFound page, and the fallback when unconfigured", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];

    const result = await writeStaticExportArtifacts({
      clientDir,
      pages: [],
      serverMod: {
        staticExportConfig: { fallback: null },
        renderStaticNotFoundHtml: async () => null,
        renderStaticFallbackHtml: () => "<html></html>",
      },
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ stateFileCount: 0, wrote404: false, fallbackFile: null });
    expect(existsSync(resolve(clientDir, "404.html"))).toBe(false);
    expect(existsSync(resolve(clientDir, "200.html"))).toBe(false);
    expect(logs.join("\n")).toContain("No 404.html emitted");
  });
});
