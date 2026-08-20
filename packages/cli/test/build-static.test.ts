import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  isStaticExportBuild,
  resolvePrerenderOutputPath,
  resolveRouteStateOutputPath,
  resolveStaticExportOutputPath,
  validateStaticExport,
  validateStaticExportOutputPaths,
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

  it("fails closed on SPA routes that cannot hydrate their client-only component", async () => {
    const error = await validateStaticExport({
      resolvedApp: {
        routes: [
          { hasLoader: false, path: "/default", render: "spa" },
          { hasLoader: false, hydration: "full", path: "/full", render: "spa" },
          { hasLoader: false, hydration: "islands", path: "/islands", render: "spa" },
          { hasLoader: false, hydration: "none", path: "/none", render: "spa" },
        ],
      },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('/islands (hydration: "islands")');
    expect(message).toContain('/none (hydration: "none")');
    expect(message).not.toContain("/default (");
    expect(message).not.toContain("/full (");
    expect(message).toContain("Static SPA routes must use full hydration");
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

  it("fails closed when a dynamic SPA fallback cannot preserve route or shell head metadata", async () => {
    const serverMod = {
      resolvedApp: {
        routes: [
          {
            file: "/src/routes/item.tsx",
            hasLoader: false,
            path: "/items/:id",
            render: "spa",
            shellFile: "/src/shells/site.tsx",
          },
        ],
      },
      registry: {
        routeModules: {
          "/src/routes/item.tsx": async () => ({ Component: () => null }),
        },
        shellModules: {
          "/src/shells/site.tsx": async () => ({ head: () => ({ title: "Item" }) }),
        },
      },
      staticExportConfig: { fallback: "200.html" },
    };

    await expect(validateStaticExport(serverMod)).rejects.toThrow(/fallbackHead/);
    await expect(
      validateStaticExport({
        ...serverMod,
        staticExportConfig: { fallback: "200.html", fallbackHead: { title: "Shared" } },
      }),
    ).resolves.toBeUndefined();
  });

  it("requires shared fallback metadata when the not-found page declares head", async () => {
    await expect(
      validateStaticExport({
        resolvedApp: {
          notFound: { file: "/src/routes/not-found.tsx", path: "/__pracht-not-found__" },
          routes: [{ path: "/", render: "ssg" }],
        },
        registry: {
          routeModules: {
            "/src/routes/not-found.tsx": async () => ({ head: () => ({ title: "Missing" }) }),
          },
        },
        staticExportConfig: { fallback: "200.html" },
      }),
    ).rejects.toThrow(/not-found\.tsx/);
  });

  it("fails closed on a sub-path Vite base", async () => {
    const error = await validateStaticExport({
      buildBase: "/app/",
      resolvedApp: { routes: [{ path: "/", render: "ssg" }] },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"/app/"');
    expect((error as Error).message).toContain("root-relative");
  });

  it("accepts the default base, however it is spelled by the bundle", async () => {
    await expect(
      validateStaticExport({
        buildBase: "/",
        resolvedApp: { routes: [{ path: "/", render: "ssg" }] },
      }),
    ).resolves.toBeUndefined();
    // Bundles built before `buildBase` existed carry no value at all.
    await expect(
      validateStaticExport({ resolvedApp: { routes: [{ path: "/", render: "ssg" }] } }),
    ).resolves.toBeUndefined();
  });

  it("fails fast when a custom static target omits required artifact renderers", async () => {
    const error = await validateStaticExport({
      staticTarget: true,
      resolvedApp: {
        notFound: { path: "/__pracht-not-found__" },
        routes: [{ path: "/", render: "ssg" }],
      },
      staticExportConfig: { fallback: "200.html", fallbackHead: {} },
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("renderStaticNotFoundHtml");
    expect((error as Error).message).toContain("renderStaticFallbackHtml");
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

describe("validateStaticExportOutputPaths", () => {
  it("rejects concrete getStaticPaths output in the reserved namespace", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/_PRACHT/state/owned" }], {
        resolvedApp: { routes: [{ path: "/:section/:slug", render: "ssg" }] },
      }),
    ).toThrow(/reserved \/_pracht\/ output namespace/);
  });

  it("preflights fixed fallback artifact collisions", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/200.html/nested" }], {
        resolvedApp: { routes: [] },
        staticExportConfig: { fallback: "200.html" },
      }),
    ).toThrow(/conflicts with dist\/client\/200.html/);
  });

  it("rejects pages that collide on case-insensitive filesystems", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/Docs" }, { path: "/docs" }], {
        resolvedApp: { routes: [] },
      }),
    ).toThrow(
      /\/Docs and \/docs map to the same case-insensitive output path dist\/client\/docs\/index\.html/,
    );
  });

  it("rejects Windows-incompatible output components", () => {
    for (const path of ["/docs.", "/docs ", "/CON", "/aux.txt", "/bad<name"]) {
      expect(() =>
        validateStaticExportOutputPaths([{ path }], {
          resolvedApp: { routes: [] },
        }),
      ).toThrow(/not a portable Windows filename/);
    }
  });

  it("rejects output components that exceed portable filesystem limits", () => {
    for (const path of [`/${"a".repeat(256)}`, `/${"é".repeat(128)}`]) {
      expect(() =>
        validateStaticExportOutputPaths([{ path }], {
          resolvedApp: { routes: [] },
        }),
      ).toThrow(/portable 255-byte\/code-unit filename limit/);
    }
  });

  it("rejects Unicode-normalization-equivalent output paths", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/caf\u00e9" }, { path: "/cafe\u0301" }], {
        resolvedApp: { routes: [] },
      }),
    ).toThrow(/map to the same case-insensitive output path/);
  });

  it("rejects page output file and directory conflicts", () => {
    for (const pages of [
      [{ path: "/" }, { path: "/index.html" }],
      [{ path: "/guide" }, { path: "/guide/index.html" }],
    ]) {
      expect(() =>
        validateStaticExportOutputPaths(pages, {
          resolvedApp: { routes: [] },
        }),
      ).toThrow(/to be both a file and a directory/);
    }
  });

  it("allows nested routes whose output files do not conflict", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/docs" }, { path: "/docs/start" }], {
        resolvedApp: { routes: [] },
      }),
    ).not.toThrow();
  });
});

