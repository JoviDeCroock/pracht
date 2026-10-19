import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

import { getCacheControl, resolveStaticFile } from "@pracht/adapter-node";
import { decodeStaticPath, staticPathCandidates } from "@pracht/core/server";

export interface StaticPreviewHandlerOptions {
  /** Directory to serve, usually `dist/client`. */
  staticDir: string;
  /**
   * SPA fallback file name (e.g. `"200.html"`). When set and present in
   * `staticDir`, unmatched URLs are answered with its contents and status
   * 200 — mirroring a host-level rewrite rule. When unset, unmatched URLs
   * are answered with `404.html` (status 404) when it exists.
   */
  fallback?: string | null;
  /**
   * Deploy base (Vite `base`), e.g. `"/my-project/"`. Requests below it are
   * served from `staticDir`; the bare base redirects to it with a trailing
   * slash, and anything outside it 404s — which is what a host serving the
   * export under a sub-path does.
   */
  base?: string | null;
  /**
   * `pracht({ trailingSlash })`. Under `"always"` or `"never"` a page asked
   * for by its other spelling is redirected (308, query kept), the way a host
   * configured for that URL shape does. Files are served as named.
   */
  trailingSlash?: "ignore" | "never" | "always" | null;
}

/**
 * A deliberately tiny static file server for `pracht preview` of static
 * exports. It mirrors what a plain static host does — files, clean-URL
 * `index.html` resolution, `404.html` for misses, an optional SPA fallback —
 * and nothing else: no route matching, no loaders, no framework runtime.
 * Production deploys should use a real static host; this exists so the build
 * output can be exercised locally with one command.
 */
export function createStaticPreviewHandler(
  options: StaticPreviewHandlerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const staticDir = resolve(options.staticDir);
  const fallback = options.fallback ?? null;
  const base = normalizePreviewBase(options.base);
  const trailingSlash = options.trailingSlash ?? "ignore";
  // Vite percent-encodes non-ASCII and spaces in `config.base`, and a request
  // may spell the same base differently. Compare decoded segments, but retain
  // `base` itself for the encoded Location header.
  const decodedBase = decodePathSegments(new URL(base, "http://localhost").pathname);
  if (!decodedBase) throw new Error(`Unsafe static preview base ${JSON.stringify(base)}.`);
  const baseSegments = decodedBase.slice(1, -1);

  return async function handleStaticPreviewRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }

    let pathname: string;
    let search: string;
    let publicPathname: string;
    try {
      const requestUrl = new URL(req.url ?? "/", "http://localhost");
      publicPathname = requestUrl.pathname;
      pathname = requestUrl.pathname;
      search = requestUrl.search;
    } catch {
      pathname = "";
      search = "";
      publicPathname = "";
    }
    // A static host looks files up by their decoded name, so a path without
    // one (an encoded separator, a malformed escape) can never name a file in
    // the export. `staticPathCandidates()` then orders the spellings to try.
    if (!decodeStaticPath(pathname).ok || staticPathCandidates(pathname) === null) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad request");
      return;
    }

    if (baseSegments.length > 0) {
      const segments = pathname.split("/").slice(1);
      const decodedSegments = decodePathSegments(pathname)?.slice(1) ?? segments;
      // Hosts serving a sub-path deploy redirect the bare base to its
      // trailing-slash form; mirror that so relative links resolve the same
      // way locally as they will in production.
      if (
        decodedSegments.length === baseSegments.length &&
        baseSegments.every((segment, index) => decodedSegments[index] === segment)
      ) {
        res.writeHead(301, { location: `${base}${search}` });
        res.end();
        return;
      }
      if (
        decodedSegments.length <= baseSegments.length ||
        !baseSegments.every((segment, index) => decodedSegments[index] === segment)
      ) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      pathname = `/${segments.slice(baseSegments.length).join("/")}`;
    }

    const file = await resolveStaticFile(staticDir, pathname);
    if (file?.document && trailingSlash !== "ignore") {
      const canonical = canonicalPagePathname(publicPathname, base, trailingSlash);
      if (canonical !== publicPathname) {
        // Never a protocol-relative Location: `//host/` must stay on this origin.
        res.writeHead(308, { location: `${canonical.replace(/^\/{2,}/, "/")}${search}` });
        res.end();
        return;
      }
    }
    if (file) {
      await sendFile(res, method, file.filePath, file.contentType, file.cacheControl, 200);
      return;
    }

    if (fallback) {
      const fallbackFile = await resolveStaticFile(staticDir, `/${fallback}`);
      if (fallbackFile?.filePath === resolve(staticDir, fallback)) {
        // Mirrors a host rewrite: the SPA fallback document answers any URL
        // with status 200 so the client router can resolve the real route.
        await sendFile(
          res,
          method,
          fallbackFile.filePath,
          "text/html; charset=utf-8",
          "no-cache",
          200,
        );
        return;
      }
    }

    const notFoundFile = await resolveStaticFile(staticDir, "/404.html");
    if (notFoundFile?.filePath === resolve(staticDir, "404.html")) {
      await sendFile(
        res,
        method,
        notFoundFile.filePath,
        "text/html; charset=utf-8",
        "no-cache",
        404,
      );
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };
}

/**
 * The spelling of a page URL under the trailing-slash policy, matching the
 * framework's own: the root (or deploy base) keeps its slash, and a last
 * segment containing a dot is a file name that never gets one.
 */
function canonicalPagePathname(pathname: string, base: string, policy: "never" | "always"): string {
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || `${trimmed}/` === base) return pathname;
  if (policy === "never") return trimmed;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).includes(".") ? trimmed : `${trimmed}/`;
}

/**
 * The decoded segments of a URL path (the first is the empty one before the
 * leading slash), or `null` when a segment has no decoded spelling.
 */
function decodePathSegments(pathname: string): string[] | null {
  const segments: string[] = [];
  for (const segment of pathname.split("/")) {
    const decoded = decodeStaticPath(segment);
    if (!decoded.ok) return null;
    segments.push(decoded.path);
  }
  return segments;
}

async function sendFile(
  res: ServerResponse,
  method: string,
  filePath: string,
  contentType: string,
  cacheControl: string,
  status: number,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": cacheControl,
    "content-length": body.byteLength,
  });
  res.end(method === "HEAD" ? undefined : body);
}

export { getCacheControl };

/** Vite normalizes `base` to leading and trailing slashes; be defensive anyway. */
function normalizePreviewBase(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw === "" || raw === "/") return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}
