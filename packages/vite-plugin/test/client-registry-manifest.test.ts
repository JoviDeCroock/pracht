import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { pracht } from "../src/index.ts";
import {
  collectExternalManifestModules,
  collectManifestModuleRefs,
  createPrachtClientModuleSource,
  createPrachtRegistryModuleSource,
  createRouteHintsForVirtualModules,
} from "../src/plugin-codegen.ts";
import { resolveOptions } from "../src/plugin-options.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** An app on disk: `files` are written verbatim, keyed by project-relative path. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-client-registry-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

const COMPONENT = "export function Component() {\n  return null;\n}\n";
const SHELL = "export function Shell({ children }) {\n  return children;\n}\n";

/**
 * Every pattern the generated client registry passes to `import.meta.glob`,
 * from all of its calls at once. A single pattern is written as a bare string
 * and a list as an array, so both forms are read here.
 */
function routeGlobPatterns(root: string): string[] {
  const source = createPrachtClientModuleSource({}, { root });
  const patterns: string[] = [];
  for (const match of source.matchAll(/import\.meta\.glob\((\[[^\]]*\]|"(?:[^"\\]|\\.)*")/g)) {
    const argument = JSON.parse(match[1]!) as string | string[];
    patterns.push(...(Array.isArray(argument) ? argument : [argument]));
  }
  return patterns;
}

