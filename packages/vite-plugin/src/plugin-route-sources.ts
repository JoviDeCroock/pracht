import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";
import { createRouteLoaderHints } from "./route-loader-hints.ts";

const ROUTE_MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".mdx", ".tsrx"]);
const NON_FULL_HYDRATION_RE = /hydration\s*:\s*["'](?:islands|none)["']/;
const FULL_HYDRATION_RE = /hydration\s*:\s*["']full["']/;
const PAGES_NON_FULL_HYDRATION_RE = /export\s+const\s+HYDRATION\s*=\s*["'](?:islands|none)["']/;

export function createNonFullHydrationExcludes(
  resolved: ResolvedPrachtPluginOptions,
  root: string = process.cwd(),
): string[] {
  const excludes = new Set<string>();

  if (resolved.pagesDir) {
    const files: string[] = [];
    scanFiles(resolve(root, resolved.pagesDir.replace(/^\//, "")), files);
    for (const file of files) {
      try {
        if (PAGES_NON_FULL_HYDRATION_RE.test(readFileSync(file, "utf-8"))) {
          excludes.add(
            `!/${toPosixPath(file).replace(toPosixPath(root).replace(/\/$/, "") + "/", "")}`,
          );
        }
      } catch {}
    }
    return [...excludes];
  }

  const appFile = resolve(root, resolved.appFile.replace(/^\//, ""));
  let source: string;
  try {
    source = readFileSync(appFile, "utf-8");
  } catch {
    return [];
  }
  const groups: Array<{ start: number; end: number; nonFull: boolean }> = [];
  for (const match of source.matchAll(/\bgroup\s*\(/g)) {
    const parenStart = match.index! + match[0].lastIndexOf("(");
    const parenEnd = findMatching(source, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const args = source.slice(parenStart + 1, parenEnd);
    const arrayStart = source.indexOf("[", parenStart);
    if (arrayStart === -1 || arrayStart > parenEnd) continue;
    const arrayEnd = findMatching(source, arrayStart, "[", "]");
    if (arrayEnd === -1) continue;
    groups.push({
      start: arrayStart,
      end: arrayEnd,
      nonFull: NON_FULL_HYDRATION_RE.test(args.split("[")[0] ?? ""),
    });
  }

  const appDir = dirname(appFile);
  const routeRe =
    /\broute\s*\(\s*[^,]+,\s*(?:(?:\(\s*\)\s*=>\s*import\s*\(\s*)?["']([^"']+)["']\s*\)?|["']([^"']+)["'])/g;
  for (const match of source.matchAll(routeRe)) {
    const fileRef = match[1] ?? match[2];
    const callStart = match.index!;
    const parenStart = source.indexOf("(", callStart);
    const parenEnd = findMatching(source, parenStart, "(", ")");
    if (parenEnd === -1) continue;
    const callSource = source.slice(parenStart, parenEnd);
    const ownNonFull = NON_FULL_HYDRATION_RE.test(callSource);
    const ownFull = FULL_HYDRATION_RE.test(callSource);
    const inheritedNonFull = groups
      .filter((group) => group.start < callStart && callStart < group.end)
      .sort((a, b) => b.start - a.start)[0]?.nonFull;
    if (ownFull || (!ownNonFull && inheritedNonFull !== true)) continue;
    const abs = resolve(appDir, fileRef);
    excludes.add(`!/${toPosixPath(abs).replace(toPosixPath(root).replace(/\/$/, "") + "/", "")}`);
  }

  return [...excludes];
}

export function createRouteLoaderHintsForVirtualModules(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): Record<string, boolean> {
  if (options.pagesDir) {
    const pages = scanPagesDirectory(resolve(root, options.pagesDir.slice(1)));
    const hints: Record<string, boolean> = {};
    for (const page of pages) {
      const key = `${options.pagesDir}/${page.relativePath.replace(/\\/g, "/")}`;
      hints[key] = !!page.hasLoader;
    }
    return hints;
  }

  const appFileAbs = resolve(root, options.appFile.slice(1));
  const appFileDir = dirname(appFileAbs);
  const routesDirAbs = resolve(root, options.routesDir.slice(1));
  return createRouteLoaderHints(routesDirAbs, {
    appFileDir,
    rootRelativePrefix: options.routesDir,
  });
}

const pagesAppSourceCache = new Map<string, string>();

export function clearPagesAppSourceCache(): void {
  pagesAppSourceCache.clear();
}

export function generatePagesAppInlineSource(
  options: ResolvedPrachtPluginOptions,
  root = process.cwd(),
): string {
  const absPagesDir = resolve(root, options.pagesDir.slice(1));
  const cacheKey = JSON.stringify({
    absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  const cached = pagesAppSourceCache.get(cacheKey);
  if (cached) return cached;

  const pages = scanPagesDirectory(absPagesDir);
  const source = generatePagesManifestSource(pages, {
    pagesDir: absPagesDir,
    pagesDefaultRender: options.pagesDefaultRender,
    pagesDirPrefix: options.pagesDir,
  });
  pagesAppSourceCache.set(cacheKey, source);
  return source;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function findMatching(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function scanFiles(dir: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      scanFiles(absolutePath, files);
    } else if (ROUTE_MODULE_EXTENSIONS.has(extname(entry))) {
      files.push(absolutePath);
    }
  }
}
