import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRouteLoaderHints } from "../src/route-loader-hints.ts";

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