describe("the client route registry follows the manifest", () => {
  it("excludes a file the manifest never names", () => {
    // Its code and its CSS were published to the client output for a page no
    // URL reaches — a draft, or a route deleted from the manifest but left on
    // disk.
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  shells: { public: "./shells/public.tsx" },
  routes: [route("/", "./routes/home.tsx", { id: "home" })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
      "src/shells/public.tsx": SHELL,
    });

    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
    expect(routeGlobPatterns(root)).not.toContain("!/src/routes/home.tsx");
  });

  it("keeps every form a ref can take", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, group, route } from "@pracht/core";
export const app = defineApp({
  shells: { public: "./shells/public.tsx" },
  routes: [
    route("/", "./routes/home.tsx", { id: "home" }),
    group({ shell: "public" }, [route("/lazy", () => import("./routes/lazy.tsx"), { id: "lazy" })]),
  ],
  notFound: { component: "./routes/not-found.tsx" },
});
`,
      "src/routes/home.tsx": COMPONENT,
      "src/routes/lazy.tsx": COMPONENT,
      "src/routes/not-found.tsx": COMPONENT,
      "src/shells/public.tsx": SHELL,
    });

    const patterns = routeGlobPatterns(root);
    for (const kept of ["home", "lazy", "not-found"]) {
      expect(patterns).not.toContain(`!/src/routes/${kept}.tsx`);
    }
    expect(patterns).not.toContain("!/src/shells/public.tsx");
  });

  it("excludes a shared module that lives under the routes directory", () => {
    // It is still imported by the route that uses it; what it stops being is
    // an independent entry in the registry.
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [route("/", "./routes/home.tsx", { id: "home" })] });
`,
      "src/routes/home.tsx": `import { Card } from "./parts/Card.tsx";\n${COMPONENT}`,
      "src/routes/parts/Card.tsx": "export function Card() {\n  return null;\n}\n",
    });

    expect(routeGlobPatterns(root)).toContain("!/src/routes/parts/Card.tsx");
  });

  it("follows the local modules the manifest imports its routes from", () => {
    const root = project({
      "src/routes.ts": `import { defineApp } from "@pracht/core";
import { marketing } from "./manifest/marketing";
export const app = defineApp({ routes: [...marketing] });
`,
      "src/manifest/marketing.ts": `import { route } from "@pracht/core";
export const marketing = [route("/pricing", "./routes/pricing.tsx", { id: "pricing" })];
`,
      "src/routes/pricing.tsx": COMPONENT,
      "src/routes/draft.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(true);
    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
    expect(routeGlobPatterns(root)).not.toContain("!/src/routes/pricing.tsx");
  });

  it("reads an inline import() as a ref, not as manifest data to follow", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  middleware: { auth: () => import("./middleware/auth.ts") },
  routes: [route("/", () => import("./routes/home.tsx"), { id: "home" })],
});
`,
      "src/middleware/auth.ts":
        'import "./auth.css";\nexport const middleware = (args, next) => next();\n',
      "src/routes/home.tsx": COMPONENT,
      "src/routes/draft.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(true);
    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
  });

  it("leaves the registry alone when an imported manifest module cannot be read", () => {
    // Dropping a module a route needs breaks navigation to that route, which is
    // worse than shipping one nothing reaches. A ref the scan cannot see means
    // no exclusions at all.
    const root = project({
      "src/routes.ts": `import { defineApp } from "@pracht/core";
import { marketing } from "./marketing-routes.json";
export const app = defineApp({ routes: [...marketing] });
`,
      "src/marketing-routes.json": "{}",
      "src/routes/pricing.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(false);
    // Only the directory-wide test and declaration patterns remain.
    expect(
      routeGlobPatterns(root).filter(
        (pattern) => pattern.startsWith("!") && !pattern.includes("/**/"),
      ),
    ).toEqual([]);
  });

  it("leaves the registry alone when a specifier is assembled at runtime", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
const dir = "./routes";
export const app = defineApp({
  routes: [route("/", () => import(dir + "/home.tsx"), { id: "home" })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(false);
    expect(routeGlobPatterns(root)).not.toContain("!/src/routes/draft.tsx");
  });

  it("leaves the registry alone when a route ref is not a literal", () => {
    for (const ref of ['"./routes/" + name + ".tsx"', "`./routes/${name}.tsx`", "file"]) {
      const root = project({
        "src/routes.ts": `import { defineApp } from "@pracht/core";
import { pages } from "./manifest/pages.ts";
export const app = defineApp({ routes: pages });
`,
        "src/manifest/pages.ts": `import { route } from "@pracht/core";
const file = "./routes/counter.tsx";
export const pages = ["counter"].map((name) => route("/" + name, ${ref}));
`,
        "src/routes/counter.tsx": COMPONENT,
      });

      expect(collectManifestModuleRefs(resolveOptions({}), root).complete, ref).toBe(false);
      expect(routeGlobPatterns(root)).not.toContain("!/src/routes/counter.tsx");
    }
  });

  it("leaves the registry alone when a component or shell ref is not a literal", () => {
    for (const manifest of [
      'routes: [route("/", { component: COMPONENT_FILE })]',
      'routes: [route("/", { ...config })]',
      'shells: { ...SHELLS }, routes: [route("/", "./routes/home.tsx")]',
      'shells: { side: SHELL_FILE }, routes: [route("/", "./routes/home.tsx")]',
    ]) {
      const root = project({
        "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ ${manifest} });
`,
        "src/routes/home.tsx": COMPONENT,
      });
      expect(collectManifestModuleRefs(resolveOptions({}), root).complete, manifest).toBe(false);
    }
  });

  it("reads a bare package import as no threat to the scan", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
import { z } from "zod";
export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home", meta: { schema: z } })],
});
`,
      "src/routes/draft.tsx": COMPONENT,
      "src/routes/home.tsx": COMPONENT,
    });

    expect(collectManifestModuleRefs(resolveOptions({}), root).complete).toBe(true);
    expect(routeGlobPatterns(root)).toContain("!/src/routes/draft.tsx");
  });

  it("does not mistake a route path or a middleware ref for a route module", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  middleware: { gate: "./middleware/gate.ts" },
  routes: [route("/", "./routes/home.tsx", { id: "home", middleware: ["gate"] })],
});
`,
      "src/middleware/gate.ts": "export const middleware = (args, next) => next();\n",
      "src/routes/home.tsx": COMPONENT,
    });

    const refs = collectManifestModuleRefs(resolveOptions({}), root);
    expect(refs.complete).toBe(true);
    expect([...refs.files].map((file) => file.slice(root.length))).toEqual([
      "/src/routes/home.tsx",
    ]);
  });

  it("leaves the pages router's directory alone, where a file is a route", () => {
    const root = project({
      "src/pages/index.tsx": COMPONENT,
      "src/pages/about.tsx": COMPONENT,
    });

    const patterns = routeGlobPatterns(root);
    expect(patterns).not.toContain("!/src/pages/about.tsx");
  });
});