describe("resolveStaticExportOutputPath", () => {
  const clientDir = `${sep}tmp${sep}client`;

  it("writes pages to the decoded path a host actually looks up", () => {
    expect(resolveStaticExportOutputPath(clientDir, "/posts/caf%C3%A9")).toBe(
      resolve(clientDir, "posts/café/index.html"),
    );
    expect(resolveStaticExportOutputPath(clientDir, "/posts/a%20b")).toBe(
      resolve(clientDir, "posts/a b/index.html"),
    );
    expect(resolveStaticExportOutputPath(clientDir, "/posts/100%25off")).toBe(
      resolve(clientDir, "posts/100%off/index.html"),
    );
  });

  it("leaves unencoded paths untouched", () => {
    expect(resolveStaticExportOutputPath(clientDir, "/")).toBe(resolve(clientDir, "index.html"));
    expect(resolveStaticExportOutputPath(clientDir, "/blog/hello")).toBe(
      resolve(clientDir, "blog/hello/index.html"),
    );
  });

  it("does not change the serverful adapters, whose static lookup matches the raw pathname", () => {
    expect(resolvePrerenderOutputPath(clientDir, "/posts/caf%C3%A9")).toBe(
      resolve(clientDir, "posts/caf%C3%A9/index.html"),
    );
  });

  it("rejects escapes that would decode into a path separator", () => {
    expect(() => resolveStaticExportOutputPath(clientDir, "/posts/a%2Fb")).toThrow(
      /decodes to a path separator/,
    );
    expect(() => resolveStaticExportOutputPath(clientDir, "/posts/a%5Cb")).toThrow(
      /decodes to a path separator/,
    );
  });

  it("rejects escapes that would decode into a relative segment", () => {
    expect(() => resolveStaticExportOutputPath(clientDir, "/posts/%2E%2E")).toThrow(
      /decodes to a relative path segment/,
    );
  });

  it("rejects malformed percent-encoding instead of writing the literal form", () => {
    expect(() => resolveStaticExportOutputPath(clientDir, "/posts/50%")).toThrow(
      /is not valid percent-encoding/,
    );
  });
});

