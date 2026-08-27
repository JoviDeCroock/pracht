import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { timeRevalidate } from "@pracht/core";
import { afterEach, describe, expect, it } from "vitest";

import { resolveVercelRuntimeRoutes, writeVercelBuildOutput } from "../src/build-shared.ts";

describe("writeVercelBuildOutput", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  function createBuildRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "pracht-vercel-build-output-"));
    roots.push(root);
    mkdirSync(join(root, "dist/client"), { recursive: true });
    mkdirSync(join(root, "dist/server"), { recursive: true });
    writeFileSync(join(root, "dist/server/server.js"), "export default {}\n", "utf-8");
    return root;
  }

  it("routes markdown-preferring requests for markdown routes to the function", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: {},
      markdownRoutes: ["/guide"],
      root,
      staticRoutes: ["/", "/guide", "/pricing"],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: { dest?: string; has?: unknown[]; src?: string }[];
    };

    const guideRoutes = config.routes.filter((entry) => entry.src === "^/guide/?$");
    // The Accept-conditional entry has to come first, or the static rewrite
    // claims the request and the function never runs.
    expect(guideRoutes).toEqual([
      {
        dest: "/render",
        has: [
          {
            type: "header",
            key: "accept",
            value: ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*",
          },
        ],
        src: "^/guide/?$",
      },
      { dest: "/guide/index.html", src: "^/guide/?$" },
    ]);

    // Routes without a `markdown` export keep their static fast path whatever
    // the client sends.
    for (const src of ["^/$", "^/pricing/?$"]) {
      expect(config.routes.filter((entry) => entry.src === src)).toHaveLength(1);
    }
  });

  it("emits markdown routing only for routes that export markdown", () => {
    const withMarkdown = createBuildRoot();
    const withoutMarkdown = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: {},
      markdownRoutes: ["/guide"],
      root: withMarkdown,
      staticRoutes: ["/", "/guide"],
    });
    writeVercelBuildOutput({
      isgManifest: {},
      root: withoutMarkdown,
      staticRoutes: ["/", "/guide"],
    });

    const routesJson = (root: string) =>
      readFileSync(join(root, ".vercel/output/config.json"), "utf-8");

    // Paired: the negative assertion alone would pass with the feature deleted.
    expect(routesJson(withMarkdown)).toContain("mM][aA][rR][kK]");
    expect(routesJson(withoutMarkdown)).not.toContain("mM][aA][rR][kK]");
  });

  it("routes the OAuth-protected MCP surface before method-agnostic static rewrites", () => {
    const root = createBuildRoot();
    const agents = {
      mcp: {
        auth: {
          resource: "https://app.example/mcp",
          authorizationServers: ["https://auth.example"],
          verify: "/src/server/mcp-token.ts",
        },
      },
    } as const;
    writeVercelBuildOutput({
      isgManifest: {},
      root,
      runtimeRoutes: resolveVercelRuntimeRoutes(agents),
      // A prerendered route with any runtime-owned name must lose for both the
      // canonical request and the one-trailing-slash spelling the runtime accepts.
      staticRoutes: [
        "/mcp",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
      ],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: { dest?: string; handle?: string; src?: string }[];
    };
    const filesystemIndex = config.routes.findIndex((route) => route.handle === "filesystem");
    const runtimeRoutes = config.routes.filter(
      (route) =>
        route.dest === "/render" && (route.src?.includes("oauth") || route.src === "^/mcp/?$"),
    );
    expect(runtimeRoutes.map((route) => route.src)).toEqual([
      "^/\\.well\\-known/oauth\\-protected\\-resource/mcp/?$",
      "^/\\.well\\-known/oauth\\-protected\\-resource/?$",
      "^/mcp/?$",
    ]);
    for (const route of runtimeRoutes) {
      const runtimeIndex = config.routes.indexOf(route);
      const shadowingStaticIndex = config.routes.findIndex(
        (candidate, index) => index > runtimeIndex && candidate.src === route.src,
      );
      expect(runtimeIndex).toBeLessThan(shadowingStaticIndex);
      expect(runtimeIndex).toBeLessThan(filesystemIndex);
    }
  });

  it("routes deploy-base-prefixed OAuth metadata aliases before static output", () => {
    const root = createBuildRoot();
    writeVercelBuildOutput({
      base: "/app/",
      isgManifest: {},
      root,
      runtimeRoutes: [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/app/mcp",
      ],
      // These become the proxy-prefixed aliases after the deploy base is
      // applied to prerendered routes.
      staticRoutes: [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/app/mcp",
      ],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: { dest?: string; handle?: string; src?: string }[];
    };
    const filesystemIndex = config.routes.findIndex((route) => route.handle === "filesystem");
    const aliasSources = [
      "^/app/\\.well\\-known/oauth\\-protected\\-resource/app/mcp/?$",
      "^/app/\\.well\\-known/oauth\\-protected\\-resource/?$",
    ];
    const aliasRoutes = config.routes.filter(
      (route) => route.dest === "/render" && aliasSources.includes(route.src ?? ""),
    );
    expect(aliasRoutes.map((route) => route.src)).toEqual(aliasSources);
    for (const route of aliasRoutes) {
      const runtimeIndex = config.routes.indexOf(route);
      const shadowingStaticIndex = config.routes.findIndex(
        (candidate, index) => index > runtimeIndex && candidate.src === route.src,
      );
      expect(runtimeIndex).toBeLessThan(shadowingStaticIndex);
      expect(runtimeIndex).toBeLessThan(filesystemIndex);
    }
  });

  it("emits configured headers for non-HTML static assets without adding page rewrites", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      headersManifest: {
        "/llms.txt": { "content-type": "text/markdown; charset=utf-8" },
      },
      isgManifest: {},
      root,
      staticAssetRoutes: ["/llms.txt"],
      staticRoutes: [],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      headers?: unknown;
      routes: {
        continue?: boolean;
        dest?: string;
        headers?: Record<string, string>;
        src?: string;
      }[];
    };
    expect(config.headers).toBeUndefined();
    expect(config.routes).toContainEqual({
      continue: true,
      headers: { "content-type": "text/markdown; charset=utf-8" },
      src: "^/llms\\.txt$",
    });
    expect(config.routes.some((entry) => entry.dest === "/llms.txt/index.html")).toBe(false);
  });

  it("nests static output and prerender routes beneath a deploy base", () => {
    const root = createBuildRoot();
    mkdirSync(join(root, "dist/client/assets"), { recursive: true });
    mkdirSync(join(root, "dist/client/guide"), { recursive: true });
    writeFileSync(join(root, "dist/client/assets/app.js"), "asset", "utf-8");
    writeFileSync(join(root, "dist/client/guide/index.html"), "guide", "utf-8");

    writeVercelBuildOutput({
      base: "/app/",
      headersManifest: { "/assets/app.js": { "x-test": "yes" } },
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      root,
      staticAssetRoutes: ["/assets/app.js"],
      staticRoutes: ["/", "/guide"],
    });

    const outputRoot = join(root, ".vercel/output");
    expect(readFileSync(join(outputRoot, "static/app/assets/app.js"), "utf-8")).toBe("asset");
    expect(readFileSync(join(outputRoot, "static/app/guide/index.html"), "utf-8")).toBe("guide");
    expect(existsSync(join(outputRoot, "functions/app/pricing.func"))).toBe(true);
    expect(existsSync(join(outputRoot, "functions/app/pricing.prerender-config.json"))).toBe(true);

    const config = JSON.parse(readFileSync(join(outputRoot, "config.json"), "utf-8")) as {
      routes: Array<{
        continue?: boolean;
        dest?: string;
        headers?: Record<string, string>;
        methods?: string[];
        src?: string;
      }>;
    };
    expect(config.routes).toContainEqual({
      dest: "/render",
      methods: ["GET", "HEAD"],
      src: "^/app$",
    });
    expect(config.routes).toContainEqual({ dest: "/app/guide/index.html", src: "^/app/guide/?$" });
    expect(config.routes).toContainEqual({ dest: "/app/pricing", src: "^/app/pricing/?$" });
    expect(config.routes).toContainEqual({
      continue: true,
      headers: { "x-test": "yes" },
      src: "^/app/assets/app\\.js$",
    });
  });

  it("rejects repeated separators instead of changing the public deploy base", () => {
    const root = createBuildRoot();

    expect(() =>
      writeVercelBuildOutput({
        base: "/app//",
        isgManifest: {},
        root,
        staticRoutes: ["/"],
      }),
    ).toThrow(/repeated path separator/);
  });

  it("emits literal PCRE content artifact header routes", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      headersManifest: {
        "/feed+(full).data": { "content-type": "application/json" },
      },
      isgManifest: {},
      root,
      staticAssetRoutes: ["/feed+(full).data"],
      staticRoutes: [],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: { headers?: Record<string, string>; src?: string }[];
    };
    expect(config.routes).toContainEqual({
      continue: true,
      headers: { "content-type": "application/json" },
      src: "^/feed\\+\\(full\\)\\.data$",
    });
  });

  it("preserves generated headers on clean content artifact index aliases", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      root,
      isgManifest: {},
      headersManifest: {
        "/feed": { "content-type": "application/json" },
        "/feed/index.html": { "content-type": "application/json" },
      },
      staticAssetRoutes: ["/feed/index.html"],
      staticRoutes: ["/feed"],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: {
        continue?: boolean;
        dest?: string;
        headers?: Record<string, string>;
        src?: string;
      }[];
    };
    expect(config.routes).toContainEqual({
      continue: true,
      headers: { "content-type": "application/json" },
      src: "^/feed/?$",
    });
    expect(config.routes).toContainEqual({ dest: "/feed/index.html", src: "^/feed/?$" });
  });

  it("routes ISG markdown routes to the render function, not the prerender function", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      functionName: "ssr-handler",
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      markdownRoutes: ["/pricing"],
      root,
      staticRoutes: ["/"],
    });

    const config = JSON.parse(readFileSync(join(root, ".vercel/output/config.json"), "utf-8")) as {
      routes: { dest?: string; has?: unknown[]; src?: string }[];
    };

    // The prerender function re-renders on a sanitized `Accept: text/html` to
    // keep its shared cache entry correct, so it can only ever produce HTML —
    // markdown has to reach the render function instead.
    expect(config.routes.filter((entry) => entry.src === "^/pricing/?$")).toEqual([
      {
        dest: "/ssr-handler",
        has: [
          {
            type: "header",
            key: "accept",
            value: ".*[tT][eE][xX][tT]/[mM][aA][rR][kK][dD][oO][wW][nN].*",
          },
        ],
        src: "^/pricing/?$",
      },
      { dest: "/pricing", src: "^/pricing/?$" },
    ]);
  });

  it("emits ISG routes as Node serverless functions", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      root,
      staticRoutes: ["/"],
    });

    const functionDir = join(root, ".vercel/output/functions/pricing.func");
    // Vercel fails the deployment when a `.prerender-config.json` sits next to
    // an edge function, so this one has to be a serverless function.
    expect(JSON.parse(readFileSync(join(functionDir, ".vc-config.json"), "utf-8"))).toEqual({
      handler: "_pracht-node-entry.cjs",
      launcherType: "Nodejs",
      runtime: expect.stringMatching(/^nodejs\d+\.x$/),
      shouldAddHelpers: false,
    });
    expect(readFileSync(join(functionDir, "_pracht-node-entry.cjs"), "utf-8")).toContain(
      'await import("./server.js")).nodeListener',
    );
    // Node types a module by its real path, so the bundle has to live inside
    // the function directory next to a `package.json` marking it as ESM.
    expect(lstatSync(join(functionDir, "server.js")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(functionDir, "package.json"), "utf-8"))).toEqual({
      type: "module",
    });
    expect(existsSync(join(root, ".vercel/output/functions/pricing.prerender-config.json"))).toBe(
      true,
    );
    // The main handler stays on the edge.
    expect(
      JSON.parse(
        readFileSync(join(root, ".vercel/output/functions/render.func/.vc-config.json"), "utf-8"),
      ),
    ).toMatchObject({ runtime: "edge" });
  });

  it("normalizes a scalar region for ISG serverless functions", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      regions: "iad1",
      root,
      staticRoutes: [],
    });

    const functionConfig = JSON.parse(
      readFileSync(join(root, ".vercel/output/functions/pricing.func/.vc-config.json"), "utf-8"),
    );
    expect(functionConfig.regions).toEqual(["iad1"]);
  });

  it("keeps the all sentinel on edge and uses the project default for ISG", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      regions: "all",
      root,
      staticRoutes: [],
    });

    const functionsDir = join(root, ".vercel/output/functions");
    const edgeConfig = JSON.parse(
      readFileSync(join(functionsDir, "render.func/.vc-config.json"), "utf-8"),
    );
    const nodeConfig = JSON.parse(
      readFileSync(join(functionsDir, "pricing.func/.vc-config.json"), "utf-8"),
    );
    expect(edgeConfig.regions).toBe("all");
    expect(nodeConfig).not.toHaveProperty("regions");
  });

  it("shares one serverless bundle across ISG routes", () => {
    const root = createBuildRoot();

    writeVercelBuildOutput({
      isgManifest: {
        "/pricing": { revalidate: timeRevalidate(60) },
        "/products/1": { revalidate: timeRevalidate(60) },
      },
      root,
      staticRoutes: [],
    });

    const functionsDir = join(root, ".vercel/output/functions");
    expect(lstatSync(join(functionsDir, "products/1.func")).isSymbolicLink()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(functionsDir, "products/1.func/.vc-config.json"), "utf-8")),
    ).toMatchObject({ launcherType: "Nodejs" });
    expect(existsSync(join(functionsDir, "products/1.prerender-config.json"))).toBe(true);
  });

  it("rejects an ISG route that collides with the default edge function", () => {
    const root = createBuildRoot();

    expect(() =>
      writeVercelBuildOutput({
        isgManifest: {
          "/render": { revalidate: timeRevalidate(60) },
        },
        root,
        staticRoutes: [],
      }),
    ).toThrow(
      'Cannot emit Vercel ISG route "/render" because its prerender function "render.func" collides with the main edge function "render.func".',
    );
    expect(existsSync(join(root, ".vercel/output"))).toBe(false);
  });

  it("rejects an ISG route that collides with a custom edge function name", () => {
    const root = createBuildRoot();

    expect(() =>
      writeVercelBuildOutput({
        functionName: "app",
        isgManifest: {
          "/app": { revalidate: timeRevalidate(60) },
        },
        root,
        staticRoutes: [],
      }),
    ).toThrow(/ISG route "\/app".*"app\.func".*main edge function "app\.func"/);
  });
});