describe("modules the manifest names outside the globbed directories", () => {
  const MANIFEST = `import { defineApp, group, route } from "@pracht/core";
import { more } from "./manifest/more.ts";
export const app = defineApp({
  shells: { side: "./layouts/side.tsx" },
  middleware: { gate: "./guards/gate.ts" },
  routes: [
    route("/", "./routes/home.tsx", { id: "home" }),
    route("/feature", () => import("./features/feature.tsx"), { id: "feature", shell: "side" }),
    route("/data", { component: "./features/data.tsx", loader: "./data/load.ts" }, { id: "data" }),
    group({ hydration: "islands" }, [route("/static", "./features/static.tsx", { id: "static" })]),
    ...more,
  ],
  notFound: { component: "./features/missing.tsx" },
});
`;
  const files = {
    "src/routes.ts": MANIFEST,
    "src/manifest/more.ts": `import { route } from "@pracht/core";
export const more = [route("/more", "./features/more.tsx", { id: "more", middleware: ["gate"] })];
`,
    "src/routes/home.tsx": COMPONENT,
    "src/features/feature.tsx": COMPONENT,
    "src/features/data.tsx": COMPONENT,
    "src/features/static.tsx": COMPONENT,
    "src/features/more.tsx": COMPONENT,
    "src/features/missing.tsx": COMPONENT,
    "src/layouts/side.tsx": SHELL,
    "src/guards/gate.ts": "export const middleware = (args, next) => next();\n",
    "src/data/load.ts": "export const loader = () => ({});\n",
  };

  it("collects each ref by the registry that serves it", () => {
    const root = project(files);
    expect(collectExternalManifestModules(resolveOptions({}), root)).toEqual({
      routes: [
        "/src/features/data.tsx",
        "/src/features/feature.tsx",
        "/src/features/missing.tsx",
        "/src/features/more.tsx",
        "/src/features/static.tsx",
      ],
      shells: ["/src/layouts/side.tsx"],
      middleware: ["/src/guards/gate.ts"],
      loaders: ["/src/data/load.ts"],
    });
  });

  it("registers route and shell modules in the client entry, minus non-hydrating routes", () => {
    const root = project(files);
    const source = createPrachtClientModuleSource({}, { root });
    for (const file of [
      "/src/features/feature.tsx",
      "/src/features/more.tsx",
      "/src/layouts/side.tsx",
    ]) {
      expect(source).toContain(
        `${JSON.stringify(file)}: () => import(${JSON.stringify(`${file}?pracht-client`)}),`,
      );
    }
    expect(source).not.toContain('import("/src/features/static.tsx');
    // Server-only modules never reach the browser registry.
    expect(source).not.toContain("/src/guards/gate.ts");
    expect(source).not.toContain("/src/data/load.ts");
  });

  it("registers every kind in the server registry", () => {
    const root = project(files);
    const source = createPrachtRegistryModuleSource({}, { root });
    for (const file of [
      "/src/features/feature.tsx",
      "/src/features/missing.tsx",
      "/src/layouts/side.tsx",
      "/src/guards/gate.ts",
      "/src/data/load.ts",
    ]) {
      expect(source).toContain(JSON.stringify(file));
    }
  });

  it("takes a file name holding glob syntax literally", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [route("/:id", "./features/[id].tsx", { id: "item" })] });
`,
      "src/features/[id].tsx": COMPONENT,
    });
    const entry = '"/src/features/[id].tsx": () => import("/src/features/[id].tsx';
    expect(createPrachtRegistryModuleSource({}, { root })).toContain(entry);
    expect(createPrachtClientModuleSource({}, { root })).toContain(entry);
  });

  it("scans their exports for the build's feature switches", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  shells: { side: "./layouts/side.tsx" },
  routes: [route("/", "./features/home.tsx", { id: "home", shell: "side" })],
});
`,
      "src/features/home.tsx": `export const search = schema;\n${COMPONENT}`,
      "src/layouts/side.tsx": `export async function loader() { return {}; }\n${SHELL}`,
    });
    const hints = createRouteHintsForVirtualModules(resolveOptions({}), root);
    expect(hints.shellLoaders).toBe(true);
    expect(hints.loader["./layouts/side.tsx"]).toBe(true);
    expect(hints.search["./features/home.tsx"]).toBe(true);
    expect(hints.search["/src/features/home.tsx"]).toBe(true);
  });

  /** A dev server double that records what a hot update did. */
  function devServer(root: string, options: Parameters<typeof pracht>[0] = {}) {
    const plugins = pracht(options);
    const plugin = plugins.find((candidate) => candidate.name === "pracht")!;
    (plugin.configResolved as (config: unknown) => void).call(plugin, {
      root,
      command: "serve",
      base: "/",
      build: {},
      plugins: [],
    });
    const record = { restarts: 0, reloads: 0, invalidated: [] as string[] };
    const node = (id: string, importers: unknown[] = []) => ({ id, importers: new Set(importers) });
    const virtualServer = node("\0virtual:pracht/server");
    const manifest = node(join(root, "src/routes.ts"), [virtualServer]);
    const fragment = node(join(root, "src/manifest/more.ts"), [manifest]);
    const server = {
      config: { root },
      moduleGraph: {
        getModuleById: (id: string) => (id.includes("pracht/") ? node(id) : undefined),
        getModulesByFile: (file: string) =>
          file === fragment.id
            ? new Set([fragment])
            : file === manifest.id
              ? new Set([manifest])
              : undefined,
        invalidateModule: (mod: { id: string }) => record.invalidated.push(mod.id),
      },
      restart: () => {
        record.restarts += 1;
      },
      ws: {
        send: (payload: { type: string }) => {
          if (payload.type === "full-reload") record.reloads += 1;
        },
      },
    };
    const hotUpdate = (file: string) =>
      (plugin.handleHotUpdate as (context: unknown) => unknown).call(plugin, {
        file,
        modules: [],
        server,
      });
    const transform = plugins.find((p) => p.name === "pracht:client-module-transform")!
      .transform as (code: string, id: string, options: { ssr: boolean }) => unknown;
    return { record, hotUpdate, transform };
  }

  it("applies a manifest edit in dev without restarting the server", () => {
    const root = project(files);
    const dev = devServer(root);

    // The fragment decides the registries as much as `src/routes.ts` does: the
    // virtual modules and every module that evaluated it are invalidated, and
    // the page reloads against the new route table.
    expect(dev.hotUpdate(join(root, "src/manifest/more.ts"))).toEqual([]);
    expect(dev.record).toMatchObject({ restarts: 0, reloads: 1 });
    expect(dev.record.invalidated).toEqual(
      expect.arrayContaining([
        join(root, "src/manifest/more.ts"),
        join(root, "src/routes.ts"),
        "\0virtual:pracht/server",
      ]),
    );

    dev.hotUpdate(join(root, "src/routes.ts"));
    expect(dev.record).toMatchObject({ restarts: 0, reloads: 2 });

    // An ordinary route module is not manifest data.
    dev.hotUpdate(join(root, "src/features/feature.tsx"));
    expect(dev.record).toMatchObject({ restarts: 0, reloads: 2 });
  });

  it("reads a route the edit adds outside the routes directory as a route module", async () => {
    const root = project(files);
    const dev = devServer(root);
    const added = join(root, "src/features/added.tsx");
    const source = `import { db } from "../server/db";\nexport async function loader() { return db; }\n${COMPONENT}`;
    writeFileSync(added, source);
    const stripped = () => dev.transform.call({} as never, source, added, { ssr: false });

    expect(await stripped()).toBeNull();
    writeFileSync(
      join(root, "src/manifest/more.ts"),
      `import { route } from "@pracht/core";
export const more = [route("/added", "./features/added.tsx", { id: "added" })];
`,
    );
    dev.hotUpdate(join(root, "src/manifest/more.ts"));
    expect(JSON.stringify(await stripped())).not.toContain("../server/db");
  });

  it("restarts for an adapter that runs its own dev server", () => {
    const root = project(files);
    const dev = devServer(root, {
      adapter: {
        id: "owned",
        serverImports: "",
        ownsDevServer: true,
        createServerEntryModule: () => "",
      },
    });
    dev.hotUpdate(join(root, "src/routes.ts"));
    expect(dev.record).toMatchObject({ restarts: 1, reloads: 0 });
  });

  it("ignores a ref that names no file", () => {
    const root = project({
      "src/routes.ts": `import { defineApp, route } from "@pracht/core";
export const app = defineApp({ routes: [route("/gone", "./features/gone.tsx", { id: "gone" })] });
`,
    });
    expect(collectExternalManifestModules(resolveOptions({}), root).routes).toEqual([]);
  });
});