describe("decodeStaticOutputPath", () => {
  it("is applied by the reserved-namespace guard in both spellings", () => {
    for (const path of ["/_pracht/state/x", "/%5Fpracht/state/x"]) {
      expect(() => validateStaticExportOutputPaths([{ path }], {})).toThrow(
        /reserved \/_pracht\/ output namespace/,
      );
    }
  });

  it("is applied by the fixed-artifact guard in both spellings", () => {
    for (const path of ["/404.html", "/404%2Ehtml"]) {
      expect(() =>
        validateStaticExportOutputPaths([{ path }], {
          resolvedApp: { notFound: { path: "/__pracht-not-found__" } },
        }),
      ).toThrow(/conflicts with dist\/client\/404\.html/);
    }
  });

  it("makes the encoded and decoded spelling of a page collide", () => {
    expect(() =>
      validateStaticExportOutputPaths([{ path: "/posts/café" }, { path: "/posts/caf%C3%A9" }], {}),
    ).toThrow(/map to the same case-insensitive output path/);
  });
});

describe("resolveRouteStateOutputPath", () => {
  it("mirrors the client URL scheme", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(resolveRouteStateOutputPath(clientDir, "/")).toBe(
      resolve(clientDir, "_pracht/state/index.json"),
    );
    expect(resolveRouteStateOutputPath(clientDir, "/blog/hello")).toBe(
      resolve(clientDir, "_pracht/state/s-0062006c006f0067/s-00680065006c006c006f/_state.json"),
    );
  });

  it("encodes percent-encoded params inside the state tree", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(resolveRouteStateOutputPath(clientDir, "/posts/caf%C3%A9")).toBe(
      resolve(
        clientDir,
        "_pracht/state/s-0070006f007300740073/s-006300610066002500430033002500410039/_state.json",
      ),
    );
  });

  it("keeps long route segments within filesystem component limits", () => {
    const clientDir = createTempDir();
    const routePath = `/${"a".repeat(64)}`;
    const outputPath = resolveRouteStateOutputPath(clientDir, routePath);

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "{}", "utf-8");

    expect(readFileSync(outputPath, "utf-8")).toBe("{}");
    expect(
      Math.max(
        ...relative(clientDir, outputPath)
          .split(sep)
          .map((part) => Buffer.byteLength(part)),
      ),
    ).toBeLessThan(256);
  });

  it("keeps path-like route segments distinct and inside the state tree", () => {
    const clientDir = `${sep}tmp${sep}client`;
    const parent = resolveRouteStateOutputPath(clientDir, "/docs");
    const child = resolveRouteStateOutputPath(clientDir, "/docs/index.json");
    expect(parent).not.toBe(child);
    expect(parent.startsWith(resolve(clientDir, "_pracht/state"))).toBe(true);
    expect(child.startsWith(resolve(clientDir, "_pracht/state"))).toBe(true);
  });

  it("refuses NUL bytes and backslashes", () => {
    const clientDir = `${sep}tmp${sep}client`;
    expect(() => resolveRouteStateOutputPath(clientDir, "/a\0b")).toThrow(/unsafe/);
    expect(() => resolveRouteStateOutputPath(clientDir, "/a\\b")).toThrow(/unsafe/);
  });
});

