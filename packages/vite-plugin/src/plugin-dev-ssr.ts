import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";
import type { Connect, EnvironmentModuleNode, ViteDevServer } from "vite";
import type {
  ModuleRegistry,
  PrachtPhaseTimings,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteErrorContext,
} from "@pracht/core";
import { applyDefaultSecurityHeaders, resolveRegistryModule } from "@pracht/core";
import {
  CLIENT_BROWSER_PATH,
  ISLANDS_CLIENT_BROWSER_PATH,
  PRACHT_DEV_MODULE_ID,
  PRACHT_SERVER_MODULE_ID,
} from "./plugin-assets.ts";

const BODYLESS_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_BODY_SIZE = 1024 * 1024; // 1 MiB
const CSS_MODULE_URL_RE = /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

export const DEVTOOLS_PATH = "/_pracht";
export const DEVTOOLS_JSON_PATH = "/_pracht.json";
export const LLMS_TXT_PATH = "/llms.txt";

export function isEventStreamContentType(contentType: string): boolean {
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
}

/**
 * Adapter-owned dev servers can route every browser request through their
 * platform runtime before Vite's transform middleware gets a chance to serve
 * Pracht's stable virtual client entries. Serve those two entries at their
 * public, base-prefixed URLs while leaving every other request to the adapter.
 */
export function createOwnedDevEntryMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  const base = server.config.base || "/";

  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return next();

    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname =
      base === "/"
        ? requestUrl.pathname
        : requestUrl.pathname.startsWith(base)
          ? `/${requestUrl.pathname.slice(base.length)}`
          : null;
    if (pathname !== CLIENT_BROWSER_PATH && pathname !== ISLANDS_CLIENT_BROWSER_PATH) {
      return next();
    }

    try {
      const result = await server.transformRequest(`${pathname}${requestUrl.search}`);
      if (!result) return next();

      if (result.etag && req.headers["if-none-match"] === result.etag) {
        res.statusCode = 304;
        res.end();
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/javascript");
      res.setHeader("cache-control", "no-cache");
      if (result.etag) res.setHeader("etag", result.etag);
      for (const [name, value] of Object.entries(server.config.server.headers ?? {})) {
        if (value !== undefined) res.setHeader(name, value);
      }
      res.end(method === "HEAD" ? undefined : result.code);
    } catch (error) {
      next(error);
    }
  };
}

