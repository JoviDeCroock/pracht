import { lstat, realpath } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import type { ISGManifestEntry } from "@pracht/core/server";

import { getManifestHeaders } from "@pracht/core/server";
export { applyHeadersManifest, getManifestHeaders } from "@pracht/core/server";
import type { HeadersManifest } from "@pracht/core/server";
export type { HeadersManifest } from "@pracht/core/server";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".map": "application/json",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".vtt": "text/vtt; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

/**
 * Hashed assets (e.g. `assets/chunk-AbCd1234.js`) are safe to cache
 * indefinitely.  Everything else gets a conservative policy.
 */
const HASHED_ASSET_RE = /\/assets\//;

/**
 * Suffix of the file holding a regenerated ISG page (its HTML and document
 * headers) next to the page's build HTML. It lives in the static directory
 * but is never served as a static file, and neither is the headers sidecar
 * (`.pracht-headers.json`) older releases wrote there.
 */
export const ISG_SNAPSHOT_SUFFIX = ".pracht-isg.json";
const ISG_PRIVATE_FILE_SUFFIXES = [ISG_SNAPSHOT_SUFFIX, ".pracht-headers.json"];

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
  /**
   * The URL named a page and was answered with its `index.html`, rather than
   * naming a file exactly — the response that follows the trailing-slash policy.
   */
  document?: boolean;
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
  const staticRoot = resolve(staticDir);
  const exactPath = resolveUrlPath(staticRoot, pathname);
  if (!exactPath) return null;

  const exactStat = ISG_PRIVATE_FILE_SUFFIXES.some((suffix) => basename(exactPath).endsWith(suffix))
    ? null
    : await lstat(exactPath).catch(() => null);
  if (exactStat?.isFile() && !exactStat.isSymbolicLink()) {
    if (!(await realPathIsInside(staticRoot, exactPath))) return null;
    const ext = extname(exactPath);
    return {
      filePath: exactPath,
      contentType: MIME_TYPES[ext] || "application/octet-stream",
      cacheControl: getCacheControl(pathname),
    };
  }

  // ISG routes need staleness checks — let the ISG handler below deal with them.
  // The manifest is keyed by route path, which carries no trailing slash.
  if (toRouteKey(pathname) in isgManifest) {
    return null;
  }

  const indexPath =
    pathname === "/"
      ? resolve(staticRoot, "index.html")
      : resolveUrlPath(staticRoot, pathname, "index.html");

  if (!indexPath) return null;

  const indexStat = await lstat(indexPath).catch(() => null);
  if (indexStat?.isFile() && !indexStat.isSymbolicLink()) {
    if (!(await realPathIsInside(staticRoot, indexPath))) return null;
    return {
      filePath: indexPath,
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=0, must-revalidate",
      document: true,
    };
  }

  return null;
}

/**
 * The route-path key the build manifests use for a URL path: `/about/` and
 * `/about` are one page, recorded without the slash.
 */
export function toRouteKey(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.replace(/\/+$/, "") || "/"
    : pathname;
}

function resolveUrlPath(staticRoot: string, pathname: string, suffix?: string): string | null {
  if (pathname.includes("\0") || pathname.includes("\\")) return null;
  const candidate = suffix
    ? resolve(staticRoot, `.${pathname}`, suffix)
    : resolve(staticRoot, `.${pathname}`);
  return pathIsInside(staticRoot, candidate) ? candidate : null;
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function realPathIsInside(staticRoot: string, candidate: string): Promise<boolean> {
  const [rootReal, candidateReal] = await Promise.all([
    realpath(staticRoot).catch(() => staticRoot),
    realpath(candidate).catch(() => null),
  ]);
  return candidateReal !== null && pathIsInside(resolve(rootReal), resolve(candidateReal));
}