describe("writeStaticExportArtifacts", () => {
  it("fails before writing when a custom static target omits the not-found renderer", async () => {
    const clientDir = createTempDir();

    await expect(
      writeStaticExportArtifacts({
        clientDir,
        pages: [{ path: "/", routeState: "{}" }],
        serverMod: {
          resolvedApp: { routes: [], notFound: { path: "/*" } },
          staticExportConfig: { fallback: null },
        },
        log: () => {},
      }),
    ).rejects.toThrow(/does not export renderStaticNotFoundHtml/);
    expect(existsSync(resolveRouteStateOutputPath(clientDir, "/"))).toBe(false);
  });

  it("fails before writing when a custom static target omits the fallback renderer", async () => {
    const clientDir = createTempDir();

    await expect(
      writeStaticExportArtifacts({
        clientDir,
        pages: [{ path: "/", routeState: "{}" }],
        serverMod: {
          resolvedApp: { routes: [] },
          staticExportConfig: { fallback: "200.html" },
          renderStaticNotFoundHtml: async () => null,
        },
        log: () => {},
      }),
    ).rejects.toThrow(/does not export renderStaticFallbackHtml/);
    expect(existsSync(resolveRouteStateOutputPath(clientDir, "/"))).toBe(false);
  });

  it("refuses to overwrite a public file at a generated route-state path", async () => {
    const clientDir = createTempDir();
    const statePath = resolveRouteStateOutputPath(clientDir, "/about");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "public-owned", "utf-8");

    await expect(
      writeStaticExportArtifacts({
        clientDir,
        pages: [{ path: "/about", routeState: '{"data":"framework"}' }],
        serverMod: { staticExportConfig: { fallback: null } },
        log: () => {},
      }),
    ).rejects.toThrow(/would overwrite _pracht\/state/);
    expect(readFileSync(statePath, "utf-8")).toBe("public-owned");
  });

  it.each([
    {
      fileName: "404.html",
      serverMod: {
        staticExportConfig: { fallback: null },
        renderStaticNotFoundHtml: async () => "<!DOCTYPE html><html><body>404</body></html>",
      },
    },
    {
      fileName: "200.html",
      serverMod: {
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () => null,
        renderStaticFallbackHtml: async () => "<!DOCTYPE html><html><body>fallback</body></html>",
      },
    },
  ])(
    "refuses to overwrite a public file at generated $fileName",
    async ({ fileName, serverMod }) => {
      const clientDir = createTempDir();
      const conflictPath = resolve(clientDir, fileName);
      writeFileSync(conflictPath, "public-owned", "utf-8");

      await expect(
        writeStaticExportArtifacts({
          clientDir,
          pages: [{ path: "/about", routeState: '{"data":"framework"}' }],
          serverMod,
          log: () => {},
        }),
      ).rejects.toThrow(/fixed artifact output conflicts/);
      expect(readFileSync(conflictPath, "utf-8")).toBe("public-owned");
      expect(existsSync(resolveRouteStateOutputPath(clientDir, "/about"))).toBe(false);
    },
  );

  it("writes state files, 404.html, and the configured fallback", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];
    let fallbackNotFoundState: unknown;

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
          '<!DOCTYPE html><html><body>404<script id="pracht-state" type="application/json">{"data":{"message":"Built custom 404"},"error":{"message":"Missing","name":"PrachtHttpError","status":404}}</script></body></html>',
        renderStaticFallbackHtml: (notFoundState) => {
          fallbackNotFoundState = notFoundState;
          return "<!DOCTYPE html><html><body>fallback</body></html>";
        },
      },
      log: (message) => logs.push(message),
    });

    expect(result).toEqual({ stateFileCount: 2, wrote404: true, fallbackFile: "200.html" });
    expect(readFileSync(resolve(clientDir, "_pracht/state/index.json"), "utf-8")).toBe(
      '{"data":{"a":1}}',
    );
    expect(readFileSync(resolveRouteStateOutputPath(clientDir, "/about"), "utf-8")).toBe(
      '{"data":{"b":2}}',
    );
    expect(existsSync(resolveRouteStateOutputPath(clientDir, "/plain"))).toBe(false);
    expect(readFileSync(resolve(clientDir, "404.html"), "utf-8")).toContain("404");
    expect(readFileSync(resolve(clientDir, "200.html"), "utf-8")).toContain("fallback");
    expect(fallbackNotFoundState).toEqual({
      data: { message: "Built custom 404" },
      error: { message: "Missing", name: "PrachtHttpError", status: 404 },
    });
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

  it("warns when the fallback has no notFound page and no catch-all to render", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];

    await writeStaticExportArtifacts({
      clientDir,
      pages: [],
      serverMod: {
        resolvedApp: {
          routes: [
            { path: "/", render: "ssg" },
            { path: "/:slug", render: "spa" },
          ],
        },
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () => null,
        renderStaticFallbackHtml: () => "<html></html>",
      },
      log: (message) => logs.push(message),
    });

    const output = logs.join("\n");
    expect(output).toContain("no unshadowed client-routable SPA catch-all matches every URL");
    expect(output).toContain("empty document with status 200");
  });

  it("stays quiet when a root splat can render every unmatched URL", async () => {
    for (const catchAllPath of ["/*", "/:rest*"]) {
      const clientDir = createTempDir();
      const logs: string[] = [];

      await writeStaticExportArtifacts({
        clientDir,
        pages: [],
        serverMod: {
          resolvedApp: { routes: [{ path: catchAllPath, render: "spa" }] },
          staticExportConfig: { fallback: "200.html" },
          renderStaticNotFoundHtml: async () => null,
          renderStaticFallbackHtml: () => "<html></html>",
        },
        log: (message) => logs.push(message),
      });

      expect(logs.join("\n")).not.toContain(
        "no unshadowed client-routable SPA catch-all matches every URL",
      );
    }
  });

  it("warns when only an SSG root splat matches every unmatched URL", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];

    await writeStaticExportArtifacts({
      clientDir,
      pages: [],
      serverMod: {
        resolvedApp: { routes: [{ path: "/*", render: "ssg" }] },
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () => null,
        renderStaticFallbackHtml: () => "<html></html>",
      },
      log: (message) => logs.push(message),
    });

    expect(logs.join("\n")).toContain(
      "no unshadowed client-routable SPA catch-all matches every URL",
    );
  });

  it("warns when an earlier dynamic SSG route shadows the SPA catch-all", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];

    await writeStaticExportArtifacts({
      clientDir,
      pages: [],
      serverMod: {
        resolvedApp: {
          routes: [
            { path: "/posts/:slug", render: "ssg" },
            { path: "/*", render: "spa" },
          ],
        },
        staticExportConfig: { fallback: "200.html" },
        renderStaticNotFoundHtml: async () => null,
        renderStaticFallbackHtml: () => "<html></html>",
      },
      log: (message) => logs.push(message),
    });

    expect(logs.join("\n")).toContain(
      "no unshadowed client-routable SPA catch-all matches every URL",
    );
  });

  it("warns when the SPA catch-all cannot hydrate in the fallback document", async () => {
    for (const hydration of ["islands", "none"]) {
      const clientDir = createTempDir();
      const logs: string[] = [];

      await writeStaticExportArtifacts({
        clientDir,
        pages: [],
        serverMod: {
          resolvedApp: { routes: [{ path: "/*", render: "spa", hydration }] },
          staticExportConfig: { fallback: "200.html" },
          renderStaticNotFoundHtml: async () => null,
          renderStaticFallbackHtml: () => "<html></html>",
        },
        log: (message) => logs.push(message),
      });

      expect(logs.join("\n")).toContain(
        "no unshadowed client-routable SPA catch-all matches every URL",
      );
    }
  });

  it("rejects route directories that collide with 404.html or the SPA fallback", async () => {
    for (const routePath of ["/404.html", "/404.html/nested", "/200.html"]) {
      const clientDir = createTempDir();
      await expect(
        writeStaticExportArtifacts({
          clientDir,
          pages: [{ path: routePath }],
          serverMod: {
            resolvedApp: {
              notFound: { path: "/__pracht-not-found__" },
              routes: [],
            },
            staticExportConfig: { fallback: "200.html" },
          },
          log: () => {},
        }),
      ).rejects.toThrow(new RegExp(`${routePath.replaceAll("/", "\\/")} conflicts`));
    }
  });

  it("writes percent-encoded prerender paths to their decoded output path", async () => {
    const clientDir = createTempDir();
    const logs: string[] = [];

    await writeStaticExportArtifacts({
      clientDir,
      pages: [
        { path: "/posts/hello", routeState: '{"data":{}}' },
        { path: "/posts/caf%C3%A9", routeState: '{"data":{}}' },
      ],
      serverMod: { staticExportConfig: { fallback: null } },
      log: (message) => logs.push(message),
    });

    // The state tree still keys off the raw (encoded) pathname, because that
    // is what the client derives from location.pathname.
    expect(existsSync(resolveRouteStateOutputPath(clientDir, "/posts/caf%C3%A9"))).toBe(true);
    expect(logs.join("\n")).not.toContain("decode URLs before the filesystem lookup");
  });
});
