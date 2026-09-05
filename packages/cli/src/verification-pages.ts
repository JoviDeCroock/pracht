import {
  readPageStringExport,
  readPageRevalidation,
  PAGES_APP_CONFIG_EXPORTS,
  pagesShellName,
  findOwningPagesShell,
  maskMarkdownFences,
  hasNamedValueExport,
  hasValueStarExport,
} from "@pracht/capabilities/static";
export {
  PAGES_APP_CONFIG_EXPORTS,
  pagesShellName,
  findOwningPagesShell,
} from "@pracht/capabilities/static";

import { parseAst } from "vite";
import { readFileSync } from "node:fs";
import { basename, extname, relative } from "node:path";

import { hasPagesAppShell, listDirectoriesRecursively, listFilesRecursively } from "./project.js";
import { isPageSource, normalizeRoutePath } from "./verification-helpers.js";

export type PagesFile =
  | {
      file: string;
      kind: "shell";
      /** Posix directory relative to the pages directory; `""` at the root. */
      directory: string;
      /** Registered shell name: `pages` at the root, `pages:blog` for `blog/_app.tsx`. */
      shellName: string;
      hasRevalidateExport: boolean;
    }
  | { file: string; kind: "not-found"; hasRevalidateExport: boolean }
  | {
      file: string;
      kind: "middleware";
      nested: boolean;
      shape: "directory" | "file" | "unsupported-extension";
    }
  | {
      file: string;
      kind: "app-config";
      nested: boolean;
      supportedExtension: boolean;
      /** The subset of PAGES_APP_CONFIG_EXPORTS the module declares. */
      exports: string[];
      /** A value `export *` hides the export set from static analysis. */
      opaque: boolean;
    }
  | { file: string; kind: "ignored" }
  | PagesRoute;

/**
 * The `defineApp` keys a pages app may set from `_app.config.ts`.
 *
 * Server-only by design. `notFound` is not one of them — the client router
 * reads `app.notFound`, so accepting it here would pull the config module (and
 * its Web Bot Auth keys) into the browser bundle. `pages/404.tsx` covers it.
 */

// Mirrors the vite plugin's pages middleware extensions (and the
// `middlewareDir` registry glob). Every exact `_middleware` basename using a
// different extension is an error rather than a silently ignored auth gate.
const PAGES_MIDDLEWARE_SOURCE_RE = /\.(ts|tsx|js|jsx)$/;

export interface PagesRoute {
  file: string;
  kind: "route";
  routePath: string;
  renderMode?: string;
  revalidate:
    | { kind: "missing" }
    | { kind: "invalid"; expression: string }
    | { kind: "time"; seconds: number };
}

export function scanPagesDirectory(
  pagesDir: string,
  additionalExtensions: string[] = [],
): PagesFile[] {
  const middlewareDirectories: PagesFile[] = listDirectoriesRecursively(pagesDir)
    .filter((directory) => basename(directory) === "_middleware")
    .map((directory) => ({
      file: directory,
      kind: "middleware",
      nested: relative(pagesDir, directory).replace(/\\/g, "/").includes("/"),
      shape: "directory",
    }));
  const files = listFilesRecursively(pagesDir)
    .filter(
      (file) =>
        !isInsideMiddlewareDirectory(pagesDir, file) &&
        (isPageSource(file, additionalExtensions) ||
          basename(file, extname(file)) === "_middleware" ||
          basename(file, extname(file)) === "_app.config"),
    )
    .map((file) => describePagesFile(pagesDir, file, additionalExtensions));
  return [...middlewareDirectories, ...files];
}

