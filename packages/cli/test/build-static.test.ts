import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
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
          routes: [
            { path: "/", render: "ssg" },
            { path: "/app", render: "spa" },
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
      resolvedApp: { routes: [{ path: "/", render: "ssg" }] },
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
    expect((error as Error).message).toContain("/src/capabilities/search.ts");
    expect((error as Error).message).toContain("http, mcp");
    expect((error as Error).message).not.toContain("/src/capabilities/private.ts");
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

    const result = await writeStaticExportArtifacts({
      clientDir,
      pages: [
        { path: "/", routeState: '{"data":{"a":1}}' },
        { path: "/about", routeState: '{"data":{"b":2}}' },
        { path: "/plain" },
      ],
      serverMod: {
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () => "<!DOCTYPE html><html><body>404</body></html>",
        renderStaticFallbackHtml: () => "<!DOCTYPE html><html><body>fallback</body></html>",
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
