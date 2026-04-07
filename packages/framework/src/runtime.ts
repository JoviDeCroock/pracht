import { createContext, h } from "preact";
import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import { matchApiRoute, matchAppRoute } from "./app.ts";
import type {
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
  PreviteHttpError,
  PreviteApp,
} from "./types.ts";

export interface PreviteHydrationState<TData = unknown> {
  url: string;
  routeId: string;
  data: TData;
  error?: SerializedRouteError | null;
}

export interface SerializedRouteError {
  message: string;
  name: string;
  status: number;
}

export interface StartAppOptions<TData = unknown> {
  initialData?: TData;
}

export interface HandlePreviteRequestOptions<TContext = unknown> {
  app: PreviteApp;
  request: Request;
  context?: TContext;
  registry?: ModuleRegistry;
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
    __PREVITE_STATE__?: PreviteHydrationState;
    __PREVITE_NAVIGATE__?: (to: string, options?: { replace?: boolean }) => Promise<void>;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);
const HYDRATION_STATE_ELEMENT_ID = "previte-state";

interface PreviteRuntimeValue {
  data: unknown;
  params: RouteParams;
  routeId: string;
  url: string;
  setData: (data: unknown) => void;
}

const RouteDataContext = createContext<PreviteRuntimeValue | undefined>(undefined);

