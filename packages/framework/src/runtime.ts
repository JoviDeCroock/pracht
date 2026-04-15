import { createContext, h } from "preact";
import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import { matchApiRoute, matchAppRoute } from "./app.ts";
import type {
  ApiRouteArgs,
  ApiRouteModule,
  BaseRouteArgs,
  DataModule,
  HeadMetadata,
  HttpMethod,
  MiddlewareModule,
  ModuleImporter,
  ModuleRegistry,
  ResolvedApiRoute,
  ResolvedRoute,
  RouteModule,
  RouteParams,
  ShellModule,
  PrachtHttpError,
  PrachtApp,
} from "./types.ts";

export type PrachtRuntimeDiagnosticPhase =
  | "match"
  | "middleware"
  | "loader"
  | "action"
  | "render"
  | "api";

export interface PrachtRuntimeDiagnostics {
  phase: PrachtRuntimeDiagnosticPhase;
  routeId?: string;
  routePath?: string;
  routeFile?: string;
  loaderFile?: string;
  shellFile?: string;
  middlewareFiles?: string[];
  status: number;
}

export interface PrachtHydrationState<TData = unknown> {
  url: string;
  routeId: string;
  data: TData;
  error?: SerializedRouteError | null;
  pending?: boolean;
}

export interface SerializedRouteError {
  message: string;
  name: string;
  status: number;
  diagnostics?: PrachtRuntimeDiagnostics;
}

export interface StartAppOptions<TData = unknown> {
  initialData?: TData;
}

export interface HandlePrachtRequestOptions<TContext = unknown> {
  app: PrachtApp;
  request: Request;
  context?: TContext;
  registry?: ModuleRegistry;
  /** Expose raw server error details in rendered HTML and route-state JSON. */
  debugErrors?: boolean;
  clientEntryUrl?: string;
  /** Per-source-file CSS map produced by the vite plugin (preferred over cssUrls). */
  cssManifest?: Record<string, string[]>;
  /** @deprecated Pass cssManifest instead for per-page CSS resolution. */
  cssUrls?: string[];
  /** Per-source-file JS chunk map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  apiRoutes?: ResolvedApiRoute[];
}

export interface FormProps extends Omit<JSX.HTMLAttributes<HTMLFormElement>, "action" | "method"> {
  action?: string;
  method?: string;
}

declare global {
  interface Window {
    __PRACHT_STATE__?: PrachtHydrationState;
    __PRACHT_NAVIGATE__?: (to: string, options?: { replace?: boolean }) => Promise<void>;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
const ROUTE_STATE_CACHE_CONTROL = "no-store";
const EMPTY_ROUTE_PARAMS = {} as RouteParams;

// Cached dynamic import — keeps preact-render-to-string out of the client bundle
// while avoiding repeated async resolution on each SSR request.
let _renderToStringAsync: typeof import("preact-render-to-string").renderToStringAsync | undefined;
async function getRenderToStringAsync() {
  if (_renderToStringAsync) return _renderToStringAsync;
  const mod = await import("preact-render-to-string");
  _renderToStringAsync = mod.renderToStringAsync;
  return _renderToStringAsync;
}

type DiagnosticRoute = ResolvedRoute | ResolvedApiRoute;

interface PrachtRuntimeValue {
  data: unknown;
  params: RouteParams;
  routeId: string;
  url: string;
  setData: (data: unknown) => void;
}

const RouteDataContext = createContext<PrachtRuntimeValue | undefined>(undefined);

export function PrachtRuntimeProvider<TData>({
  children,
  data,
  params = EMPTY_ROUTE_PARAMS,
  routeId,
  stateVersion = 0,
  url,
}: {
  children: ComponentChildren;
  data: TData;
  params?: RouteParams;
  routeId: string;
  stateVersion?: number;
  url: string;
}) {
  // TODO: make signal with getter to reduce
  // re-renders caused by the framework itself.
  const [routeDataState, setRouteDataState] = useState({
    data,
    stateVersion,
  });
  const routeData = routeDataState.stateVersion === stateVersion ? routeDataState.data : data;

  useEffect(() => {
    setRouteDataState({
      data,
      stateVersion,
    });
  }, [data, routeId, stateVersion, url]);

  const context = useMemo(
    () => ({
      data: routeData,
      params,
      routeId,
      setData: (nextData: unknown) =>
        setRouteDataState({
          data: nextData as TData,
          stateVersion,
        }),
      url,
    }),
    [routeData, params, routeId, stateVersion, url],
  );

  return h(RouteDataContext.Provider, {
    value: context,
    children,
  });
}

export function startApp<TData = unknown>(options: StartAppOptions<TData> = {}): TData | undefined {
  if (typeof window === "undefined") {
    return options.initialData;
  }

  if (typeof options.initialData !== "undefined") {
    return options.initialData;
  }

  return readHydrationState<TData>()?.data;
}

export function readHydrationState<TData = unknown>(): PrachtHydrationState<TData> | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (window.__PRACHT_STATE__) {
    return window.__PRACHT_STATE__ as PrachtHydrationState<TData>;
  }

  const element = document.getElementById(HYDRATION_STATE_ELEMENT_ID);
  if (!(element instanceof HTMLScriptElement)) {
    return undefined;
  }

  const raw = element.textContent;
  if (!raw) {
    return undefined;
  }

  try {
    const state = JSON.parse(raw) as PrachtHydrationState<TData>;
    window.__PRACHT_STATE__ = state as PrachtHydrationState;
    return state;
  } catch {
    return undefined;
  }
}

export function useRouteData<TData = unknown>(): TData {
  return useContext(RouteDataContext)?.data as TData;
}

export interface Location {
  pathname: string;
  search: string;
}

export function useLocation(): Location {
  const url =
    useContext(RouteDataContext)?.url ??
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  return parseLocation(url);
}

export function useParams(): RouteParams {
  return useContext(RouteDataContext)?.params ?? {};
}

export function useRevalidate() {
  const runtime = useContext(RouteDataContext);

  return async () => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const path = runtime?.url || window.location.pathname + window.location.search;
    const result = await fetchPrachtRouteState(path);

    if (result.type === "redirect") {
      await navigateToClientLocation(result.location);
      return undefined;
    }

    if (result.type === "error") {
      throw deserializeRouteError(result.error);
    }

    runtime?.setData(result.data);
    return result.data;
  };
}

/** @deprecated Use useRevalidate instead. */
export const useRevalidateRoute = useRevalidate;

export function Form(props: FormProps) {
  const { onSubmit, method, ...rest } = props;

  return h("form", {
    ...rest,
    method,
    onSubmit: async (event: Event) => {
      onSubmit?.(event as never);
      if (event.defaultPrevented) {
        return;
      }

      const form = event.currentTarget;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }

      const formMethod = (method ?? form.method ?? "post").toUpperCase();
      if (SAFE_METHODS.has(formMethod)) {
        return;
      }

      event.preventDefault();
      const response = await fetch(props.action ?? form.action, {
        method: formMethod,
        body: new FormData(form),
        redirect: "manual",
      });

      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        const location = response.headers.get("location");
        if (location) {
          await navigateToClientLocation(location);
          return;
        }
        window.location.href = props.action ?? form.action;
      }
    },
  } as JSX.HTMLAttributes<HTMLFormElement>);
}

