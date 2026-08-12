import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { detectHeadExport, detectLoaderExport } from "./route-loader-hints.ts";
import {
  DEFAULT_ROUTE_EXTENSIONS,
  DEFAULT_SHELL_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";

export interface ScannedPage {
  absolutePath: string;
  relativePath: string;
  routePath: string;
  isIndex: boolean;
  isCatchAll: boolean;
  isDynamic: boolean;
  renderMode?: string;
  hydrationMode?: string;
  revalidateSeconds?: number;
  hasRevalidateExport?: boolean;
  hasLoader?: boolean;
  hasHead?: boolean;
}

export interface PagesRouterOptions {
  pagesDir: string;
  pagesDefaultRender?: string;
  additionalExtensions?: readonly string[];
}

export function scanPagesDirectory(
  pagesDir: string,
  additionalExtensions: readonly string[] = [],
): ScannedPage[] {
  const normalizedExtensions = normalizeAdditionalExtensions(additionalExtensions);
  const pageExtensions = withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, normalizedExtensions);
  const shellExtensions = withAdditionalExtensions(DEFAULT_SHELL_EXTENSIONS, normalizedExtensions);
  const pages: ScannedPage[] = [];
  scan(pagesDir, pagesDir, pages, pageExtensions, shellExtensions);
  const appShell = pages.find((page) => page.routePath === "__shell__");
  if (appShell?.hasRevalidateExport) {
    throw new Error(
      `[pracht] Pages app shell ${JSON.stringify(appShell.relativePath)} exports REVALIDATE, ` +
        "but app shells are not ISG routes. Declare the policy on each ISG page instead.",
    );
  }
  return sortRoutes(pages);
}

function scan(
  dir: string,
  root: string,
  pages: ScannedPage[],
  pageExtensions: Set<string>,
  shellExtensions: Set<string>,
): void {
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
      scan(abs, root, pages, pageExtensions, shellExtensions);
      continue;
    }

    const ext = extname(entry);
    if (!pageExtensions.has(ext)) continue;

    const name = basename(entry, ext);
    if (name === "_app" && !shellExtensions.has(ext)) continue;

    // Skip _-prefixed files except _app
    if (name.startsWith("_") && name !== "_app") continue;

    const rel = relative(root, abs);
    const routePath = filePathToRoutePath(rel);
    const source = readFileSync(abs, "utf-8");
    const analysisSource = maskMarkdownFences(source, rel);
    const renderMode = extractQuotedPageExport(analysisSource, "RENDER_MODE", rel);
    const hydrationMode = extractQuotedPageExport(analysisSource, "HYDRATION", rel);
    const revalidate = extractRevalidateSeconds(analysisSource, rel);
    const hasLoader = detectLoaderExport(analysisSource);
    const hasHead = ext === ".md" || ext === ".mdx" || detectHeadExport(analysisSource);

    pages.push({
      absolutePath: abs,
      relativePath: rel,
      routePath,
      isIndex: name === "index",
      isCatchAll: routePath.split("/").includes("*"),
      isDynamic: routePath.split("/").some((segment) => segment.startsWith(":")),
      renderMode,
      hydrationMode,
      revalidateSeconds: revalidate.seconds,
      hasRevalidateExport: revalidate.present,
      hasLoader,
      hasHead,
    });
  }
}

