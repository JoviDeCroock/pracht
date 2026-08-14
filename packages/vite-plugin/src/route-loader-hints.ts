import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { initSync, parse } from "es-module-lexer";

import {
  DEFAULT_ROUTE_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";

initSync();

const HEAD_DECLARATION_RE = /export\s+(?:async\s+)?(?:function|const|let|var)\s+head\b/;
const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?/g;
const EXPORT_ALL_RE = /export\s+\*\s+from\b/;
const EXPORT_VARIABLE_DECLARATION_RE = /export\s+(?:const|let|var)\b/g;

function isExportAllStatement(source: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, " ");
  return /^\s*export\s*\*/.test(withoutComments);
}

function detectLoaderExportFallback(source: string): boolean {
  const masked = maskCommentsAndStrings(source);
  if (/\bexport\s+(?:async\s+)?function\s+loader\b/.test(masked)) return true;
  if (/\bexport\s+(?:const|let|var)\s+[^;]*\bloader\s*(?::[^=,;]+)?=/.test(masked)) {
    return true;
  }
  // es-module-lexer reports object destructuring property keys rather than
  // their local bindings (`{ value: loader }` is reported as `value`). Keep
  // the loader hint fail-closed for exported binding patterns so static
  // builds never omit route state for a loader that really exists.
  if (
    /\bexport\s+(?:const|let|var)\s+(?:\{[^;]*\bloader\b[^;]*\}|\[[^;]*\bloader\b[^;]*\])\s*(?::[^=;]+)?=/.test(
      masked,
    )
  ) {
    return true;
  }
  if (/\bexport\s*\*/.test(masked)) return true;

  for (const match of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const hasLoader = match[1]
      .split(",")
      .map((specifier) => specifier.trim())
      .filter(Boolean)
      .some((specifier) => {
        const names = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
          specifier,
        );
        if (!names || specifier.startsWith("type ")) return false;
        return (names[2] ?? names[1]) === "loader";
      });
    if (hasLoader) return true;
  }

  return false;
}

function topLevelAssignmentIndex(source: string): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "=" && parentheses === 0 && brackets === 0 && braces === 0) return index;
  }
  return -1;
}

function bindingExportsName(source: string, exportName: string): boolean {
  const assignmentIndex = topLevelAssignmentIndex(source);
  const binding = assignmentIndex === -1 ? source : source.slice(0, assignmentIndex);
  return new RegExp(`\\b${exportName}\\b`).test(binding);
}

function variableDeclarationExports(source: string, exportName: string): boolean {
  for (const match of source.matchAll(EXPORT_VARIABLE_DECLARATION_RE)) {
    let declarationStart = (match.index ?? 0) + match[0].length;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    for (let index = declarationStart; index <= source.length; index += 1) {
      const char = source[index];
      if (char === "(") parentheses += 1;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "{") braces += 1;
      else if (char === "}") braces = Math.max(0, braces - 1);

      const atTopLevel = parentheses === 0 && brackets === 0 && braces === 0;
      if (atTopLevel && (char === "," || char === ";" || char === undefined)) {
        if (bindingExportsName(source.slice(declarationStart, index), exportName)) return true;
        if (char !== ",") break;
        declarationStart = index + 1;
      }
    }
  }
  return false;
}

function exportSpecifiersInclude(specifiers: string, exportName: string): boolean {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .some((specifier) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(specifier);
      if (!match) return false;
      const [, localName, exportedName] = match;
      return (exportedName ?? localName) === exportName;
    });
}

export function detectHeadExport(source: string): boolean {
  // Markdown and MDX transforms can synthesize a head export from frontmatter.
  // Keep them conservative even when the raw source has no JS declaration.
  const analysisSource = maskCommentsAndStrings(source);
  if (
    HEAD_DECLARATION_RE.test(analysisSource) ||
    variableDeclarationExports(analysisSource, "head")
  ) {
    return true;
  }
  for (const match of analysisSource.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersInclude(match[1], "head")) return true;
  }
  return EXPORT_ALL_RE.test(analysisSource);
}

