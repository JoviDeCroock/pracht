import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";

import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  applyDefaultSecurityHeaders,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ISGManifestEntry,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core";

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

type HeadersManifest = Record<string, Record<string, string>>;

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

function getCacheControl(urlPath: string): string {
  if (HASHED_ASSET_RE.test(urlPath)) {
    return "public, max-age=31536000, immutable";
  }

  return "public, max-age=0, must-revalidate";
}

export interface NodeAdapterContextArgs {
  request: Request;
  req: IncomingMessage;
  res: ServerResponse;
}

export interface NodeAdapterOptions<TContext = unknown> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  staticDir?: string;
  viteManifest?: unknown;
  isgManifest?: Record<string, ISGManifestEntry>;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
  createContext?: (args: NodeAdapterContextArgs) => TContext | Promise<TContext>;
  /**
   * Whether to trust proxy headers (`Forwarded`, `X-Forwarded-Proto`,
   * `X-Forwarded-Host`) when constructing the request URL.
   *
   * When **false** (the default), the request URL is derived from the socket:
   * protocol is inferred from TLS state, and host from the `Host` header.
   * Forwarded headers are ignored, preventing host-header poisoning.
   *
   * When **true**, forwarded headers are honored with the following precedence:
   *   1. RFC 7239 `Forwarded` header (`proto=` and `host=` directives)
   *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
   *   3. Socket-derived values (fallback)
   *
   * Enable this only when the Node server sits behind a trusted reverse proxy
   * (e.g. nginx, Cloudflare, a load balancer) that sets these headers.
   */
  trustProxy?: boolean;
}

export interface NodeServerEntryModuleOptions {
  port?: number;
}

export function createNodeRequestHandler<TContext = unknown>(
  options: NodeAdapterOptions<TContext>,
) {
  const isgManifest = options.isgManifest ?? {};
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;
  const trustProxy = options.trustProxy ?? false;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let request: Request;
    try {
      request = await createWebRequest(req, trustProxy);
    } catch (err) {
      if (err instanceof Error && err.message === "Request body too large") {
        res.statusCode = 413;
        res.end("Payload Too Large");
        return;
      }
      throw err;
    }
    const url = new URL(request.url);
    const isRouteStateRequest = request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1";

    // Skip index.html for ISG routes — those go through the staleness check below.
    if (staticDir && request.method === "GET") {
      const staticResult = await resolveStaticFile(staticDir, url.pathname, isgManifest);
      if (staticResult) {
        const body = await readFile(staticResult.filePath);
        res.statusCode = 200;
        const headers = applyDefaultSecurityHeaders(
          new Headers({
            "content-type": staticResult.contentType,
            "cache-control": staticResult.cacheControl,
          }),
        );
        if (staticResult.contentType.includes("text/html")) {
          applyHeadersManifest(headers, headersManifest, url.pathname);
        }
        headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(body);
        return;
      }
    }

    if (
      staticDir &&
      request.method === "GET" &&
      !isRouteStateRequest &&
      url.pathname in isgManifest
    ) {
      const entry = isgManifest[url.pathname];
      const htmlPath =
        url.pathname === "/"
          ? join(staticDir, "index.html")
          : join(staticDir, url.pathname, "index.html");

      const fileStat = await stat(htmlPath).catch(() => null);
      if (fileStat?.isFile()) {
        const ageMs = Date.now() - fileStat.mtimeMs;
        const isStale = entry.revalidate.kind === "time" && ageMs > entry.revalidate.seconds * 1000;

        // Serve the cached file
        const html = await readFile(htmlPath, "utf-8");
        res.statusCode = 200;
        const headers = applyDefaultSecurityHeaders(
          new Headers({
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
            vary: ROUTE_STATE_REQUEST_HEADER,
          }),
        );
        applyHeadersManifest(headers, headersManifest, url.pathname);
        headers.set("x-pracht-isg", isStale ? "stale" : "fresh");
        headers.forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(html);

        // Background regeneration if stale
        if (isStale) {
          regenerateISGPage(options, url.pathname, htmlPath, { request, req, res }).catch((err) => {
            console.error(`ISG regeneration failed for ${url.pathname}:`, err);
          });
        }

        return;
      }
    }

    const context = options.createContext
      ? await options.createContext({ request, req, res })
      : undefined;

    const response = await handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);

    // Cache ISG responses on first render
    if (
      staticDir &&
      request.method === "GET" &&
      !isRouteStateRequest &&
      url.pathname in isgManifest &&
      response.status === 200 &&
      response.headers.get("content-type")?.includes("text/html")
    ) {
      const html = await response.clone().text();
      const htmlPath =
        url.pathname === "/"
          ? join(staticDir, "index.html")
          : join(staticDir, url.pathname, "index.html");
      await mkdir(dirname(htmlPath), { recursive: true });
      await writeFile(htmlPath, html, "utf-8");
    }

    await writeWebResponse(res, response);
  };
}