export function createDevSSRMiddleware(
  server: ViteDevServer,
  options: { maxBodySize?: number; llmsTxt?: boolean } = {},
): Connect.NextHandleFunction {
  const maxBodySize = options.maxBodySize ?? DEFAULT_MAX_BODY_SIZE;
  // Vite's own base middleware strips the base from `req.url` before this
  // handler runs, so routing here is base-free — but everything the document
  // hands back to the browser (client entry, request URL in the hydration
  // state) must carry it again, exactly as a production build does.
  const devBase = server.config.base || "/";
  const withDevBase = (path: string): string =>
    devBase === "/" || !path.startsWith("/") ? path : `${devBase}${path.slice(1)}`;
  let warnedDevtoolsCollision = false;
  let warnedLlmsTxtCollision = false;

  // A hand-written public/llms.txt and the generated one disagree about who
  // wins: Vite's publicDir middleware serves the static file in dev (before
  // this handler runs), while `pracht build` overwrites it with generated
  // content. Warn once so the divergence is not silent.
  if (options.llmsTxt && typeof server.config.publicDir === "string") {
    const publicLlmsTxt = join(server.config.publicDir, "llms.txt");
    if (existsSync(publicLlmsTxt)) {
      server.config.logger.warn(
        `[pracht] Both public/llms.txt and the pracht({ llmsTxt }) option are present. ` +
          `Dev serves the static public/llms.txt, but "pracht build" overwrites it with the ` +
          `generated content. Remove one to avoid a dev/production mismatch.`,
      );
    }
  }
  return async (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const url = req.url ?? "/";
    const requestUrl = new URL(url, "http://localhost");

    try {
      const [framework, serverMod] = await Promise.all([
        server.ssrLoadModule("@pracht/core/server"),
        server.ssrLoadModule(PRACHT_SERVER_MODULE_ID),
      ]);

      const routeMatchers = {
        app: serverMod.resolvedApp as ResolvedPrachtApp,
        apiRoutes: serverMod.apiRoutes as ResolvedApiRoute[],
        matchApiRoute: framework.matchApiRoute,
        matchAppRoute: framework.matchAppRoute,
      };

      // `/_pracht` is reserved in dev only. Production builds never see this
      // branch, so a user route at that path keeps working in production.
      if (requestUrl.pathname === DEVTOOLS_PATH || requestUrl.pathname === DEVTOOLS_JSON_PATH) {
        if (!warnedDevtoolsCollision && matchesResolvedRoute(requestUrl.pathname, routeMatchers)) {
          warnedDevtoolsCollision = true;
          server.config.logger.warn(
            `[pracht] An app route matches ${requestUrl.pathname}, which is reserved for the ` +
              `pracht devtools page in dev. The devtools page wins during development; the app ` +
              `route is only served in production builds.`,
          );
        }

        await serveDevtools(server, res, {
          apiRoutes: serverMod.apiRoutes ?? [],
          app: serverMod.resolvedApp,
          base: devBase,
          url,
          wantsJson: requestUrl.pathname === DEVTOOLS_JSON_PATH,
        });
        return;
      }

      // `/llms.txt` is served from the live app graph when the plugin's
      // `llmsTxt` option is enabled — the same content `pracht build` writes
      // to dist/client/llms.txt.
      if (
        options.llmsTxt &&
        requestUrl.pathname === LLMS_TXT_PATH &&
        BODYLESS_METHODS.has((req.method ?? "GET").toUpperCase()) &&
        typeof serverMod.generateLlmsTxt === "function"
      ) {
        if (!warnedLlmsTxtCollision && matchesResolvedRoute(LLMS_TXT_PATH, routeMatchers)) {
          warnedLlmsTxtCollision = true;
          server.config.logger.warn(
            `[pracht] An app route matches ${LLMS_TXT_PATH}, which is reserved by the ` +
              `pracht({ llmsTxt }) option. The generated llms.txt wins; disable the option ` +
              `to serve the app route instead.`,
          );
        }

        const llmsTxt: string = await serverMod.generateLlmsTxt();
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        // Match production: the adapters serve dist/client/llms.txt with the
        // framework's default security headers, and dev diverging from that is
        // exactly the kind of difference that only shows up after deploy.
        applyDefaultSecurityHeaders(new Headers()).forEach((value, key) => {
          res.setHeader(key, value);
        });
        res.end(llmsTxt);
        return;
      }

      if (shouldBypassDevSSR(requestUrl, req, routeMatchers)) {
        return next();
      }

      if (isDevNotFoundRequest(requestUrl, req, routeMatchers)) {
        return serveDevNotFound(
          server,
          res,
          next,
          url,
          requestUrl.pathname,
          routeMatchers,
          devBase,
        );
      }

      let webRequest: Request;
      try {
        webRequest = await nodeToWebRequest(req, maxBodySize, devBase);
      } catch (err) {
        if (err instanceof Error && err.message === "Request body too large") {
          res.statusCode = 413;
          res.end("Payload Too Large");
          return;
        }
        throw err;
      }
      // Dev-only: collect middleware/loader/render phase durations so the
      // browser Network panel shows them via the Server-Timing header.
      const timings: PrachtPhaseTimings = {};
      // A route that fails without an ErrorBoundary answers with the runtime's
      // plain-text fallback. That is the right answer for a production adapter
      // and the wrong one for a browser in dev, so capture the raw error here
      // and re-render it as the overlay below.
      let routeError: unknown;
      // An explicit flag rather than `routeError !== undefined`: `throw
      // undefined` and a bare `Promise.reject()` are real failures that would
      // otherwise fall through to the plain-text fallback.
      let capturedRouteError = false;
      let routeErrorContext: RouteErrorContext | undefined;
      const response = await framework.handlePrachtRequest({
        app: serverMod.resolvedApp,
        registry: serverMod.registry,
        request: webRequest,
        debugErrors: true,
        onRouteError: (error: unknown, _requestPath: string, context?: RouteErrorContext) => {
          capturedRouteError = true;
          routeError = error;
          routeErrorContext = context;
        },
        clientEntryUrl: withDevBase(CLIENT_BROWSER_PATH),
        islandsEntryUrl: withDevBase(ISLANDS_CLIENT_BROWSER_PATH),
        islandsBootstrapRequired: serverMod.islandsBootstrapRequired === true,
        apiRoutes: serverMod.apiRoutes,
        timings,
      });

      // A 404 from the runtime normally falls through to Vite (which has
      // already had its shot at static files, since this middleware is
      // installed after Vite's own). Two exceptions are served as-is: apps
      // that declare a `notFound` page get that page rendered here — same as
      // in production — and JSON 404s are typed API responses (route-state,
      // capability envelopes) that must reach the client untouched.
      const responseContentType = response.headers.get("content-type") ?? "";
      if (
        response.status === 404 &&
        !responseContentType.includes("application/json") &&
        !routeMatchers.app?.notFound
      ) {
        return next();
      }

      // Only transform what actually is HTML. Defaulting a missing
      // content-type to `text/html` made Vite inject its client script into
      // bodiless responses — an MCP `notifications/*` 202 came back with
      // `<script type="module" src="/@vite/client">` as its body, and so did
      // redirects.
      const contentType = response.headers.get("content-type") ?? "";

      // A Server-Sent Events response never ends, so buffering it through
      // `response.text()` below would hang the request forever — dev would
      // diverge from every production adapter, all of which stream. Pipe it
      // through untouched, and cancel the source when the client disconnects
      // so `createEventStream()` cleanup (keep-alive timers, producer loops)
      // runs in dev exactly as it does in production.
      if (response.body && isEventStreamContentType(contentType)) {
        res.statusCode = response.status;
        response.headers.forEach((value: string, key: string) => {
          res.setHeader(key, value);
        });
        const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        // The client may already have hung up while the handler ran; `close`
        // has then already fired and the listener below would never run,
        // leaving the stream (and its keep-alive timer) alive forever.
        if (res.destroyed || res.writableEnded) {
          source.destroy();
          return;
        }
        res.on("close", () => {
          if (!res.writableFinished) source.destroy();
        });
        source.on("error", () => {
          res.destroy();
        });
        source.pipe(res);
        return;
      }

      if (
        shouldRenderDevErrorOverlay({
          capturedRouteError,
          contentType,
          exposeServerErrors: shouldExposeDevServerErrors(),
          status: response.status,
        })
      ) {
        await respondWithErrorOverlay(
          server,
          res,
          url,
          routeError,
          routeErrorContext,
          devBase,
          response.status,
        );
        return;
      }

      let body = await response.text();

      if (contentType.includes("text/html")) {
        body = await transformDevHtml(server, url, body, devBase);
      }

      res.statusCode = response.status;
      response.headers.forEach((value: string, key: string) => {
        res.setHeader(key, value);
      });
      const serverTiming = framework.formatServerTimingHeader(timings);
      if (serverTiming) {
        res.setHeader("Server-Timing", serverTiming);
      }
      res.end(body);
    } catch (error: unknown) {
      await handleDevError(server, req, res, next, url, error, devBase);
    }
  };
}

