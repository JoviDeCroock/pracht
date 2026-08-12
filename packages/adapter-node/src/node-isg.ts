import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import {
  applyDefaultSecurityHeaders,
  classifyRevalidationSkip,
  createISGRegenerationRequest,
  createRevalidationSingleFlight,
  getTimeRevalidateSeconds,
  handlePrachtRequest,
  type ISGManifestEntry,
  isCacheableISGResponse,
  jsonResponse,
  matchAppRoute,
  readRevalidationRequest,
  RevalidationReport,
  resolveRevalidationToken,
} from "@pracht/core/server";
import { pipeToResponse, writeNodeResponseHeaders } from "./node-request.ts";
import { applyHeadersManifest, createWeakEtag, isNotModified } from "./node-static.ts";
import type { HeadersManifest, NodeAdapterContextArgs, NodeAdapterOptions } from "./node-types.ts";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

// Shared across all handler instances in this process so a stampede of stale
// requests (or repeated webhook posts) for the same output file collapses
// into a single regeneration instead of N parallel renders racing to write.
const regenerationSingleFlight = createRevalidationSingleFlight();

/**
 * Regenerate an ISG page and write it to disk. Returns `true` when fresh
 * HTML was written, `false` when the render did not produce cacheable
 * 200 HTML (the stale on-disk copy is kept in that case).
 */
export async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  contextArgs?: NodeAdapterContextArgs,
): Promise<boolean> {
  return regenerationSingleFlight(htmlPath, async () => {
    const request = createISGRegenerationRequest(pathname, contextArgs?.request);
    const context =
      options.createContext && contextArgs
        ? await options.createContext({ ...contextArgs, request })
        : undefined;

    const response = await handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      clientEntryUrl: options.clientEntryUrl,
      islandsEntryUrl: options.islandsEntryUrl,
      islandsBootstrapRequired: options.islandsBootstrapRequired,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    });

    if (response.status !== 200 || !isCacheableISGResponse(response)) {
      return false;
    }

    const html = await response.text();
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, "utf-8");
    return true;
  });
}

export async function persistISGSnapshot(
  staticDir: string,
  pathname: string,
  response: Response,
): Promise<void> {
  const htmlPath = resolveContainedPath(staticDir, pathname);
  if (!htmlPath) return;

  const html = await response.clone().text();
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html, "utf-8");
}

export async function serveISGEntry<TContext>(
  request: Request,
  res: ServerResponse,
  options: NodeAdapterOptions<TContext>,
  staticDir: string,
  pathname: string,
  entry: ISGManifestEntry,
  headersManifest: HeadersManifest,
  contextArgs: NodeAdapterContextArgs,
): Promise<boolean> {
  const htmlPath = resolveContainedPath(staticDir, pathname);
  if (!htmlPath) return false;

  const fileStat = await stat(htmlPath).catch(() => null);
  if (!fileStat?.isFile()) return false;

  const ageMs = Date.now() - fileStat.mtimeMs;
  const revalidateSeconds = getTimeRevalidateSeconds(entry.revalidate);
  const isStale = revalidateSeconds !== null && ageMs > revalidateSeconds * 1000;

  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=0, must-revalidate",
      etag: createWeakEtag(fileStat),
      "last-modified": fileStat.mtime.toUTCString(),
      vary: ROUTE_STATE_REQUEST_HEADER,
    }),
  );
  applyHeadersManifest(headers, headersManifest, pathname);
  headers.set("x-pracht-isg", isStale ? "stale" : "fresh");

  if (isNotModified(request, headers)) {
    res.statusCode = 304;
    writeNodeResponseHeaders(res, headers);
    res.end();
  } else {
    res.statusCode = 200;
    writeNodeResponseHeaders(res, headers);
    if (request.method === "HEAD") {
      res.end();
    } else {
      await pipeToResponse(createReadStream(htmlPath), res);
    }
  }

  if (isStale) {
    regenerateISGPage(options, pathname, htmlPath, contextArgs).catch((err) => {
      console.error(`ISG regeneration failed for ${pathname}:`, err);
    });
  }

  return true;
}

export async function handleRevalidationEndpoint<TContext>(
  request: Request,
  options: NodeAdapterOptions<TContext>,
  staticDir: string | undefined,
  isgManifest: Record<string, ISGManifestEntry>,
  contextArgs: NodeAdapterContextArgs,
): Promise<Response> {
  const parsed = await readRevalidationRequest(request, resolveRevalidationToken());
  if (!parsed.ok) return parsed.response;

  if (!staticDir) {
    // Built through the shared report so this reply has the same shape as every
    // other one, `details` included, rather than the three legacy arrays alone.
    const unavailable = new RevalidationReport();
    for (const pathname of parsed.paths) unavailable.skipped(pathname, "not_prerendered");
    return jsonResponse(
      { error: "ISG revalidation requires a staticDir.", ...unavailable.toJSON() },
      503,
    );
  }

  const report = new RevalidationReport();

  for (const pathname of parsed.paths) {
    try {
      const entry = isgManifest[pathname];
      const htmlPath = resolveContainedPath(staticDir, pathname);
      const skip = classifyRevalidationSkip(
        entry && { render: "isg", revalidate: entry.revalidate },
        htmlPath !== null,
        matchAppRoute(options.app, pathname)?.route ?? null,
      );
      if (skip) {
        report.skipped(pathname, skip);
        continue;
      }

      // A failed regeneration keeps the existing on-disk HTML and is reported
      // in `failed` instead of aborting the whole batch with a 500.
      if (await regenerateISGPage(options, pathname, htmlPath!, contextArgs)) {
        report.revalidated(pathname);
      } else {
        report.failed(pathname, "regeneration_failed");
      }
    } catch (err) {
      console.error(`ISG webhook revalidation failed for ${pathname}:`, err);
      report.failed(pathname, "regeneration_error");
    }
  }

  return jsonResponse(report.toJSON());
}

/**
 * Resolve a URL pathname to `<staticDir>/<pathname>/index.html` while
 * ensuring the result stays inside `staticDir`. Returns `null` when the
 * pathname would escape the root (`..`, encoded separators, NUL bytes,
 * etc.), which the caller treats as a miss. Also rejects NUL — Node
 * filesystem APIs throw on these but it's clearer to bail early.
 */
function resolveContainedPath(staticDir: string, pathname: string): string | null {
  if (pathname.includes("\0")) return null;

  const rootResolved = resolve(staticDir);
  const candidate =
    pathname === "/"
      ? join(rootResolved, "index.html")
      : resolve(rootResolved, `.${pathname}`, "index.html");
  const resolved = resolve(candidate);

  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    return null;
  }
  return resolved;
}

export { createISGRegenerationRequest };
