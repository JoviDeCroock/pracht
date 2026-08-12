import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import {
  DEFAULT_ROUTE_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";

const LOADER_DECLARATION_RE = /export\s+(?:async\s+)?(?:function|const|let|var)\s+loader\b/;
const HEAD_DECLARATION_RE = /export\s+(?:async\s+)?(?:function|const|let|var)\s+head\b/;
const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?/g;
const EXPORT_ALL_RE = /export\s+\*\s+from\s*["'][^"']+["']/;

function exportSpecifiersInclude(specifiers: string, exportName: string): boolean {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .some((specifier) => {
      const match = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
        specifier,
      );
      if (!match) return false;
      const [, localName, exportedName] = match;
      return (exportedName ?? localName) === exportName;
    });
}

export function detectLoaderExport(source: string): boolean {
  if (LOADER_DECLARATION_RE.test(source)) return true;

  for (const match of source.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersInclude(match[1], "loader")) {
      return true;
    }
  }

  // `export *` can expose a loader through re-exports. Treat it as a loader
  // route to avoid skipping route-state fetches incorrectly.
  return EXPORT_ALL_RE.test(source);
}

function scanRouteFiles(dir: string, files: string[], extensions: Set<string>): void {
export function detectHeadExport(source: string): boolean {
  // Markdown and MDX transforms can synthesize a head export from frontmatter.
  // Keep them conservative even when the raw source has no JS declaration.
  if (HEAD_DECLARATION_RE.test(source)) return true;
  for (const match of source.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersInclude(match[1], "head")) return true;
  }
  return EXPORT_ALL_RE.test(source);
}

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
  const extensions = withAdditionalExtensions(
    DEFAULT_ROUTE_EXTENSIONS,
    normalizeAdditionalExtensions(options.additionalExtensions),
  );
  scanRouteFiles(routesDir, files, extensions);

  for (const file of files) {
    const extension = extname(file);
    const hasHead =
      extension === ".md" || extension === ".mdx" || detectHeadExport(readFileSync(file, "utf-8"));
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