export type RouteStateResult =
  | { type: "data"; data: unknown }
  | { type: "redirect"; location: string }
  | { type: "error"; error: SerializedRouteError };

export async function fetchPrachtRouteState(url: string): Promise<RouteStateResult> {
  const response = await fetch(url, {
    headers: { [ROUTE_STATE_REQUEST_HEADER]: "1", "Cache-Control": "no-cache" },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    return {
      location: location ?? url,
      type: "redirect",
    };
  }

  const json = (await response.json()) as {
    data?: unknown;
    error?: SerializedRouteError;
    redirect?: string;
  };
  if (json.redirect) {
    return {
      location: json.redirect,
      type: "redirect",
    };
  }

  if (!response.ok) {
    if (json.error) {
      return {
        error: json.error,
        type: "error",
      };
    }

    throw new Error(`Failed to fetch route state (${response.status})`);
  }

  return {
    data: json.data,
    type: "data",
  };
}

export async function handlePrachtRequest<TContext>(
  options: HandlePrachtRequestOptions<TContext>,
): Promise<Response> {
  const url = new URL(options.request.url);
  const requestPath = getRequestPath(url);
  const registry = options.registry ?? {};
  const isRouteStateRequest = options.request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1";
  const exposeDiagnostics = shouldExposeServerErrors(options);

  // --- API route dispatch (before page routes) ---
  if (options.apiRoutes?.length) {
    const apiMatch = matchApiRoute(options.apiRoutes, url.pathname);
    if (apiMatch) {
      const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
        const middlewareFile = options.app.middleware[name];
        return middlewareFile ? [middlewareFile] : [];
      });
      let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

      try {
        const middlewareResult = await runMiddlewareChain({
          context: (options.context ?? {}) as TContext,
          middlewareFiles: apiMiddlewareFiles,
          params: apiMatch.params,
          registry,
          request: options.request,
          route: apiMatch.route,
          url,
        });
        if (middlewareResult.response) {
          return middlewareResult.response;
        }

        currentPhase = "api";
        const apiModule = await resolveRegistryModule<ApiRouteModule>(
          registry.apiModules,
          apiMatch.route.file,
        );

        if (!apiModule) {
          throw new Error("API route module not found");
        }

        const method = options.request.method.toUpperCase() as HttpMethod;
        const handler = apiModule[method] ?? apiModule.default;

        if (!handler) {
          return withDefaultSecurityHeaders(
            new Response("Method not allowed", {
              status: 405,
              headers: { "content-type": "text/plain; charset=utf-8" },
            }),
          );
        }

        const apiRouteArgs: ApiRouteArgs<TContext> = {
          request: options.request,
          params: apiMatch.params,
          context: middlewareResult.context,
          signal: AbortSignal.timeout(30_000),
          url,
          route: apiMatch.route as any,
        };

        return withDefaultSecurityHeaders(await handler(apiRouteArgs));
      } catch (error: unknown) {
        return renderApiErrorResponse({
          error,
          middlewareFiles: apiMiddlewareFiles,
          options,
          phase: currentPhase,
          route: apiMatch.route,
        });
      }
    }
  }

  const match = matchAppRoute(options.app, url.pathname);

  if (!match) {
    if (isRouteStateRequest) {
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

    return withDefaultSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (!SAFE_METHODS.has(options.request.method)) {
    if (isRouteStateRequest) {
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

    return withRouteResponseHeaders(
      new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      { isRouteStateRequest },
    );
  }

  let routeArgs: BaseRouteArgs<TContext> = {
    request: options.request,
    params: match.params,
    context: (options.context ?? {}) as TContext,
    signal: AbortSignal.timeout(30_000),
    url,
    route: match.route,
  };
  let routeModule: RouteModule | undefined;
  let shellModule: ShellModule | undefined;
  let loaderFile: string | undefined;
  let currentPhase: PrachtRuntimeDiagnosticPhase = "middleware";

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
    // receives the merged context. This removes one serial await from
    // every request (typically the shell module load after the loader).
    const middlewarePromise = runMiddlewareChain({
      context: routeArgs.context,
      middlewareFiles: match.route.middlewareFiles,
      params: match.params,
      registry,
      request: options.request,
      route: match.route,
      url,
    });

    const routeModulePromise = resolveRegistryModule<RouteModule>(
      registry.routeModules,
      match.route.file,
    );

    const shellModulePromise: Promise<ShellModule | undefined> = match.route.shellFile
      ? resolveRegistryModule<ShellModule>(registry.shellModules, match.route.shellFile)
      : Promise.resolve(undefined);

    const dataFunctionsPromise = routeModulePromise.then((mod) =>
      resolveDataFunctions(match.route, mod, registry),
    );

    // Suppress unhandled-rejection warnings for in-flight promises that we
    // may not reach (e.g. middleware short-circuits with a response). Each
    // promise is still awaited via the original reference below, so real
    // errors still surface through the existing try/catch.
    routeModulePromise.catch(() => {});
    shellModulePromise.catch(() => {});
    dataFunctionsPromise.catch(() => {});

    // --- Middleware chain ---
    const middlewareResult = await middlewarePromise;
    if (middlewareResult.response) {
      return normalizePageResponse(middlewareResult.response, { isRouteStateRequest });
    }

    routeArgs = {
      ...routeArgs,
      context: middlewareResult.context,
    };

    // --- Load route module ---
    currentPhase = "render";
    routeModule = await routeModulePromise;
    if (!routeModule) {
      throw new Error("Route module not found");
    }

    // --- Resolve loader from separate data module or route module ---
    currentPhase = "loader";
    const { loader, loaderFile: resolvedLoaderFile } = await dataFunctionsPromise;
    loaderFile = resolvedLoaderFile;

    // --- Execute loader ---
    const loaderResult = loader ? await loader(routeArgs) : undefined;

    // Allow loaders to return a Response directly (e.g. for redirects)
    if (loaderResult instanceof Response) {
      return normalizePageResponse(loaderResult, { isRouteStateRequest });
    }

    const data = loaderResult;

    // --- Route state request (client navigation): return JSON ---
    if (isRouteStateRequest) {
      return withRouteResponseHeaders(Response.json({ data }), { isRouteStateRequest: true });
    }

    // --- Load shell module ---
    // Shell import was kicked off up front; this await is usually already
    // resolved by the time we get here (it runs in parallel with the loader).
    currentPhase = "render";
    shellModule = await shellModulePromise;

    // --- Merge document metadata ---
    // head and document headers are independent; run them concurrently.
    const [head, documentHeaders] = await Promise.all([
      mergeHeadMetadata(shellModule, routeModule, routeArgs, data),
      mergeDocumentHeaders(shellModule, routeModule, routeArgs, data),
    ]);

    const cssUrls = resolvePageCssUrls(options, match.route.shellFile, match.route.file);
    const modulePreloadUrls = resolvePageJsUrls(options, match.route.shellFile, match.route.file);

    // --- SPA mode: render shell chrome / loading state, but keep route component client-only ---
    if (match.route.render === "spa") {
      let body = "";

      if (shellModule?.Shell || shellModule?.Loading) {
        const Shell = shellModule?.Shell as any;
        const Loading = shellModule?.Loading as any;
        const loadingTree =
          Shell != null
            ? h(Shell, null, Loading ? h(Loading, null) : null)
            : Loading
              ? h(Loading, null)
              : null;

        if (loadingTree) {
          const renderFn = await getRenderToStringAsync();
          body = await renderFn(loadingTree);
        }
      }

      return htmlResponse(
        buildHtmlDocument({
          head,
          body,
          hydrationState: {
            url: requestPath,
            routeId: match.route.id ?? "",
            data: null,
            error: null,
            pending: true,
          },
          clientEntryUrl: options.clientEntryUrl,
          cssUrls,
          modulePreloadUrls,
        }),
        200,
        documentHeaders,
      );
    }

    // --- SSR / SSG / ISG: render Preact tree to string ---
    const DefaultComponent =
      typeof routeModule.default === "function" ? routeModule.default : undefined;
    const Component = (routeModule.Component ?? DefaultComponent) as any;
    if (!Component) {
      throw new Error("Route has no Component or default export");
    }

    const Shell = shellModule?.Shell;
    const componentProps = { data, params: match.params };

    const componentTree = Shell
      ? h(Shell, null, h(Component, componentProps))
      : h(Component, componentProps);

    const tree = h(
      PrachtRuntimeProvider as any,
      {
        data,
        params: match.params,
        routeId: match.route.id ?? "",
        url: requestPath,
      },
      componentTree,
    );
    const renderToString = await getRenderToStringAsync();
    const ssrContent = await renderToString(tree);

    return htmlResponse(
      buildHtmlDocument({
        head,
        body: ssrContent,
        hydrationState: {
          url: requestPath,
          routeId: match.route.id ?? "",
          data,
          error: null,
        },
        clientEntryUrl: options.clientEntryUrl,
        cssUrls,
        modulePreloadUrls,
      }),
      200,
      documentHeaders,
    );
  } catch (error: unknown) {
    return renderRouteErrorResponse({
      error,
      isRouteStateRequest,
      loaderFile,
      options,
      phase: currentPhase,
      routeArgs,
      routeId: match.route.id ?? "",
      routeModule,
      shellFile: match.route.shellFile,
      shellModule,
      requestPath,
    });
  }
}

function parseLocation(value: string): Location {
  try {
    const url = new URL(value, "http://pracht.local");
    return {
      pathname: url.pathname,
      search: url.search,
    };
  } catch {
    return {
      pathname: value || "/",
      search: "",
    };
  }
}

function getRequestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strip leading `./` and `/` so all module paths share one canonical form. */
function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

function buildSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(manifest)) {
    const normalized = normalizeModulePath(key);
    if (!normalized) continue;

    if (!index.has(normalized)) {
      index.set(normalized, key);
    }

    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {
      const suffix = normalized.slice(i + 1);
      if (suffix && !index.has(suffix)) {
        index.set(suffix, key);
      }
    }
  }
  return index;
}

