import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ConfigEnv, UserConfig } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPrachtClientModuleSource,
  createPrachtRegistryModuleSource,
  pracht,
} from "../src/index.ts";
import { createPrachtDevModuleSource } from "../src/plugin-codegen.ts";
import {
  GENERATED_PAGES_MANIFEST_MARKER,
  generatePagesManifestSource,
  generateRoutesFile,
  scanPagesDirectory,
} from "../src/pages-router.ts";

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
  it("preserves built-in TSRX route and shell discovery", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(join(pagesDir, "index.tsrx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.tsrx"), "export function Shell() { return null; }\n");

    expect(scanPagesDirectory(pagesDir).map((page) => page.relativePath)).toEqual(["index.tsrx"]);
    expect(generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toContain(
      "_app.tsrx",
    );
  });

  it("discovers configured additional route and shell extensions only when enabled", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(join(pagesDir, "index.custom"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.custom"), "export function Shell() { return null; }\n");

    expect(scanPagesDirectory(pagesDir)).toEqual([]);
    const customPages = scanPagesDirectory(pagesDir, [".custom"]);
    expect(customPages.map((page) => [page.routePath, page.relativePath])).toEqual([
      ["/", "index.custom"],
    ]);
    expect(customPages[0]?.hasHead).toBe(true);

    const source = generatePagesManifestSource(customPages, {
      additionalExtensions: [".custom"],
      pagesDir,
    });
    expect(source).toContain("shells: {");
    expect(source).toContain("_app.custom");
    expect(source).toContain("hasHead: true");
  });

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
    expect(pages.find((page) => page.routePath === "/guide")?.hasHead).toBe(true);
    expect(pages.find((page) => page.routePath === "/")?.hasHead).toBe(false);
  });

  it("detects named and re-exported head exports for navigation hints", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      "export function head() { return {}; }\nexport default function Page() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "about.tsx"),
      'export { metadata as head } from "./shared";\nexport default function Page() { return null; }\n',
    );
    writeFileSync(
      join(pagesDir, "comment.tsx"),
      "// export function head() { return {}; }\nexport default function Page() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "example.tsx"),
      "const example = `export const head = () => ({})`;\nexport default function Page() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "annotated.tsx"),
      "export function /* navigation metadata */ head() { return {}; }\nexport default function Page() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "combined.tsx"),
      'export const title = "Combined", head = () => ({ title });\nexport default function Page() { return null; }\n',
    );
    writeFileSync(
      join(pagesDir, "metadata.tsx"),
      'export const metadata = { head: "not an export" };\nexport default function Page() { return null; }\n',
    );
    writeFileSync(
      join(pagesDir, "type-only.tsx"),
      "type Head = () => Record<string, unknown>;\nexport { type Head as head };\nexport default function Page() { return null; }\n",
    );

    const pages = scanPagesDirectory(pagesDir);
    expect(pages.find((page) => page.routePath === "/")?.hasHead).toBe(true);
    expect(pages.find((page) => page.routePath === "/about")?.hasHead).toBe(true);
    expect(pages.find((page) => page.routePath === "/comment")?.hasHead).toBe(false);
    expect(pages.find((page) => page.routePath === "/example")?.hasHead).toBe(false);
    expect(pages.find((page) => page.routePath === "/annotated")?.hasHead).toBe(true);
    expect(pages.find((page) => page.routePath === "/combined")?.hasHead).toBe(true);
    expect(pages.find((page) => page.routePath === "/metadata")?.hasHead).toBe(false);
    expect(pages.find((page) => page.routePath === "/type-only")?.hasHead).toBe(false);
  });

  it("ignores every file beneath underscore-prefixed directories", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "_components", "nested"), { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_components", "button.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "_components", "nested", "index.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "_components", "_app.tsx"),
      "export function Shell() { return null; }\n",
    );

    const pages = scanPagesDirectory(pagesDir);
    const source = generatePagesManifestSource(pages, { pagesDir });

    expect(pages.map((page) => page.routePath)).toEqual(["/"]);
    expect(source).not.toContain("_components");
    expect(source).not.toContain("shells:");
  });

  it("extracts the HYDRATION export and emits it in the generated manifest", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(
      join(pagesDir, "index.tsx"),
      'export const RENDER_MODE = "ssg";\nexport const HYDRATION = "islands";\nexport function Component() { return null; }\n',
    );
    writeFileSync(join(pagesDir, "about.tsx"), "export function Component() { return null; }\n");

    const pages = scanPagesDirectory(pagesDir);
    expect(pages.find((page) => page.routePath === "/")?.hydrationMode).toBe("islands");
    expect(pages.find((page) => page.routePath === "/about")?.hydrationMode).toBeUndefined();

    const source = generatePagesManifestSource(pages, { pagesDir });
    expect(source).toContain('hydration: "islands"');
    // Routes without a HYDRATION export stay on the default (full) hydration.
    expect(source.match(/hydration:/g)).toHaveLength(1);
  });

  it("turns a pages ISG policy into time-based revalidation", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      [
        'export const RENDER_MODE = "isg";',
        "export const REVALIDATE = 1_200 as const;",
        "export function Component() { return null; }",
        "",
      ].join("\n"),
    );

    const pages = scanPagesDirectory(pagesDir);
    expect(pages[0].revalidateSeconds).toBe(1200);
    const source = generatePagesManifestSource(pages, { pagesDir });
    expect(source).toContain("timeRevalidate");
    expect(source).toContain('render: "isg"');
    expect(source).toContain("revalidate: timeRevalidate(1200)");
  });

  it("fails closed when an effective pages ISG route has no policy", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      'export const RENDER_MODE = "isg";\nexport function Component() { return null; }\n',
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /does not export a revalidation policy/,
    );
    expect(() =>
      generatePagesManifestSource(scanPagesDirectory(pagesDir), {
        pagesDir,
        pagesDefaultRender: "isg",
      }),
    ).toThrow(/does not export a revalidation policy/);
  });

  it("requires every route inheriting an ISG default to declare its own policy", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      "export const REVALIDATE = 60;\nexport function Component() { return null; }\n",
    );
    writeFileSync(
      join(pagesDir, "live.tsx"),
      'export const RENDER_MODE = "ssr";\nexport function Component() { return null; }\n',
    );

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), {
      pagesDir,
      pagesDefaultRender: "isg",
    });
    expect(source).toContain("revalidate: timeRevalidate(60)");
    expect(source).toContain('route("/live"');
  });

  it.each(["ssr", "ssg", "spa"])("rejects REVALIDATE on %s pages", (render) => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      `export const RENDER_MODE = "${render}";\nexport const REVALIDATE = 60;\n`,
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /REVALIDATE is only valid/,
    );
  });

  it.each(["0", "-1", "1.5", "1e3", '"60"', "SECONDS", "30 * 2"])(
    "rejects unsupported REVALIDATE expression %s",
    (expression) => {
      const pagesDir = makeTempPagesDir();
      writeFileSync(
        join(pagesDir, "index.tsx"),
        `export const RENDER_MODE = "isg";\nexport const REVALIDATE = ${expression};\n`,
      );
      expect(() => scanPagesDirectory(pagesDir)).toThrow(/positive integer literal/);
    },
  );

  it("ignores commented and string-contained policy declarations", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      [
        'export const RENDER_MODE = "isg";',
        "// export const REVALIDATE = 60;",
        'const text = "export const REVALIDATE = 120";',
        "export function Component() { return text; }",
        "",
      ].join("\n"),
    );
    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /does not export a revalidation policy/,
    );
  });

  it("ignores commented and string-contained render and hydration exports", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "index.tsx"),
      [
        '// export const RENDER_MODE = "isg";',
        "const example = 'export const HYDRATION = \"islands\"';",
        'export const RENDER_MODE = "ssr";',
        'export const HYDRATION = "none";',
        "export const REVALIDATE = 60;",
        "export function Component() { return example; }",
        "",
      ].join("\n"),
    );

    const pages = scanPagesDirectory(pagesDir);
    expect(pages[0]).toMatchObject({ renderMode: "ssr", hydrationMode: "none" });
    expect(() => generatePagesManifestSource(pages, { pagesDir })).toThrow(
      /REVALIDATE is only valid/,
    );
  });

  it("ignores Markdown fenced policy examples but retains top-level MDX exports", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(
      join(pagesDir, "guide.mdx"),
      [
        'export const RENDER_MODE = "isg";',
        "export const REVALIDATE = 90;",
        "",
        "# Guide",
        "",
        "```ts",
        'export const RENDER_MODE = "ssr";',
        "export const REVALIDATE = 10;",
        "```",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "reference.md"),
      [
        "# Reference",
        "",
        "~~~ts",
        'export const RENDER_MODE = "isg";',
        "export const REVALIDATE = 60;",
        "~~~",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "nested.md"),
      [
        "# Nested examples",
        "",
        "> ```ts",
        '> export const RENDER_MODE = "isg";',
        "> export const REVALIDATE = 60;",
        "> ```",
        "",
        "- ~~~ts",
        '  export const RENDER_MODE = "isg";',
        "  export const REVALIDATE = 30;",
        "  ~~~",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "ordered.mdx"),
      [
        "10. ~~~ts",
        '    export const RENDER_MODE = "ssr";',
        "    export const REVALIDATE = 30;",
        "    ~~~",
        "",
        'export const RENDER_MODE = "isg";',
        "export const REVALIDATE = 75;",
        "",
      ].join("\n"),
    );

    const pages = scanPagesDirectory(pagesDir);
    expect(pages.find((page) => page.routePath === "/guide")).toMatchObject({
      renderMode: "isg",
      revalidateSeconds: 90,
    });
    expect(pages.find((page) => page.routePath === "/reference")).toMatchObject({
      renderMode: undefined,
      revalidateSeconds: undefined,
    });
    expect(pages.find((page) => page.routePath === "/nested")).toMatchObject({
      renderMode: undefined,
      revalidateSeconds: undefined,
    });
    expect(pages.find((page) => page.routePath === "/ordered")).toMatchObject({
      renderMode: "isg",
      revalidateSeconds: 75,
    });
    expect(() => generatePagesManifestSource(pages, { pagesDir })).not.toThrow();
  });

  it("rejects REVALIDATE on the pages app shell", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.tsx"), "export const REVALIDATE = 60;\n");
    expect(() => scanPagesDirectory(pagesDir)).toThrow(/app shell.*REVALIDATE/s);
  });

  it("rejects REVALIDATE on the not-found page", () => {
    const pagesDir = makeTempPagesDir();
    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "404.tsx"), "export const REVALIDATE = 60;\n");
    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /not-found.*REVALIDATE/s,
    );
  });

  it("wires pages/404 as the app notFound page instead of a route", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "404.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.tsx"), "export function Shell() { return null; }\n");

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir });

    expect(source).toContain(
      `notFound: { component: "./${basename(pagesDir)}/404.tsx", shell: "pages" }`,
    );
    // The 404 page is not reachable at a URL of its own.
    expect(source).not.toContain('route("/404"');
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

  it("detects loader exports declared through named re-exports", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(
      join(pagesDir, "index.tsx"),
      [
        "const loader = async () => ({ ok: true });",
        "export { loader };",
        "export default function Home() {",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "about.tsx"),
      [
        'export { loader } from "./_shared";',
        "export default function About() {",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "docs.tsx"),
      [
        'export * from "./_shared";',
        "export default function Docs() {",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(pagesDir, "_shared.ts"),
      ["export async function loader() {", "  return { ok: true };", "}", ""].join("\n"),
    );

    const pages = scanPagesDirectory(pagesDir);

    expect(pages.find((page) => page.routePath === "/")?.hasLoader).toBe(true);
    expect(pages.find((page) => page.routePath === "/about")?.hasLoader).toBe(true);
    expect(pages.find((page) => page.routePath === "/docs")?.hasLoader).toBe(true);
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
    expect(source).toContain(
      `route("/", "./${basename(pagesDir)}/index.mdx", { render: "ssr", hasLoader: false, hasHead: true })`,
    );
  });

  it("registers root _middleware as named middleware on every route", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "about.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.tsx"), "export function Shell() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir });

    expect(source).toContain("middleware: {");
    expect(source).toContain(`pages: "./${basename(pagesDir)}/_middleware.ts",`);
    expect(source).toContain('group({ shell: "pages", middleware: ["pages"] }, [');
    // `_middleware` never becomes a route.
    expect(source).not.toContain('route("/_middleware"');
  });

  it("wraps routes in a middleware-only group when there is no _app shell", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir });

    expect(source).not.toContain("shells:");
    expect(source).toContain('group({ middleware: ["pages"] }, [');
  });

  it("accepts middleware in a multi-declarator export", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const helper = 1, middleware = async (_args, next) => next();\n",
    );

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir });
    expect(source).toContain(`pages: "./${basename(pagesDir)}/_middleware.ts",`);
  });

  it("emits prefix and import-syntax refs for _middleware", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    const pages = scanPagesDirectory(pagesDir);
    const virtualSource = generatePagesManifestSource(pages, {
      pagesDir,
      pagesDirPrefix: "/src/pages",
    });
    expect(virtualSource).toContain('pages: "/src/pages/_middleware.ts",');

    const ejectedSource = generatePagesManifestSource(pages, {
      pagesDir,
      useImportSyntax: true,
    });
    expect(ejectedSource).toContain(
      `pages: () => import("./${basename(pagesDir)}/_middleware.ts"),`,
    );
  });

  it("rejects nested _middleware files", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "admin"), { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "admin", "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /Nested pages middleware is not supported/,
    );
  });

  it("rejects a _middleware directory instead of treating its contents as routes", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "_middleware"), { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware", "index.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /`_middleware` directory is not supported/,
    );
  });

  it.each([".md", ".mdx", ".tsrx"])(
    "rejects _middleware%s instead of silently ignoring it",
    (extension) => {
      const pagesDir = makeTempPagesDir();

      writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
      writeFileSync(
        join(pagesDir, `_middleware${extension}`),
        "export const middleware = async (_args, next) => next();\n",
      );

      expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
        `cannot use the ${JSON.stringify(extension)} extension`,
      );
    },
  );

  it("rejects _middleware files using a configured custom page extension", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.vue"), "<template><main>Home</main></template>\n");
    writeFileSync(
      join(pagesDir, "_middleware.vue"),
      "<script>export const middleware = async (_args, next) => next();</script>\n",
    );

    const additionalExtensions = [".vue"];
    expect(() =>
      generatePagesManifestSource(scanPagesDirectory(pagesDir, additionalExtensions), {
        additionalExtensions,
        pagesDir,
      }),
    ).toThrow(/cannot use the "\.vue" extension/);
  });

  it("emits ejected route and notFound refs relative to the manifest directory", () => {
    const pagesDir = makeTempPagesDir();
    mkdirSync(join(pagesDir, "blog"), { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "blog", "[slug].tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(join(pagesDir, "404.tsx"), "export function Component() { return null; }\n");

    const source = generatePagesManifestSource(scanPagesDirectory(pagesDir), {
      pagesDir,
      useImportSyntax: true,
    });

    // An ejected manifest lives beside the pages directory (src/routes.ts
    // next to src/pages), so every ref must include the pages directory
    // segment or the manifest points at files that do not exist.
    const base = basename(pagesDir);
    expect(source).toContain(`route("/", () => import("./${base}/index.tsx")`);
    expect(source).toContain(`route("/blog/:slug", () => import("./${base}/blog/[slug].tsx")`);
    expect(source).toContain(`notFound: { component: () => import("./${base}/404.tsx") }`);
    expect(source).not.toContain('import("./index.tsx")');
  });

  it("rejects multiple root _middleware files", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );
    writeFileSync(
      join(pagesDir, "_middleware.js"),
      "export const middleware = async (_args, next) => next();\n",
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /Multiple pages middleware files/,
    );
  });

  it("rejects root _middleware without a named middleware export during codegen", () => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export default async (_args, next) => next();\n",
    );

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /does not export a `middleware` function/,
    );
  });

  it.each([
    ["type-only star re-export", 'export type * from "./middleware-types";\n'],
    ["namespace re-export", 'export * as middleware from "./middleware";\n'],
    [
      "local type alias exported as a value",
      "type Contract = (_args: unknown, next: () => unknown) => unknown;\nexport { Contract as middleware };\n",
    ],
    [
      "local interface exported as a value",
      "interface Contract { (_args: unknown, next: () => unknown): unknown }\nexport { Contract as middleware };\n",
    ],
    [
      "type-only import exported as a value",
      'import type { MiddlewareFn as Contract } from "@pracht/core";\nexport { Contract as middleware };\n',
    ],
    [
      "ambient declaration exported as a value",
      "declare const Contract: unknown;\nexport { Contract as middleware };\n",
    ],
  ])("rejects a %s as pages middleware", (_description, source) => {
    const pagesDir = makeTempPagesDir();

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_middleware.ts"), source);

    expect(() => generatePagesManifestSource(scanPagesDirectory(pagesDir), { pagesDir })).toThrow(
      /does not export a `middleware` function/,
    );
  });

  it("emits ejected refs relative to the requested output path", () => {
    const pagesDir = makeTempPagesDir();
    const outputDir = join(pagesDir, "generated");
    const outputPath = join(outputDir, "routes.ts");
    mkdirSync(outputDir, { recursive: true });

    writeFileSync(join(pagesDir, "index.tsx"), "export function Component() { return null; }\n");
    writeFileSync(join(pagesDir, "_app.tsx"), "export function Shell() { return null; }\n");
    writeFileSync(
      join(pagesDir, "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    generateRoutesFile(pagesDir, outputPath, { pagesDir });
    const source = readFileSync(outputPath, "utf-8");

    expect(source).toContain('route("/", () => import("../index.tsx")');
    expect(source).toContain('pages: () => import("../_app.tsx")');
    expect(source).toContain('pages: () => import("../_middleware.ts")');
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
      "src/routes/**/*.{ts,tsx,js,jsx}",
      "src/shells/**/*.{ts,tsx,js,jsx}",
      "src/middleware/**/*.{ts,tsx,js,jsx}",
      "src/api/**/*.{ts,js,tsx,jsx}",
      "!src/api/**/*.d.ts",
      "src/server/**/*.{ts,js,tsx,jsx}",
      "src/islands/**/*.{ts,tsx,js,jsx}",
      "src/capabilities/**/*.{ts,js,tsx,jsx}",
    ];

    expect(result.optimizeDeps?.entries).toEqual(["custom-entry.ts", ...expectedPrachtEntries]);
    expect(result.environments?.worker.optimizeDeps?.entries).toEqual([
      "virtual:pracht/server",
      ...expectedPrachtEntries,
    ]);
  });

  it("adds only Vite-scannable configured extensions to optimize-deps entries", async () => {
    const plugins = await pracht({ additionalExtensions: [".tsrx", ".vue"] });
    const plugin = plugins.find((candidate) => candidate.name === "pracht:optimize-deps-entries");
    const config = plugin?.config;
    expect(typeof config).toBe("function");

    const result = (config as (config: UserConfig, env: ConfigEnv) => UserConfig)(
      {},
      { command: "serve", isSsrBuild: false, mode: "development" },
    );

    expect(result.optimizeDeps?.entries).toContain("src/routes/**/*.{ts,tsx,js,jsx,vue}");
    expect(result.optimizeDeps?.entries).toContain("src/shells/**/*.{ts,tsx,js,jsx,vue}");

    const withFormatOptimizer = (config as (config: UserConfig, env: ConfigEnv) => UserConfig)(
      { optimizeDeps: { extensions: [".tsrx"] } },
      { command: "serve", isSsrBuild: false, mode: "development" },
    );
    expect(withFormatOptimizer.optimizeDeps?.entries).toContain(
      "src/routes/**/*.{ts,tsx,js,jsx,tsrx,vue}",
    );
  });
});

