import { createContext, h, options } from "preact";
import type { ComponentChildren, ComponentType, FunctionComponent, VNode } from "preact";
import { useContext } from "preact/hooks";

import { matchAppRoute } from "./app.ts";
import { stripBase } from "./base.ts";
import {
  getIslandsClientEntryUrl,
  IslandCaptureContext,
  validateIslandProps,
  type IslandCapture,
} from "./islands-server.ts";
import { RegionDataContext } from "./regions-data.ts";
import {
  MAX_REGION_PROPS_LENGTH,
  REGION_ELEMENT,
  REGION_FILE_ATTRIBUTE,
  REGION_ISLANDS_HEADER,
  REGION_PENDING_ATTRIBUTE,
  REGION_PROPS_ATTRIBUTE,
  REGION_QUERY_FILE,
  REGION_QUERY_PATH,
  REGION_QUERY_PROPS,
  REGION_REQUEST_HEADER,
} from "./regions-shared.ts";
import {
  PrachtRuntimeProvider,
  RouteDataContext,
  type PrachtRuntimeValue,
} from "./runtime-context.ts";
import { reportRequestError, type PrachtRuntimeDiagnosticPhase } from "./runtime-errors.ts";
import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import {
  composeRequestSignal,
  isClientDisconnect,
  type PrachtRequestContext,
} from "./runtime-request.ts";
import { getRenderToStringAsync } from "./runtime-response.ts";
import { IS_STATIC_TARGET } from "./runtime-static.ts";
import { ScriptCaptureContext, type ScriptCapture } from "./script.ts";
import type { BaseRouteArgs, HydrationMode, RegionLoaderArgs, RegionModule } from "./types.ts";

/**
 * Server-side request-time regions.
 *
 * The generated `virtual:pracht/server` module eagerly imports every module
 * in the regions directory and registers its default export here. A Preact
 * `options.vnode` hook — the technique islands use — retypes any vnode whose
 * type is a registered region to a boundary component, so call sites stay
 * plain JSX.
 *
 * What the boundary renders depends on the page render it is part of, which
 * travels through context (never module state, so concurrent prerenders
 * cannot interfere):
 *
 * - **inline** (SSR documents, and the region endpoint itself): a
 *   `<pracht-region>` element whose content is a per-render token. Once the
 *   page has rendered, every token is replaced by that region's HTML — its
 *   loader and render run concurrently, and a failure renders the fallback.
 * - **defer** (SSG/ISG documents, streamed documents, and anything rendered
 *   outside a page render): a `pending` placeholder holding the fallback,
 *   which the browser swaps for the endpoint's HTML after load.
 */

export interface RegionDescriptor {
  /** Project-root-relative module path, e.g. "/src/regions/CartCount.tsx". */
  file: string;
  /** Human-readable name used in error messages. */
  name: string;
  component: ComponentType<any>;
  loader?: RegionModule["loader"];
}

/** A region the current inline render still has to fill in. */
interface PendingRegion {
  token: string;
  descriptor: RegionDescriptor;
  props: Record<string, unknown>;
  fallback: ComponentChildren;
  runtime: PrachtRuntimeValue | undefined;
  islandCapture: IslandCapture | null;
  scriptCapture: ScriptCapture | null;
}

/** Per-render region state, threaded through the page render via context. */
export interface RegionRenderState {
  mode: "inline" | "defer";
  /** Set when the render emitted at least one pending placeholder. */
  deferred: boolean;
  pending: PendingRegion[];
  /** Random per render, so markup cannot collide with a region token. */
  token: string;
  depth: number;
}

/** What an inline region needs from the page that embeds it. */
export interface RegionRenderEnv {
  /** The embedding page's route arguments, after its middleware ran. */
  routeArgs: BaseRouteArgs<any>;
  /** Called for a region whose loader or render failed. */
  onError: (error: unknown, descriptor: RegionDescriptor) => void;
}

export const RegionRenderContext = createContext<RegionRenderState | null>(null);