const suffixIndexCache = new WeakMap<object, Map<string, string>>();

function getSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  let index = suffixIndexCache.get(manifest);
  if (index) return index;
  index = buildSuffixIndex(manifest);
  suffixIndexCache.set(manifest, index);
  return index;
}

function resolveManifestEntries(
  manifest: Record<string, string[]>,
  file: string,
): string[] | undefined {
  if (file in manifest) return manifest[file];

  const resolved = getSuffixIndex(manifest).get(normalizeModulePath(file));
  if (resolved) return manifest[resolved];
  return undefined;
}

function resolvePageCssUrls(
  options: HandlePrachtRequestOptions<unknown>,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!options.cssManifest) return options.cssUrls ?? [];

  const css = new Set<string>();

  function addFromManifest(file: string): void {
    const entries = resolveManifestEntries(options.cssManifest!, file);
    if (entries) {
      for (const c of entries) css.add(c);
    }
  }

  if (shellFile) addFromManifest(shellFile);
  addFromManifest(routeFile);
  return [...css];
}

function resolvePageJsUrls(
  options: HandlePrachtRequestOptions<unknown>,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!options.jsManifest) return [];

  const js = new Set<string>();

  function addFromManifest(file: string): void {
    const entries = resolveManifestEntries(options.jsManifest!, file);
    if (entries) {
      for (const j of entries) js.add(j);
    }
  }

  if (shellFile) addFromManifest(shellFile);
  addFromManifest(routeFile);
  return [...js];
}

