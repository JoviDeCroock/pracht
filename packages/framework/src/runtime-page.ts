/**
 * The back half of the server request pipeline: turning one matched route into
 * a response.
 *
 * `renderPage` is the entry point and reads as the pipeline it is — middleware
 * chain around a terminal that resolves modules, runs the loader, merges head
 * and headers, and assembles a document. Each of those steps is a named
 * function taking one explicit `PageRenderJob` rather than a closure over the
 * request handler's locals, which is what makes the loader path testable apart
 * from the HTML path and the route-state path apart from both.
 *
 * @internal Not part of the published API.
 */
import { h } from "preact";
import { streamingHtmlResponse } from "./runtime-stream.ts";
import type { FunctionComponent } from "preact";
import { DEFER_RUNTIME_SHIM, resolveDeferredData, serializeDeferred } from "./defer.ts";
import { collectFontHeadFragments } from "./font.ts";
import {
  buildRuntimeDiagnostics,
  createSerializedRouteError,
  isPrachtHttpError,
  type PrachtRuntimeDiagnosticPhase,
} from "./runtime-errors.ts";
import { appendVaryHeader, withRouteResponseHeaders } from "./runtime-headers.ts";
import { PrachtRuntimeProvider } from "./runtime-context.ts";
import { buildHtmlDocument, buildHtmlDocumentParts, htmlResponse } from "./runtime-html.ts";
import { getAppSpeculationRules } from "./runtime-speculation.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  type IslandCapture,
} from "./islands-server.ts";
import { createScriptCapture, ScriptCaptureContext, withCapturedScripts } from "./script.ts";
import {
  CLIENT_ENTRY_MANIFEST_KEY,
  ISLANDS_ENTRY_MANIFEST_KEY,
  mergeEntryPreloadUrls,
  resolveManifestEntries,
  resolvePageCssUrls,
  resolvePageJsUrls,
  resolveDataFunctions,
  resolveRegistryModule,
} from "./runtime-manifest.ts";
import {
  mergeDocumentHeaders,
  mergeErrorHeadMetadata,
  mergeHeadMetadata,
  runMiddlewareChain,
} from "./runtime-middleware.ts";
import { buildRouteStateUrl } from "./runtime-client-fetch.ts";
import { buildStaticRouteStateUrl, IS_STATIC_TARGET } from "./runtime-static.ts";
import {
  getRenderToStringAsync,
  isFrameworkFontHeadResponse,
  jsonErrorResponse,
  markFrameworkFontHeadResponse,
  normalizePageResponse,
  renderRouteErrorResponse,
} from "./runtime-response.ts";
import { markdownResponse, prefersMarkdown } from "./runtime-negotiation.ts";
import {
  composeRequestSignal,
  combineRequestSignals,
  isClientDisconnect,
  type PrachtRequestContext,
} from "./runtime-request.ts";
import type {
  BaseRouteArgs,
  HeadMetadata,
  ResolvedPrachtApp,
  RouteMatch,
  RouteModule,
  ShellModule,
} from "./types.ts";

const BODY_REPRESENTATION_HEADERS = [
  "content-digest",
  "content-encoding",
  "content-length",
  "content-md5",
  "content-range",
  "digest",
  "etag",
  "last-modified",
  "repr-digest",
  "transfer-encoding",
] as const;