/**
 * Vite's HTML transform adds `config.base` to root-absolute asset attributes.
 * Pracht's runtime has already added it to URLs produced by `withBase()` — the
 * client entry, route-state preloads, image endpoints, and user-authored asset
 * URLs — while Vite-owned or module-graph URLs still need the transform. Hide
 * the already-based strings while the hooks run, then restore them afterward,
 * so each producer applies the deploy base exactly once.
 */
async function transformDevHtml(
  server: ViteDevServer,
  url: string,
  html: string,
  base: string,
): Promise<string> {
  if (base === "/") return server.transformIndexHtml(url, html);

  const assetUrls = protectRootAbsoluteAssetAttributes(html);

  // An external URL is inert to Vite's asset rewriting and module pre-transform.
  // A relative marker would produce a noisy failed pre-transform even though it
  // is restored before the HTML reaches the browser.
  let placeholder = "https://pracht.invalid/__PRACHT_DEV_BASE_PLACEHOLDER__/";
  while (assetUrls.html.includes(placeholder)) placeholder += "_";

  const protectedHtml = assetUrls.html.replaceAll(base, placeholder);
  const transformedHtml = await server.transformIndexHtml(url, protectedHtml);
  return assetUrls.restore(transformedHtml.replaceAll(placeholder, base));
}