// Regions render regions: a region's own markup is resolved inline too. Past
// this depth the nesting is almost certainly a region rendering itself.
const MAX_REGION_DEPTH = 8;

const regionRegistry = new Map<ComponentType<any>, RegionDescriptor>();
const regionsByFile = new Map<string, RegionDescriptor>();
let regionsClientEntryUrl: string | undefined;
let vnodeHookInstalled = false;

// Same set-then-consume sentinel as islands: `h()` is synchronous, so the
// boundary can create a vnode for the original component without the hook
// wrapping it again.
let skipWrapForType: ComponentType<any> | null = null;

// Internal prop the vnode hook uses to hand the original component type to
// the boundary. Never reaches user components.
const REGION_TYPE_PROP = "__prachtRegionType";

/** A loader that answered with a `Response` instead of data. */
class RegionResponse {
  constructor(readonly response: Response) {}
}

/**
 * Register region modules discovered from the regions directory. Called by
 * the generated `virtual:pracht/server` module with the eager
 * `import.meta.glob` result. The default export is the region; an optional
 * `loader` export runs at request time. Safe to call multiple times.
 */
export function registerServerRegions(modules: Record<string, unknown>): void {
  for (const [file, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== "object") continue;
    const { default: component, loader } = mod as Partial<RegionModule>;
    if (typeof component !== "function") continue;
    const descriptor: RegionDescriptor = {
      file,
      name: regionNameFromFile(file),
      component,
      loader: typeof loader === "function" ? loader : undefined,
    };
    regionRegistry.set(component, descriptor);
    regionsByFile.set(file, descriptor);
  }

  if (regionRegistry.size > 0) {
    installRegionVnodeHook();
  }
}

export function setRegionsClientEntryUrl(url: string | undefined): void {
  regionsClientEntryUrl = url ?? undefined;
}

export function getRegionsClientEntryUrl(): string | undefined {
  return regionsClientEntryUrl;
}

export function hasRegisteredRegions(): boolean {
  return regionRegistry.size > 0;
}

/** @internal Reset module state for tests. */
export function _resetRegionsForTesting(): void {
  regionRegistry.clear();
  regionsByFile.clear();
  regionsClientEntryUrl = undefined;
  skipWrapForType = null;
}

export function createRegionRenderState(
  mode: RegionRenderState["mode"],
  depth = 0,
): RegionRenderState {
  return { mode, deferred: false, pending: [], token: createRenderToken(), depth };
}

function createRenderToken(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function regionNameFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.[^.]+$/, "");
}

function installRegionVnodeHook(): void {
  if (vnodeHookInstalled) return;
  vnodeHookInstalled = true;

  const previousHook = options.vnode;
  options.vnode = (vnode: VNode<any>) => {
    const type = vnode.type;
    if (typeof type === "function" && regionRegistry.has(type as ComponentType<any>)) {
      if (skipWrapForType === type) {
        skipWrapForType = null;
      } else {
        vnode.props[REGION_TYPE_PROP] = type;
        (vnode as { type: unknown }).type = RegionBoundary;
      }
    }
    if (previousHook) previousHook(vnode);
  };
}

function renderOriginal(type: ComponentType<any>, props: Record<string, unknown>): VNode<any> {
  skipWrapForType = type;
  try {
    return h(type, props);
  } finally {
    skipWrapForType = null;
  }
}

