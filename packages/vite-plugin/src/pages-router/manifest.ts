import { writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { findPagesShellFile, scanPagesDirectory } from "./discovery.ts";
import type { PagesRouterOptions, ScannedPage } from "./model.ts";

export function generatePagesManifestSource(
  pages: ScannedPage[],
  options: PagesRouterOptions & { pagesDirPrefix?: string; useImportSyntax?: boolean },
): string {
  const defaultRender = options.pagesDefaultRender ?? "ssr";
  // pagesDirPrefix is the project-root-relative prefix (e.g. "/src/pages")
  // used to build Vite-resolvable paths in virtual modules.
  const prefix = options.pagesDirPrefix;
  // useImportSyntax: when true, emit `() => import("path")` for IDE navigation.
  // Only used for ejected files; virtual modules must use plain strings.
  const useImport = options.useImportSyntax ?? false;

  const appFile = findPagesShellFile(options.pagesDir);
  const coreImports = pages.some((page) => page.revalidateSeconds !== undefined)
    ? "defineApp, group, route, timeRevalidate"
    : "defineApp, group, route";
  const lines: string[] = [`import { ${coreImports} } from "@pracht/core/manifest";`, ""];

  const routeEntries: string[] = [];
  // `pages/404.tsx` is the app's not-found page, not a route: it renders with
  // a 404 status when nothing matches, and it is never reachable at a URL of
  // its own (which is what would let it shadow a static asset).
  const notFoundPage = pages.find((page) => page.routePath === "/404");
  if (notFoundPage?.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages not-found module ${JSON.stringify(notFoundPage.relativePath)} exports ` +
        "REVALIDATE, but not-found responses are never ISG routes.",
    );
  }

  for (const page of pages) {
    if (page === notFoundPage) continue;
    const render = page.renderMode ?? defaultRender;
    assertValidRevalidationPolicy(page, render);

    const filePath = prefix
      ? `${prefix}/${normalizeRelativePath(page.relativePath)}`
      : `./${normalizeRelativePath(page.relativePath)}`;
    const fileRef = useImport
      ? `() => import(${JSON.stringify(filePath)})`
      : JSON.stringify(filePath);
    const metaParts = [
      `render: ${JSON.stringify(render)}`,
      `hasLoader: ${page.hasLoader ? "true" : "false"}`,
    ];
    if (page.hydrationMode) metaParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);
    if (page.revalidateSeconds !== undefined) {
      metaParts.push(`revalidate: timeRevalidate(${page.revalidateSeconds})`);
    }
    routeEntries.push(
      `    route(${JSON.stringify(page.routePath)}, ${fileRef}, { ${metaParts.join(", ")} })`,
    );
  }

  const notFoundEntry = notFoundPage
    ? buildNotFoundEntry(notFoundPage, { prefix, useImport, withShell: !!appFile })
    : null;

  lines.push("const app = defineApp({");
  if (appFile) {
    const appPath = prefix
      ? `${prefix}/_app.${extname(appFile).slice(1)}`
      : `./${normalizeRelativePath(relative(join(options.pagesDir, ".."), appFile))}`;
    const shellRef = useImport
      ? `() => import(${JSON.stringify(appPath)})`
      : JSON.stringify(appPath);
    lines.push("  shells: {");
    lines.push(`    pages: ${shellRef},`);
    lines.push("  },");
    lines.push("  routes: [");
    lines.push(`    group({ shell: "pages" }, [`);
    lines.push(routeEntries.join(",\n"));
    lines.push("    ]),");
  } else {
    lines.push("  routes: [");
    lines.push(routeEntries.join(",\n"));
  }
  lines.push("  ],");
  if (notFoundEntry) lines.push(notFoundEntry);
  lines.push("});");
  lines.push("");
  return lines.join("\n");
}

export function generateRoutesFile(
  pagesDir: string,
  outputPath: string,
  options: PagesRouterOptions,
): void {
  const pages = scanPagesDirectory(pagesDir);
  // For standalone files, replace `const app` with `export const app`.
  const manifestSource = generatePagesManifestSource(pages, {
    ...options,
    useImportSyntax: true,
  }).replace("const app = defineApp(", "export const app = defineApp(");
  const source = [
    "// Auto-generated from pages/ directory by @pracht/vite-plugin.",
    "// Customize this file and remove `pagesDir` from pracht config to use it directly.",
    "",
    manifestSource,
  ].join("\n");

  writeFileSync(outputPath, source, "utf-8");
}

function assertValidRevalidationPolicy(page: ScannedPage, render: string): void {
  if (render === "isg" && page.revalidateSeconds === undefined) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(page.relativePath)} uses render mode "isg" but ` +
        "does not export a revalidation policy. Add `export const REVALIDATE = 60` with a " +
        "positive integer number of seconds, or use another render mode.",
    );
  }
  if (render !== "isg" && page.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(page.relativePath)} exports REVALIDATE but its ` +
        `effective render mode is ${JSON.stringify(render)}. REVALIDATE is only valid with ` +
        '`RENDER_MODE = "isg"` (or `pagesDefaultRender: "isg"`).',
    );
  }
}

function buildNotFoundEntry(
  page: ScannedPage,
  options: { prefix?: string; useImport: boolean; withShell: boolean },
): string {
  const filePath = options.prefix
    ? `${options.prefix}/${normalizeRelativePath(page.relativePath)}`
    : `./${normalizeRelativePath(page.relativePath)}`;
  const fileRef = options.useImport
    ? `() => import(${JSON.stringify(filePath)})`
    : JSON.stringify(filePath);

  const configParts = [`component: ${fileRef}`];
  if (options.withShell) configParts.push('shell: "pages"');
  if (page.hydrationMode) configParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);

  return `  notFound: { ${configParts.join(", ")} },`;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}