async function navigateToClientLocation(
  location: string,
  options?: { replace?: boolean },
): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const targetUrl = new URL(location, window.location.href);
  const target = targetUrl.pathname + targetUrl.search + targetUrl.hash;
  if (targetUrl.origin === window.location.origin && window.__PRACHT_NAVIGATE__) {
    await window.__PRACHT_NAVIGATE__(target, options);
    return;
  }

  if (options?.replace) {
    window.location.replace(targetUrl.toString());
    return;
  }

  window.location.href = targetUrl.toString();
}

function isPrachtHttpError(error: unknown): error is PrachtHttpError {
  return error instanceof Error && error.name === "PrachtHttpError" && "status" in error;
}

function shouldExposeServerErrors(options: HandlePrachtRequestOptions<unknown>): boolean {
  return options.debugErrors === true;
}

function createSerializedRouteError(
  message: string,
  status: number,
  options: {
    diagnostics?: PrachtRuntimeDiagnostics;
    name?: string;
  } = {},
): SerializedRouteError {
  return {
    message,
    name: options.name ?? "Error",
    status,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  };
}

function buildRuntimeDiagnostics(options: {
  middlewareFiles?: string[];
  phase: PrachtRuntimeDiagnosticPhase;
  route?: DiagnosticRoute;
  loaderFile?: string;
  shellFile?: string;
  status: number;
}): PrachtRuntimeDiagnostics {
  const route = options.route;
  const routeId = route && "id" in route ? route.id : undefined;

  return {
    phase: options.phase,
    routeId,
    routePath: route?.path,
    routeFile: route?.file,
    loaderFile: options.loaderFile,
    shellFile: options.shellFile,
    middlewareFiles: options.middlewareFiles ? [...options.middlewareFiles] : [],
    status: options.status,
  };
}

