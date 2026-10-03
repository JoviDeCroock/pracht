import { posix, resolve } from "node:path";

import { build, createServer, type Plugin, type Rollup } from "vite";
import { describe, expect, it } from "vitest";

import {
  buildModuleKey,
  collectBoundServerIslands,
  computeServerIslandBindings,
  createDevServerIslandGraph,
  createSourceServerIslandGraph,
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
 * - news imports only `Button` from a barrel that re-exports Barrelled and,
 *   through `export *`, a component rendering AdminStats: binds neither;
 * - featured imports `Barrelled` from that barrel: bound;
 * - lazy reaches Lazy only through `import()`: not bound;
 * - raw imports a server island's source text with `?raw`: not bound;
 * - static renders no server island.
 */
const EXPECTED = {
  "/src/routes/admin.ts": ["/src/server-islands/AdminStats.ts"],
  "/src/routes/featured.ts": ["/src/server-islands/Barrelled.ts"],
  "/src/routes/org.ts": ["/src/server-islands/OrgData.ts"],
  "/src/shells/site.ts": ["/src/server-islands/Cart.ts", "/src/server-islands/Nested.ts"],
};

const STARTS = ["admin", "featured", "lazy", "news", "org", "raw", "static"].map(
  (name) => `/src/routes/${name}.ts`,
);

/** A graph from an adjacency list keyed by glob-style keys; every import is used. */
function graphOf(edges: Record<string, string[]>): ServerIslandGraph {
  return {
    keyOf: devModuleKey,
    links: (id) => ({
      imports: (edges[id] ?? []).map((imported) => ({ id: imported, names: "*" as const })),
      reexports: [],
      starExports: [],
      localExports: [],
    }),
  };
}

/** A graph read from in-memory sources, resolving relative specifiers only. */
function sourceGraphOf(files: Record<string, string>): ServerIslandGraph {
  return createSourceServerIslandGraph({
    keyOf: devModuleKey,
    readFile: async (id) => {
      if (!(id in files)) throw new Error(`no file ${id}`);
      return files[id]!;
    },
    resolve: async (specifier, importer) =>
      specifier.startsWith(".") ? posix.join(posix.dirname(importer), specifier) : specifier,
    importedIds: () => [],
  });
}

describe("server island binding walk", () => {
  it("follows a barrel's re-exports only for the names the importer uses", async () => {
    const graph = sourceGraphOf({
      "/src/routes/public.tsx": [
        'import { Button } from "../components/index.ts";',
        'import type { AdminProps } from "../components/index.ts";',
        "export function Component() { return <Button />; }",
      ].join("\n"),
      "/src/routes/admin.tsx": [
        'import { AdminStats as Stats, Button } from "../components/index.ts";',
        "export function Component() { return <Stats />; }",
      ].join("\n"),
      "/src/routes/panel.tsx": [
        'import { AdminPanel } from "../components/index.ts";',
        "export function Component() { return <AdminPanel />; }",
      ].join("\n"),
      "/src/routes/everything.tsx": [
        'import * as UI from "../components/index.ts";',
        "export function Component() { return <UI.Button />; }",
      ].join("\n"),
      "/src/components/index.ts": [
        'export { Button } from "./Button.tsx";',
        'export { default as AdminStats } from "../server-islands/AdminStats.tsx";',
        'import OrgData from "../server-islands/OrgData.tsx";',
        "export { OrgData };",
        'export * from "./panels.tsx";',
        'export type { AdminProps } from "../server-islands/Typed.tsx";',
      ].join("\n"),
      "/src/components/Button.tsx": "export function Button() { return <button />; }",
      "/src/components/panels.tsx": [
        'import AdminStats from "../server-islands/AdminStats.tsx";',
        "export function AdminPanel() { return <AdminStats />; }",
      ].join("\n"),
      "/src/server-islands/AdminStats.tsx": "export default function AdminStats() {}",
      "/src/server-islands/OrgData.tsx": "export default function OrgData() {}",
      "/src/server-islands/Typed.tsx": "export interface AdminProps {}",
    });
    const bound = (route: string) => collectBoundServerIslands(route, graph, "/src/server-islands");

    expect(await bound("/src/routes/public.tsx")).toEqual([]);
    expect(await bound("/src/routes/admin.tsx")).toEqual(["/src/server-islands/AdminStats.tsx"]);
    expect(await bound("/src/routes/panel.tsx")).toEqual(["/src/server-islands/AdminStats.tsx"]);
    // A namespace import may use any export.
    expect(await bound("/src/routes/everything.tsx")).toEqual([
      "/src/server-islands/AdminStats.tsx",
      "/src/server-islands/OrgData.tsx",
    ]);
  });

  it("follows every import of a module whose own code is used", async () => {
    const graph = sourceGraphOf({
      "/src/routes/a.tsx": [
        'import { Header } from "../components/Header.tsx";',
        'export { loader } from "./a.data.ts";',
        "export default function Page() { return <Header />; }",
      ].join("\n"),
      "/src/routes/a.data.ts": [
        'import "../server-islands/Side.tsx";',
        "export const loader = () => null;",
      ].join("\n"),
      "/src/components/Header.tsx": [
        'import Cart from "../server-islands/Cart.tsx";',
        'import { Unused } from "./unused.ts";',
        "export const Header = () => <Cart />;",
      ].join("\n"),
      "/src/components/unused.ts":
        'export { default as Unused } from "../server-islands/Other.tsx";',
      "/src/server-islands/Cart.tsx": "export default () => null;",
      "/src/server-islands/Side.tsx": "export default () => null;",
      "/src/server-islands/Other.tsx": "export default () => null;",
    });

    expect(
      await collectBoundServerIslands("/src/routes/a.tsx", graph, "/src/server-islands"),
    ).toEqual([
      "/src/server-islands/Cart.tsx",
      "/src/server-islands/Other.tsx",
      "/src/server-islands/Side.tsx",
    ]);
  });

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
        [...STARTS, "/src/shells/site.ts"].map((key) => resolve(fixtureRoot, `.${key}`)),
        graph,
        "/src/server-islands",
      );
      expect(bindings).toEqual(EXPECTED);
    } finally {
      await server.close();
    }
  });
});