async function regenerateISGPage<TContext>(
  options: NodeAdapterOptions<TContext>,
  pathname: string,
  htmlPath: string,
  contextArgs?: NodeAdapterContextArgs,
): Promise<void> {
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
    cssManifest: options.cssManifest,
    jsManifest: options.jsManifest,
  });

  if (response.status === 200) {
    const html = await response.text();
    await mkdir(dirname(htmlPath), { recursive: true });
    await writeFile(htmlPath, html, "utf-8");
  }
}

function createISGRegenerationRequest(pathname: string, originalRequest?: Request): Request {
  const baseUrl = originalRequest ? new URL(originalRequest.url) : new URL("http://localhost");
  const regenerationUrl = new URL(pathname, baseUrl);

  return new Request(regenerationUrl, {
    method: "GET",
    headers: originalRequest ? new Headers(originalRequest.headers) : undefined,
  });
}

export function createNodeServerEntryModule(options: NodeServerEntryModuleOptions = {}): string {
  const port = options.port ?? 3000;

  return [
    'import { existsSync, readFileSync } from "node:fs";',
    'import { createServer } from "node:http";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'import { createNodeRequestHandler } from "@pracht/adapter-node";',
    "",
    "const serverDir = dirname(fileURLToPath(import.meta.url));",
    'const staticDir = resolve(serverDir, "../client");',
    'const isgManifestPath = resolve(serverDir, "isg-manifest.json");',
    "const isgManifest = existsSync(isgManifestPath)",
    '  ? JSON.parse(readFileSync(isgManifestPath, "utf-8"))',
    "  : {};",
    'const headersManifestPath = resolve(serverDir, "headers-manifest.json");',
    "const headersManifest = existsSync(headersManifestPath)",
    '  ? JSON.parse(readFileSync(headersManifestPath, "utf-8"))',
    "  : {};",
    "",
    "export const handler = createNodeRequestHandler({",
    "  app: resolvedApp,",
    "  registry,",
    "  staticDir,",
    "  isgManifest,",
    "  headersManifest,",
    "  apiRoutes,",
    "  clientEntryUrl: clientEntryUrl ?? undefined,",
    "  cssManifest,",
    "  jsManifest,",
    "});",
    "",
    "const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;",
    "if (entryHref && import.meta.url === entryHref) {",
    "  const server = createServer(handler);",
    `  const port = Number(process.env.PORT ?? ${port});`,
    "  server.listen(port, () => {",
    "    console.log(`pracht node server listening on http://localhost:${port}`);",
    "  });",
    "}",
    "",
  ].join("\n");
}

async function createWebRequest(req: IncomingMessage, trustProxy: boolean): Promise<Request> {
  const { protocol, host } = resolveOrigin(req, trustProxy);
  const url = new URL(req.url ?? "/", `${protocol}://${host}`);
  const method = req.method ?? "GET";
  const headers = createHeaders(req.headers);
  const init: RequestInit = {
    headers,
    method,
  };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const body = await readRequestBody(req);
    if (body.byteLength > 0) {
      const exactBody = new Uint8Array(body.byteLength);
      exactBody.set(body);
      init.body = exactBody.buffer;
    }
  }

  return new Request(url, init);
}

