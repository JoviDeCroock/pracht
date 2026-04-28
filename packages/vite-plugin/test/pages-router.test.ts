import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigEnv, UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import { createPrachtRegistryModuleSource, pracht } from "../src/index.ts";
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

  it("sorts nested dynamic folders after static routes", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "[slug]"), { recursive: true });
    mkdirSync(join(pagesDir, "docs", "[slug]"), { recursive: true });

    writeFileSync(join(pagesDir, "about.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "[slug]", "index.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "docs", "intro.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "docs", "[slug]", "index.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "[...path].tsx"),
      "export function Component() { return null; }\n",
    );

    const pages = scanPagesDirectory(pagesDir);

    expect(pages.map((page) => page.routePath)).toEqual([
      "/about",
      "/docs/intro",
      "/docs/:slug",
      "/:slug",
      "/*",
    ]);
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

describe("pracht plugin config", () => {
  it("adds framework dynamic modules to optimize-deps entries", async () => {
    const plugins = await pracht();
    const plugin = plugins.find((candidate) => candidate.name === "pracht:optimize-deps-entries");
    const config = plugin?.config;
    expect(typeof config).toBe("function");

    const result = (config as (config: UserConfig, env: ConfigEnv) => UserConfig)(
      {
        optimizeDeps: { entries: "custom-entry.ts" },
        environments: {
          worker: { optimizeDeps: { entries: "virtual:pracht/server" } },
        },
      },
      { command: "serve", isSsrBuild: false, mode: "development" },
    );

    const expectedPrachtEntries = [
      "src/routes.ts",
      "src/routes/**/*.{ts,tsx,js,jsx,md,mdx,tsrx}",
      "src/shells/**/*.{ts,tsx,js,jsx,md,mdx,tsrx}",
      "src/middleware/**/*.{ts,tsx,js,jsx}",
      "src/api/**/*.{ts,js,tsx,jsx}",
      "src/server/**/*.{ts,js,tsx,jsx}",
    ];

    expect(result.optimizeDeps?.entries).toEqual(["custom-entry.ts", ...expectedPrachtEntries]);
    expect(result.environments?.worker.optimizeDeps?.entries).toEqual([
      "virtual:pracht/server",
      ...expectedPrachtEntries,
    ]);
  });
});

describe("createPrachtRegistryModuleSource", () => {
  it("includes md and mdx pages plus script server module extensions", () => {
    const source = createPrachtRegistryModuleSource({
      pagesDir: "/src/pages",
    });

    expect(source).toContain("/src/pages/**/*.{ts,tsx,js,jsx,md,mdx}");
    expect(source).toContain("/src/pages/**/*.tsrx");
    expect(source).toContain("/src/api/**/*.{ts,js,tsx,jsx}");
    expect(source).toContain("/src/server/**/*.{ts,js,tsx,jsx}");
    expect(source).toContain("/src/middleware/**/*.{ts,tsx,js,jsx}");
  });
});
