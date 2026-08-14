import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { applyDefaultSecurityHeaders } from "@pracht/core/server";

import { ensureNetlifyPageVary, hasExplicitCachePolicy } from "./runtime-cache.ts";
import type { HeadersManifest } from "./types.ts";

export interface NetlifyStaticFile {
  filePath: string;
  contentType: string;
  document: boolean;
}

/** Return the first candidate containing the Pracht client build directory. */
export async function resolveNetlifyStaticDir(
  candidates: Array<string | null | undefined>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = resolve(candidate);
    const info = await lstat(root).catch(() => null);
    if (info?.isDirectory()) return root;
  }
  return undefined;
}

export async function resolveStaticFile(
  staticDir: string,
  pathname: string,
): Promise<NetlifyStaticFile | null> {
  const root = resolve(staticDir);
  const exact = resolveUrlPath(root, pathname);
  if (exact && (await isContainedFile(root, exact))) {
    return {
      contentType: MIME_TYPES[extname(exact)] ?? "application/octet-stream",
      document: exact.endsWith(".html"),
      filePath: exact,
    };
  }

  const index =
    pathname === "/" ? resolve(root, "index.html") : resolveUrlPath(root, pathname, "index.html");
  if (!index || !(await isContainedFile(root, index))) return null;
  return { contentType: "text/html; charset=utf-8", document: true, filePath: index };
}

export async function serveStaticFile(
  request: Request,
  file: NetlifyStaticFile,
  headersManifest: HeadersManifest,
  pathname: string,
  staticMaxAge: number,
): Promise<Response> {
  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": file.contentType,
    }),
  );
  if (file.document) applyHeadersManifest(headers, headersManifest, pathname);
  if (!hasExplicitCachePolicy(headers)) {
    headers.set(
      "cache-control",
      pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=0, must-revalidate",
    );
    headers.set("netlify-cdn-cache-control", `public, durable, max-age=${staticMaxAge}`);
  }
  if (file.document) ensureNetlifyPageVary(headers);
  const body = request.method === "HEAD" ? null : await readFile(file.filePath);
  return new Response(body, { headers });
}

function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const values =
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex];
  if (!values) return;
  for (const [name, value] of Object.entries(values)) headers.set(name, value);
}

function resolveUrlPath(root: string, pathname: string, suffix?: string): string | null {
  const decodedPathname = decodeStaticPathname(pathname);
  if (decodedPathname === null) return null;
  const candidate = suffix
    ? resolve(root, `.${decodedPathname}`, suffix)
    : resolve(root, `.${decodedPathname}`);
  return pathIsInside(root, candidate) ? candidate : null;
}

function decodeStaticPathname(pathname: string): string | null {
  const decodedSegments: string[] = [];
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }
    if (decoded.includes("\0")) return null;
    decodedSegments.push(decoded);
  }
  return decodedSegments.join("/");
}

async function isContainedFile(root: string, candidate: string): Promise<boolean> {
  const info = await lstat(candidate).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) return false;
  const [rootReal, candidateReal] = await Promise.all([
    realpath(root).catch(() => root),
    realpath(candidate).catch(() => null),
  ]);
  return candidateReal !== null && pathIsInside(resolve(rootReal), resolve(candidateReal));
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

const MIME_TYPES: Record<string, string> = {
  ".atom": "application/atom+xml",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};