function RegionBoundary(props: Record<string, unknown>) {
  const {
    [REGION_TYPE_PROP]: type,
    fallback,
    ...regionProps
  } = props as Record<string, unknown> & { [REGION_TYPE_PROP]: ComponentType<any> };
  const state = useContext(RegionRenderContext);
  const runtime = useContext(RouteDataContext);
  const islandCapture = useContext(IslandCaptureContext);
  const scriptCapture = useContext(ScriptCaptureContext);
  const descriptor = regionRegistry.get(type)!;

  const { children } = regionProps;
  if (children != null && !(Array.isArray(children) && children.length === 0)) {
    throw new Error(
      `Region "${descriptor.name}" (${descriptor.file}) received children. A region renders ` +
        "on its own at request time, so it cannot take JSX from the page — pass " +
        "JSON-serializable props instead, and use `fallback` for what shows before it loads.",
    );
  }
  delete regionProps.children;
  validateIslandProps(regionProps, descriptor, "Region");

  const serializedProps = JSON.stringify(regionProps);
  const attributes: Record<string, unknown> = {
    [REGION_FILE_ATTRIBUTE]: descriptor.file,
    // Unknown custom elements default to inline display; keep the wrapper
    // out of layout entirely.
    style: "display:contents",
  };
  if (serializedProps !== "{}") {
    attributes[REGION_PROPS_ATTRIBUTE] = serializedProps;
  }

  if (state?.mode === "inline") {
    const token = `<!--pracht-region:${state.token}:${state.pending.length}-->`;
    state.pending.push({
      token,
      descriptor,
      props: regionProps,
      fallback: (fallback as ComponentChildren) ?? null,
      runtime,
      islandCapture,
      scriptCapture,
    });
    return h(REGION_ELEMENT, { ...attributes, dangerouslySetInnerHTML: { __html: token } });
  }

  if (IS_STATIC_TARGET) {
    throw new Error(
      `Region "${descriptor.name}" (${descriptor.file}) was rendered on a prerendered page, ` +
        "but the static adapter deploys no server to answer region requests. Render the " +
        "content client-side from an island instead, or deploy with a server adapter.",
    );
  }
  if (state) state.deferred = true;
  attributes[REGION_PENDING_ATTRIBUTE] = "";
  return h(REGION_ELEMENT, attributes, (fallback as ComponentChildren) ?? null);
}

/**
 * Replace every inline region token in `html` with that region's markup.
 * Regions load and render concurrently; a failing region is reported through
 * `env.onError` and renders its fallback, so it can never fail the page.
 */
export async function resolveInlineRegions(
  html: string,
  state: RegionRenderState,
  env: RegionRenderEnv,
): Promise<string> {
  if (state.pending.length === 0) return html;
  const pending = state.pending.splice(0);
  const rendered = await Promise.all(
    pending.map(async (region) => {
      try {
        return await renderRegionMarkup(region, env, state.depth + 1);
      } catch (error: unknown) {
        if (!(error instanceof RegionResponse) && !env.routeArgs.signal.aborted) {
          env.onError(error, region.descriptor);
        }
        return renderWithRegionContexts(region, region.fallback, state.depth + 1, env);
      }
    }),
  );
  let result = html;
  pending.forEach((region, index) => {
    result = result.replace(region.token, () => rendered[index]);
  });
  return result;
}

async function renderRegionMarkup(
  region: PendingRegion,
  env: RegionRenderEnv,
  depth: number,
): Promise<string> {
  const { descriptor, props } = region;
  if (depth > MAX_REGION_DEPTH) {
    throw new Error(
      `Region "${descriptor.name}" (${descriptor.file}) is nested more than ${MAX_REGION_DEPTH} ` +
        "regions deep. A region that renders itself never finishes.",
    );
  }
  const data = await runRegionLoader(descriptor, props, env.routeArgs);
  const body = h(
    RegionDataContext.Provider,
    { value: data },
    renderOriginal(descriptor.component, props),
  );
  return renderWithRegionContexts(region, body, depth, env);
}

async function runRegionLoader(
  descriptor: RegionDescriptor,
  props: Record<string, unknown>,
  routeArgs: BaseRouteArgs<any>,
): Promise<unknown> {
  if (!descriptor.loader) return undefined;
  const args: RegionLoaderArgs<any, Record<string, unknown>> = { ...routeArgs, props };
  let result: unknown;
  try {
    result = await descriptor.loader(args);
  } catch (error: unknown) {
    // A thrown `Response` (`throw redirect(...)`) is the loader answering, not
    // failing. A region has no document to redirect, so it keeps its fallback.
    if (error instanceof Response) throw new RegionResponse(error);
    throw error;
  }
  if (result instanceof Response) throw new RegionResponse(result);
  return result;
}