function normalizeRouteError(
  error: unknown,
  options: { exposeDetails: boolean },
): SerializedRouteError {
  if (isPrachtHttpError(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    if (status >= 400 && status < 500) {
      return {
        message: error.message,
        name: error.name,
        status,
      };
    }

    if (options.exposeDetails) {
      return {
        message: error.message || "Internal Server Error",
        name: error.name || "Error",
        status,
      };
    }

    return {
      message: "Internal Server Error",
      name: "Error",
      status,
    };
  }

  if (error instanceof Error) {
    if (options.exposeDetails) {
      return {
        message: error.message || "Internal Server Error",
        name: error.name || "Error",
        status: 500,
      };
    }

    return {
      message: "Internal Server Error",
      name: "Error",
      status: 500,
    };
  }

  if (options.exposeDetails) {
    return {
      message: typeof error === "string" && error ? error : "Internal Server Error",
      name: "Error",
      status: 500,
    };
  }

  return {
    message: "Internal Server Error",
    name: "Error",
    status: 500,
  };
}

function deserializeRouteError(error: SerializedRouteError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  (result as Error & { diagnostics?: PrachtRuntimeDiagnostics; status?: number }).status =
    error.status;
  (result as Error & { diagnostics?: PrachtRuntimeDiagnostics; status?: number }).diagnostics =
    error.diagnostics;
  return result;
}

function jsonErrorResponse(
  routeError: SerializedRouteError,
  options: { isRouteStateRequest: boolean },
): Response {
  const headers = applySecurityAndRouteHeaders(
    new Headers({ "content-type": "application/json; charset=utf-8" }),
    options.isRouteStateRequest ? { isRouteStateRequest: true } : undefined,
  );
  return new Response(JSON.stringify({ error: routeError }), {
    status: routeError.status,
    headers,
  });
}

function jsonRedirectResponse(
  location: string,
  options: { headers?: HeadersInit; isRouteStateRequest: boolean },
): Response {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  const response = new Response(JSON.stringify({ redirect: location }), {
    status: 200,
    headers,
  });
  return withRouteResponseHeaders(response, { isRouteStateRequest: options.isRouteStateRequest });
}

function normalizePageResponse(
  response: Response,
  options: { isRouteStateRequest: boolean },
): Response {
  if (options.isRouteStateRequest && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      return jsonRedirectResponse(location, {
        headers: response.headers,
        isRouteStateRequest: true,
      });
    }
  }

  return withRouteResponseHeaders(response, options);
}

function renderApiErrorResponse<TContext>(options: {
  error: unknown;
  middlewareFiles: string[];
  options: HandlePrachtRequestOptions<TContext>;
  phase: PrachtRuntimeDiagnosticPhase;
  route: ResolvedApiRoute;
}): Response {
  const exposeDetails = shouldExposeServerErrors(options.options);
  const routeError = normalizeRouteError(options.error, {
    exposeDetails,
  });
  const routeErrorWithDiagnostics = exposeDetails
    ? {
        ...routeError,
        diagnostics: buildRuntimeDiagnostics({
          middlewareFiles: options.middlewareFiles,
          phase: options.phase,
          route: options.route,
          status: routeError.status,
        }),
      }
    : routeError;

  if (exposeDetails) {
    return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: false });
  }

  const message =
    routeErrorWithDiagnostics.status >= 500
      ? "Internal Server Error"
      : routeErrorWithDiagnostics.message;
  return withDefaultSecurityHeaders(
    new Response(message, {
      status: routeErrorWithDiagnostics.status,
      headers: { "content-type": "text/plain; charset=utf-8" },
    }),
  );
}

