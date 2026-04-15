import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPrachtRegistryModuleSource } from "../src/index.ts";
import { generatePagesManifestSource, scanPagesDirectory } from "../src/pages-router.ts";

const tempDirs: string[] = [];

function makeTempPagesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pracht-pages-router-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

describe("scanPagesDirectory", () => {
  it("includes markdown and mdx pages in the generated route list", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "docs"), { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "guide.mdx"), 'export const RENDER_MODE = "ssg";\n\n# Guide\n');
    writeFileSync(join(pagesDir, "docs", "getting-started.md"), "# Getting Started\n");
    writeFileSync(join(pagesDir, "[slug].mdx"), "# Dynamic\n");
    writeFileSync(join(pagesDir, "_draft.mdx"), "# Draft\n");

    const pages = scanPagesDirectory(pagesDir);

    expect(pages.map((page) => page.routePath)).toEqual([
      "/",
      "/docs/getting-started",
      "/guide",
      "/:slug",
    ]);
    expect(pages.find((page) => page.routePath === "/guide")?.renderMode).toBe("ssg");
  });
});

describe("generatePagesManifestSource", () => {
  it("does not treat markdown _app files as shells", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.mdx"), "# Home\n");
    writeFileSync(join(pagesDir, "_app.mdx"), "# Not a shell\n");

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), {
      pagesDir,
    });

    expect(source).not.toContain("shells:");
    expect(source).toContain('route("/", "./index.mdx", { render: "ssr" })');
  });
});

describe("createPrachtRegistryModuleSource", () => {
  it("includes md and mdx pages plus script server module extensions", () => {
    const source = createPrachtRegistryModuleSource({
      pagesDir: "/src/pages",
    });

    expect(source).toContain("/src/pages/**/*.{ts,tsx,js,jsx,md,mdx}");
    expect(source).toContain("/src/api/**/*.{ts,js,tsx,jsx}");
    expect(source).toContain("/src/server/**/*.{ts,js,tsx,jsx}");
    expect(source).toContain("/src/middleware/**/*.{ts,tsx,js,jsx}");
  });
});
