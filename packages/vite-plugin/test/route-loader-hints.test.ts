import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRouteLoaderHints, detectLoaderExport } from "../src/route-loader-hints.ts";

describe("detectLoaderExport", () => {
  it("recognizes commented declarations and export lists", () => {
    expect(detectLoaderExport("export /* build-time */ function loader() {}\n")).toBe(true);
    expect(
      detectLoaderExport("const loader = () => {}; export { /* route state */ loader };\n"),
    ).toBe(true);
    expect(detectLoaderExport('export { data as loader } from "./data.ts";\n')).toBe(true);
    expect(detectLoaderExport('export /* conservative */ * from "./data.ts";\n')).toBe(true);
  });

  it("ignores loader-shaped text in comments and strings", () => {
    expect(
      detectLoaderExport(
        'const text = "export function loader() {}";\n// export { loader }\nexport { text };\n',
      ),
    ).toBe(false);
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
});
