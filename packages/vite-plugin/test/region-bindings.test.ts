import { resolve } from "node:path";

import { build, createServer, type Plugin, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

import {
  buildModuleKey,
  collectBoundRegions,
  computeRegionBindings,
  createDevRegionGraph,
  createRegionBindingsPlugin,
  devModuleKey,
  isRegionKey,
  isRouteOrShellKey,
  REGION_BINDINGS_TOKEN,
  type RegionGraph,
} from "../src/region-bindings.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/region-bindings-app");

const DIRS = {
  regionsDir: "/src/regions",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  pagesDir: "",
};

/**
 * What both the build and the dev server must compute for the fixture:
 *
 * - admin/org import their region directly;
 * - the `site` shell reaches Cart through a shared Header component, and Cart
 *   reaches Nested (a region rendering a region);
 * - news imports a barrel that re-exports Barrelled: bound, conservatively;
 * - lazy reaches Lazy only through `import()`: not bound;
 * - raw imports a region's source text with `?raw`: not bound;
 * - static renders no region.
 */
const EXPECTED = {
  "/src/routes/admin.ts": ["/src/regions/AdminStats.ts"],
  "/src/routes/news.ts": ["/src/regions/Barrelled.ts"],
  "/src/routes/org.ts": ["/src/regions/OrgData.ts"],
  "/src/shells/site.ts": ["/src/regions/Cart.ts", "/src/regions/Nested.ts"],
};

const STARTS = ["admin", "lazy", "news", "org", "raw", "static"].map(
  (name) => `/src/routes/${name}.ts`,
);

/** A graph from an adjacency list keyed by glob-style keys. */
function graphOf(edges: Record<string, string[]>): RegionGraph {
  return {
    keyOf: devModuleKey,
    staticImports: (id) => edges[id] ?? [],
  };
}

describe("region binding walk", () => {
  it("follows static imports through components, barrels, cycles, and nested regions", async () => {
    const graph = graphOf({
      "/src/routes/a.tsx": ["/src/components/Nav.tsx", "preact"],
      "/src/components/Nav.tsx": ["/src/components/index.ts", "/src/routes/a.tsx"],
      "/src/components/index.ts": ["/src/regions/Cart.tsx"],
      "/src/regions/Cart.tsx": ["/src/regions/Badge.tsx"],
    });

    expect(await collectBoundRegions("/src/routes/a.tsx", graph, "/src/regions")).toEqual([
      "/src/regions/Badge.tsx",
      "/src/regions/Cart.tsx",
    ]);
  });

  it("never enters dependencies, virtual modules, or files outside the root", async () => {
    // Each of these imports every region, the way the generated server module
    // does; entering one would bind them all.
    const everything = ["/src/regions/Admin.tsx"];
    const graph = graphOf({
      "/src/routes/a.tsx": [
        "/@id/__x00__virtual:pracht/server",
        "/@fs/elsewhere/lib.ts",
        "/node_modules/pkg/index.js",
        "some-package",
      ],
      "/@id/__x00__virtual:pracht/server": everything,
      "/@fs/elsewhere/lib.ts": everything,
      "/node_modules/pkg/index.js": everything,
      "some-package": everything,
    });

    expect(await collectBoundRegions("/src/routes/a.tsx", graph, "/src/regions")).toEqual([]);
  });

  it("does not count a region imported for its text or URL", async () => {
    const graph = graphOf({
      "/src/routes/a.tsx": ["/src/regions/Cart.tsx?raw", "/src/regions/Cart.tsx?url"],
    });

    expect(await collectBoundRegions("/src/routes/a.tsx", graph, "/src/regions")).toEqual([]);
  });

  it("recognises region modules and route or shell modules by directory", () => {
    expect(isRegionKey("/src/regions/Cart.tsx", "/src/regions")).toBe(true);
    expect(isRegionKey("/src/regions/nested/Cart.jsx", "src/regions/")).toBe(true);
    expect(isRegionKey("/src/regions/cart.css", "/src/regions")).toBe(false);
    expect(isRegionKey("/src/regions/types.d.ts", "/src/regions")).toBe(false);
    expect(isRegionKey("/src/regions-old/Cart.tsx", "/src/regions")).toBe(false);
    expect(isRegionKey("/src/regions/../routes/a.tsx", "/src/regions")).toBe(false);

    expect(isRouteOrShellKey("/src/routes/a.tsx", DIRS)).toBe(true);
    expect(isRouteOrShellKey("/src/shells/site.tsx", DIRS)).toBe(true);
    expect(isRouteOrShellKey("/src/components/a.tsx", DIRS)).toBe(false);
    const pages = { ...DIRS, pagesDir: "/src/pages" };
    expect(isRouteOrShellKey("/src/pages/_app.tsx", pages)).toBe(true);
    expect(isRouteOrShellKey("/src/routes/a.tsx", pages)).toBe(false);
  });

  it("keys build module ids by their path under the root, and nothing else", () => {
    const roots = ["/app", "/private/app"];
    expect(buildModuleKey("/app/src/routes/a.tsx", roots)).toBe("/src/routes/a.tsx");
    expect(buildModuleKey("/private/app/src/routes/a.tsx?x", roots)).toBe("/src/routes/a.tsx");
    expect(buildModuleKey("/app/node_modules/pkg/index.js", roots)).toBeNull();
    expect(buildModuleKey("/elsewhere/a.tsx", roots)).toBeNull();
    expect(buildModuleKey("\0virtual:pracht/server", roots)).toBeNull();
    expect(buildModuleKey("virtual:pracht/server", roots)).toBeNull();
  });
});

describe("region bindings from a real module graph", () => {
  it("builds the fixture's bindings into the server bundle", async () => {
    const entry: Plugin = {
      name: "region-bindings-test-entry",
      enforce: "pre",
      resolveId: (id) => (id === "virtual:entry" ? "\0virtual:entry" : null),
      load: (id) =>
        id === "\0virtual:entry"
          ? [
              `export const bindings = ${JSON.stringify(REGION_BINDINGS_TOKEN)};`,
              'export const routes = import.meta.glob("/src/routes/*.ts");',
              'export const shells = import.meta.glob("/src/shells/*.ts");',
              // The generated server module imports every region eagerly.
              'export const regions = import.meta.glob("/src/regions/*.ts", { eager: true });',
            ].join("\n")
          : null,
    };
    const output = (await build({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [entry, createRegionBindingsPlugin(DIRS)],
      build: {
        ssr: true,
        write: false,
        minify: false,
        rollupOptions: { input: "virtual:entry" },
      },
    })) as Rollup.RollupOutput;

    const entryChunk = output.output.find(
      (chunk): chunk is Rollup.OutputChunk => chunk.type === "chunk" && chunk.isEntry,
    )!;
    expect(entryChunk.code).not.toContain(REGION_BINDINGS_TOKEN);
    const literal = /bindings = ("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(entryChunk.code)![1]!;
    const json = literal.startsWith("'")
      ? literal.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\")
      : (JSON.parse(literal) as string);
    expect(JSON.parse(json)).toEqual(EXPECTED);
  });

  it("computes the same bindings from the dev server's module graph", async () => {
    const server = await createServer({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, ws: false },
      appType: "custom",
    });
    try {
      const graph = createDevRegionGraph(server.environments.ssr);
      const bindings = await computeRegionBindings(
        [...STARTS, "/src/shells/site.ts"],
        graph,
        "/src/regions",
      );
      expect(bindings).toEqual(EXPECTED);
    } finally {
      await server.close();
    }
  });
});