function headersForReserializedBody(headers: Headers): Headers {
  const nextHeaders = new Headers(headers);
  for (const name of BODY_REPRESENTATION_HEADERS) nextHeaders.delete(name);
  return nextHeaders;
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

async function attachFontHeadToRouteStateResponse<TContext>(options: {
  response: Response;
  isRouteStateRequest: boolean;
  routeArgs: BaseRouteArgs<TContext>;
  routeModule: RouteModule | undefined | Promise<RouteModule | undefined>;
  shellModule: ShellModule | undefined | Promise<ShellModule | undefined>;
}): Promise<Response> {
  const { response, isRouteStateRequest, routeArgs } = options;
  if (!isRouteStateRequest) return response;

  const contentType = response.headers.get("content-type") ?? "";
  if (!isJsonMediaType(contentType)) return response;

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    // A middleware/loader Response is authoritative even when its declared
    // JSON representation is empty, malformed, or otherwise unreadable. Font
    // enrichment is optional and must not turn that response into a 500.
    return response;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return response;

  const body = payload as Record<string, unknown>;
  if (isFrameworkFontHeadResponse(response) || typeof body.redirect === "string") return response;

  // This response already completed the middleware/loader contract. Font-head
  // enrichment must not replace it with a 500 if an eagerly-started route or
  // shell import fails, or if head metadata itself cannot be evaluated. Use
  // whichever modules resolved and fall back to authoritative empty fragments
  // so client navigation also clears fonts left by the previous route.
  const [routeModuleResult, shellModuleResult] = await Promise.allSettled([
    options.routeModule,
    options.shellModule,
  ]);
  const routeModule =
    routeModuleResult.status === "fulfilled" ? routeModuleResult.value : undefined;
  const shellModule =
    shellModuleResult.status === "fulfilled" ? shellModuleResult.value : undefined;
  let fontHead = collectFontHeadFragments([]);
  try {
    const data = body.data;
    const head =
      response.ok && !Object.hasOwn(body, "error")
        ? await mergeHeadMetadata(shellModule, routeModule, routeArgs, data)
        : await mergeErrorHeadMetadata(shellModule, routeModule, routeArgs);
    fontHead = collectFontHeadFragments(head.fonts ?? []);
  } catch {}
  return Response.json(
    {
      ...body,
      fontHead,
    },
    {
      status: response.status,
      statusText: response.statusText,
      headers: headersForReserializedBody(response.headers),
    },
  );
}

/**
 * A `RouteMatch` for the app-level not-found page, or `undefined` when the
 * app declares none. `pathname` is the matched, base-free request path passed
 * to loaders, middleware, and route metadata callbacks. `useLocation()` keeps
 * using the public request URL separately.
 */
export function createNotFoundMatch(
  app: ResolvedPrachtApp,
  pathname: string,
): RouteMatch | undefined {
  const route = app.notFound;
  if (!route || !("segments" in route)) return undefined;
  return { route, params: {}, pathname };
}

export function isNotFoundError(error: unknown): boolean {
  return isPrachtHttpError(error) && error.status === 404;
}

/** The success status of the rendered document, and which page it is. */
export interface PageRenderOptions {
  /**
   * Marks a render that is already the not-found page, so a 404 thrown from
   * *its* loader cannot re-enter that path.
   */
  isNotFoundPage: boolean;
  /** 200 for a normal route, 404 for the not-found page. */
  status: number;
}

/**
 * One page render in flight. The mutable fields are what the terminal fills in
 * as it goes; the error path reads them to attribute a failure to a phase, a
 * loader file, and an ErrorBoundary owner.
 */
interface PageRenderJob<TContext> {
  ctx: PrachtRequestContext<TContext>;
  abortController?: AbortController;
  willStream: boolean;
  match: RouteMatch;
  pageOptions: PageRenderOptions;
  routeArgs: BaseRouteArgs<TContext>;
  routeModulePromise: Promise<RouteModule | undefined> | undefined;
  shellModulePromise: Promise<ShellModule | undefined>;
  dataFunctionsPromise: Promise<Awaited<ReturnType<typeof resolveDataFunctions>>> | undefined;
  routeModule: RouteModule | undefined;
  shellModule: ShellModule | undefined;
  loaderFile: string | undefined;
  phase: PrachtRuntimeDiagnosticPhase;
}

/**
 * Resolve the route module and run the loader.
 *
 * Returns the loader's own `Response` when it answered directly (a redirect,
 * say), otherwise the deferred-resolved data every downstream representation
 * serializes.
 */
async function runPageLoader<TContext>(
  job: PageRenderJob<TContext>,
): Promise<{ response: Response } | { data: unknown; hasLoader: boolean }> {
  const { match, pageOptions } = job;
  const timings = job.ctx.options.timings;

  job.phase = "render";
  job.routeModule = await job.routeModulePromise;
  if (!job.routeModule) {
    throw new Error(
      pageOptions.isNotFoundPage
        ? `notFound page module ${JSON.stringify(match.route.file)} was not found in the module registry. ` +
            "The not-found page is loaded from the same registry as route modules, so it has to live in the routes directory."
        : "Route module not found",
    );
  }

  job.phase = "loader";
  const { loader, loaderFile: resolvedLoaderFile } = await job.dataFunctionsPromise!;
  job.loaderFile = resolvedLoaderFile;

  let loaderResult: unknown;
  const loaderStart = loader && timings ? performance.now() : 0;
  if (loader) {
    try {
      loaderResult = await loader(job.routeArgs);
    } catch (error: unknown) {
      // A thrown Response is the loader's answer, just like a returned
      // Response. Normalize both through the same route-state path so
      // redirects, cache headers, and font metadata cannot diverge.
      if (!(error instanceof Response)) throw error;
      loaderResult = error;
    }
  }

  // Allow loaders to return a Response directly (e.g. for redirects)
  if (loaderResult instanceof Response) {
    if (timings) timings.loader = performance.now() - loaderStart;
    return { response: loaderResult };
  }

  // Buffered representations resolve deferred fields here. Streaming documents
  // preserve their markers until the renderer and hydration channel consume them.
  let data: unknown;
  try {
    data = job.willStream ? loaderResult : await resolveDeferredData(loaderResult);
  } finally {
    if (loader && timings) timings.loader = performance.now() - loaderStart;
  }

  return { data, hasLoader: loader != null };
}

/**
 * The route-state (`_data`) representation: loader data plus the font
 * fragments the client needs to keep route-scoped registrations in sync.
 *
 * Route head exports are stripped from the client bundle, which is why the
 * fragments have to be generated here rather than derived in the browser.
 */
async function buildRouteStateResponse<TContext>(
  job: PageRenderJob<TContext>,
  data: unknown,
): Promise<Response> {
  job.phase = "render";
  job.shellModule = await job.shellModulePromise;
  const head = await mergeHeadMetadata(job.shellModule, job.routeModule, job.routeArgs, data);
  const fontHead = collectFontHeadFragments(head.fonts ?? []);
  const body = { data, fontHead };
  return markFrameworkFontHeadResponse(
    withRouteResponseHeaders(Response.json(body), {
      isRouteStateRequest: true,
      loaderCache: job.match.route.loaderCache,
    }),
  );
}

/**
 * Await the shell, merge `head()` and `headers()` from shell and route, and
 * settle Markdown-for-Agents negotiation.
 *
 * Negotiation runs after loader and header resolution on purpose: auth
 * redirects, 401s, and cache policies still apply to the markdown
 * representation.
 */
async function resolvePageDocumentMetadata<TContext>(
  job: PageRenderJob<TContext>,
  data: unknown,
): Promise<{ response: Response } | { head: HeadMetadata; documentHeaders: Headers }> {
  // Shell import was kicked off up front; this await is usually already
  // resolved by the time we get here (it runs in parallel with the loader).
  job.phase = "render";
  job.shellModule = await job.shellModulePromise;

  // head and document headers are independent; run them concurrently.
  const [head, documentHeaders] = await Promise.all([
    mergeHeadMetadata(job.shellModule, job.routeModule, job.routeArgs, data),
    mergeDocumentHeaders(job.shellModule, job.routeModule, job.routeArgs, data),
  ]);

  // Both representations must carry the same Vary header so a cache
  // filled by an HTML request can never satisfy a later markdown request
  // (or vice versa). Keep the variance scoped to routes that actually
  // export markdown: raw Accept values create distinct cache variants on
  // CDNs such as Cloudflare Workers Caching.
  const markdownRepresentation =
    typeof job.routeModule!.markdown === "string" ? job.routeModule!.markdown : undefined;
  if (markdownRepresentation !== undefined) {
    appendVaryHeader(documentHeaders, "Accept");
  }

  if (
    !job.ctx.isRouteStateRequest &&
    markdownRepresentation !== undefined &&
    prefersMarkdown(job.ctx.request.headers.get("accept"))
  ) {
    return {
      response: markdownResponse(markdownRepresentation, documentHeaders, job.pageOptions.status),
    };
  }

  return { head, documentHeaders };
}

/** Stylesheet and modulepreload URLs for this route's document. */
function resolvePageAssets<TContext>(job: PageRenderJob<TContext>): {
  cssUrls: string[];
  modulePreloadUrls: string[];
} {
  const { options } = job.ctx;
  const { route } = job.match;
  return {
    cssUrls: resolvePageCssUrls(options.cssManifest, route.shellFile, route.file),
    modulePreloadUrls: mergeEntryPreloadUrls(
      options.jsManifest,
      CLIENT_ENTRY_MANIFEST_KEY,
      resolvePageJsUrls(options.jsManifest, route.shellFile, route.file),
    ),
  };
}

/**
 * `render: "spa"` — ship the shell's `Loading()` tree and let the client fetch
 * route state, rather than blocking the document on the loader.
 */
async function renderSpaDocument<TContext>(
  job: PageRenderJob<TContext>,
  head: HeadMetadata,
  documentHeaders: Headers,
  hasLoader: boolean,
): Promise<Response> {
  const { ctx, match, pageOptions } = job;
  const { cssUrls, modulePreloadUrls } = resolvePageAssets(job);
  // The generated hasLoader hint can be absent for direct runtime
  // callers, but the resolved loader is authoritative here. Route
  // middleware also participates in the route-state request.
  const needsRouteState = hasLoader || match.route.middlewareFiles.length > 0;
  let body = "";
  const Shell = job.shellModule?.Shell as FunctionComponent | undefined;
  const Loading = job.shellModule?.Loading as FunctionComponent | undefined;
  const loadingTree =
    Shell != null
      ? h(Shell, null, Loading ? h(Loading, null) : null)
      : Loading
        ? h(Loading, null)
        : null;

  // SPA shells render on the server too (the loading tree), so a
  // <Script strategy="beforeHydration"> inside the shell still lands
  // in the document head.
  const spaScriptCapture = createScriptCapture("full");
  if (loadingTree) {
    const tree = h(
      ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: spaScriptCapture },
      h(
        PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
        {
          data: null,
          params: match.params,
          routeId: match.route.id ?? "",
          routes: ctx.hrefRoutes,
          url: ctx.requestPath,
        },
        loadingTree,
      ),
    );
    const renderFn = await getRenderToStringAsync();
    body = await renderFn(tree);
  }

  return htmlResponse(
    buildHtmlDocument({
      head: withCapturedScripts(head, spaScriptCapture),
      body,
      hydrationState: {
        url: ctx.requestPath,
        routeId: match.route.id ?? "",
        data: null,
        error: null,
        pending: needsRouteState,
      },
      clientEntryUrl: ctx.options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
      // Routes with loader/middleware state preload it. Static exports
      // point this at a serialized file; other adapters use `_data=1`.
      routeStatePreloadUrl: needsRouteState
        ? IS_STATIC_TARGET
          ? buildStaticRouteStateUrl(ctx.requestPath)
          : buildRouteStateUrl(ctx.requestPath)
        : undefined,
      speculationRules: getAppSpeculationRules(ctx.resolvedApp),
    }),
    pageOptions.status,
    documentHeaders,
  );
}

