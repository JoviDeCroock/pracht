import { resolve } from "node:path";

import { build, createServer, type Plugin, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

import {
  buildModuleKey,
  collectBoundServerIslands,
  computeServerIslandBindings,
  createDevServerIslandGraph,
  createServerIslandBindingsPlugin,
  devModuleKey,
  isServerIslandKey,
  isRouteOrShellKey,
  SERVER_ISLAND_BINDINGS_TOKEN,
  type ServerIslandGraph,
} from "../src/server-island-bindings.ts";

const fixtureRoot = resolve(import.meta.dirname, "fixtures/server-island-bindings-app");

const DIRS = {
  serverIslandsDir: "/src/server-islands",
  routesDir: "/src/routes",
  shellsDir: "/src/shells",
  pagesDir: "",
};

/**
 * What both the build and the dev server must compute for the fixture:
 *
 * - admin/org import their server island directly;
 * - the `site` shell reaches Cart through a shared Header component, and Cart
 *   reaches Nested (a server island rendering a server island);
 * - news imports a barrel that re-exports Barrelled: bound, conservatively;
 * - lazy reaches Lazy only through `import()`: not bound;
 * - raw imports a server island's source text with `?raw`: not bound;
 * - static renders no server island.
 */
const EXPECTED = {
  "/src/routes/admin.ts": ["/src/server-islands/AdminStats.ts"],
  "/src/routes/news.ts": ["/src/server-islands/Barrelled.ts"],
  "/src/routes/org.ts": ["/src/server-islands/OrgData.ts"],
  "/src/shells/site.ts": ["/src/server-islands/Cart.ts", "/src/server-islands/Nested.ts"],
};

const STARTS = ["admin", "lazy", "news", "org", "raw", "static"].map(
  (name) => `/src/routes/${name}.ts`,
);

/** A graph from an adjacency list keyed by glob-style keys. */
function graphOf(edges: Record<string, string[]>): ServerIslandGraph {
  return {
    keyOf: devModuleKey,
    staticImports: (id) => edges[id] ?? [],
  };
}

describe("server island binding walk", () => {
  it("follows static imports through components, barrels, cycles, and nested server islands", async () => {
    const graph = graphOf({
      "/src/routes/a.tsx": ["/src/components/Nav.tsx", "preact"],
      "/src/components/Nav.tsx": ["/src/components/index.ts", "/src/routes/a.tsx"],
      "/src/components/index.ts": ["/src/server-islands/Cart.tsx"],
      "/src/server-islands/Cart.tsx": ["/src/server-islands/Badge.tsx"],
    });

    expect(
      await collectBoundServerIslands("/src/routes/a.tsx", graph, "/src/server-islands"),
    ).toEqual(["/src/server-islands/Badge.tsx", "/src/server-islands/Cart.tsx"]);
  });

  it("never enters dependencies, virtual modules, or files outside the root", async () => {
    // Each of these imports every server island, the way the generated server module
    // does; entering one would bind them all.
    const everything = ["/src/server-islands/Admin.tsx"];
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

    expect(
      await collectBoundServerIslands("/src/routes/a.tsx", graph, "/src/server-islands"),
    ).toEqual([]);
  });

  it("does not count a server island imported for its text or URL", async () => {
    const graph = graphOf({
      "/src/routes/a.tsx": ["/src/server-islands/Cart.tsx?raw", "/src/server-islands/Cart.tsx?url"],
    });

    expect(
      await collectBoundServerIslands("/src/routes/a.tsx", graph, "/src/server-islands"),
    ).toEqual([]);
  });

  it("recognises server island modules and route or shell modules by directory", () => {
    expect(isServerIslandKey("/src/server-islands/Cart.tsx", "/src/server-islands")).toBe(true);
    expect(isServerIslandKey("/src/server-islands/nested/Cart.jsx", "src/server-islands/")).toBe(
      true,
    );
    expect(isServerIslandKey("/src/server-islands/cart.css", "/src/server-islands")).toBe(false);
    expect(isServerIslandKey("/src/server-islands/types.d.ts", "/src/server-islands")).toBe(false);
    expect(isServerIslandKey("/src/server-islands-old/Cart.tsx", "/src/server-islands")).toBe(
      false,
    );
    expect(isServerIslandKey("/src/server-islands/../routes/a.tsx", "/src/server-islands")).toBe(
      false,
    );

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

describe("server island bindings from a real module graph", () => {
  it("builds the fixture's bindings into the server bundle", async () => {
    const entry: Plugin = {
      name: "server-island-bindings-test-entry",
      enforce: "pre",
      resolveId: (id) => (id === "virtual:entry" ? "\0virtual:entry" : null),
      load: (id) =>
        id === "\0virtual:entry"
          ? [
              `export const bindings = ${JSON.stringify(SERVER_ISLAND_BINDINGS_TOKEN)};`,
              'export const routes = import.meta.glob("/src/routes/*.ts");',
              'export const shells = import.meta.glob("/src/shells/*.ts");',
              // The generated server module imports every server island eagerly.
              'export const serverIslands = import.meta.glob("/src/server-islands/*.ts", { eager: true });',
            ].join("\n")
          : null,
    };
    const output = (await build({
      root: fixtureRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [entry, createServerIslandBindingsPlugin(DIRS)],
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
    expect(entryChunk.code).not.toContain(SERVER_ISLAND_BINDINGS_TOKEN);
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
      const graph = createDevServerIslandGraph(server.environments.ssr);
      const bindings = await computeServerIslandBindings(
        [...STARTS, "/src/shells/site.ts"],
        graph,
        "/src/server-islands",
      );
      expect(bindings).toEqual(EXPECTED);
    } finally {
      await server.close();
    }
  });
});
