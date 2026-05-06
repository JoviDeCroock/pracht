import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { detectLoaderExport } from "./route-loader-hints.ts";

export interface ScannedPage {
  absolutePath: string;
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isCatchAll: boolean;
  isDynamic: boolean;
  renderMode?: string;
  hasLoader?: boolean;
}

export interface PagesRouterOptions {
  pagesDir: string;
  pagesDefaultRender?: string;
}

const PAGE_EXTENSIONS = new Set([".tsx", ".tsrx", ".ts", ".jsx", ".js", ".md", ".mdx"]);
const SHELL_EXTENSIONS = new Set([".tsx", ".tsrx", ".ts", ".jsx", ".js"]);

export function scanPagesDirectory(pagesDir: string): ScannedPage[] {
  const pages: ScannedPage[] = [];
  scan(pagesDir, pagesDir, pages);
  return sortRoutes(pages);
}

function scan(dir: string, root: string, pages: ScannedPage[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);

    if (stat.isDirectory()) {
      scan(abs, root, pages);
      continue;
    }

    const ext = extname(entry);
    if (!PAGE_EXTENSIONS.has(ext)) continue;

    const name = basename(entry, ext);

    // Skip _-prefixed files except _app
    if (name.startsWith("_") && name !== "_app") continue;

    const rel = relative(root, abs);
    const routePath = filePathToRoutePath(rel);
    const source = readFileSync(abs, "utf-8");
    const renderMode = extractRenderMode(source);
    const hasLoader = detectLoaderExport(source);

    pages.push({
      absolutePath: abs,
      relativePath: rel,
      routePath,
      isIndex: name === "index",
      isCatchAll: routePath.split("/").includes("*"),
      isDynamic: routePath.split("/").some((segment) => segment.startsWith(":")),
      renderMode,
      hasLoader,
    });
  }
}

export function filePathToRoutePath(relativePath: string): string {
  let route = relativePath.replace(/\.(tsx?|tsrx|jsx?|mdx?)$/, "");
  route = route.replace(/\\/g, "/");

  // _app is not a route
  if (route === "_app" || route.endsWith("/_app")) return "__shell__";

  // Remove trailing /index
  if (route === "index") return "/";
  route = route.replace(/\/index$/, "");

  // Convert [param] → :param
  route = route.replace(/\[([^\].]+)\]/g, ":$1");

  // Convert [...param] → *
  route = route.replace(/\[\.\.\.([^\]]+)\]/g, "*");

  return `/${route}`;
}

export function sortRoutes(pages: ScannedPage[]): ScannedPage[] {
  return [...pages].filter((p) => p.routePath !== "__shell__").sort(comparePagesBySpecificity);
}

function comparePagesBySpecificity(left: ScannedPage, right: ScannedPage): number {
  const leftSegments = splitRoutePath(left.routePath);
  const rightSegments = splitRoutePath(right.routePath);
  const length = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < length; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];

    // Exact routes should win over deeper catch-all routes that can also
    // match the same URL (e.g. `/docs` before `/docs/*`).
    if (!leftSegment) return -1;
    if (!rightSegment) return 1;

    const leftScore = getRouteSegmentSpecificity(leftSegment);
    const rightScore = getRouteSegmentSpecificity(rightSegment);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }

    if (leftScore === 3 && leftSegment !== rightSegment) {
      return leftSegment.localeCompare(rightSegment);
    }
  }

  return left.routePath.localeCompare(right.routePath);
}

function splitRoutePath(routePath: string): string[] {
  return routePath.split("/").filter(Boolean);
}

function getRouteSegmentSpecificity(segment: string): number {
  if (segment === "*") return 1;
  if (segment.startsWith(":")) return 2;
  return 3;
}

const RENDER_MODE_RE = /export\s+const\s+RENDER_MODE\s*=\s*["'](\w+)["']/;

function extractRenderMode(source: string): string | undefined {
  const match = RENDER_MODE_RE.exec(source);
  return match ? match[1] : undefined;
}

export function generatePagesManifestSource(
  pages: ScannedPage[],
  options: PagesRouterOptions & { pagesDirPrefix?: string; useImportSyntax?: boolean },
): string {
  const pagesDir = options.pagesDir;
  const defaultRender = options.pagesDefaultRender ?? "ssr";
  // pagesDirPrefix is the project-root-relative prefix (e.g. "/src/pages")
  // used to build Vite-resolvable paths in virtual modules.
  const prefix = options.pagesDirPrefix;
  // useImportSyntax: when true, emit `() => import("path")` for IDE navigation.
  // Only used for ejected files; virtual modules must use plain strings.
  const useImport = options.useImportSyntax ?? false;

  const allFiles = scanAllFiles(pagesDir);
  const appFile = allFiles.find(
    (f) => basename(f, extname(f)) === "_app" && SHELL_EXTENSIONS.has(extname(f)),
  );

  const lines: string[] = ['import { defineApp, group, route } from "@pracht/core/manifest";', ""];

  const routeEntries: string[] = [];

  for (const page of pages) {
    const render = page.renderMode ?? defaultRender;
    const filePath = prefix
      ? `${prefix}/${page.relativePath.replace(/\\/g, "/")}`
      : `./${page.relativePath.replace(/\\/g, "/")}`;
    const fileRef = useImport
      ? `() => import(${JSON.stringify(filePath)})`
      : JSON.stringify(filePath);
    const metaParts = [
      `render: ${JSON.stringify(render)}`,
      `hasLoader: ${page.hasLoader ? "true" : "false"}`,
    ];
    routeEntries.push(
      `    route(${JSON.stringify(page.routePath)}, ${fileRef}, { ${metaParts.join(", ")} })`,
    );
  }

  if (appFile) {
    const appPath = prefix
      ? `${prefix}/_app.${extname(appFile).slice(1)}`
      : `./${relative(join(pagesDir, ".."), appFile).replace(/\\/g, "/")}`;
    const shellRef = useImport
      ? `() => import(${JSON.stringify(appPath)})`
      : JSON.stringify(appPath);
    lines.push("const app = defineApp({");
    lines.push("  shells: {");
    lines.push(`    pages: ${shellRef},`);
    lines.push("  },");
    lines.push("  routes: [");
    lines.push(`    group({ shell: "pages" }, [`);
    lines.push(routeEntries.join(",\n"));
    lines.push("    ]),");
    lines.push("  ],");
    lines.push("});");
  } else {
    lines.push("const app = defineApp({");
    lines.push("  routes: [");
    lines.push(routeEntries.join(",\n"));
    lines.push("  ],");
    lines.push("});");
  }

  lines.push("");
  return lines.join("\n");
}

function scanAllFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      results.push(...scanAllFiles(abs));
    } else {
      results.push(abs);
    }
  }
  return results;
}

export function generateRoutesFile(
  pagesDir: string,
  outputPath: string,
  options: PagesRouterOptions,
): void {
  const pages = scanPagesDirectory(pagesDir);
  // For standalone files, replace `const app` with `export const app`
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
