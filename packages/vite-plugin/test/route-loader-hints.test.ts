import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRouteHeadersHints,
  createRouteHints,
  createRouteLoaderHints,
  createRouteStaticPathsHints,
  detectHeadersExport,
  detectLoaderExport,
  detectStaticPathsExport,
} from "../src/route-loader-hints.ts";

describe("detectHeadersExport", () => {
  it("recognizes declarations, export lists, and re-exports", () => {
    expect(detectHeadersExport("export function headers() { return {}; }\n")).toBe(true);
    expect(
      detectHeadersExport(
        "const responseHeaders = () => ({}); export { responseHeaders as headers };\n",
      ),
    ).toBe(true);
    expect(detectHeadersExport('export { headers } from "./policy.ts";\n')).toBe(true);
    expect(
      detectHeadersExport('const policy = () => ({}); export { policy as "headers" };\n'),
    ).toBe(true);
    expect(detectHeadersExport('export * from "./policy.ts";\n')).toBe(true);
  });

  it("ignores comments, strings, local bindings, and type-only exports", () => {
    expect(
      detectHeadersExport("// export function headers() {}\nexport function Component() {}\n"),
    ).toBe(false);
    expect(detectHeadersExport('const text = "export { headers }";\n')).toBe(false);
    expect(detectHeadersExport("function headers() {}\nexport function Component() {}\n")).toBe(
      false,
    );
    expect(detectHeadersExport("export type headers = Record<string, string>;\n")).toBe(false);
  });
});

describe("detectLoaderExport", () => {
  it("recognizes commented declarations and export lists", () => {
    expect(detectLoaderExport("export /* build-time */ function loader() {}\n")).toBe(true);
    expect(
      detectLoaderExport("const loader = () => {}; export { /* route state */ loader };\n"),
    ).toBe(true);
    expect(detectLoaderExport('export { data as loader } from "./data.ts";\n')).toBe(true);
    expect(detectLoaderExport('export /* conservative */ * from "./data.ts";\n')).toBe(true);
  });

  it("recognizes loaders exported through destructuring bindings", () => {
    expect(detectLoaderExport("export const { value: loader } = source;\n")).toBe(true);
    expect(detectLoaderExport("export const { nested: { loader } } = source;\n")).toBe(true);
    expect(detectLoaderExport("export const [loader] = source;\n")).toBe(true);
    expect(detectLoaderExport("export const route = { loader: source };\n")).toBe(false);
  });

  it("only treats exported variable bindings as loaders", () => {
    expect(detectLoaderExport("export const Component = () => <Widget loader={value} />;\n")).toBe(
      false,
    );
    expect(
      detectLoaderExport(
        "export const Component = () => <Widget loader={value} />, loader = () => ({});\n",
      ),
    ).toBe(true);
  });

  it("does not treat identifiers in TypeScript generic types as variable bindings", () => {
    expect(detectLoaderExport("export const Component: Pair<View, loader> = view;\n")).toBe(false);
    expect(
      detectLoaderExport("export const Component = view satisfies Pair<View, loader>;\n"),
    ).toBe(false);
    expect(detectLoaderExport("export const Component = async <T, loader>() => null;\n")).toBe(
      false,
    );
    expect(
      detectLoaderExport(
        "export const Component: Pair<View, loader> = view, loader = () => ({});\n",
      ),
    ).toBe(true);
  });

  it("ignores loader-shaped text in comments and strings", () => {
    expect(
      detectLoaderExport(
        'const text = "export function loader() {}";\n// export { loader }\nexport { text };\n',
      ),
    ).toBe(false);
  });

  it("ignores type-only loader exports", () => {
    expect(detectLoaderExport("export interface loader { value: string }\n")).toBe(false);
    expect(detectLoaderExport("export type loader = () => unknown;\n")).toBe(false);
    expect(detectLoaderExport("export declare const loader: () => unknown;\n")).toBe(false);
    expect(detectLoaderExport('export { type loader } from "./types.ts";\n')).toBe(false);
  });

  it("falls back safely for JSX and TSRX component syntax", () => {
    expect(
      detectLoaderExport(`
        export function Component() {
          return <section><p>client-only</p></section>;
        }
      `),
    ).toBe(false);
    expect(
      detectLoaderExport(`
        export /* build-time */ function loader() { return {}; }
        export component Component() { <p>TSRX</p> }
      `),
    ).toBe(true);
  });

  it("does not mistake regex contents for comments in the JSX fallback", () => {
    expect(
      detectLoaderExport(
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

describe("detectStaticPathsExport", () => {
  it("recognizes declarations, export lists, and re-exports", () => {
    expect(detectStaticPathsExport("export function getStaticPaths() { return []; }\n")).toBe(true);
    expect(detectStaticPathsExport("export async function getStaticPaths() {}\n")).toBe(true);
    expect(detectStaticPathsExport("export const getStaticPaths = () => [];\n")).toBe(true);
    expect(
      detectStaticPathsExport("const paths = () => []; export { paths as getStaticPaths };\n"),
    ).toBe(true);
    expect(detectStaticPathsExport('export { getStaticPaths } from "./paths.ts";\n')).toBe(true);
    // `export *` could expose one, so it stays conservative.
    expect(detectStaticPathsExport('export * from "./paths.ts";\n')).toBe(true);
  });

  it("does not mistake comments, strings, or local bindings for an export", () => {
    expect(
      detectStaticPathsExport("// TODO: add getStaticPaths\nexport function Component() {}\n"),
    ).toBe(false);
    expect(detectStaticPathsExport('const hint = "getStaticPaths";\n')).toBe(false);
    expect(
      detectStaticPathsExport("function getStaticPaths() {}\nexport function Component() {}\n"),
    ).toBe(false);
    expect(detectStaticPathsExport("export function Component() {}\n")).toBe(false);
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
