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

import { writeVercelBuildOutput } from "../src/build-shared.ts";

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

  it("nests static output and prerender routes beneath a deploy base", () => {
    const root = createBuildRoot();
    mkdirSync(join(root, "dist/client/assets"), { recursive: true });
    mkdirSync(join(root, "dist/client/guide"), { recursive: true });
    writeFileSync(join(root, "dist/client/assets/app.js"), "asset", "utf-8");
    writeFileSync(join(root, "dist/client/guide/index.html"), "guide", "utf-8");

    writeVercelBuildOutput({
      base: "/app/",
      isgManifest: { "/pricing": { revalidate: timeRevalidate(60) } },
      root,
      staticRoutes: ["/", "/guide"],
    });

    const outputRoot = join(root, ".vercel/output");
    expect(readFileSync(join(outputRoot, "static/app/assets/app.js"), "utf-8")).toBe("asset");
    expect(readFileSync(join(outputRoot, "static/app/guide/index.html"), "utf-8")).toBe("guide");
    expect(existsSync(join(outputRoot, "functions/app/pricing.func"))).toBe(true);
    expect(existsSync(join(outputRoot, "functions/app/pricing.prerender-config.json"))).toBe(true);

    const config = JSON.parse(readFileSync(join(outputRoot, "config.json"), "utf-8")) as {
      routes: Array<{ dest?: string; src?: string }>;
    };
    expect(config.routes).toContainEqual({ dest: "/app/guide/index.html", src: "^/app/guide/?$" });
    expect(config.routes).toContainEqual({ dest: "/app/pricing", src: "^/app/pricing/?$" });
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
