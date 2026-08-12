import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { applyDefaultSecurityHeaders, type ISGManifestEntry } from "@pracht/core/server";
import { pipeToResponse, writeNodeResponseHeaders } from "./node-request.ts";
import type { HeadersManifest } from "./node-types.ts";

export type { HeadersManifest } from "./node-types.ts";

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
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
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
  const staticRoot = resolve(staticDir);
  const exactPath = resolveUrlPath(staticRoot, pathname);
  if (!exactPath) return null;

  const exactStat = await lstat(exactPath).catch(() => null);
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
  if (pathname in isgManifest) {
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

export function getManifestHeaders(
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

export async function serveStaticFile(
  request: Request,
  res: ServerResponse,
  staticResult: StaticFileResult,
  headersManifest: HeadersManifest,
  pathname: string,
): Promise<void> {
  const fileStat = await stat(staticResult.filePath);
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": staticResult.contentType,
      "cache-control": staticResult.cacheControl,
      etag: createWeakEtag(fileStat),
      "last-modified": fileStat.mtime.toUTCString(),
    }),
  );
  if (staticResult.contentType.includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, pathname);
  }

  if (isNotModified(request, headers)) {
    res.statusCode = 304;
    writeNodeResponseHeaders(res, headers);
    res.end();
    return;
  }

  res.statusCode = 200;
  writeNodeResponseHeaders(res, headers);
  if (request.method === "HEAD") {
    res.end();
    return;
  }
  await pipeToResponse(createReadStream(staticResult.filePath), res);
}

export function createWeakEtag(fileStat: { mtimeMs: number; size: number }): string {
  return `W/"${fileStat.size.toString(16)}-${Math.floor(fileStat.mtimeMs).toString(16)}"`;
}

export function isNotModified(request: Request, headers: Headers): boolean {
  const etag = headers.get("etag");
  const ifNoneMatch = request.headers.get("if-none-match");
  if (etag && ifNoneMatch) {
    const candidates = ifNoneMatch.split(",").map((value) => value.trim());
    if (candidates.includes("*") || candidates.includes(etag)) {
      return true;
    }
  }

  const lastModified = headers.get("last-modified");
  const ifModifiedSince = request.headers.get("if-modified-since");
  if (lastModified && ifModifiedSince) {
    const modifiedTime = Date.parse(lastModified);
    const sinceTime = Date.parse(ifModifiedSince);
    if (!Number.isNaN(modifiedTime) && !Number.isNaN(sinceTime) && modifiedTime <= sinceTime) {
      return true;
    }
  }

  return false;
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