export function detectLoaderExport(source: string): boolean {
  // Run the syntax-aware scan even when es-module-lexer accepts the file. The
  // lexer intentionally does not model binding patterns deeply enough to
  // identify aliased destructuring exports.
  if (detectLoaderExportFallback(source)) return true;

  try {
    const [imports, exports] = parse(source);
    if (exports.some((entry) => entry.n === "loader")) return true;

    // `export *` can expose a loader through a re-export. The lexer reports it
    // as an import record without a named export, so inspect only that exact
    // export statement. Ordinary imports and comments/strings mentioning a
    // loader must not turn a client-only SPA route into a false positive.
    for (const entry of imports) {
      if (entry.d === -1 && isExportAllStatement(source.slice(entry.ss, entry.se))) {
        return true;
      }
    }
  } catch {
    // es-module-lexer intentionally parses JavaScript rather than every JSX or
    // TSRX construct. The syntax-aware scan above already handled declarations
    // and re-exports without letting comments, strings, or regex contents forge
    // an export.
    return false;
  }

  return false;
}

function scanRouteFiles(dir: string, files: string[], extensions: Set<string>): void {
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
      scanRouteFiles(abs, files, extensions);
      continue;
    }

    if (extensions.has(extname(entry))) {
      files.push(abs);
    }
  }
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function createRouteLoaderHints(
  routesDir: string,
  options: {
    additionalExtensions?: readonly string[];
    appFileDir?: string;
    rootRelativePrefix?: string;
  } = {},
): Record<string, boolean> {
  const files: string[] = [];
  const hints: Record<string, boolean> = {};
  const extensions = withAdditionalExtensions(
    DEFAULT_ROUTE_EXTENSIONS,
    normalizeAdditionalExtensions(options.additionalExtensions),
  );
  scanRouteFiles(routesDir, files, extensions);

  for (const file of files) {
    const hasLoader = detectLoaderExport(readFileSync(file, "utf-8"));
    const relativeToRoutesDir = toPosixPath(relative(routesDir, file));
    const routeRootPrefix = options.rootRelativePrefix?.replace(/\/$/, "");
    const appFileDir = options.appFileDir;

    const keys = new Set<string>();
    if (appFileDir) {
      const relativeToAppFile = toPosixPath(relative(appFileDir, file));
      keys.add(relativeToAppFile.startsWith(".") ? relativeToAppFile : `./${relativeToAppFile}`);
    }
    if (routeRootPrefix) {
      keys.add(`${routeRootPrefix}/${relativeToRoutesDir}`);
    }

    for (const key of keys) {
      hints[key] = hasLoader;
    }
  }

  return hints;
}

export function createRouteHeadHints(
  routesDir: string,
  options: {
    additionalExtensions?: readonly string[];
    appFileDir?: string;
    rootRelativePrefix?: string;
  } = {},
): Record<string, boolean> {
  const files: string[] = [];
  const hints: Record<string, boolean> = {};
  const additionalExtensions = normalizeAdditionalExtensions(options.additionalExtensions);
  const extensions = withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, additionalExtensions);
  scanRouteFiles(routesDir, files, extensions);

  for (const file of files) {
    const extension = extname(file);
    const hasHead =
      extension === ".md" ||
      extension === ".mdx" ||
      // A companion Vite plugin may synthesize `head` while compiling a
      // configured format (for example, from frontmatter). Raw-source scanning
      // cannot prove such a module is headless, so keep navigation conservative.
      additionalExtensions.includes(extension) ||
      detectHeadExport(readFileSync(file, "utf-8"));
    const relativeToRoutesDir = toPosixPath(relative(routesDir, file));
    const routeRootPrefix = options.rootRelativePrefix?.replace(/\/$/, "");
    const keys = new Set<string>();
    if (options.appFileDir) {
      const relativeToAppFile = toPosixPath(relative(options.appFileDir, file));
      keys.add(relativeToAppFile.startsWith(".") ? relativeToAppFile : `./${relativeToAppFile}`);
    }
    if (routeRootPrefix) keys.add(`${routeRootPrefix}/${relativeToRoutesDir}`);
    for (const key of keys) hints[key] = hasHead;
  }

  return hints;
}