async function renderRouteErrorResponse<TContext>(options: {
  error: unknown;
  isRouteStateRequest: boolean;
  loaderFile: string | undefined;
  options: HandlePrachtRequestOptions<TContext>;
  phase: PrachtRuntimeDiagnosticPhase;
  routeArgs: BaseRouteArgs<TContext>;
  routeId: string;
  routeModule: RouteModule | undefined;
  shellFile: string | undefined;
  shellModule: ShellModule | undefined;
  requestPath: string;
}): Promise<Response> {
  const exposeDetails = shouldExposeServerErrors(options.options);
  const routeError = normalizeRouteError(options.error, {
    exposeDetails,
  });
  const routeErrorWithDiagnostics = exposeDetails
    ? {
        ...routeError,
        diagnostics: buildRuntimeDiagnostics({
          loaderFile: options.loaderFile,
          middlewareFiles: options.routeArgs.route.middlewareFiles,
          phase: options.phase,
          route: options.routeArgs.route,
          shellFile: options.shellFile,
          status: routeError.status,
        }),
      }
    : routeError;

  if (!options.routeModule?.ErrorBoundary) {
    if (options.isRouteStateRequest) {
      return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: true });
    }

    const message =
      routeErrorWithDiagnostics.status >= 500
        ? "Internal Server Error"
        : routeErrorWithDiagnostics.message;
    return withDefaultSecurityHeaders(
      new Response(message, {
        status: routeErrorWithDiagnostics.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (options.isRouteStateRequest) {
    return jsonErrorResponse(routeErrorWithDiagnostics, { isRouteStateRequest: true });
  }

  const shellModule =
    options.shellModule ??
    (options.shellFile
      ? await resolveRegistryModule<ShellModule>(
          options.options.registry?.shellModules,
          options.shellFile,
        )
      : undefined);
  const head = shellModule?.head ? await shellModule.head(options.routeArgs) : {};
  const documentHeaders = await mergeDocumentHeaders(
    shellModule,
    undefined,
    options.routeArgs,
    undefined,
  );
  const cssUrls = resolvePageCssUrls(
    options.options,
    options.shellFile,
    options.routeArgs.route.file,
  );
  const modulePreloadUrls = resolvePageJsUrls(
    options.options,
    options.shellFile,
    options.routeArgs.route.file,
  );
  const renderToString = await getRenderToStringAsync();

  const ErrorBoundary = options.routeModule.ErrorBoundary as any;
  const Shell = shellModule?.Shell;
  const errorValue = deserializeRouteError(routeErrorWithDiagnostics);
  const componentTree = Shell
    ? h(Shell, null, h(ErrorBoundary, { error: errorValue }))
    : h(ErrorBoundary, { error: errorValue });
  const tree = h(
    PrachtRuntimeProvider as any,
    {
      data: null,
      routeId: options.routeId,
      url: options.requestPath,
    },
    componentTree,
  );
  const body = await renderToString(tree);

  return htmlResponse(
    buildHtmlDocument({
      head,
      body,
      hydrationState: {
        url: options.requestPath,
        routeId: options.routeId,
        data: null,
        error: routeErrorWithDiagnostics,
      },
      clientEntryUrl: options.options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
    }),
    routeErrorWithDiagnostics.status,
    documentHeaders,
  );
}

async function runMiddlewareChain<TContext>(options: {
  context: TContext;
  middlewareFiles: string[];
  params: Record<string, string>;
  registry: ModuleRegistry;
  request: Request;
  route: BaseRouteArgs<TContext>["route"] | ResolvedApiRoute;
  url: URL;
}): Promise<
  { context: TContext; response?: undefined } | { response: Response; context?: undefined }
> {
  let context = options.context;

  // Kick off module resolution for every middleware in parallel. Execution
  // below still runs sequentially — middleware may mutate context and the
  // ordering is part of the public contract — but the imports themselves
  // have no inter-dependency, so waiting for them one-by-one is pure
  // latency for no benefit. On cold starts where middleware ships as its
  // own chunks this can meaningfully reduce TTFB.
  const modulePromises = options.middlewareFiles.map((mwFile) =>
    resolveRegistryModule<MiddlewareModule>(options.registry.middlewareModules, mwFile),
  );
  // Suppress unhandled-rejection warnings for promises that may not be
  // awaited if an earlier middleware short-circuits with a response.
  for (const p of modulePromises) {
    p.catch(() => {});
  }

  for (const modulePromise of modulePromises) {
    const mwModule = await modulePromise;
    if (!mwModule?.middleware) continue;

    const result = await mwModule.middleware({
      request: options.request,
      params: options.params,
      context,
      signal: AbortSignal.timeout(30_000),
      url: options.url,
      route: options.route as BaseRouteArgs<TContext>["route"],
    });

    if (!result) continue;
    if (result instanceof Response) {
      return { response: withDefaultSecurityHeaders(result) };
    }
    if ("redirect" in result) {
      return {
        response: withDefaultSecurityHeaders(
          new Response(null, {
            status: 302,
            headers: { location: result.redirect },
          }),
        ),
      };
    }
    if ("context" in result) {
      context = { ...context, ...result.context } as TContext;
    }
  }

  return { context };
}

async function resolveDataFunctions(
  route: ResolvedRoute,
  routeModule: RouteModule | undefined,
  registry: ModuleRegistry,
): Promise<{ loader: RouteModule["loader"]; loaderFile?: string }> {
  let loader = routeModule?.loader;
  let loaderFile = routeModule?.loader ? route.file : undefined;

  if (route.loaderFile) {
    const dataModule = await resolveRegistryModule<DataModule>(
      registry.dataModules,
      route.loaderFile,
    );
    if (dataModule?.loader) {
      loader = dataModule.loader;
      loaderFile = route.loaderFile;
    }
  }

  return { loader, loaderFile };
}

async function resolveRegistryModule<T>(
  modules: Record<string, ModuleImporter> | undefined,
  file: string,
): Promise<T | undefined> {
  if (!modules) return undefined;

  // Direct key match (fast path)
  if (file in modules) {
    return modules[file]() as Promise<T>;
  }

  // Indexed suffix match
  const resolved = getSuffixIndex(modules).get(normalizeModulePath(file));
  if (resolved) {
    return modules[resolved]() as Promise<T>;
  }

  return undefined;
}

async function mergeHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<HeadMetadata> {
  // Shell and route `head` exports are independent — run them concurrently.
  // Merge order (shell first, then route) is preserved below.
  const [shellHead, routeHead] = await Promise.all([
    shellModule?.head ? shellModule.head(routeArgs) : Promise.resolve({} as HeadMetadata),
    routeModule?.head
      ? routeModule.head({ ...routeArgs, data } as any)
      : Promise.resolve({} as HeadMetadata),
  ]);

  return {
    title: routeHead.title ?? shellHead.title,
    lang: routeHead.lang ?? shellHead.lang,
    meta: [...(shellHead.meta ?? []), ...(routeHead.meta ?? [])],
    link: [...(shellHead.link ?? []), ...(routeHead.link ?? [])],
  };
}

async function mergeDocumentHeaders(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<Headers> {
  const headers = new Headers();
  // Shell and route `headers` exports are independent — run concurrently.
  // Apply order (shell first, then route) still gives route precedence.
  const [shellHeaders, routeHeaders] = await Promise.all([
    shellModule?.headers ? shellModule.headers(routeArgs) : Promise.resolve(undefined),
    routeModule?.headers
      ? routeModule.headers({ ...routeArgs, data } as any)
      : Promise.resolve(undefined),
  ]);
  if (shellHeaders) {
    applyHeaders(headers, shellHeaders);
  }
  if (routeHeaders) {
    applyHeaders(headers, routeHeaders);
  }

  return headers;
}

function applyHeaders(headers: Headers, init: HeadersInit): void {
  new Headers(init).forEach((value, key) => {
    headers.set(key, value);
  });
}

function buildHtmlDocument(options: {
  head: HeadMetadata;
  body: string;
  hydrationState: PrachtHydrationState;
  clientEntryUrl?: string;
  cssUrls?: string[];
  modulePreloadUrls?: string[];
}): string {
  const {
    head,
    body,
    hydrationState,
    clientEntryUrl,
    cssUrls = [],
    modulePreloadUrls = [],
  } = options;

  const titleTag = head.title ? `<title>${escapeHtml(head.title)}</title>` : "";

  const metaTags = (head.meta ?? [])
    .map(
      (m) =>
        `<meta ${Object.entries(m)
          .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
          .join(" ")}>`,
    )
    .join("\n    ");

  const linkTags = (head.link ?? [])
    .map(
      (l) =>
        `<link ${Object.entries(l)
          .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
          .join(" ")}>`,
    )
    .join("\n    ");

  const cssTags = cssUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">`)
    .join("\n    ");

  const modulePreloadTags = modulePreloadUrls
    .map((url) => `<link rel="modulepreload" href="${escapeHtml(url)}">`)
    .join("\n    ");

  const stateScript = `<script id="${HYDRATION_STATE_ELEMENT_ID}" type="application/json">${serializeJsonForHtml(hydrationState)}</script>`;
  const entryScript = clientEntryUrl
    ? `<script type="module" src="${escapeHtml(clientEntryUrl)}"></script>`
    : "";

  return `<!DOCTYPE html>
<html${head.lang ? ` lang="${escapeHtml(head.lang)}"` : ""}>
  <head>
    <meta charset="utf-8">
    ${titleTag}
    ${metaTags}
    ${linkTags}
    ${cssTags}
    ${modulePreloadTags}
  </head>
  <body>
    <div id="pracht-root">${body}</div>
    ${stateScript}
    ${entryScript}
  </body>
</html>`;
}

function htmlResponse(html: string, status = 200, initHeaders?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  if (initHeaders) {
    applyHeaders(headers, initHeaders);
  }
  applySecurityAndRouteHeaders(headers, { isRouteStateRequest: false });
  return new Response(html, { status, headers });
}

export function applyDefaultSecurityHeaders(headers: Headers): Headers {
  if (!headers.has("permissions-policy")) {
    headers.set(
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  }

  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }

  if (!headers.has("x-content-type-options")) {
    headers.set("x-content-type-options", "nosniff");
  }

  if (!headers.has("x-frame-options")) {
    headers.set("x-frame-options", "SAMEORIGIN");
  }

  return headers;
}

function applySecurityAndRouteHeaders(
  headers: Headers,
  options?: { isRouteStateRequest: boolean },
): Headers {
  applyDefaultSecurityHeaders(headers);
  if (options) {
    appendVaryHeader(headers, ROUTE_STATE_REQUEST_HEADER);
    if (options.isRouteStateRequest && !headers.has("cache-control")) {
      headers.set("cache-control", ROUTE_STATE_CACHE_CONTROL);
    }
  }
  return headers;
}

function withDefaultSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withRouteResponseHeaders(
  response: Response,
  options: { isRouteStateRequest: boolean },
): Response {
  const headers = new Headers(response.headers);
  applySecurityAndRouteHeaders(headers, options);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendVaryHeader(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }

  const values = current
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes("*") || values.includes(value.toLowerCase())) {
    return;
  }

  headers.set("vary", `${current}, ${value}`);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// ---------------------------------------------------------------------------
// SSG Prerendering
// ---------------------------------------------------------------------------

export interface PrerenderResult {
  path: string;
  html: string;
  headers?: Record<string, string>;
}

export interface ISGManifestEntry {
  revalidate: import("./types.ts").RouteRevalidate;
}

export interface PrerenderAppResult {
  pages: PrerenderResult[];
  isgManifest: Record<string, ISGManifestEntry>;
}

export interface PrerenderAppOptions {
  app: PrachtApp;
  registry?: ModuleRegistry;
  clientEntryUrl?: string;
  /** Per-source-file CSS map produced by the vite plugin (preferred over cssUrls). */
  cssManifest?: Record<string, string[]>;
  /** Per-source-file JS map produced by the vite plugin for modulepreload hints. */
  jsManifest?: Record<string, string[]>;
  /** @deprecated Pass cssManifest instead for per-page CSS resolution. */
  cssUrls?: string[];
}

export async function prerenderApp(options: PrerenderAppOptions): Promise<PrerenderResult[]>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest: true },
): Promise<PrerenderAppResult>;
export async function prerenderApp(
  options: PrerenderAppOptions & { withISGManifest?: boolean },
): Promise<PrerenderResult[] | PrerenderAppResult> {
  const { resolveApp } = await import("./app.ts");
  const resolved = resolveApp(options.app);
  const results: PrerenderResult[] = [];
  const isgManifest: Record<string, ISGManifestEntry> = {};

  // Collect all work items first, then render in parallel batches
  const work: {
    pathname: string;
    render: string;
    revalidate?: import("./types.ts").RouteRevalidate;
  }[] = [];
  for (const route of resolved.routes) {
    if (route.render !== "ssg" && route.render !== "isg") continue;
    const paths = await collectSSGPaths(route, options.registry);
    for (const pathname of paths) {
      work.push({ pathname, render: route.render, revalidate: route.revalidate });
    }
  }

  const CONCURRENCY = 10;
  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        const url = new URL(item.pathname, "http://localhost");
        const request = new Request(url, { method: "GET" });

        const response = await handlePrachtRequest({
          app: options.app,
          request,
          registry: options.registry,
          clientEntryUrl: options.clientEntryUrl,
          cssManifest: options.cssManifest,
          jsManifest: options.jsManifest,
        });

        if (response.status !== 200) {
          console.warn(
            `  Warning: ${item.render.toUpperCase()} route "${item.pathname}" returned status ${response.status}, skipping.`,
          );
          return null;
        }

        const html = await response.text();
        return { headers: Object.fromEntries(response.headers), html, item };
      }),
    );

    for (const result of batchResults) {
      if (!result) continue;
      results.push({
        path: result.item.pathname,
        html: result.html,
        headers: result.headers,
      });
      if (result.item.render === "isg" && result.item.revalidate) {
        isgManifest[result.item.pathname] = { revalidate: result.item.revalidate };
      }
    }
  }

  if (options.withISGManifest) {
    return { pages: results, isgManifest };
  }

  return results;
}

async function collectSSGPaths(
  route: import("./types.ts").ResolvedRoute,
  registry?: ModuleRegistry,
): Promise<string[]> {
  const hasDynamicSegments = route.segments.some(
    (s) => s.type === "param" || s.type === "catchall",
  );

  if (!hasDynamicSegments) {
    return [route.path];
  }

  // Dynamic route — must export getStaticPaths() to enumerate params
  const routeModule = await resolveRegistryModule<RouteModule>(registry?.routeModules, route.file);

  if (!routeModule?.getStaticPaths) {
    console.warn(
      `  Warning: SSG route "${route.path}" has dynamic segments but no getStaticPaths() export, skipping.`,
    );
    return [];
  }

  const { buildPathFromSegments } = await import("./app.ts");
  const paramSets = await routeModule.getStaticPaths();
  return paramSets.map((params) => buildPathFromSegments(route.segments, params));
}