/**
 * The server-rendered document for every non-SPA render mode: full hydration,
 * islands, and `hydration: "none"`.
 */
async function renderServerDocument<TContext>(
  job: PageRenderJob<TContext>,
  head: HeadMetadata,
  documentHeaders: Headers,
  data: unknown,
): Promise<Response> {
  const { ctx, match, pageOptions } = job;
  const routeModule = job.routeModule!;
  const { cssUrls, modulePreloadUrls } = resolvePageAssets(job);

  const DefaultComponent =
    typeof routeModule.default === "function" ? routeModule.default : undefined;
  const Component = (routeModule.Component ?? DefaultComponent) as FunctionComponent | undefined;
  if (!Component) {
    throw new Error("Route has no Component or default export");
  }

  const Shell = job.shellModule?.Shell as FunctionComponent<Record<string, unknown>> | undefined;
  const Comp = Component as FunctionComponent<Record<string, unknown>>;
  const componentProps = { data, params: match.params };

  const componentTree = Shell ? h(Shell, null, h(Comp, componentProps)) : h(Comp, componentProps);

  let tree = h(
    PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
    {
      data,
      params: match.params,
      routeId: match.route.id ?? "",
      routes: ctx.hrefRoutes,
      url: ctx.requestPath,
    },
    componentTree,
  );

  const hydration = match.route.hydration ?? "full";

  // <Script strategy="beforeHydration"> usages captured during the
  // render land in the document head after head() scripts. The capture
  // travels through context (not module state), so concurrent async
  // renders — e.g. parallel SSG prerendering — never attribute scripts
  // to the wrong page.
  const scriptCapture = createScriptCapture(hydration, job.willStream, head.script);
  tree = h(
    ScriptCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
    { value: scriptCapture },
    tree,
  );

  let islandCapture: IslandCapture | null = null;
  if (hydration === "islands") {
    // The capture collector travels through context (not module state),
    // so concurrent async renders — e.g. parallel SSG prerendering —
    // never attribute islands to the wrong page.
    islandCapture = { islands: [] };
    tree = h(
      IslandCaptureContext.Provider as FunctionComponent<Record<string, unknown>>,
      { value: islandCapture },
      tree,
    );
  }

  if (job.willStream) {
    // head/headers are already resolved above and the state script only
    // needs the awaited loader data, so the whole document shape is known
    // before a single component renders.
    const { data: serializedData, pending } = serializeDeferred(data);
    const { prefix, afterShell, suffix } = buildHtmlDocumentParts({
      head: withCapturedScripts(head, scriptCapture),
      body: "",
      hydrationState: {
        url: ctx.requestPath,
        routeId: match.route.id ?? "",
        data: serializedData,
        deferred: pending.map(({ id, path }) => ({ id, path })),
        error: null,
      },
      clientEntryUrl: ctx.options.clientEntryUrl,
      clientEntryAtEnd: true,
      inlineBootstrapScript:
        pending.length > 0
          ? {
              source: DEFER_RUNTIME_SHIM,
              nonce: head.fontNonce,
            }
          : undefined,
      cssUrls,
      // Buffered documents expose the client entry through their script
      // immediately, so the build manifest only lists its dependencies.
      // This script lives at the end of a streamed document; preload the
      // entry itself so deferred work does not also delay its download.
      modulePreloadUrls: ctx.options.clientEntryUrl
        ? [...new Set([ctx.options.clientEntryUrl, ...modulePreloadUrls])]
        : modulePreloadUrls,
      speculationRules: getAppSpeculationRules(ctx.resolvedApp),
    });

    return await streamingHtmlResponse({
      tree,
      prefix,
      afterShell,
      suffix,
      status: pageOptions.status,
      headers: documentHeaders,
      signal: job.routeArgs.signal,
      pending,
      nonce: head.fontNonce,
      exposeErrorDetails: ctx.exposeDiagnostics,
      onError: (error) => {
        // Past the first flush there is no error document to send, so the
        // only remaining job is to make the failure visible server-side.
        ctx.options.onRouteError?.(error, ctx.requestPath, {
          phase: "render",
          routeFile: match.route.file,
          routeId: match.route.id,
          routePath: match.route.path,
          shellFile: match.route.shellFile,
          loaderFile: job.loaderFile,
          middlewareFiles: [...(match.route.middlewareFiles ?? [])],
        });
        console.error("[pracht] streaming render failed after the first flush:", error);
      },
      onCancel: () => {
        job.abortController?.abort(
          new DOMException("The streaming response consumer disconnected.", "AbortError"),
        );
      },
    });
  }

  const renderToString = await getRenderToStringAsync();
  const ssrContent = await renderToString(tree);

  if (hydration !== "full") {
    const islandFiles = [
      ...new Set((islandCapture?.islands ?? []).map((usage) => usage.descriptor.file)),
    ];
    let islandsEntryUrl: string | undefined;
    const needsIslandsBootstrap =
      hydration === "islands" &&
      (islandFiles.length > 0 || ctx.options.islandsBootstrapRequired === true);
    if (needsIslandsBootstrap) {
      islandsEntryUrl = ctx.options.islandsEntryUrl ?? getIslandsClientEntryUrl();
      if (!islandsEntryUrl) {
        throw new Error(
          `Route "${match.route.path}" uses hydration: "islands" and requires the ` +
            `islands bootstrap${islandFiles.length > 0 ? ` for ${islandFiles.length} rendered island(s)` : " for a page-level runtime projection"}, but no bootstrap URL is registered. ` +
            (islandFiles.length > 0
              ? "This usually means the @pracht/vite-plugin islands entry was not built — check that your islands live in the configured islands directory."
              : "This usually means generated page-runtime metadata was not forwarded by the deployment adapter."),
        );
      }
    }

    // Preload only islands that hydrate immediately ("load"). Preloading
    // "visible"/"idle" islands would defeat those strategies' whole
    // point: deferring the network cost until the island is needed.
    const preloadFiles = new Set(
      (islandCapture?.islands ?? [])
        .filter((usage) => usage.strategy === "load")
        .map((usage) => usage.descriptor.file),
    );
    const islandPreloadUrls = new Set<string>();
    if (ctx.options.jsManifest) {
      for (const file of preloadFiles) {
        for (const url of resolveManifestEntries(ctx.options.jsManifest, file) ?? []) {
          islandPreloadUrls.add(url);
        }
      }
    }

    // No hydration state, no client runtime: islands routes ship only the
    // islands bootstrap plus the islands present on the page, and
    // hydration: "none" routes ship no JavaScript at all.
    return htmlResponse(
      buildHtmlDocument({
        head: withCapturedScripts(head, scriptCapture),
        body: ssrContent,
        clientEntryUrl: islandsEntryUrl,
        cssUrls,
        modulePreloadUrls: islandsEntryUrl
          ? mergeEntryPreloadUrls(ctx.options.jsManifest, ISLANDS_ENTRY_MANIFEST_KEY, [
              ...islandPreloadUrls,
            ])
          : [...islandPreloadUrls],
        speculationRules: getAppSpeculationRules(ctx.resolvedApp),
      }),
      pageOptions.status,
      documentHeaders,
    );
  }

  return htmlResponse(
    buildHtmlDocument({
      head: withCapturedScripts(head, scriptCapture),
      body: ssrContent,
      hydrationState: {
        url: ctx.requestPath,
        routeId: match.route.id ?? "",
        data,
        error: null,
      },
      clientEntryUrl: ctx.options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
      speculationRules: getAppSpeculationRules(ctx.resolvedApp),
    }),
    pageOptions.status,
    documentHeaders,
  );
}

