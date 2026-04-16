import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ISGManifestEntry } from "@pracht/core";

export type HeadersManifest = Record<string, Record<string, string>>;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

/**
 * Hashed assets (e.g. `assets/chunk-AbCd1234.js`) are safe to cache
 * indefinitely.  Everything else gets a conservative policy.
 */
const HASHED_ASSET_RE = /\/assets\//;

export function getCacheControl(urlPath: string): string {
  if (HASHED_ASSET_RE.test(urlPath)) {
    return "public, max-age=31536000, immutable";
  }

  return "public, max-age=0, must-revalidate";
}

export interface StaticFileResult {
  filePath: string;
  contentType: string;
  cacheControl: string;
}

/**
 * Resolve a URL pathname to a static file inside `staticDir`.
 *
 * Tries the exact path first (e.g. `/assets/chunk-Ab12.js`), then falls back
 * to `{pathname}/index.html` for clean-URL pages (e.g. `/about` →
 * `about/index.html`).  Returns `null` when no matching file is found.
 */
export async function resolveStaticFile(
  staticDir: string,
  pathname: string,
  isgManifest: Record<string, ISGManifestEntry> = {},
): Promise<StaticFileResult | null> {
  const exactPath = join(staticDir, pathname);
  if (!exactPath.startsWith(staticDir + "/") && exactPath !== staticDir) {
    return null; // Directory traversal
  }

  const exactStat = await stat(exactPath).catch(() => null);
  if (exactStat?.isFile()) {
    const ext = extname(exactPath);
    return {
      filePath: exactPath,
      contentType: MIME_TYPES[ext] || "application/octet-stream",
      cacheControl: getCacheControl(pathname),
    };
  }

  // ISG routes need staleness checks — let the ISG handler below deal with them.
  if (pathname in isgManifest) {
    return null;
  }

  const indexPath =
    pathname === "/" ? join(staticDir, "index.html") : join(staticDir, pathname, "index.html");

  if (!indexPath.startsWith(staticDir + "/")) {
    return null;
  }

  const indexStat = await stat(indexPath).catch(() => null);
  if (indexStat?.isFile()) {
    return {
      filePath: indexPath,
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=0, must-revalidate",
    };
  }

  return null;
}

export function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const routeHeaders = getManifestHeaders(headersManifest, pathname);
  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

function getManifestHeaders(
  headersManifest: HeadersManifest,
  pathname: string,
): Record<string, string> | undefined {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";

  return (
    headersManifest[pathname] ??
    headersManifest[withoutSlash] ??
    headersManifest[withoutIndex] ??
    undefined
  );
}