describe("createPrachtRegistryModuleSource", () => {
  it("includes md and mdx pages plus script server module extensions", () => {
    const source = createPrachtRegistryModuleSource({
      pagesDir: "/src/pages",
    });

    expect(source).toContain("/src/pages/**/*.{ts,tsx,js,jsx,md,mdx}");
    expect(source).toContain("/src/pages/**/*.tsrx");
    expect(source).toContain("/src/pages/**/_app.tsrx");
    expect(source).toContain(
      'import.meta.glob(["/src/api/**/*.{ts,js,tsx,jsx}","!/src/api/**/*.d.ts"])',
    );
    expect(source).toContain("/src/server/**/*.{ts,js,tsx,jsx}");
    expect(source).toContain("/src/middleware/**/*.{ts,tsx,js,jsx}");
  });

  it("adds configured route and shell extension globs", () => {
    const source = createPrachtRegistryModuleSource({
      additionalExtensions: [".tsrx", ".vue"],
      pagesDir: "/src/pages",
    });

    expect(source).toContain("/src/pages/**/*.{tsrx,vue}");
    expect(source).toContain("/src/pages/**/_app.{tsrx,vue}");
  });

  it("keeps compatibility TSRX client module ids bare without configuration", () => {
    const source = createPrachtClientModuleSource();

    expect(source).toContain('import.meta.glob("/src/routes/**/*.tsrx")');
    expect(source).toContain('import.meta.glob("/src/shells/**/*.tsrx")');
    expect(source).not.toContain('/src/routes/**/*.tsrx", { query:');
  });

  it("keeps additional client module ids bare for their format plugins", () => {
    const source = createPrachtClientModuleSource({ additionalExtensions: [".custom"] });

    expect(source).toContain('import.meta.glob("/src/routes/**/*.{tsrx,custom}")');
    expect(source).toContain('import.meta.glob("/src/shells/**/*.{tsrx,custom}")');
    expect(source).not.toContain('/src/routes/**/*.{tsrx,custom}", { query:');
  });

  it("resolves the pages _middleware file through the middleware registry", () => {
    const source = createPrachtRegistryModuleSource({ pagesDir: "/src/pages" });

    expect(source).toContain('import.meta.glob("/src/pages/_middleware.{ts,tsx,js,jsx}")');
    // Manifest mode has no pages middleware glob.
    expect(createPrachtRegistryModuleSource({ appFile: "/src/routes.ts" })).not.toContain(
      "_middleware",
    );
  });

  it("keeps _middleware out of the pages-mode client route glob", () => {
    const root = makeTempPagesDir();
    mkdirSync(join(root, "src", "pages"), { recursive: true });
    writeFileSync(
      join(root, "src", "pages", "index.tsx"),
      "export function Component() { return null; }\n",
    );
    writeFileSync(
      join(root, "src", "pages", "_middleware.ts"),
      "export const middleware = async (_args, next) => next();\n",
    );

    const source = createPrachtClientModuleSource({ pagesDir: "/src/pages" }, { root });

    expect(source).toContain('"!/src/pages/**/_*"');
    expect(source).toContain('"!/src/pages/**/_*/**"');
    expect(source).toContain('import.meta.glob("/src/pages/_app.{ts,tsx,js,jsx}"');
    expect(source).not.toContain("/src/pages/**/_app");
  });

  it("keeps reserved pages helpers out of generated ejected route and shell globs", () => {
    const root = makeTempPagesDir();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "routes.ts"),
      `// ${GENERATED_PAGES_MANIFEST_MARKER}\nexport const app = {};\n`,
    );

    const source = createPrachtClientModuleSource(
      {
        appFile: "/src/routes.ts",
        routesDir: "/src/pages",
        shellsDir: "/src/pages",
        middlewareDir: "/src/pages",
      },
      { root },
    );

    expect(source.match(/"!\/src\/pages\/\*\*\/_\*"/g)).toHaveLength(4);
    expect(source.match(/"!\/src\/pages\/\*\*\/_\*\/\*\*"/g)).toHaveLength(4);
    expect(source).toContain(
      'import.meta.glob("/src/pages/_app.{ts,tsx,js,jsx}", { query: "?pracht-client" })',
    );
  });

  it("preserves underscore modules in ordinary co-located manifest directories", () => {
    const root = makeTempPagesDir();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "routes.ts"), "export const app = {};\n");

    const source = createPrachtClientModuleSource(
      {
        appFile: "/src/routes.ts",
        routesDir: "/src/modules",
        shellsDir: "/src/modules",
        middlewareDir: "/src/modules",
      },
      { root },
    );

    expect(source).not.toContain("!/src/modules/**/_*");
    expect(source).not.toContain('import.meta.glob("/src/modules/_app.');
  });

  it("creates adapter-neutral development metadata", () => {
    const source = createPrachtDevModuleSource({ appFile: "/src/routes.ts" });

    expect(source).toContain('import { app } from "/src/routes.ts"');
    expect(source).toContain("export const resolvedApp = resolveApp(app)");
    expect(source).toContain("export const registry = {");
    expect(source).not.toContain("createCloudflareFetchHandler");
  });

  // The dev banner, `pracht inspect`, and the graph snapshot read the whole
  // app graph from this module, so it carries the adapter-neutral exports the
  // server entry has — without the adapter's runtime-only imports.
  it("exposes the app graph the CLI reads without the adapter entry", () => {
    const source = createPrachtDevModuleSource({
      adapter: {
        id: "cloudflare",
        serverImports: 'import { x } from "@pracht/adapter-cloudflare/runtime";',
        createServerEntryModule: () => 'export * from "/src/cloudflare.ts";',
      },
      appFile: "/src/routes.ts",
    });

    expect(source).toContain(
      'export const apiRoutes = resolveApiRoutes(Object.keys(apiModules), "/src/api");',
    );
    expect(source).toContain('export const buildTarget = "cloudflare";');
    expect(source).not.toContain("/src/cloudflare.ts");
    expect(source).not.toContain("@pracht/adapter-cloudflare/runtime");
  });

  it("reports the node build target when no adapter is configured", () => {
    expect(createPrachtDevModuleSource({ appFile: "/src/routes.ts" })).toContain(
      'export const buildTarget = "node";',
    );
  });
});