/** Loader → representation. The terminal of the page middleware chain. */
async function runPageTerminal<TContext>(job: PageRenderJob<TContext>): Promise<Response> {
  const loaded = await runPageLoader(job);
  if ("response" in loaded) return loaded.response;
  const { data, hasLoader } = loaded;

  if (job.ctx.isRouteStateRequest) {
    return buildRouteStateResponse(job, data);
  }

  const metadata = await resolvePageDocumentMetadata(job, data);
  if ("response" in metadata) return metadata.response;
  const { head, documentHeaders } = metadata;

  return job.match.route.render === "spa"
    ? renderSpaDocument(job, head, documentHeaders, hasLoader)
    : renderServerDocument(job, head, documentHeaders, data);
}

/**
 * Render one page match through the middleware → loader → render pipeline.
 *
 * `inheritedSignal` is passed by the not-found re-render below so a loader that
 * spent 29 of 30 seconds before throwing `notFound()` cannot buy the 404 page a
 * fresh 30 on top.
 */
export async function renderPage<TContext>(
  ctx: PrachtRequestContext<TContext>,
  match: RouteMatch,
  pageOptions: PageRenderOptions,
  inheritedSignal?: AbortSignal,
): Promise<Response> {
  const { options, registry, request } = ctx;
  // One budget per request.
  const willStream =
    match.route.streaming === true &&
    (match.route.render ?? "ssr") === "ssr" &&
    (match.route.hydration ?? "full") === "full" &&
    request.method === "GET" &&
    !ctx.isRouteStateRequest &&
    !prefersMarkdown(request.headers.get("accept"));
  const abortController = willStream ? new AbortController() : undefined;
  const budgetSignal = inheritedSignal ?? composeRequestSignal(request, ctx.loaderTimeoutMs);
  const requestSignal = abortController
    ? combineRequestSignals(budgetSignal, abortController.signal)
    : budgetSignal;
  const pageContext = ctx.context;
  const routeArgs: BaseRouteArgs<TContext> = {
    request,
    params: match.params,
    context: pageContext,
    signal: requestSignal,
    url: ctx.url,
    route: match.route,
    pathname: match.pathname,
  };
  const timings = options.timings;
  const job: PageRenderJob<TContext> = {
    ctx,
    abortController,
    willStream,
    match,
    pageOptions,
    routeArgs,
    routeModulePromise: undefined,
    shellModulePromise: Promise.resolve(undefined),
    dataFunctionsPromise: undefined,
    routeModule: undefined,
    shellModule: undefined,
    loaderFile: undefined,
    phase: "middleware",
  };

  try {
    // Kick off every piece of the pipeline that doesn't depend on the
    // middleware chain's result up front, so they run concurrently with
    // middleware rather than waiting in line:
    //
    //   • route module import                          (needs only match.route.file)
    //   • shell module import                          (needs only match.route.shellFile)
    //   • data-module resolution (separate loader file) (needs routeModule)
    //
    // Only the loader itself still waits for middleware, because it
    // receives the (potentially middleware-mutated) context.
    const routeModulePromise = resolveRegistryModule<RouteModule>(
      registry.routeModules,
      match.route.file,
    );
    job.routeModulePromise = routeModulePromise;

    const shellModulePromise = match.route.shellFile
      ? resolveRegistryModule<ShellModule>(registry.shellModules, match.route.shellFile)
      : Promise.resolve(undefined);
    job.shellModulePromise = shellModulePromise;

    const dataFunctionsPromise = routeModulePromise.then((mod) =>
      resolveDataFunctions(match.route, mod, registry),
    );
    job.dataFunctionsPromise = dataFunctionsPromise;

    // Suppress unhandled-rejection warnings for in-flight promises that we
    // may not reach (e.g. middleware short-circuits with a response). Each
    // promise is still awaited via the original reference below, so real
    // errors still surface through the existing try/catch.
    routeModulePromise.catch(() => {});
    shellModulePromise.catch(() => {});
    dataFunctionsPromise.catch(() => {});

    const pageTerminal = () => runPageTerminal(job);

    // Dev-only instrumentation: wrap the terminal so middleware time can be
    // derived as "chain total minus terminal", and terminal time minus the
    // loader becomes the render phase. Production passes no collector and
    // uses the un-wrapped terminal.
    let terminal = pageTerminal;
    let chainStart = 0;
    if (timings) {
      terminal = async () => {
        const terminalStart = performance.now();
        try {
          return await pageTerminal();
        } finally {
          timings.render = performance.now() - terminalStart - (timings.loader ?? 0);
        }
      };
      chainStart = performance.now();
    }

    const response = await runMiddlewareChain({
      context: pageContext,
      middlewareFiles: match.route.middlewareFiles,
      params: match.params,
      pathname: match.pathname,
      registry,
      request,
      route: match.route,
      signal: requestSignal,
      url: ctx.url,
      terminal,
      onMiddlewareError: () => {
        job.phase = "middleware";
      },
    });
    if (timings) {
      timings.mw = performance.now() - chainStart - (timings.render ?? 0) - (timings.loader ?? 0);
    }
    const normalizedResponse = normalizePageResponse(response, {
      isRouteStateRequest: ctx.isRouteStateRequest,
      loaderCache: match.route.loaderCache,
      markdown: match.route.markdown,
    });
    return await attachFontHeadToRouteStateResponse({
      response: normalizedResponse,
      isRouteStateRequest: ctx.isRouteStateRequest,
      routeArgs,
      routeModule: job.routeModulePromise,
      shellModule: job.shellModulePromise,
    });
  } catch (error: unknown) {
    // An abandoned request is not an application failure: do not report it or
    // spend more work rendering an error nobody can read. A timeout still
    // follows the ordinary error path below.
    if (isClientDisconnect(request, requestSignal)) {
      return new Response(null, { status: 499 });
    }

    // A thrown `Response` is a deliberate short-circuit, not a failure: it is
    // how a loader aborts its own render to redirect (`throw redirect(...)`)
    // or answer directly, which returning cannot express from inside a helper
    // the loader called. Same value either way, so it takes the same path a
    // returned `Response` does.
    //
    // Normalizing here means normalizing *inside* the catch, where a throw
    // has nothing left to catch it and would reject out of
    // `handlePrachtRequest` — an unhandled rejection in the adapter, not a
    // 500. A shared module-scope `Response` with a body delivered twice does
    // exactly that (the second read finds the body disturbed), so failures
    // fall through to the error renderer like any other loader fault.
    let thrownResponseFailure: unknown;
    if (error instanceof Response) {
      try {
        const normalizedResponse = normalizePageResponse(error, {
          isRouteStateRequest: ctx.isRouteStateRequest,
          loaderCache: match.route.loaderCache,
          markdown: match.route.markdown,
        });
        return await attachFontHeadToRouteStateResponse({
          response: normalizedResponse,
          isRouteStateRequest: ctx.isRouteStateRequest,
          routeArgs,
          routeModule: job.routeModulePromise,
          shellModule: job.shellModulePromise,
        });
      } catch (normalizeError: unknown) {
        thrownResponseFailure = normalizeError;
      }
    }

    // A 404 thrown by a loader or middleware (`throw notFound()`) is not a
    // crash — it means "this URL has no content". Render the app-level
    // not-found page for it, unless the route declares its own
    // ErrorBoundary (the more specific handler wins) or we are already
    // rendering the not-found page.
    if (!pageOptions.isNotFoundPage && isNotFoundError(error) && !ctx.isRouteStateRequest) {
      const notFoundMatch = createNotFoundMatch(ctx.resolvedApp, match.pathname);
      if (notFoundMatch) {
        const module = job.routeModule ?? (await job.routeModulePromise?.catch(() => undefined));
        if (!module?.ErrorBoundary) {
          return renderPage(
            ctx,
            notFoundMatch,
            { isNotFoundPage: true, status: 404 },
            requestSignal,
          );
        }
      }
    }

    // Middleware can fail before the terminal assigns routeModule. The import
    // was still started in parallel, so retain route-scoped error metadata
    // (notably fonts used by the route ErrorBoundary) when it resolves.
    job.routeModule ??= await job.routeModulePromise?.catch(() => undefined);
    // A loader or middleware failure can happen before the shell await in
    // the terminal. Resolve the already-started import here so callers know
    // whether the response will be rendered by a route/shell ErrorBoundary
    // instead of having to infer that from mutable response headers.
    job.shellModule ??= await job.shellModulePromise.catch(() => undefined);

    options.onRouteError?.(thrownResponseFailure ?? error, ctx.requestPath, {
      errorBoundary: job.routeModule?.ErrorBoundary
        ? "route"
        : job.shellModule?.ErrorBoundary
          ? "shell"
          : undefined,
      loaderFile: job.loaderFile ?? match.route.loaderFile,
      middlewareFiles: [...(match.route.middlewareFiles ?? [])],
      phase: job.phase,
      routeFile: match.route.file,
      routeId: match.route.id,
      routePath: match.route.path,
      shellFile: match.route.shellFile,
    });

    return renderRouteErrorResponse({
      error: thrownResponseFailure ?? error,
      isRouteStateRequest: ctx.isRouteStateRequest,
      loaderFile: job.loaderFile,
      options,
      phase: job.phase,
      routeArgs,
      routeId: match.route.id ?? "",
      routeModule: job.routeModule,
      routes: ctx.hrefRoutes,
      shellFile: match.route.shellFile,
      shellModule: job.shellModule,
      requestPath: ctx.requestPath,
    });
  }
}

/** The route-state JSON body for a request that matched no route. */
export function routeStateNotFoundResponse(exposeDiagnostics: boolean): Response {
  return jsonErrorResponse(
    createSerializedRouteError("Not found", 404, {
      diagnostics: exposeDiagnostics
        ? buildRuntimeDiagnostics({
            phase: "match",
            status: 404,
          })
        : undefined,
      name: "Error",
    }),
    { isRouteStateRequest: true },
  );
}

/** The route-state JSON body for an unsafe method on a matched route. */
export function routeStateMethodNotAllowedResponse(
  match: RouteMatch,
  exposeDiagnostics: boolean,
): Response {
  return jsonErrorResponse(
    createSerializedRouteError("Method not allowed", 405, {
      diagnostics: exposeDiagnostics
        ? buildRuntimeDiagnostics({
            middlewareFiles: match.route.middlewareFiles,
            phase: "action",
            route: match.route,
            shellFile: match.route.shellFile,
            status: 405,
          })
        : undefined,
      name: "Error",
    }),
    { isRouteStateRequest: true },
  );
}