export function PreviteRuntimeProvider<TData>({
  children,
  data,
  params = {} as RouteParams,
  routeId,
  url,
}: {
  children: ComponentChildren;
  data: TData;
  params?: RouteParams;
  routeId: string;
  url: string;
}) {
  // TODO: make signal with getter to reduce
  // re-renders caused by the framework itself.
  const [routeData, setRouteData] = useState<TData>(data);

  useEffect(() => {
    setRouteData(data);
  }, [data, routeId, url]);

  const context = useMemo(
    () => ({
      data: routeData,
      params,
      routeId,
      setData: setRouteData as (data: unknown) => void,
      url,
    }),
    [routeData, params, routeId, url],
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

export function readHydrationState<TData = unknown>(): PreviteHydrationState<TData> | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (window.__PREVITE_STATE__) {
    return window.__PREVITE_STATE__ as PreviteHydrationState<TData>;
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
    const state = JSON.parse(raw) as PreviteHydrationState<TData>;
    window.__PREVITE_STATE__ = state as PreviteHydrationState;
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
}

export function useLocation(): Location {
  const url =
    useContext(RouteDataContext)?.url ??
    (typeof window !== "undefined" ? window.location.pathname : "/");
  return { pathname: url };
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
    const result = await fetchPreviteRouteState(path);

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

export async function fetchPreviteRouteState(url: string): Promise<RouteStateResult> {
  const response = await fetch(url, {
    headers: { "x-previte-route-state-request": "1", "Cache-Control": "no-cache" },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    return {
      location: location ?? url,
      type: "redirect",
    };
  }

  const json = (await response.json()) as { data?: unknown; error?: SerializedRouteError };
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

export async function handlePreviteRequest<TContext>(
  options: HandlePreviteRequestOptions<TContext>,
): Promise<Response> {
  const url = new URL(options.request.url);
  const registry = options.registry ?? {};

  // --- API route dispatch (before page routes) ---
  if (options.apiRoutes?.length) {
    const apiMatch = matchApiRoute(options.apiRoutes, url.pathname);
    if (apiMatch) {
      const apiMiddlewareFiles = (options.app.api.middleware ?? []).flatMap((name) => {
        const middlewareFile = options.app.middleware[name];
        return middlewareFile ? [middlewareFile] : [];
      });
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

      const apiModule = await resolveRegistryModule<ApiRouteModule>(
        registry.apiModules,
        apiMatch.route.file,
      );

      if (!apiModule) {
        return withDefaultSecurityHeaders(
          new Response("API route module not found", {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }

      const method = options.request.method.toUpperCase() as HttpMethod;
      const handler = apiModule[method];

      if (!handler) {
        return withDefaultSecurityHeaders(
          new Response("Method not allowed", {
            status: 405,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        );
      }

      return withDefaultSecurityHeaders(
        await handler({
          request: options.request,
          params: apiMatch.params,
          context: middlewareResult.context,
          signal: AbortSignal.timeout(30_000),
          url,
          route: apiMatch.route as any,
        }),
      );
    }
  }

  const match = matchAppRoute(options.app, url.pathname);

  if (!match) {
    return withDefaultSecurityHeaders(
      new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  const isRouteStateRequest = options.request.headers.get("x-previte-route-state-request") === "1";

  if (!SAFE_METHODS.has(options.request.method)) {
    return withDefaultSecurityHeaders(
      new Response("Method not allowed", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  // --- Middleware chain ---
  const middlewareResult = await runMiddlewareChain({
    context: (options.context ?? {}) as TContext,
    middlewareFiles: match.route.middlewareFiles,
    params: match.params,
    registry,
    request: options.request,
    route: match.route,
    url,
  });
  if (middlewareResult.response) {
    return middlewareResult.response;
  }
  const context = middlewareResult.context;

  // --- Load route module ---
  const routeModule = await resolveRegistryModule<RouteModule>(
    registry.routeModules,
    match.route.file,
  );

  const routeArgs: BaseRouteArgs<TContext> = {
    request: options.request,
    params: match.params,
    context,
    signal: AbortSignal.timeout(30_000),
    url,
    route: match.route,
  };

  // --- Resolve loader from separate data module or route module ---
  const { loader } = await resolveDataFunctions(match.route, routeModule, registry);

  let shellModule: ShellModule | undefined;

  try {
    // --- Execute loader ---
    const loaderResult = loader ? await loader(routeArgs) : undefined;

    // Allow loaders to return a Response directly (e.g. for redirects)
    if (loaderResult instanceof Response) {
      return withDefaultSecurityHeaders(loaderResult);
    }

    const data = loaderResult;

    // --- Route state request (client navigation): return JSON ---
    if (isRouteStateRequest) {
      return withDefaultSecurityHeaders(Response.json({ data }));
    }

    // --- Load shell module ---
    shellModule = match.route.shellFile
      ? await resolveRegistryModule<ShellModule>(registry.shellModules, match.route.shellFile)
      : undefined;

    // --- Merge head metadata ---
    const head = await mergeHeadMetadata(shellModule, routeModule, routeArgs, data);

    const cssUrls = resolvePageCssUrls(options, match.route.shellFile, match.route.file);
    const modulePreloadUrls = resolvePageJsUrls(options, match.route.shellFile, match.route.file);

    // --- SPA mode: shell HTML with empty body, no SSR ---
    if (match.route.render === "spa") {
      return htmlResponse(
        buildHtmlDocument({
          head,
          body: "",
          hydrationState: {
            url: url.pathname,
            routeId: match.route.id ?? "",
            data: null,
            error: null,
          },
          clientEntryUrl: options.clientEntryUrl,
          cssUrls,
          modulePreloadUrls,
        }),
      );
    }

    // --- SSR / SSG / ISG: render Preact tree to string ---
    if (!routeModule?.Component) {
      return withDefaultSecurityHeaders(
        new Response("Route has no Component export", {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      );
    }

    const { renderToStringAsync } = await import("preact-render-to-string");

    const Component = routeModule.Component as any;
    const Shell = shellModule?.Shell;
    const componentProps = { data, params: match.params };

    const componentTree = Shell
      ? h(Shell, null, h(Component, componentProps))
      : h(Component, componentProps);

    const tree = h(
      PreviteRuntimeProvider as any,
      {
        data,
        params: match.params,
        routeId: match.route.id ?? "",
        url: url.pathname,
      },
      componentTree,
    );
    const ssrContent = await renderToStringAsync(tree);

    return htmlResponse(
      buildHtmlDocument({
        head,
        body: ssrContent,
        hydrationState: {
          url: url.pathname,
          routeId: match.route.id ?? "",
          data,
          error: null,
        },
        clientEntryUrl: options.clientEntryUrl,
        cssUrls,
        modulePreloadUrls,
      }),
    );
  } catch (error: unknown) {
    return renderRouteErrorResponse({
      error,
      isRouteStateRequest,
      options,
      routeArgs,
      routeId: match.route.id ?? "",
      routeModule,
      shellFile: match.route.shellFile,
      shellModule,
      urlPathname: url.pathname,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolvePageCssUrls(
  options: HandlePreviteRequestOptions<unknown>,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!options.cssManifest) return options.cssUrls ?? [];

  const css = new Set<string>();

  function addFromManifest(file: string): void {
    const suffix = file.replace(/^\.\//, "");
    for (const [key, cssFiles] of Object.entries(options.cssManifest!)) {
      if (key === file || key.endsWith(`/${suffix}`) || key.endsWith(suffix)) {
        for (const c of cssFiles) css.add(c);
        break;
      }
    }
  }

  if (shellFile) addFromManifest(shellFile);
  addFromManifest(routeFile);
  return [...css];
}

function resolvePageJsUrls(
  options: HandlePreviteRequestOptions<unknown>,
  shellFile: string | undefined,
  routeFile: string,
): string[] {
  if (!options.jsManifest) return [];

  const js = new Set<string>();

  function addFromManifest(file: string): void {
    const suffix = file.replace(/^\.\//, "");
    for (const [key, jsFiles] of Object.entries(options.jsManifest!)) {
      if (key === file || key.endsWith(`/${suffix}`) || key.endsWith(suffix)) {
        for (const j of jsFiles) js.add(j);
        break;
      }
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
  if (targetUrl.origin === window.location.origin && window.__PREVITE_NAVIGATE__) {
    await window.__PREVITE_NAVIGATE__(target, options);
    return;
  }

  if (options?.replace) {
    window.location.replace(targetUrl.toString());
    return;
  }

  window.location.href = targetUrl.toString();
}

function isPreviteHttpError(error: unknown): error is PreviteHttpError {
  return error instanceof Error && error.name === "PreviteHttpError" && "status" in error;
}

function normalizeRouteError(error: unknown): SerializedRouteError {
  if (isPreviteHttpError(error)) {
    return {
      message: error.message,
      name: error.name,
      status: typeof error.status === "number" ? error.status : 500,
    };
  }

  if (error instanceof Error) {
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

function deserializeRouteError(error: SerializedRouteError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  (result as Error & { status?: number }).status = error.status;
  return result;
}

async function renderRouteErrorResponse<TContext>(options: {
  error: unknown;
  isRouteStateRequest: boolean;
  options: HandlePreviteRequestOptions<TContext>;
  routeArgs: BaseRouteArgs<TContext>;
  routeId: string;
  routeModule: RouteModule | undefined;
  shellFile: string | undefined;
  shellModule: ShellModule | undefined;
  urlPathname: string;
}): Promise<Response> {
  const routeError = normalizeRouteError(options.error);

  if (!options.routeModule?.ErrorBoundary) {
    if (options.isRouteStateRequest) {
      return withDefaultSecurityHeaders(
        new Response(JSON.stringify({ error: routeError }), {
          status: routeError.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      );
    }

    const message = routeError.status >= 500 ? "Internal Server Error" : routeError.message;
    return withDefaultSecurityHeaders(
      new Response(message, {
        status: routeError.status,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    );
  }

  if (options.isRouteStateRequest) {
    return withDefaultSecurityHeaders(
      new Response(JSON.stringify({ error: routeError }), {
        status: routeError.status,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    );
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
  const { renderToStringAsync } = await import("preact-render-to-string");

  const ErrorBoundary = options.routeModule.ErrorBoundary as any;
  const Shell = shellModule?.Shell;
  const errorValue = deserializeRouteError(routeError);
  const componentTree = Shell
    ? h(Shell, null, h(ErrorBoundary, { error: errorValue }))
    : h(ErrorBoundary, { error: errorValue });
  const tree = h(
    PreviteRuntimeProvider as any,
    {
      data: null,
      routeId: options.routeId,
      url: options.urlPathname,
    },
    componentTree,
  );
  const body = await renderToStringAsync(tree);

  return htmlResponse(
    buildHtmlDocument({
      head,
      body,
      hydrationState: {
        url: options.urlPathname,
        routeId: options.routeId,
        data: null,
        error: routeError,
      },
      clientEntryUrl: options.options.clientEntryUrl,
      cssUrls,
      modulePreloadUrls,
    }),
    routeError.status,
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

  for (const mwFile of options.middlewareFiles) {
    const mwModule = await resolveRegistryModule<MiddlewareModule>(
      options.registry.middlewareModules,
      mwFile,
    );
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
): Promise<{ loader: RouteModule["loader"] }> {
  let loader = routeModule?.loader;

  if (route.loaderFile) {
    const dataModule = await resolveRegistryModule<DataModule>(
      registry.dataModules,
      route.loaderFile,
    );
    if (dataModule?.loader) loader = dataModule.loader;
  }

  return { loader };
}

async function resolveRegistryModule<T>(
  modules: Record<string, ModuleImporter> | undefined,
  file: string,
): Promise<T | undefined> {
  if (!modules) return undefined;

  // Direct key match
  if (file in modules) {
    return modules[file]() as Promise<T>;
  }

  // Suffix match: strip leading ./ and match against registry keys
  const suffix = file.replace(/^\.\//, "");
  for (const key of Object.keys(modules)) {
    if (key.endsWith(`/${suffix}`) || key.endsWith(suffix)) {
      return modules[key]() as Promise<T>;
    }
  }

  return undefined;
}

async function mergeHeadMetadata(
  shellModule: ShellModule | undefined,
  routeModule: RouteModule | undefined,
  routeArgs: BaseRouteArgs<unknown>,
  data: unknown,
): Promise<HeadMetadata> {
  const shellHead = shellModule?.head ? await shellModule.head(routeArgs) : {};
  const routeHead = routeModule?.head ? await routeModule.head({ ...routeArgs, data } as any) : {};

  return {
    title: routeHead.title ?? shellHead.title,
    lang: routeHead.lang ?? shellHead.lang,
    meta: [...(shellHead.meta ?? []), ...(routeHead.meta ?? [])],
    link: [...(shellHead.link ?? []), ...(routeHead.link ?? [])],
  };
}

function buildHtmlDocument(options: {
  head: HeadMetadata;
  body: string;
  hydrationState: PreviteHydrationState;
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
    <div id="previte-root">${body}</div>
    ${stateScript}
    ${entryScript}
  </body>
</html>`;
}

function htmlResponse(html: string, status = 200): Response {
  return withDefaultSecurityHeaders(
    new Response(html, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
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

function withDefaultSecurityHeaders(response: Response): Response {
  const headers = applyDefaultSecurityHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
}

export interface ISGManifestEntry {
  revalidate: import("./types.ts").RouteRevalidate;
}

export interface PrerenderAppResult {
  pages: PrerenderResult[];
  isgManifest: Record<string, ISGManifestEntry>;
}

export interface PrerenderAppOptions {
  app: PreviteApp;
  registry?: ModuleRegistry;
  clientEntryUrl?: string;
  /** Per-source-file CSS map produced by the vite plugin (preferred over cssUrls). */
  cssManifest?: Record<string, string[]>;
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

  for (const route of resolved.routes) {
    if (route.render !== "ssg" && route.render !== "isg") continue;

    const paths = await collectSSGPaths(route, options.registry);

    for (const pathname of paths) {
      const url = new URL(pathname, "http://localhost");
      const request = new Request(url, { method: "GET" });

      const response = await handlePreviteRequest({
        app: options.app,
        request,
        registry: options.registry,
        clientEntryUrl: options.clientEntryUrl,
        cssManifest: options.cssManifest,
      });

      if (response.status !== 200) {
        console.warn(
          `  Warning: ${route.render!.toUpperCase()} route "${pathname}" returned status ${response.status}, skipping.`,
        );
        continue;
      }

      const html = await response.text();
      results.push({ path: pathname, html });

      if (route.render === "isg" && route.revalidate) {
        isgManifest[pathname] = { revalidate: route.revalidate };
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