export function filePathToRoutePath(relativePath: string): string {
  const extension = extname(relativePath);
  let route = extension ? relativePath.slice(0, -extension.length) : relativePath;
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

function extractQuotedPageExport(
  source: string,
  name: "RENDER_MODE" | "HYDRATION",
  relativePath: string,
): string | undefined {
  const masked = maskCommentsAndStrings(source);
  const declarations = [...masked.matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=`, "g"))];
  if (declarations.length === 0) return undefined;
  if (declarations.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports ${name} more than once.`,
    );
  }

  const declaration = declarations[0];
  const valueStart = (declaration.index ?? 0) + declaration[0].length;
  return source
    .slice(valueStart)
    .trimStart()
    .match(/^["'](\w+)["']/)?.[1];
}

const REVALIDATE_RE = /export\s+const\s+REVALIDATE\s*=\s*([^;\n]+)/;

function extractRevalidateSeconds(
  source: string,
  relativePath: string,
): { present: boolean; seconds?: number } {
  const matches = [...maskCommentsAndStrings(source).matchAll(new RegExp(REVALIDATE_RE, "g"))];
  if (matches.length === 0) return { present: false };
  if (matches.length > 1) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} exports REVALIDATE more than once.`,
    );
  }
  const match = matches[0];

  const expression = match[1].trim().replace(/\s+as\s+const$/, "");
  if (!/^\d(?:_?\d)*$/.test(expression)) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds (for example, `export const REVALIDATE = 60`).",
    );
  }

  const seconds = Number(expression.replaceAll("_", ""));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error(
      `[pracht] Pages route ${JSON.stringify(relativePath)} must export REVALIDATE as a ` +
        "positive integer literal number of seconds within JavaScript's safe integer range.",
    );
  }

  return { present: true, seconds };
}

/** Mask Markdown fenced examples while preserving source offsets and top-level MDX exports. */
function maskMarkdownFences(source: string, relativePath: string): string {
  if (!/\.mdx?$/.test(relativePath)) return source;

  const chars = source.split("");
  let activeFence: { character: "`" | "~"; continuationIndent: number; length: number } | null =
    null;
  for (const line of source.matchAll(/.*(?:\r?\n|$)/g)) {
    if (line[0] === "") continue;
    const lineStart = line.index ?? 0;
    const content = line[0].replace(/\r?\n$/, "");
    const stripped = stripMarkdownContainerPrefix(content);
    const fenceContent: string =
      activeFence && stripped.content.startsWith(" ".repeat(activeFence.continuationIndent))
        ? stripped.content.slice(activeFence.continuationIndent)
        : stripped.content;
    const opening: RegExpExecArray | null = activeFence
      ? null
      : /^ {0,3}(`{3,}|~{3,})/.exec(fenceContent);
    const closing = activeFence
      ? new RegExp(`^ {0,3}\\${activeFence.character}{${activeFence.length},}[ \\t]*$`).test(
          fenceContent,
        )
      : false;

    if (activeFence || opening) {
      for (let offset = 0; offset < line[0].length; offset += 1) {
        const index = lineStart + offset;
        if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
      }
    }

    if (closing) {
      activeFence = null;
    } else if (opening) {
      activeFence = {
        character: opening[1][0] as "`" | "~",
        continuationIndent: stripped.continuationIndent,
        length: opening[1].length,
      };
    }
  }
  return chars.join("");
}

function stripMarkdownContainerPrefix(line: string): {
  content: string;
  continuationIndent: number;
} {
  let content = line;
  let continuationIndent = 0;
  while (true) {
    const quote = /^ {0,3}> ?/.exec(content);
    if (quote) {
      content = content.slice(quote[0].length);
      continue;
    }
    const list = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/.exec(content);
    if (!list) return { content, continuationIndent };
    continuationIndent += list[0].length;
    content = content.slice(list[0].length);
  }
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
  const shellExtensions = withAdditionalExtensions(
    DEFAULT_SHELL_EXTENSIONS,
    normalizeAdditionalExtensions(options.additionalExtensions),
  );

  const allFiles = scanAllFiles(pagesDir);
  const appFile = allFiles.find(
    (f) => basename(f, extname(f)) === "_app" && shellExtensions.has(extname(f)),
  );

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
    const filePath = prefix
      ? `${prefix}/${page.relativePath.replace(/\\/g, "/")}`
      : `./${page.relativePath.replace(/\\/g, "/")}`;
    const fileRef = useImport
      ? `() => import(${JSON.stringify(filePath)})`
      : JSON.stringify(filePath);
    const metaParts = [
      `render: ${JSON.stringify(render)}`,
      `hasLoader: ${page.hasLoader ? "true" : "false"}`,
      `hasHead: ${page.hasHead ? "true" : "false"}`,
    ];
    if (page.hydrationMode) {
      metaParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);
    }
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
    if (notFoundEntry) lines.push(notFoundEntry);
    lines.push("});");
  } else {
    lines.push("const app = defineApp({");
    lines.push("  routes: [");
    lines.push(routeEntries.join(",\n"));
    lines.push("  ],");
    if (notFoundEntry) lines.push(notFoundEntry);
    lines.push("});");
  }

  lines.push("");
  return lines.join("\n");
}

function buildNotFoundEntry(
  page: ScannedPage,
  options: { prefix?: string; useImport: boolean; withShell: boolean },
): string {
  const filePath = options.prefix
    ? `${options.prefix}/${page.relativePath.replace(/\\/g, "/")}`
    : `./${page.relativePath.replace(/\\/g, "/")}`;
  const fileRef = options.useImport
    ? `() => import(${JSON.stringify(filePath)})`
    : JSON.stringify(filePath);

  const configParts = [`component: ${fileRef}`];
  if (options.withShell) configParts.push('shell: "pages"');
  if (page.hydrationMode) configParts.push(`hydration: ${JSON.stringify(page.hydrationMode)}`);

  return `  notFound: { ${configParts.join(", ")} },`;
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
  const pages = scanPagesDirectory(pagesDir, options.additionalExtensions);
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