/**
 * Derive the request protocol and host from the incoming message.
 *
 * When `trustProxy` is false (default), the protocol is inferred from the
 * socket's TLS state and the host from the HTTP `Host` header.  Forwarded
 * headers are ignored entirely.
 *
 * When `trustProxy` is true, the following precedence applies:
 *   1. RFC 7239 `Forwarded` header (`proto=` / `host=` directives)
 *   2. `X-Forwarded-Proto` / `X-Forwarded-Host`
 *   3. Socket-derived values (fallback)
 */
function resolveOrigin(
  req: IncomingMessage,
  trustProxy: boolean,
): { protocol: string; host: string } {
  // Socket-derived defaults — always safe regardless of proxy trust.
  const socketProtocol =
    "encrypted" in req.socket && (req.socket as { encrypted?: boolean }).encrypted
      ? "https"
      : "http";
  const socketHost = getFirstHeaderValue(req.headers.host) ?? "localhost";

  if (!trustProxy) {
    return { protocol: socketProtocol, host: socketHost };
  }

  // 1. RFC 7239 `Forwarded` header (highest precedence)
  const forwarded = getFirstHeaderValue(req.headers.forwarded);
  if (forwarded) {
    const parsed = parseForwardedHeader(forwarded);
    return {
      protocol:
        parsed.proto ?? getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? socketProtocol,
      host: parsed.host ?? getFirstHeaderValue(req.headers["x-forwarded-host"]) ?? socketHost,
    };
  }

  // 2. De-facto X-Forwarded-* headers
  const proto = getFirstHeaderValue(req.headers["x-forwarded-proto"]) ?? socketProtocol;
  const host = getFirstHeaderValue(req.headers["x-forwarded-host"]) ?? socketHost;
  return { protocol: proto, host };
}

/**
 * Parse the first element of an RFC 7239 `Forwarded` header, extracting
 * `proto` and `host` directives.  Returns `undefined` for directives that
 * are not present.
 */
function parseForwardedHeader(value: string): { proto?: string; host?: string } {
  // The header may contain multiple comma-separated elements; use the first
  // (the one closest to the client).
  const first = value.split(",")[0];
  const result: { proto?: string; host?: string } = {};

  for (const part of first.split(";")) {
    const [key, val] = part.trim().split("=");
    if (!key || !val) continue;
    const k = key.toLowerCase();
    // Strip surrounding quotes if present
    const v = val.replace(/^"|"$/g, "");
    if (k === "proto") result.proto = v;
    else if (k === "host") result.host = v;
  }

  return result;
}

function createHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "undefined") {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        result.append(key, entry);
      }

      continue;
    }

    result.set(key, value);
  }

  return result;
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

async function readRequestBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    totalSize += buf.byteLength;
    if (totalSize > MAX_BODY_SIZE) {
      req.destroy();
      throw new Error("Request body too large");
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  const body = Buffer.from(await response.arrayBuffer());
  res.end(body);
}

function applyHeadersManifest(
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

function getFirstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

interface StaticFileResult {
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
async function resolveStaticFile(
  staticDir: string,
  pathname: string,
  isgManifest: Record<string, ISGManifestEntry> = {},
): Promise<StaticFileResult | null> {
  // Try exact file path
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

  // Try {pathname}/index.html for clean URLs (SSG pages)
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

/**
 * Create a pracht adapter for Node.js.
 *
 * ```ts
 * import { nodeAdapter } from "@pracht/adapter-node";
 * pracht({ adapter: nodeAdapter() })
 * ```
 */
export function nodeAdapter(options: NodeServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "node",
    serverImports: 'import { resolveApp, resolveApiRoutes } from "@pracht/core";',
    createServerEntryModule() {
      return createNodeServerEntryModule(options);
    },
  };
}
