import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRouteHeadersHints,
  createRouteHints,
  createRouteLoaderHints,
  createRouteStaticPathsHints,
  analyzeRouteExports,
} from "../src/route-loader-hints.ts";

/** What the hint tables read off one route module's source. */
const exportsOf = (source: string) => analyzeRouteExports(source, "route.tsx");
const exportsHeaders = (source: string) => exportsOf(source).headers;
const exportsLoader = (source: string) => exportsOf(source).loader;
const exportsStaticPaths = (source: string) => exportsOf(source).getStaticPaths;

describe("exportsHeaders", () => {
  it("recognizes declarations, export lists, and re-exports", () => {
    expect(exportsHeaders("export function headers() { return {}; }\n")).toBe(true);
    expect(
      exportsHeaders(
        "const responseHeaders = () => ({}); export { responseHeaders as headers };\n",
      ),
    ).toBe(true);
    expect(exportsHeaders('export { headers } from "./policy.ts";\n')).toBe(true);
    expect(exportsHeaders('const policy = () => ({}); export { policy as "headers" };\n')).toBe(
      true,
    );
    expect(exportsHeaders('export * from "./policy.ts";\n')).toBe(true);
  });

  it("ignores comments, strings, local bindings, and type-only exports", () => {
    expect(
      exportsHeaders("// export function headers() {}\nexport function Component() {}\n"),
    ).toBe(false);
    expect(exportsHeaders('const text = "export { headers }";\n')).toBe(false);
    expect(exportsHeaders("function headers() {}\nexport function Component() {}\n")).toBe(false);
    expect(exportsHeaders("export type headers = Record<string, string>;\n")).toBe(false);
  });
});

describe("exportsLoader", () => {
  it("recognizes commented declarations and export lists", () => {
    expect(exportsLoader("export /* build-time */ function loader() {}\n")).toBe(true);
    expect(exportsLoader("const loader = () => {}; export { /* route state */ loader };\n")).toBe(
      true,
    );
    expect(exportsLoader('export { data as loader } from "./data.ts";\n')).toBe(true);
    expect(exportsLoader('export /* conservative */ * from "./data.ts";\n')).toBe(true);
  });

  it("recognizes loaders exported through destructuring bindings", () => {
    expect(exportsLoader("export const { value: loader } = source;\n")).toBe(true);
    expect(exportsLoader("export const { nested: { loader } } = source;\n")).toBe(true);
    expect(exportsLoader("export const [loader] = source;\n")).toBe(true);
    expect(exportsLoader("export const route = { loader: source };\n")).toBe(false);
  });

  it("only treats exported variable bindings as loaders", () => {
    expect(exportsLoader("export const Component = () => <Widget loader={value} />;\n")).toBe(
      false,
    );
    expect(
      exportsLoader(
        "export const Component = () => <Widget loader={value} />, loader = () => ({});\n",
      ),
    ).toBe(true);
  });

  it("does not treat identifiers in TypeScript generic types as variable bindings", () => {
    expect(exportsLoader("export const Component: Pair<View, loader> = view;\n")).toBe(false);
    expect(exportsLoader("export const Component = view satisfies Pair<View, loader>;\n")).toBe(
      false,
    );
    expect(exportsLoader("export const Component = async <T, loader>() => null;\n")).toBe(false);
    expect(
      exportsLoader("export const Component: Pair<View, loader> = view, loader = () => ({});\n"),
    ).toBe(true);
  });

  it("ignores loader-shaped text in comments and strings", () => {
    expect(
      exportsLoader(
        'const text = "export function loader() {}";\n// export { loader }\nexport { text };\n',
      ),
    ).toBe(false);
  });

  it("ignores type-only loader exports", () => {
    expect(exportsLoader("export interface loader { value: string }\n")).toBe(false);
    expect(exportsLoader("export type loader = () => unknown;\n")).toBe(false);
    expect(exportsLoader("export declare const loader: () => unknown;\n")).toBe(false);
    expect(exportsLoader('export { type loader } from "./types.ts";\n')).toBe(false);
  });

  it("falls back safely for JSX and TSRX component syntax", () => {
    expect(
      exportsLoader(`
        export function Component() {
          return <section><p>client-only</p></section>;
        }
      `),
    ).toBe(false);
    expect(
      exportsLoader(`
        export /* build-time */ function loader() { return {}; }
        export component Component() { <p>TSRX</p> }
      `),
    ).toBe(true);
  });

  it("does not mistake regex contents for comments in the JSX fallback", () => {
    expect(
      exportsLoader(
        'export function Component() { return <p>{/a\\/*b/.test("x")}</p>; } export function loader() { return {}; }',
      ),
    ).toBe(true);
  });
});