describe("client-side search validation", () => {
  const MANIFEST = `import { defineApp, route } from "@pracht/core";
export const app = defineApp({
  routes: [route("/", "./routes/home.tsx", { id: "home" })],
});
`;

  it("ships the parser when a route module exports a search schema", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": `export const search = schema;\n${COMPONENT}`,
    });

    expect(createPrachtClientModuleSource({}, { root })).toContain(
      "    parseSearch: parseRouteSearch,",
    );
  });

  it("keeps the parser out of production builds when no route declares a schema", () => {
    const root = project({ "src/routes.ts": MANIFEST, "src/routes/home.tsx": COMPONENT });

    // Dev keeps it so the first `search` export works without regenerating
    // the entry; the production build folds the branch and drops the import.
    expect(createPrachtClientModuleSource({}, { root })).toContain(
      "    ...(import.meta.env.DEV ? { parseSearch: parseRouteSearch } : null),",
    );
  });

  it("compiles the router's search glue out of a build with no schema", () => {
    const define = (root: string, command: string) => {
      const plugin = pracht().find((candidate) => candidate.name === "pracht")!;
      const hook = plugin.config as (
        config: Record<string, unknown>,
        env: { command: string; mode: string; isSsrBuild: boolean },
      ) => { define?: Record<string, string> };
      return hook.call(
        plugin as never,
        { root },
        { command, mode: "production", isSsrBuild: false },
      ).define?.__PRACHT_ROUTE_SEARCH__;
    };
    const plain = project({ "src/routes.ts": MANIFEST, "src/routes/home.tsx": COMPONENT });
    const typed = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": `export const search = schema;\n${COMPONENT}`,
    });

    expect(define(plain, "build")).toBe("false");
    expect(define(typed, "build")).toBe("true");
    // Dev keeps it on, so the first schema works without a restart.
    expect(define(plain, "serve")).toBe("true");
  });
});

