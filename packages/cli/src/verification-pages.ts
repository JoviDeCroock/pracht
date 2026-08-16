import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { readFileSync } from "node:fs";
import { basename, relative } from "node:path";

import { hasPagesAppShell, listFilesRecursively } from "./project.js";
import { isPageSource, normalizeRoutePath } from "./verification-helpers.js";

export type PagesFile =
  | { file: string; kind: "shell"; hasRevalidateExport: boolean }
  | { file: string; kind: "not-found"; hasRevalidateExport: boolean }
  | {
      file: string;
      kind: "middleware";
      nested: boolean;
      shape: "directory" | "file" | "unsupported-extension";
    }
  | { file: string; kind: "ignored" }
  | PagesRoute;

// Mirrors the vite plugin's pages middleware extensions (and the
// `middlewareDir` registry glob). `_middleware.md` stays an ignored file
// (Markdown cannot export a function), but `_middleware.tsrx` and configured
// custom page formats are middleware-shaped files the registry cannot load —
// errors, not routes.
const PAGES_MIDDLEWARE_SOURCE_RE = /\.(ts|tsx|js|jsx)$/;
const PAGES_MIDDLEWARE_UNSUPPORTED_RE = /\.tsrx$/;

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
  return listFilesRecursively(pagesDir)
    .filter(
      (file) =>
        isPageSource(file, additionalExtensions) || isInsideMiddlewareDirectory(pagesDir, file),
    )
    .map((file) => describePagesFile(pagesDir, file, additionalExtensions));
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

  // Check middleware-shaped files before ignoring reserved parent directories.
  // Build-time discovery scans every file for this basename, so a file such as
  // `_components/_middleware.ts` must remain a nested-middleware error here too.
  if (name === "_middleware" && PAGES_MIDDLEWARE_SOURCE_RE.test(file)) {
    return { file, kind: "middleware", nested: relativePath.includes("/"), shape: "file" };
  }

  if (
    name === "_middleware" &&
    (PAGES_MIDDLEWARE_UNSUPPORTED_RE.test(file) ||
      additionalExtensions.some((extension) => file.endsWith(extension)))
  ) {
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

  if (!relativePath.includes("/") && hasPagesAppShell(file, additionalExtensions)) {
    return {
      file,
      kind: "shell",
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

function isInsideMiddlewareDirectory(pagesDir: string, file: string): boolean {
  return relative(pagesDir, file)
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1)
    .includes("_middleware");
}

function extractQuotedExport(source: string, name: string): string | undefined {
  const masked = maskCommentsAndStrings(source);
  const declarations = [...masked.matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=`, "g"))];
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  const valueStart = (declaration.index ?? 0) + declaration[0].length;
  return source
    .slice(valueStart)
    .trimStart()
    .match(/^["'](\w+)["']/)?.[1];
}

function extractRevalidate(source: string): PagesRoute["revalidate"] {
  const matches = [
    ...maskCommentsAndStrings(source).matchAll(/export\s+const\s+REVALIDATE\s*=\s*([^;\n]+)/g),
  ];
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "invalid", expression: "duplicate exports" };
  const match = matches[0];

  const expression = match[1].trim().replace(/\s+as\s+const$/, "");
  if (!/^\d(?:_?\d)*$/.test(expression)) {
    return { kind: "invalid", expression };
  }

  const seconds = Number(expression.replaceAll("_", ""));
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    return { kind: "invalid", expression };
  }
  return { kind: "time", seconds };
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