describe("createRouteLoaderHints", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("marks loaderless TSRX routes so static SPA validation accepts them", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-tsrx-loader-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "dashboard.tsrx"), "export function Component() {}\n");

    expect(
      createRouteLoaderHints(routesDir, {
        appFileDir: routesDir,
        rootRelativePrefix: "/src/routes",
      }),
    ).toEqual({
      "./dashboard.tsrx": false,
      "/src/routes/dashboard.tsrx": false,
    });
  });

  it("tracks literal Pages capability exports for client-entry HMR", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-capability-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(
      join(routesDir, "notes.tsx"),
      'export const CAPABILITIES = ["notes.search", "notes.create"] as const;\n',
    );

    expect(createRouteHints(routesDir, { rootRelativePrefix: "/src/pages" }).capabilities).toEqual({
      "/src/pages/notes.tsx": ["notes.search", "notes.create"],
    });
  });

  // A dangling symlink — or a file an editor is mid-replace — made the
  // unguarded `statSync` throw and discard the whole table, which in dev meant
  // every route's loader hint went stale at once.
  it("skips an entry it cannot stat instead of losing the table", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-unstattable-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "home.tsx"), "export function loader() { return {}; }\n");
    symlinkSync(join(routesDir, "gone.tsx"), join(routesDir, "broken.tsx"));

    expect(createRouteLoaderHints(routesDir, { rootRelativePrefix: "/src/routes" })).toEqual({
      "/src/routes/home.tsx": true,
    });
  });
});

describe("createRouteHeadersHints", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports document-header ownership per route file", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-headers-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "home.tsx"), "export function Component() {}\n");
    writeFileSync(
      join(routesDir, "account.tsx"),
      'export function headers() { return { "cache-control": "private" }; }\n',
    );

    expect(
      createRouteHeadersHints(routesDir, {
        appFileDir: routesDir,
        rootRelativePrefix: "/src/routes",
      }),
    ).toEqual({
      "./account.tsx": true,
      "./home.tsx": false,
      "/src/routes/account.tsx": true,
      "/src/routes/home.tsx": false,
    });
  });

  it("keeps compiled route formats conservatively header-bearing", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-compiled-headers-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "post.mdx"), "# Post\n");
    writeFileSync(join(routesDir, "account.custom"), "title: Account\n");

    expect(
      createRouteHeadersHints(routesDir, {
        additionalExtensions: [".custom"],
        rootRelativePrefix: "/src/routes",
      }),
    ).toEqual({
      "/src/routes/account.custom": true,
      "/src/routes/post.mdx": true,
    });
  });
});

describe("exportsStaticPaths", () => {
  it("recognizes declarations, export lists, and re-exports", () => {
    expect(exportsStaticPaths("export function getStaticPaths() { return []; }\n")).toBe(true);
    expect(exportsStaticPaths("export async function getStaticPaths() {}\n")).toBe(true);
    expect(exportsStaticPaths("export const getStaticPaths = () => [];\n")).toBe(true);
    expect(
      exportsStaticPaths("const paths = () => []; export { paths as getStaticPaths };\n"),
    ).toBe(true);
    expect(exportsStaticPaths('export { getStaticPaths } from "./paths.ts";\n')).toBe(true);
    // `export *` could expose one, so it stays conservative.
    expect(exportsStaticPaths('export * from "./paths.ts";\n')).toBe(true);
  });

  it("does not mistake comments, strings, or local bindings for an export", () => {
    expect(
      exportsStaticPaths("// TODO: add getStaticPaths\nexport function Component() {}\n"),
    ).toBe(false);
    expect(exportsStaticPaths('const hint = "getStaticPaths";\n')).toBe(false);
    expect(
      exportsStaticPaths("function getStaticPaths() {}\nexport function Component() {}\n"),
    ).toBe(false);
    expect(exportsStaticPaths("export function Component() {}\n")).toBe(false);
  });
});

describe("createRouteStaticPathsHints", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports getStaticPaths presence per route file", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-static-paths-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "tag.tsx"), "export function Component() {}\n");
    writeFileSync(
      join(routesDir, "post.tsx"),
      "export function getStaticPaths() { return []; }\nexport function Component() {}\n",
    );

    expect(
      createRouteStaticPathsHints(routesDir, {
        appFileDir: routesDir,
        rootRelativePrefix: "/src/routes",
      }),
    ).toEqual({
      "./post.tsx": true,
      "./tag.tsx": false,
      "/src/routes/post.tsx": true,
      "/src/routes/tag.tsx": false,
    });
  });

  it("stays conservative for formats a companion plugin compiles", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-static-paths-hints-ext-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "item.tsrx"), "export function Component() {}\n");

    expect(
      createRouteStaticPathsHints(routesDir, {
        additionalExtensions: [".tsrx"],
        rootRelativePrefix: "/src/routes",
      }),
    ).toEqual({ "/src/routes/item.tsrx": true });
  });
});

describe("search schema hints", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("records which route modules export a search schema", () => {
    const routesDir = mkdtempSync(join(tmpdir(), "pracht-search-hints-"));
    tempDirs.push(routesDir);
    writeFileSync(join(routesDir, "catalog.tsx"), "export const search = schema;\n");
    writeFileSync(
      join(routesDir, "aliased.tsx"),
      "const schema = x; export { schema as search };\n",
    );
    writeFileSync(
      join(routesDir, "home.tsx"),
      "const search = schema;\nexport function Component() {}\n",
    );
    writeFileSync(join(routesDir, "custom.tsrx"), "export const search = schema;\n<Component />\n");

    expect(
      createRouteHints(routesDir, {
        additionalExtensions: [".tsrx"],
        rootRelativePrefix: "/src/routes",
      }).search,
    ).toEqual({
      "/src/routes/aliased.tsx": true,
      "/src/routes/catalog.tsx": true,
      "/src/routes/custom.tsrx": true,
      "/src/routes/home.tsx": false,
    });
  });
});