describe("deferred-data hydration", () => {
  const define = (root: string, command = "build", options = {}) => {
    const plugin = pracht(options).find((candidate) => candidate.name === "pracht")!;
    const hook = plugin.config as (
      config: Record<string, unknown>,
      env: { command: string; mode: string; isSsrBuild: boolean },
    ) => { define?: Record<string, string> };
    return hook.call(plugin as never, { root }, { command, mode: "production", isSsrBuild: false })
      .define?.__PRACHT_STREAMING__;
  };
  const manifest = (routes: string, imports = "") =>
    `import { defineApp, group, route } from "@pracht/core";
${imports}
export const app = defineApp({ routes: [${routes}] });
`;

  it("compiles out of a build where no route streams", () => {
    const root = project({
      "src/routes.ts": manifest('route("/", "./routes/home.tsx")'),
      "src/routes/home.tsx": COMPONENT,
    });
    expect(define(root)).toBe("false");
    // Lazy refs and type-only imports supply no route options.
    const lazy = project({
      "src/routes.ts": manifest(
        'route("/", () => import("./routes/home.tsx"))',
        'import type { Props } from "./routes/home.tsx";',
      ),
      "src/routes/home.tsx": COMPONENT,
    });
    expect(define(lazy)).toBe("false");
    // Dev keeps it on, so `streaming: true` works without a restart.
    expect(define(root, "serve")).toBe("true");
  });

  it("stays in a build that may stream", () => {
    const cases: Array<Record<string, string>> = [
      { "src/routes.ts": manifest('route("/", "./routes/home.tsx", { streaming: true })') },
      {
        "src/routes.ts": manifest('group({ streaming: true }, [route("/", "./routes/home.tsx")])'),
      },
      {
        "src/routes.ts": manifest("...more", 'import { more } from "./more.ts";'),
        "src/more.ts":
          'import { route } from "@pracht/core";\nexport const more = [route("/", "./routes/home.tsx", { streaming: true })];\n',
      },
      // Options a package hands the manifest are not read.
      {
        "src/routes.ts": manifest(
          'route("/", "./routes/home.tsx", options)',
          'import { options } from "shared-route-options";',
        ),
      },
      // Nor are values a route-directory module or an eager `import()` supplies.
      {
        "src/routes.ts": manifest(
          'route("/", "./routes/home.tsx", options)',
          'import { options } from "./routes/options.ts";',
        ),
        "src/routes/options.ts": "export const options = { streaming: true };\n",
      },
      {
        "src/routes.ts": manifest(
          'route("/", "./routes/home.tsx", (await import("./opts.ts")).options)',
        ),
        "src/opts.ts": "export const options = { streaming: true };\n",
      },
    ];
    for (const files of cases) {
      const root = project({ ...files, "src/routes/home.tsx": COMPONENT });
      expect(define(root), files["src/routes.ts"]).toBe("true");
    }
  });

  it("follows `STREAMING` exports in the pages router", () => {
    const pages = { pagesDir: "/src/pages" };
    const plain = project({ "src/pages/index.tsx": COMPONENT });
    const streaming = project({
      "src/pages/index.tsx": COMPONENT,
      "src/pages/live.tsx": `export const STREAMING = true;\n${COMPONENT}`,
    });
    expect(define(plain, "build", pages)).toBe("false");
    expect(define(streaming, "build", pages)).toBe("true");
  });
});
