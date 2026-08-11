import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, resolve, sep } from "node:path";

import type { StaticBuildManifest } from "./build-static.js";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

export function readStaticBuildManifest(root: string): StaticBuildManifest | null {
  const manifestPath = resolve(root, "dist/server/static-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as StaticBuildManifest;
  } catch {
    return null;
  }
}

/**
 * Serve a static build the way a host would: clean URLs, the emitted rewrite
 * rules, the emitted header rules, and `404.html` for everything unmatched.
 *
 * This is a preview server, not a production one. It exists so the routing
 * and header configuration `pracht build` wrote can be exercised locally
 * before the deploy that would otherwise be the first test of it.
 */
export function createStaticPreviewServer(
  clientDir: string,
  manifest: StaticBuildManifest,
): Server {
  const rewrites = manifest.rewrites.map((rule) => ({
    regex: new RegExp(rule.regex),
    destination: rule.destination,
  }));

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = safeDecode(url.pathname);

    if (pathname === null) {
      res.writeHead(400).end("Bad Request");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end("Method Not Allowed");
      return;
    }

    const matched =
      resolveFile(clientDir, pathname) ?? resolveRewrite(clientDir, pathname, rewrites);
    const file = matched ?? (manifest.notFound ? resolveFile(clientDir, manifest.notFound) : null);
    const status = matched ? 200 : 404;

    if (file === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }

    const headers: Record<string, string> = {
      "content-type": MIME_TYPES[extname(file.path).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(statSync(file.path).size),
    };
    for (const rule of manifest.headers) {
      if (matchesHeaderSource(rule.source, file.matchedPath)) {
        Object.assign(headers, rule.headers);
      }
    }

    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file.path).pipe(res);
  });
}

interface ResolvedPreviewFile {
  path: string;
  /** URL path the header rules are matched against. */
  matchedPath: string;
}

function resolveFile(clientDir: string, pathname: string): ResolvedPreviewFile | null {
  const candidates =
    pathname.endsWith("/") || extname(pathname) === ""
      ? [join(pathname, "index.html"), pathname]
      : [pathname];

  for (const candidate of candidates) {
    const filePath = safeJoin(clientDir, candidate);
    if (filePath && isFile(filePath)) return { path: filePath, matchedPath: pathname };
  }
  return null;
}

function resolveRewrite(
  clientDir: string,
  pathname: string,
  rewrites: { regex: RegExp; destination: string }[],
): ResolvedPreviewFile | null {
  for (const rule of rewrites) {
    if (!rule.regex.test(pathname)) continue;
    const filePath = safeJoin(clientDir, rule.destination);
    if (filePath && isFile(filePath)) return { path: filePath, matchedPath: pathname };
  }
  return null;
}

function matchesHeaderSource(source: string, pathname: string): boolean {
  // `/*` and `/assets/*` are prefix rules; anything else is an exact path.
  if (source.endsWith("/*")) return pathname.startsWith(source.slice(0, -1));
  return source === pathname || `${source}/` === pathname;
}

function safeDecode(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function safeJoin(clientDir: string, urlPath: string): string | null {
  if (urlPath.includes("\0")) return null;
  const root = resolve(clientDir);
  const filePath = resolve(root, `.${urlPath.startsWith("/") ? urlPath : `/${urlPath}`}`);
  return filePath === root || filePath.startsWith(root + sep) ? filePath : null;
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}