/**
 * Render `content` as a region subtree: the page's runtime, island, and
 * script contexts are re-provided so hooks like `useLocation()` behave as
 * they would inline, and islands inside a region are captured by the page.
 */
async function renderWithRegionContexts(
  region: Pick<PendingRegion, "runtime" | "islandCapture" | "scriptCapture">,
  content: ComponentChildren,
  depth: number,
  env: RegionRenderEnv,
): Promise<string> {
  if (content == null || content === false) return "";
  const nested = createRegionRenderState("inline", depth);
  let tree: VNode<any> = h(RegionRenderContext.Provider, { value: nested }, content);
  tree = h(IslandCaptureContext.Provider, { value: region.islandCapture }, tree);
  tree = h(ScriptCaptureContext.Provider, { value: region.scriptCapture }, tree);
  if (region.runtime) {
    tree = h(RouteDataContext.Provider, { value: region.runtime }, tree);
  }
  const renderToString = await getRenderToStringAsync();
  const html = await renderToString(tree);
  return resolveInlineRegions(html, nested, env);
}

function regionResponse(body: BodyInit | null, status: number, headers?: HeadersInit): Response {
  const response = new Response(body, { status, headers });
  // Region HTML is per request and per visitor. Pinned after middleware ran,
  // so neither application code nor an adapter's cache can widen it.
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex");
  return withDefaultSecurityHeaders(response);
}

function regionTextResponse(message: string, status: number, headers?: HeadersInit): Response {
  return regionResponse(message, status, {
    "content-type": "text/plain; charset=utf-8",
    ...Object.fromEntries(new Headers(headers)),
  });
}

/**
 * Answer `GET /__pracht/region` — render one region at request time for the
 * page the browser is on.
 *
 * The request names the region, its props, and the page path. The page path
 * is matched against the route table and that route's middleware chain runs
 * around the region, with a request whose URL is the page's and whose
 * headers (cookies included) are the region request's — so session and auth
 * middleware populate `context` exactly as they did, or would have, for the
 * page. Then the region loader runs and the region renders to an HTML
 * fragment.
 *
 * - `200` — the fragment. Always `Cache-Control: private, no-store`.
 * - `204` — middleware or the loader answered with a `Response` (a redirect,
 *   a 401): the page keeps the fallback.
 * - `4xx` — malformed request, unknown region, or a path no route matches.
 * - `500` — the loader or render threw; reported through `onRouteError`.
 */
