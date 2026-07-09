import type { PrachtAdapter } from "@pracht/vite-plugin";
import {
  applyDefaultSecurityHeaders,
  handlePrachtRequest,
  type HandlePrachtRequestOptions,
  type ModuleRegistry,
  type ResolvedApiRoute,
  type PrachtApp,
} from "@pracht/core/server";

type HeadersManifest = Record<string, Record<string, string>>;

interface DenoFileInfo {
  isFile: boolean;
  isSymlink: boolean;
  mtime: Date | null;
  size: number;
}

interface DenoRuntime {
  cwd(): string;
  env: {
    get(name: string): string | undefined;
  };
  errors: {
    NotFound: new (...args: unknown[]) => Error;
  };
  lstat(path: string | URL): Promise<DenoFileInfo>;
  readFile(path: string | URL): Promise<Uint8Array>;
  realPath(path: string | URL): Promise<string>;
  serve(
    options: { port?: number },
    handler: (request: Request) => Response | Promise<Response>,
  ): unknown;
}

declare const Deno: DenoRuntime | undefined;

const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

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

export interface DenoAdapterContextArgs {
  request: Request;
}

export interface DenoAdapterOptions<TContext = unknown> {
  app: PrachtApp;
  registry?: ModuleRegistry;
  staticDir?: string | URL;
  apiRoutes?: ResolvedApiRoute[];
  clientEntryUrl?: string;
  cssManifest?: Record<string, string[]>;
  jsManifest?: Record<string, string[]>;
  headersManifest?: HeadersManifest;
  createContext?: (args: DenoAdapterContextArgs) => TContext | Promise<TContext>;
}

export interface DenoServerEntryModuleOptions {
  port?: number;
  /** Vite-resolvable module path exporting `createContext(args)`. */
  createContextFrom?: string;
}

export function createDenoRequestHandler<TContext = unknown>(
  options: DenoAdapterOptions<TContext>,
): (request: Request) => Promise<Response> {
  const headersManifest = options.headersManifest ?? {};
  const staticDir = options.staticDir;

  return async (request: Request): Promise<Response> => {
    if (staticDir && isStaticAssetRequest(request)) {
      const staticResponse = await maybeServeStaticFile(request, staticDir, headersManifest);
      if (staticResponse) {
        return staticResponse;
      }
    }

    const context = options.createContext ? await options.createContext({ request }) : undefined;

    return handlePrachtRequest({
      app: options.app,
      context,
      registry: options.registry,
      request,
      apiRoutes: options.apiRoutes,
      clientEntryUrl: options.clientEntryUrl,
      cssManifest: options.cssManifest,
      jsManifest: options.jsManifest,
    } satisfies HandlePrachtRequestOptions<TContext>);
  };
}

export function createDenoServerEntryModule(options: DenoServerEntryModuleOptions = {}): string {
  const port = options.port ?? 3000;
  const contextImport = options.createContextFrom
    ? `import { createContext as createPrachtContext } from ${JSON.stringify(options.createContextFrom)};`
    : "const createPrachtContext = undefined;";

  return [
    'import { createDenoRequestHandler } from "@pracht/adapter-deno";',
    contextImport,
    "",
    'const staticDir = new URL("../client/", import.meta.url);',
    "let headersManifestPromise;",
    "async function readHeadersManifest() {",
    "  if (!headersManifestPromise) {",
    "    headersManifestPromise = Deno.readTextFile(new URL('./headers-manifest.json', import.meta.url))",
    "      .then((text) => JSON.parse(text))",
    "      .catch(() => ({}));",
    "  }",
    "  return headersManifestPromise;",
    "}",
    "",
    "let denoHandlerPromise;",
    "function getDenoHandler() {",
    "  if (!denoHandlerPromise) {",
    "    denoHandlerPromise = readHeadersManifest().then((headersManifest) => createDenoRequestHandler({",
    "      app: resolvedApp,",
    "      registry,",
    "      staticDir,",
    "      headersManifest,",
    "      apiRoutes,",
    "      clientEntryUrl: clientEntryUrl ?? undefined,",
    "      cssManifest,",
    "      jsManifest,",
    "      createContext: createPrachtContext,",
    "    }));",
    "  }",
    "  return denoHandlerPromise;",
    "}",
    "",
    "export async function handler(request) {",
    "  return (await getDenoHandler())(request);",
    "}",
    "",
    "if (import.meta.main) {",
    `  const port = Number(Deno.env.get("PORT") ?? ${port});`,
    "  Deno.serve({ port }, handler);",
    "}",
    "",
  ].join("\n");
}

/**
 * Create a pracht adapter for Deno.
 *
 * ```ts
 * import { denoAdapter } from "@pracht/adapter-deno";
 * pracht({ adapter: denoAdapter() })
 * ```
 */
export function denoAdapter(options: DenoServerEntryModuleOptions = {}): PrachtAdapter {
  return {
    id: "deno",
    edge: true,
    serverImports:
      'import { handlePrachtRequest, resolveApp, resolveApiRoutes } from "@pracht/core/server";',
    createServerEntryModule() {
      return createDenoServerEntryModule(options);
    },
  };
}

function isStaticAssetRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url);
  if (
    request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" ||
    url.searchParams.get("_data") === "1"
  ) {
    return false;
  }

  return !(request.headers.get("accept") ?? "").includes("text/markdown");
}

