import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

// Every Babel parse and every Vite `parseAst` call is counted, then attributed
// to the file whose marker comment the parsed source carries.
const babelSources: string[] = [];
const astSources: string[] = [];
vi.mock("@babel/parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babel/parser")>();
  return {
    ...actual,
    parse: (source: string, options?: object) => {
      babelSources.push(source);
      return actual.parse(source, options as never);
    },
  };
});
vi.mock("vite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vite")>();
  return {
    ...actual,
    parseAst: (source: string, ...rest: unknown[]) => {
      astSources.push(source);
      return (actual.parseAst as (...args: unknown[]) => unknown)(source, ...rest);
    },
  };
});

const codegen = await import("../src/plugin-codegen.ts");
const { resolveOptions } = await import("../src/plugin-options.ts");
const { getAnalysisSession } = await import("../src/analysis.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-parse-count-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) write(root, name, content);
  return root;
}

function write(root: string, name: string, content: string): void {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), `// file:${name}\n${content}`);
}

/** Parses of any part of the app manifest: the whole module, or its `defineApp()` body. */
function manifestParses(): number {
  return astSources.filter((source) => source.includes('route("/external"')).length;
}

function parsesOf(sources: string[], name: string): number {
  return sources.filter((source) => source.includes(`// file:${name}\n`)).length;
}

/** Everything one dev save regenerates: the hot-update scan, then each virtual module. */
function regenerate(options: Record<string, unknown>, root: string): void {
  const resolved = resolveOptions(options);
  getAnalysisSession(resolved, root);
  codegen.createRouteHintsForVirtualModules(resolved, root);
  codegen.clearPagesAppSourceCache();
  const routeHints = codegen.createRouteHintsForVirtualModules(resolved, root);
  codegen.createServerLoaderHintsForHotUpdates(resolved, root);
  codegen.createPrachtClientModuleSource(resolved, { root, routeHints });
  codegen.createPrachtServerModuleSource(resolved, { root });
  codegen.createPrachtDevModuleSource(resolved, { root });
}

const ROUTE =
  "export async function loader() { return {}; }\nexport function Component() { return null; }\n";
const MANIFEST = [
  'import { defineApp, group, route } from "@pracht/core";',
  "export const app = defineApp({",
  '  shells: { site: "./shells/site.tsx" },',
  "  routes: [",
  '    group({ shell: "site" }, [',
  '      route("/", "./routes/home.tsx"),',
  '      route("/about", "./routes/about.tsx", { hydration: "islands" }),',
  '      route("/docs", "./routes/docs.md"),',
  '      route("/external", "./features/external.tsx"),',
  "    ]),",
  "  ],",
  "});",
  "",
].join("\n");

const MODULES = [
  "src/routes/home.tsx",
  "src/routes/about.tsx",
  "src/routes/docs.md",
  "src/shells/site.tsx",
  "src/features/external.tsx",
];

describe("one parse per file per regeneration", () => {
  it("parses each module of a manifest app at most once, and only the edited one again", () => {
    const root = project({
      "src/routes.ts": MANIFEST,
      "src/routes/home.tsx": ROUTE,
      "src/routes/about.tsx": ROUTE,
      "src/routes/docs.md": "# Docs\n\n```ts\nexport async function loader() {}\n```\n",
      "src/shells/site.tsx": "export function Shell() { return null; }\n",
      "src/features/external.tsx": ROUTE,
    });

    babelSources.length = 0;
    astSources.length = 0;
    regenerate({}, root);
    for (const file of MODULES) expect(parsesOf(babelSources, file), file).toBeLessThanOrEqual(1);
    // A format no parser reads goes straight to the lexical reader.
    expect(parsesOf(babelSources, "src/routes/docs.md")).toBe(0);
    // R505-2: the registries, the app root and the ejected-layout check read
    // one parse of the manifest, not one each.
    expect(manifestParses()).toBe(1);

    babelSources.length = 0;
    astSources.length = 0;
    write(root, "src/routes/about.tsx", "export function Component() { return 1; }\n");
    regenerate({}, root);
    expect(parsesOf(babelSources, "src/routes/about.tsx")).toBe(1);
    for (const file of MODULES.filter((file) => !file.endsWith("about.tsx"))) {
      expect(parsesOf(babelSources, file), file).toBe(0);
    }
    expect(manifestParses()).toBe(0);

    astSources.length = 0;
    write(root, "src/routes.ts", MANIFEST.replace('"/about"', '"/about-us"'));
    regenerate({}, root);
    expect(manifestParses()).toBe(1);
  });

  it("parses each page of a pages app at most once, and only the edited one again", () => {
    const pages = ["src/pages/index.tsx", "src/pages/about.tsx", "src/pages/blog/[slug].tsx"];
    const root = project({
      "src/pages/_app.tsx": "export function Shell() { return null; }\n",
      "src/pages/index.tsx": ROUTE,
      "src/pages/about.tsx": `export const HYDRATION = "islands";\n${ROUTE}`,
      "src/pages/blog/[slug].tsx": ROUTE,
    });
    const options = { pagesDir: "/src/pages" };

    babelSources.length = 0;
    regenerate(options, root);
    for (const file of [...pages, "src/pages/_app.tsx"]) {
      expect(parsesOf(babelSources, file), file).toBeLessThanOrEqual(1);
    }

    babelSources.length = 0;
    write(root, "src/pages/about.tsx", "export function Component() { return 1; }\n");
    regenerate(options, root);
    expect(parsesOf(babelSources, "src/pages/about.tsx")).toBe(1);
    for (const file of pages.filter((file) => !file.endsWith("about.tsx"))) {
      expect(parsesOf(babelSources, file), file).toBe(0);
    }
  });
});