export async function handleRegionRequest<TContext>(
  ctx: PrachtRequestContext<TContext>,
): Promise<Response> {
  const { request, url, options } = ctx;
  if (request.method !== "GET") {
    return regionTextResponse("Method not allowed", 405, { allow: "GET" });
  }
  if (request.headers.get(REGION_REQUEST_HEADER) !== "1") {
    return regionTextResponse(`Region requests must send ${REGION_REQUEST_HEADER}: 1`, 400);
  }

  const file = url.searchParams.get(REGION_QUERY_FILE) ?? "";
  const descriptor = regionsByFile.get(file);
  if (!descriptor) return regionTextResponse("Unknown region", 404);

  const rawProps = url.searchParams.get(REGION_QUERY_PROPS) ?? "{}";
  if (rawProps.length > MAX_REGION_PROPS_LENGTH) {
    return regionTextResponse("Region props too large", 413);
  }
  let props: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawProps);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    props = parsed as Record<string, unknown>;
  } catch {
    return regionTextResponse("Region props must be a JSON object", 400);
  }

  const pagePath = url.searchParams.get(REGION_QUERY_PATH) ?? "";
  if (!pagePath.startsWith("/") || pagePath.startsWith("//") || pagePath.includes("\\")) {
    return regionTextResponse("Region path must be a same-origin path", 400);
  }
  const pageUrl = new URL(pagePath, url.origin);
  // The URL parser drops tabs and newlines, so "/\t/evil.example" still
  // resolves off-origin; compare the result, not just the input.
  if (pageUrl.origin !== url.origin) {
    return regionTextResponse("Region path must be a same-origin path", 400);
  }
  const routePathname = stripBase(pageUrl.pathname);
  const match = routePathname === null ? undefined : matchAppRoute(ctx.resolvedApp, routePathname);
  if (!match) return regionTextResponse("No route matches the region path", 404);

  // The page's URL with the region request's headers: middleware and the
  // loader see the page they are rendering for, and the visitor's cookies.
  const pageRequest = new Request(pageUrl, {
    method: "GET",
    headers: request.headers,
    signal: request.signal,
  });
  const signal = composeRequestSignal(pageRequest, ctx.loaderTimeoutMs);
  const routeArgs: BaseRouteArgs<TContext> = {
    request: pageRequest,
    params: match.params,
    context: ctx.context,
    signal,
    url: pageUrl,
    route: match.route,
    pathname: match.pathname,
  };
  const hydration: HydrationMode = match.route.hydration ?? "full";
  let phase: PrachtRuntimeDiagnosticPhase = "middleware";
  const reportContext = (errorPhase: PrachtRuntimeDiagnosticPhase) => ({
    middlewareFiles: [...(match.route.middlewareFiles ?? [])],
    phase: errorPhase,
    regionFile: descriptor.file,
    routeFile: match.route.file,
    routeId: match.route.id,
    routePath: match.route.path,
  });

  const terminal = async (): Promise<Response> => {
    phase = "loader";
    const data = await runRegionLoader(descriptor, props, routeArgs);
    phase = "render";
    // Islands inside a region hydrate only where the page runs the islands
    // bootstrap; on other pages they are plain server-rendered components.
    const islandCapture: IslandCapture | null = hydration === "islands" ? { islands: [] } : null;
    const env: RegionRenderEnv = {
      routeArgs,
      onError: (error, nested) => {
        reportRequestError(options.onRouteError, error, pagePath, {
          ...reportContext("render"),
          regionFile: nested.file,
        });
      },
    };
    const body = h(
      RegionDataContext.Provider,
      { value: data },
      renderOriginal(descriptor.component, props),
    );
    const content = h(
      PrachtRuntimeProvider as FunctionComponent<Record<string, unknown>>,
      {
        data: null,
        params: match.params,
        routeId: match.route.id ?? "",
        routes: ctx.hrefRoutes,
        url: pagePath,
      },
      body,
    );
    const html = await renderWithRegionContexts(
      { runtime: undefined, islandCapture, scriptCapture: null },
      content,
      1,
      env,
    );
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      [REGION_REQUEST_HEADER]: "1",
    });
    const islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
    if (islandCapture && islandCapture.islands.length > 0 && islandsEntryUrl) {
      headers.set(REGION_ISLANDS_HEADER, islandsEntryUrl);
    }
    return new Response(html, { status: 200, headers });
  };

  try {
    const response = await runMiddlewareChain({
      context: ctx.context,
      middlewareFiles: match.route.middlewareFiles,
      params: match.params,
      pathname: match.pathname,
      registry: ctx.registry,
      request: pageRequest,
      route: match.route,
      signal,
      url: pageUrl,
      terminal,
      onMiddlewareError: () => {
        phase = "middleware";
      },
    });
    // Only the region's own fragment is ever swapped into the page. Anything
    // else — a middleware redirect to a login page, a 401 — means "no region
    // for this visitor", and the page keeps its fallback.
    if (response.headers.get(REGION_REQUEST_HEADER) !== "1") {
      return regionResponse(null, 204);
    }
    return regionResponse(response.body, response.status, response.headers);
  } catch (error: unknown) {
    if (isClientDisconnect(request, signal)) {
      return new Response(null, { status: 499 });
    }
    if (error instanceof Response || error instanceof RegionResponse) {
      return regionResponse(null, 204);
    }
    reportRequestError(options.onRouteError, error, pagePath, reportContext(phase));
    return regionTextResponse(
      ctx.exposeDiagnostics && error instanceof Error
        ? `Region "${descriptor.name}" failed: ${error.message}`
        : "Internal Server Error",
      500,
    );
  }
}
