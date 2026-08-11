import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readProjectConfig } from "../src/project.ts";

const tempDirs: string[] = [];

function makeProject(config: string): string {
  const root = mkdtempSync(join(tmpdir(), "pracht-project-config-"));
  tempDirs.push(root);
  writeFileSync(join(root, "vite.config.ts"), config);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("readProjectConfig additionalExtensions", () => {
  it("reads an inline quoted array", () => {
    const project = readProjectConfig(
      makeProject(
        'export default { plugins: [pracht({ additionalExtensions: [".tsrx", ".vue"] })] };',
      ),
    );

    expect(project.additionalExtensions).toEqual([".tsrx", ".vue"]);
  });

  it("reads a quoted array through a const and defaults to an empty list", () => {
    const configured = readProjectConfig(
      makeProject(
        'const routeExtensions = [".custom"] as const;\nexport default { plugins: [pracht({ additionalExtensions: routeExtensions })] };',
      ),
    );
    const defaults = readProjectConfig(makeProject("export default { plugins: [pracht()] };"));

    expect(configured.additionalExtensions).toEqual([".custom"]);
    expect(defaults.additionalExtensions).toEqual([]);
  });

  it("reads arrays with comments and a trailing comma", () => {
    const project = readProjectConfig(
      makeProject(`
        export default {
          plugins: [
            pracht({
              additionalExtensions: [
                ".tsrx", // Ripple routes
                /* Vue routes */ ".vue",
              ],
            }),
          ],
        };
      `),
    );

    expect(project.additionalExtensions).toEqual([".tsrx", ".vue"]);
  });
});