async function maybeServeStaticFile(
  request: Request,
  staticDir: string | URL,
  headersManifest: HeadersManifest,
): Promise<Response | null> {
  if (typeof Deno === "undefined") {
    return null;
  }

  const url = new URL(request.url);
  const resolved = await resolveStaticFile(staticDir, url.pathname);
  if (!resolved) {
    return null;
  }

  const headers = applyDefaultSecurityHeaders(
    new Headers({
      "content-type": resolved.contentType,
      "cache-control": resolved.cacheControl,
      etag: createWeakEtag(resolved.info),
      "last-modified": (resolved.info.mtime ?? new Date(0)).toUTCString(),
      vary: ROUTE_STATE_REQUEST_HEADER,
    }),
  );

  if (resolved.contentType.includes("text/html")) {
    applyHeadersManifest(headers, headersManifest, url.pathname);
  }

  if (isNotModified(request, headers)) {
    return new Response(null, { status: 304, headers });
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  const bytes = await Deno.readFile(resolved.fileUrl);
  const body = new Uint8Array(bytes);
  return new Response(body, { status: 200, headers });
}

async function resolveStaticFile(
  staticDir: string | URL,
  pathname: string,
): Promise<{
  fileUrl: URL;
  info: DenoFileInfo;
  contentType: string;
  cacheControl: string;
} | null> {
  const rootUrl = normalizeStaticRoot(staticDir);
  if (!rootUrl || pathname.includes("\0") || pathname.includes("\\")) {
    return null;
  }

  const exactUrl = resolveUrlPath(rootUrl, pathname);
  if (!exactUrl) return null;

  const exactInfo = await lstatFileInside(rootUrl, exactUrl);
  if (exactInfo) {
    return {
      fileUrl: exactUrl,
      info: exactInfo,
      contentType: MIME_TYPES[getExtension(exactUrl.pathname)] || "application/octet-stream",
      cacheControl: getCacheControl(pathname),
    };
  }

  const indexUrl =
    pathname === "/"
      ? new URL("index.html", rootUrl)
      : resolveUrlPath(rootUrl, `${pathname.replace(/\/$/, "")}/index.html`);
  if (!indexUrl) return null;

  const indexInfo = await lstatFileInside(rootUrl, indexUrl);
  if (!indexInfo) return null;

  return {
    fileUrl: indexUrl,
    info: indexInfo,
    contentType: "text/html; charset=utf-8",
    cacheControl: "public, max-age=0, must-revalidate",
  };
}

function normalizeStaticRoot(staticDir: string | URL): URL | null {
  const url = staticDir instanceof URL ? new URL(staticDir.href) : stringPathToFileUrl(staticDir);
  if (url.protocol !== "file:") return null;
  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  return url;
}

function stringPathToFileUrl(path: string): URL {
  try {
    return new URL(path);
  } catch {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/")) {
      return new URL(`file://${normalized}`);
    }
    if (/^[A-Za-z]:\//.test(normalized)) {
      return new URL(`file:///${normalized}`);
    }

    const cwd =
      typeof Deno === "undefined" ? "/" : Deno.cwd().replace(/\\/g, "/").replace(/\/$/, "");
    return stringPathToFileUrl(`${cwd}/${normalized}`);
  }
}

function resolveUrlPath(rootUrl: URL, pathname: string): URL | null {
  const candidate = new URL(`.${pathname}`, rootUrl);
  return urlIsInside(rootUrl, candidate) ? candidate : null;
}

async function lstatFileInside(rootUrl: URL, fileUrl: URL): Promise<DenoFileInfo | null> {
  if (typeof Deno === "undefined") return null;

  const info = await Deno.lstat(fileUrl).catch((error: unknown) => {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  });
  if (!info?.isFile || info.isSymlink) return null;

  const [rootReal, fileReal] = await Promise.all([
    Deno.realPath(rootUrl).catch(() => rootUrl.pathname),
    Deno.realPath(fileUrl).catch(() => null),
  ]);
  if (!fileReal) return null;

  return pathIsInside(rootReal, fileReal) ? info : null;
}

function applyHeadersManifest(
  headers: Headers,
  headersManifest: HeadersManifest,
  pathname: string,
): void {
  const withoutIndex = pathname.replace(/\/index\.html$/, "") || "/";
  const withoutSlash = pathname.replace(/\/$/, "") || "/";
  const routeHeaders =
    headersManifest[pathname] ?? headersManifest[withoutSlash] ?? headersManifest[withoutIndex];

  if (!routeHeaders) return;

  for (const [key, value] of Object.entries(routeHeaders)) {
    headers.set(key, value);
  }
}

function getCacheControl(urlPath: string): string {
  return /\/assets\//.test(urlPath)
    ? "public, max-age=31536000, immutable"
    : "public, max-age=0, must-revalidate";
}

function getExtension(pathname: string): string {
  const basename = pathname.slice(pathname.lastIndexOf("/") + 1);
  const index = basename.lastIndexOf(".");
  return index === -1 ? "" : basename.slice(index).toLowerCase();
}

function createWeakEtag(info: DenoFileInfo): string {
  const mtimeMs = info.mtime?.getTime() ?? 0;
  return `W/"${info.size}-${Math.floor(mtimeMs)}"`;
}

function isNotModified(request: Request, headers: Headers): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === headers.get("etag")) {
    return true;
  }

  const ifModifiedSince = request.headers.get("if-modified-since");
  const lastModified = headers.get("last-modified");
  if (ifModifiedSince && lastModified) {
    const since = Date.parse(ifModifiedSince);
    const modified = Date.parse(lastModified);
    return Number.isFinite(since) && Number.isFinite(modified) && modified <= since;
  }

  return false;
}

function urlIsInside(rootUrl: URL, candidate: URL): boolean {
  return candidate.href === rootUrl.href || candidate.href.startsWith(rootUrl.href);
}

function pathIsInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}
