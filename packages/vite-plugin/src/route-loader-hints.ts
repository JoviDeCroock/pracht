import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROUTE_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js", ".md", ".mdx"]);
const LOADER_DECLARATION_RE = /export\s+(?:async\s+)?(?:function|const|let|var)\s+loader\b/;
const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?/g;
const EXPORT_ALL_RE = /export\s+\*\s+from\s*["'][^"']+["']/;

function exportSpecifiersIncludeLoader(specifiers: string): boolean {
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
      return (exportedName ?? localName) === "loader";
    });
}

export function detectLoaderExport(source: string): boolean {
  if (LOADER_DECLARATION_RE.test(source)) return true;

  for (const match of source.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersIncludeLoader(match[1])) {
      return true;
    }
  }

  // `export *` can expose a loader through re-exports. Treat it as a loader
  // route to avoid skipping route-state fetches incorrectly.
  return EXPORT_ALL_RE.test(source);
}

function scanRouteFiles(dir: string, files: string[]): void {
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
      scanRouteFiles(abs, files);
      continue;
    }

    if (ROUTE_EXTENSIONS.has(extname(entry))) {
      files.push(abs);
    }
  }
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function createRouteLoaderHints(
  routesDir: string,
  options: { appFileDir?: string; rootRelativePrefix?: string } = {},
): Record<string, boolean> {
  const files: string[] = [];
  const hints: Record<string, boolean> = {};
  scanRouteFiles(routesDir, files);

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
