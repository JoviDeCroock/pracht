import { basename, relative } from "node:path";

import { hasPagesAppShell, listFilesRecursively } from "./project.js";
import { normalizeRoutePath, PAGE_SOURCE_RE } from "./verification-helpers.js";

export type PagesFile =
  | { file: string; kind: "shell" }
  | { file: string; kind: "ignored" }
  | PagesRoute;

export interface PagesRoute {
  file: string;
  kind: "route";
  routePath: string;
}

export function scanPagesDirectory(pagesDir: string): PagesFile[] {
  return listFilesRecursively(pagesDir)
    .filter((file) => PAGE_SOURCE_RE.test(file))
    .map((file) => describePagesFile(pagesDir, file));
}

export function describePagesFile(pagesDir: string, file: string): PagesFile {
  const relativePath = relative(pagesDir, file).replace(/\\/g, "/");
  const routePath = relativePath.replace(/\.(tsx?|jsx?|mdx?)$/, "");
  const name = basename(routePath);

  if (hasPagesAppShell(file)) {
    return { file, kind: "shell" };
  }

  if (name.startsWith("_")) {
    return { file, kind: "ignored" };
  }

  if (routePath === "index") {
    return { file, kind: "route", routePath: "/" };
  }

  const withoutIndex = routePath.replace(/\/index$/, "");
  const normalized = withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, "*")
    .replace(/\[([^\].]+)\]/g, ":$1");

  return {
    file,
    kind: "route",
    routePath: normalizeRoutePath(`/${normalized}`),
  };
}

export function collectDuplicateRoutePaths(
  routes: PagesRoute[],
): { files: string[]; path: string }[] {
  const routeMap = new Map<string, string[]>();

  for (const route of routes) {
    const files = routeMap.get(route.routePath) ?? [];
    files.push(route.file);
    routeMap.set(route.routePath, files);
  }

  return [...routeMap.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([path, files]) => ({ files, path }));
}