const HTML_ASSET_URL_ATTRIBUTE_RE =
  /(\s(?:src|href|xlink:href|data|srcset|imagesrcset|poster|content)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * Runtime-rendered root-absolute asset URLs have already reached their final
 * public meaning: raw `/logo.svg` deliberately stays at the origin root,
 * while `withBase("/logo.svg")` is already under the deploy base. Vite's dev
 * HTML pass prefixes both, unlike production SSR, so hide complete attribute
 * values behind inert external URLs until that pass finishes.
 */
function protectRootAbsoluteAssetAttributes(html: string): {
  html: string;
  restore: (transformedHtml: string) => string;
} {
  let markerPrefix = "https://pracht.invalid/__PRACHT_DEV_ASSET_PLACEHOLDER__/";
  while (html.includes(markerPrefix)) markerPrefix += "_";

  const replacements: Array<{ marker: string; value: string }> = [];
  const protectedHtml = html.replace(
    HTML_ASSET_URL_ATTRIBUTE_RE,
    (match, prefix: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? unquoted ?? "";
      const isSrcset = /(?:srcset)\s*=\s*$/i.test(prefix);
      const isRootAbsolute = isSrcset
        ? /(?:^|,)\s*\/(?!\/)/.test(value)
        : /^\s*\/(?!\/)/.test(value);
      if (!isRootAbsolute) return match;

      const marker = `${markerPrefix}${replacements.length}`;
      replacements.push({ marker, value });
      if (doubleQuoted !== undefined) return `${prefix}"${marker}"`;
      if (singleQuoted !== undefined) return `${prefix}'${marker}'`;
      return `${prefix}${marker}`;
    },
  );

  return {
    html: protectedHtml,
    restore(transformedHtml) {
      let restoredHtml = transformedHtml;
      for (const { marker, value } of replacements) {
        restoredHtml = restoredHtml.replaceAll(marker, value);
      }
      return restoredHtml;
    },
  };
}

/**
 * Build the development equivalent of the production CSS manifest for the
 * current route. Vite turns CSS imports into client-side style injection by
 * default; resolving the same imports through the active server environment
 * graphs lets pracht put real stylesheet links in the initial document and
 * avoid a first-paint FOUC.
 */
export async function createDevCssManifest(
  server: ViteDevServer,
  options: {
    app: ResolvedPrachtApp;
    matchAppRoute: (
      app: ResolvedPrachtApp,
      pathname: string,
    ) => { route: ResolvedRoute } | undefined;
    pathname: string | null;
    registry: ModuleRegistry;
  },
): Promise<Record<string, string[]>> {
  const route =
    options.pathname === null
      ? undefined
      : (options.matchAppRoute(options.app, options.pathname)?.route ?? options.app.notFound);
  if (!route) return {};

  const manifest: Record<string, string[]> = {};
  const modules = [
    ...(route.shellFile
      ? [{ file: route.shellFile, registry: options.registry.shellModules }]
      : []),
    { file: route.file, registry: options.registry.routeModules },
  ];

  const results = await Promise.all(
    modules.map(async ({ file, registry }) => {
      if (!registry) return { file, urls: [] };
      const moduleKey = findRegistryModuleKey(registry, file);
      if (!moduleKey) return { file, urls: [] };

      // Adapters can name their server environment (for example, Cloudflare
      // does), so inspect every graph instead of assuming `ssr`.
      const entries = await Promise.all(
        Object.values(server.environments).map((environment) =>
          environment.moduleGraph.getModuleByUrl(moduleKey),
        ),
      );
      const urls = [...new Set(entries.flatMap((entry) => collectDevCssUrls(entry)))];
      return { file, urls };
    }),
  );

  for (const { file, urls } of results) {
    if (urls.length > 0) manifest[file] = urls;
  }

  return manifest;
}

function findRegistryModuleKey(
  modules: Record<string, () => Promise<unknown>> | undefined,
  file: string,
): string | undefined {
  if (!modules) return undefined;
  if (file in modules) return file;

  const suffix = `/${file
    .split("?")[0]
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")}`;
  return Object.keys(modules).find((key) => key.split("?")[0].replace(/\\/g, "/").endsWith(suffix));
}

export function collectDevCssUrls(entry: EnvironmentModuleNode | undefined): string[] {
  if (!entry) return [];

  const urls = new Set<string>();
  const visited = new Set<EnvironmentModuleNode>();
  const pending = [entry];

  while (pending.length > 0) {
    const module = pending.pop()!;
    if (visited.has(module)) continue;
    visited.add(module);

    // SSR transforms CSS imports into JavaScript modules, so Vite can label
    // these nodes as `js`. The URL remains the reliable signal for CSS and
    // preprocessor requests; asset/string queries are intentionally excluded.
    if (
      (module.type === "css" || CSS_MODULE_URL_RE.test(module.url)) &&
      !/[?&](?:inline|raw|url)(?:[=&]|$)/.test(module.url)
    ) {
      urls.add(module.url);
    }
    pending.push(...[...module.importedModules].reverse());
  }

  return [...urls];
}

export function injectDevCssLinks(
  html: string,
  manifest: Record<string, string[]>,
  base = "/",
): string {
  if (!html.includes("</head>")) return html;

  const urls = [
    ...new Set(
      Object.values(manifest)
        .flat()
        .map((url) => (base === "/" || !url.startsWith("/") ? url : `${base}${url.slice(1)}`)),
    ),
  ];
  const tags = urls
    .map((url) => escapeHtmlAttribute(url))
    .filter((escapedUrl) => !html.includes(`href="${escapedUrl}"`))
    .map((escapedUrl) => `<link rel="stylesheet" href="${escapedUrl}">`);
  if (tags.length === 0) return html;

  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

export async function injectDevCssForPath(
  server: ViteDevServer,
  path: string,
  html: string,
  options: { basePathRetained?: boolean } = {},
): Promise<string> {
  const context = await resolveDevCssContextForPath(server, path, options);
  const manifest = await createDevCssManifest(server, context);
  return injectDevCssLinks(html, manifest, server.config.base || "/");
}

async function resolveDevCssContextForPath(
  server: ViteDevServer,
  path: string,
  options: { basePathRetained?: boolean } = {},
): Promise<Parameters<typeof createDevCssManifest>[1]> {
  const [framework, serverMod] = await Promise.all([
    server.ssrLoadModule("@pracht/core/server"),
    server.ssrLoadModule(PRACHT_DEV_MODULE_ID),
  ]);
  const publicPathname = new URL(path, "http://localhost").pathname;
  // Vite strips its base before the normal dev SSR middleware runs, but an
  // adapter-owned server receives the original browser path because this CSS
  // middleware is registered before Vite's base middleware. Match both paths
  // against the same base-free route manifest. `null` deliberately suppresses
  // not-found CSS for adapter HTML responses outside this app's base.
  const pathname = options.basePathRetained ? framework.stripBase(publicPathname) : publicPathname;
  return {
    app: serverMod.resolvedApp,
    matchAppRoute: framework.matchAppRoute,
    pathname,
    registry: serverMod.registry,
  };
}

/**
 * Adapter-owned dev servers (for example Cloudflare's worker runtime) bypass
 * Vite's HTML transform hooks. Install this before the adapter middleware so
 * document responses still receive the same parser-blocking stylesheet links.
 */
export function createDevCssInjectionMiddleware(server: ViteDevServer): Connect.NextHandleFunction {
  let warned = false;
  return (req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) => {
    const method = (req.method ?? "GET").toUpperCase();
    const accept = readRequestHeader(req.headers.accept).toLowerCase();
    if (method !== "GET" || !accept.includes("text/html")) {
      next();
      return;
    }

    // Resolve the route before the adapter begins its request. Remote dev
    // runtimes can serialize module-runner work while a response is open. CSS
    // traversal itself waits until res.end(), after that runtime has populated
    // its environment graph with the matched route and shell.
    const contextPromise = resolveDevCssContextForPath(server, req.url ?? "/", {
      basePathRetained: true,
    }).catch((error) => {
      if (!warned) {
        warned = true;
        server.config.logger.warn(
          `[pracht] Could not discover development stylesheets: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return null;
    });
    const chunks: Buffer[] = [];
    const originalEnd = res.end.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    res.writeHead = ((statusCode: number, ...args: unknown[]) => {
      res.removeHeader("content-length");
      return Reflect.apply(originalWriteHead, res, [
        statusCode,
        ...args.map(stripContentLengthHeader),
      ]);
    }) as typeof res.writeHead;

    res.write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;
      done?.();
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
      if (chunk != null) chunks.push(toBuffer(chunk, encodingOrCallback));
      const done: (() => void) | undefined =
        typeof encodingOrCallback === "function"
          ? (encodingOrCallback as () => void)
          : typeof callback === "function"
            ? (callback as () => void)
            : undefined;

      void (async () => {
        const body = Buffer.concat(chunks);
        const contentType = String(res.getHeader("content-type") ?? "");
        if (!contentType.includes("text/html")) {
          originalEnd(body, done);
          return;
        }

        try {
          const context = await contextPromise;
          const manifest = context ? await createDevCssManifest(server, context) : null;
          const html = manifest
            ? injectDevCssLinks(body.toString("utf-8"), manifest, server.config.base || "/")
            : body.toString("utf-8");
          originalEnd(html, done);
        } catch {
          originalEnd(body, done);
        }
      })();

      return res;
    }) as typeof res.end;

    next();
  };
}

function toBuffer(chunk: unknown, encoding: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(
    String(chunk),
    typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
  );
}

function stripContentLengthHeader(value: unknown): unknown {
  if (Array.isArray(value)) {
    const headers: unknown[] = [];
    for (let index = 0; index < value.length; index += 2) {
      if (String(value[index]).toLowerCase() !== "content-length") {
        headers.push(value[index], value[index + 1]);
      }
    }
    return headers;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => name.toLowerCase() !== "content-length"),
    );
  }

  return value;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Serve the dev-only `/_pracht` devtools page (or `/_pracht.json`) built from
 * the same resolved app graph that `pracht inspect` reports.
 */
async function serveDevtools(
  server: ViteDevServer,
  res: ServerResponse,
  options: {
    apiRoutes: ResolvedApiRoute[];
    app: ResolvedPrachtApp;
    base: string;
    url: string;
    wantsJson: boolean;
  },
): Promise<void> {
  const devtools = await server.ssrLoadModule("@pracht/core/devtools");
  // Manifest capability paths are relative to the app file (e.g.
  // `./capabilities/notes-search.ts`), which a bare ssrLoadModule resolves
  // against the Vite root and fails to find. Resolve through the virtual
  // server module's registry first (matching `pracht inspect`), falling back
  // to a direct load for absolute/root-relative paths.
  const serverModule = (await server.ssrLoadModule(PRACHT_SERVER_MODULE_ID)) as {
    registry?: { capabilityModules?: Record<string, () => Promise<unknown>> };
  };
  const capabilityModules = serverModule.registry?.capabilityModules;
  const graph = await devtools.buildAppGraph({
    apiRoutes: options.apiRoutes,
    app: options.app,
    loadModule: async (file: string) => {
      const viaRegistry = await resolveRegistryModule<Record<string, unknown>>(
        capabilityModules,
        file,
      );
      return viaRegistry ?? server.ssrLoadModule(file);
    },
    readSource: (file: string) => readFileSync(resolve(server.config.root, `.${file}`), "utf-8"),
  });

  if (options.wantsJson) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(graph, null, 2));
    return;
  }

  let html = devtools.buildDevtoolsHtml(graph, { base: options.base });
  html = await server.transformIndexHtml(options.url, html);
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(html);
}

/**
 * True when a dev response should be replaced by the error overlay.
 *
 * The runtime only falls back to `text/plain` for a page render when neither
 * the route nor its shell declares an ErrorBoundary. When one does, the
 * response is the app's own error UI (`text/html`) and dev must leave it
 * alone. Route-state and capability failures are JSON and belong to the
 * client router, not to a human reading a document.
 */
export function shouldRenderDevErrorOverlay(options: {
  capturedRouteError: boolean;
  contentType: string;
  /**
   * Mirror of the runtime's `shouldExposeServerErrors()` verdict. `onRouteError`
   * fires with the raw error regardless of `debugErrors`, so without this the
   * overlay would print the stack trace and filesystem paths that the runtime
   * had just refused to put in the response body under `NODE_ENV=production`.
   */
  exposeServerErrors: boolean;
  status: number;
}): boolean {
  return (
    options.capturedRouteError &&
    options.exposeServerErrors &&
    options.status >= 500 &&
    options.contentType.toLowerCase().startsWith("text/plain")
  );
}

/**
 * The dev middleware passes `debugErrors: true` unconditionally, but the
 * runtime refuses to honor it when `NODE_ENV === "production"` (see
 * `shouldExposeServerErrors` in @pracht/core) — a dev server started inside a
 * container that exports `NODE_ENV=production` must not answer with internals.
 * The overlay is built from the raw error rather than from the runtime's
 * already-redacted body, so it has to repeat that check.
 */
function shouldExposeDevServerErrors(): boolean {
  return (typeof process !== "undefined" ? process.env?.NODE_ENV : undefined) !== "production";
}

/**
 * Render a failed page render as the dev error overlay.
 *
 * `handlePrachtRequest` answers a render/loader/middleware failure with the
 * runtime's plain-text fallback whenever no ErrorBoundary claims it. In a
 * production adapter that is correct — a browser is not the audience. In dev
 * the browser *is* the audience, and the fallback is at its worst exactly when
 * it matters most: a compiler diagnostic arrives colourized for a terminal, so
 * `text/plain` renders every escape sequence literally.
 */
async function respondWithErrorOverlay(
  server: ViteDevServer,
  res: ServerResponse,
  url: string,
  error: unknown,
  context: RouteErrorContext | undefined,
  base: string,
  status: number,
): Promise<void> {
  if (error instanceof Error) {
    server.ssrFixStacktrace(error);
  }

  const { buildErrorOverlayHtml } = await server.ssrLoadModule("@pracht/core/error-overlay");
  let html = buildErrorOverlayHtml({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    routeId: context?.routeId,
    file: context?.routeFile,
    loaderFile: context?.loaderFile,
    shellFile: context?.shellFile,
    phase: context?.phase,
    root: server.config.root,
    base,
  });
  html = await server.transformIndexHtml(url, html);
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  // The runtime response this replaces carried the framework's default
  // security headers. Dropping them here would make dev the one surface that
  // answers a 500 without them.
  applyDefaultSecurityHeaders(new Headers()).forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.end(html);
}

async function handleDevError(
  server: ViteDevServer,
  req: IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
  url: string,
  error: unknown,
  base: string,
): Promise<void> {
  if (error instanceof Error) {
    server.ssrFixStacktrace(error);
  }

  const isRouteState = req.headers["x-pracht-route-state-request"] === "1";
  if (isRouteState) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : "Error",
          status: 500,
        },
      }),
    );
    return;
  }

  try {
    const { buildErrorOverlayHtml } = await server.ssrLoadModule("@pracht/core/error-overlay");
    let html = buildErrorOverlayHtml({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      root: server.config.root,
      base,
    });
    html = await server.transformIndexHtml(url, html);
    res.statusCode = 500;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    next(error);
  }
}

/**
 * True when a GET/HEAD document request matches no page route and no API
 * route — the dev middleware then serves the rich dev-only 404 page instead
 * of falling through to Vite. Route-state (JSON) requests and non-document
 * fetches keep their existing 404 behavior.
 *
 * Apps that declare a `notFound` page own their 404s: dev renders that page
 * (exactly as production does) rather than the framework's route table.
 */
export function isDevNotFoundRequest(
  requestUrl: URL | string,
  req: Pick<IncomingMessage, "headers" | "method">,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  } = {},
): boolean {
  const url = typeof requestUrl === "string" ? new URL(requestUrl, "http://localhost") : requestUrl;

  if (options.app?.notFound) {
    return false;
  }

  if (isRouteStateRequest(url, req)) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const accept = readRequestHeader(req.headers.accept).toLowerCase();
  if (!accept.includes("text/html") && !accept.includes("application/xhtml+xml")) {
    return false;
  }

  return !matchesResolvedRoute(url.pathname, options);
}

async function serveDevNotFound(
  server: ViteDevServer,
  res: ServerResponse,
  next: Connect.NextFunction,
  url: string,
  pathname: string,
  options: { app: ResolvedPrachtApp; apiRoutes: ResolvedApiRoute[] },
  base: string,
): Promise<void> {
  try {
    const { buildDevNotFoundHtml } = await server.ssrLoadModule("@pracht/core/dev-404");
    let html = buildDevNotFoundHtml({
      apiRoutes: options.apiRoutes.map((route) => ({ path: route.path })),
      base,
      requestedPath: pathname,
      routes: options.app.routes.map((route) => ({
        path: route.path,
        render: route.render ?? null,
      })),
    });
    html = await server.transformIndexHtml(url, html);
    res.statusCode = 404;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  } catch {
    next();
  }
}

export function shouldBypassDevSSR(
  requestUrl: URL | string,
  req: Pick<IncomingMessage, "headers" | "method">,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  } = {},
): boolean {
  const url = typeof requestUrl === "string" ? new URL(requestUrl, "http://localhost") : requestUrl;
  const pathname = url.pathname;

  if (isReservedDevPath(pathname)) {
    return true;
  }

  if (isRouteStateRequest(url, req)) {
    return false;
  }

  const isApiRequest = pathname === "/api" || pathname.startsWith("/api/");
  if (isApiRequest) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const fetchDest = readRequestHeader(req.headers["sec-fetch-dest"]).toLowerCase();
  const hasRouteMatch = matchesResolvedRoute(pathname, options);

  if (hasRouteMatch && !NON_DOCUMENT_FETCH_DESTINATIONS.has(fetchDest)) {
    return false;
  }

  if (NON_DOCUMENT_FETCH_DESTINATIONS.has(fetchDest)) {
    return true;
  }

  const accept = readRequestHeader(req.headers.accept).toLowerCase();
  if (accept.includes("text/html") || accept.includes("application/xhtml+xml")) {
    return false;
  }

  return hasKnownAssetExtension(pathname);
}

function matchesResolvedRoute(
  pathname: string,
  options: {
    app?: ResolvedPrachtApp;
    apiRoutes?: ResolvedApiRoute[];
    matchApiRoute?: (routes: ResolvedApiRoute[], pathname: string) => unknown;
    matchAppRoute?: (app: ResolvedPrachtApp, pathname: string) => unknown;
  },
): boolean {
  if (options.app && options.matchAppRoute && options.matchAppRoute(options.app, pathname)) {
    return true;
  }

  if (
    options.apiRoutes?.length &&
    options.matchApiRoute &&
    options.matchApiRoute(options.apiRoutes, pathname)
  ) {
    return true;
  }

  return false;
}

function isRouteStateRequest(url: URL, req: Pick<IncomingMessage, "headers" | "method">): boolean {
  return (
    req.headers["x-pracht-route-state-request"] === "1" || url.searchParams.get("_data") === "1"
  );
}

function readRequestHeader(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value ?? "";
}

function hasKnownAssetExtension(pathname: string): boolean {
  const fileName = pathname.split("/").pop() ?? "";
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return false;
  }

  const extension = fileName.slice(extensionIndex).toLowerCase();
  return DEV_ASSET_EXTENSIONS.has(extension);
}

function isReservedDevPath(pathname: string): boolean {
  return (
    pathname === CLIENT_BROWSER_PATH ||
    pathname === ISLANDS_CLIENT_BROWSER_PATH ||
    pathname === "/@vite/client" ||
    pathname === "/@react-refresh" ||
    pathname.startsWith("/@vite/") ||
    pathname.startsWith("/@id/") ||
    pathname.startsWith("/@fs/") ||
    pathname.startsWith("/__vite_")
  );
}

const NON_DOCUMENT_FETCH_DESTINATIONS = new Set([
  "audio",
  "embed",
  "font",
  "image",
  "manifest",
  "object",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "worker",
]);

const DEV_ASSET_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".cjs",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".map",
  ".markdown",
  ".md",
  ".mjs",
  ".pdf",
  ".png",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
  ".webp",
  ".woff",
  ".woff2",
  ".xml",
]);

async function nodeToWebRequest(
  req: IncomingMessage,
  maxBodySize: number,
  base = "/",
): Promise<Request> {
  // Dev server is always a direct connection — never trust forwarded headers.
  // Protocol is always plain HTTP (Vite's dev server does not use TLS), and
  // host comes from the standard Host header which is safe for direct clients.
  const protocol = "http";
  const host = req.headers.host ?? "localhost";
  // Vite stripped the base off `req.url`; put it back so the request the app
  // sees — and the URL it serializes for the client — is the one the visitor
  // typed. `handlePrachtRequest` strips it again for route matching.
  const path = req.url ?? "/";
  const url = new URL(
    base === "/" || !path.startsWith("/") ? path : `${base}${path.slice(1)}`,
    `${protocol}://${host}`,
  );
  const method = req.method ?? "GET";

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = { method, headers };

  if (!BODYLESS_METHODS.has(method.toUpperCase())) {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalSize += buf.byteLength;
      if (totalSize > maxBodySize) {
        throw new Error("Request body too large");
      }
      chunks.push(buf);
    }
    const body = Buffer.concat(chunks);
    if (body.byteLength > 0) {
      init.body = body;
    }
  }

  return new Request(url, init);
}