export function describePagesFile(
  pagesDir: string,
  file: string,
  additionalExtensions: string[] = [],
): PagesFile {
  const relativePath = relative(pagesDir, file).replace(/\\/g, "/");
  const extensionIndex = relativePath.lastIndexOf(".");
  const routePath = extensionIndex === -1 ? relativePath : relativePath.slice(0, extensionIndex);
  const name = basename(routePath);
  const parentSegments = relativePath.split("/").slice(0, -1);

  // Files inside a `_middleware/` directory are middleware-shaped too: without
  // this, `_middleware/index.ts` silently becomes a page route at
  // `/_middleware` while looking like an auth gate.
  if (parentSegments.includes("_middleware")) {
    return { file, kind: "middleware", nested: true, shape: "directory" };
  }

  // Like `_middleware`, app config is checked before reserved parent
  // directories are ignored: build-time discovery scans every file for this
  // basename, so a stray copy has to be reported rather than dropped.
  if (name === "_app.config") {
    const supportedExtension = PAGES_MIDDLEWARE_SOURCE_RE.test(file);
    if (!supportedExtension) {
      return {
        file,
        kind: "app-config",
        nested: relativePath.includes("/"),
        supportedExtension,
        exports: [],
        opaque: false,
      };
    }
    const program = parseAst(readFileSync(file, "utf-8"), { lang: parserLanguage(file) });
    return {
      file,
      kind: "app-config",
      nested: relativePath.includes("/"),
      supportedExtension,
      exports: PAGES_APP_CONFIG_EXPORTS.filter((key) => hasNamedValueExport(program, key)),
      opaque: hasValueStarExport(program),
    };
  }

  // Check middleware-shaped files before ignoring reserved parent directories.
  // Build-time discovery scans every file for this basename, so a file such as
  // `_components/_middleware.ts` must remain a nested-middleware error here too.
  if (name === "_middleware" && PAGES_MIDDLEWARE_SOURCE_RE.test(file)) {
    return { file, kind: "middleware", nested: relativePath.includes("/"), shape: "file" };
  }

  if (name === "_middleware") {
    return {
      file,
      kind: "middleware",
      nested: relativePath.includes("/"),
      shape: "unsupported-extension",
    };
  }

  // The underscore prefix reserves whole directories as well as individual
  // files. Keep implementation helpers such as `_components/button.tsx` out
  // of the route graph, while the `_middleware/` case above remains a hard
  // error because silently ignoring an auth-looking directory would fail open.
  if (parentSegments.some((segment) => segment.startsWith("_"))) {
    return { file, kind: "ignored" };
  }

  const source = readFileSync(file, "utf-8");
  const analysisSource = maskMarkdownFences(source, relativePath);

  if (hasPagesAppShell(file, additionalExtensions)) {
    // Every `_app` is the shell for its own subtree; the nearest one wins and
    // replaces the parent, matching how a group's `shell` behaves in an
    // explicit manifest.
    const directory = parentSegments.join("/");
    return {
      file,
      kind: "shell",
      directory,
      shellName: pagesShellName(directory),
      hasRevalidateExport: extractRevalidate(analysisSource).kind !== "missing",
    };
  }

  if (name.startsWith("_")) {
    return { file, kind: "ignored" };
  }

  const withoutIndex = routePath.replace(/\/index$/, "");
  if (withoutIndex === "404") {
    return {
      file,
      kind: "not-found",
      hasRevalidateExport: extractRevalidate(analysisSource).kind !== "missing",
    };
  }

  if (routePath === "index") {
    return {
      file,
      kind: "route",
      routePath: "/",
      renderMode: extractQuotedExport(analysisSource, "RENDER_MODE"),
      revalidate: extractRevalidate(analysisSource),
    };
  }

  const normalized = withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, "*")
    .replace(/\[([^\].]+)\]/g, ":$1");

  return {
    file,
    kind: "route",
    routePath: normalizeRoutePath(`/${normalized}`),
    renderMode: extractQuotedExport(analysisSource, "RENDER_MODE"),
    revalidate: extractRevalidate(analysisSource),
  };
}

/** The registered shell name for an `_app` in `directory` (posix, `""` at the root). */
/** The oxc parser language for a source file, by extension. */
export function parserLanguage(file: string): "js" | "jsx" | "ts" | "tsx" {
  switch (extname(file).toLowerCase()) {
    case ".js":
      return "js";
    case ".jsx":
      return "jsx";
    case ".tsx":
      return "tsx";
    default:
      return "ts";
  }
}

function isInsideMiddlewareDirectory(pagesDir: string, file: string): boolean {
  return relative(pagesDir, file)
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .includes("_middleware");
}

function extractQuotedExport(source: string, name: string): string | undefined {
  return readPageStringExport(source, name).value;
}

function extractRevalidate(source: string): PagesRoute["revalidate"] {
  const result = readPageRevalidation(source);
  return result.kind === "invalid" ? { kind: "invalid", expression: result.expression } : result;
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
