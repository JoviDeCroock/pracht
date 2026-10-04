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
import { ServerIslandDataContext } from "./server-islands-data.ts";
import {
  MAX_SERVER_ISLAND_PROPS_LENGTH,
  SERVER_ISLAND_ELEMENT,
  SERVER_ISLAND_FILE_ATTRIBUTE,
  SERVER_ISLAND_ISLANDS_HEADER,
  SERVER_ISLAND_PENDING_ATTRIBUTE,
  SERVER_ISLAND_PROPS_ATTRIBUTE,
  SERVER_ISLAND_QUERY_FILE,
  SERVER_ISLAND_QUERY_PATH,
  SERVER_ISLAND_QUERY_PROPS,
  SERVER_ISLAND_REQUEST_HEADER,
} from "./server-islands-shared.ts";
import {
  PrachtRuntimeProvider,
  RouteDataContext,
  type PrachtRuntimeValue,
} from "./runtime-context.ts";
import { reportRequestError, type PrachtRuntimeDiagnosticPhase } from "./runtime-errors.ts";
import { installServerIslandsRuntime } from "./server-islands-runtime.ts";
import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import {
  composeRequestSignal,
  isClientDisconnect,
  type PrachtRequestContext,
} from "./runtime-request.ts";
import { getRenderToStringAsync } from "./runtime-response.ts";
import { resolveRequestRoot } from "./runtime-root.ts";
import {
  applyRouteSearch,
  createPageRouteArgs,
  runPageMiddlewareChain,
} from "./runtime-route-args.ts";
import { IS_STATIC_TARGET } from "./runtime-static.ts";
import { ScriptCaptureContext, type ScriptCapture } from "./script.ts";
import type {
  BaseRouteArgs,
  HydrationMode,
  ServerIslandLoaderArgs,
  ServerIslandModule,
  RouteModule,
  ShellModule,
} from "./types.ts";

/**
 * The server half of server islands.
 *
 * The generated `virtual:pracht/server` module eagerly imports every module
 * in the server islands directory and registers its default export here. A Preact
 * `options.vnode` hook — the technique islands use — retypes any vnode whose
 * type is a registered server island to a boundary component, so call sites stay
 * plain JSX.
 *
 * What the boundary renders depends on the page render it is part of, which
 * travels through context (never module state, so concurrent prerenders
 * cannot interfere):
 *
 * - **inline** (SSR documents, and the server island endpoint itself): a
 *   `<pracht-server-island>` element whose content is a per-render token. Once the
 *   page has rendered, every token is replaced by that server island's HTML — its
 *   loader and render run concurrently, and a failure renders the fallback.
 * - **defer** (SSG/ISG documents, streamed documents, and anything rendered
 *   outside a page render): a `pending` placeholder holding the fallback,
 *   which the browser swaps for the endpoint's HTML after load.
 */

export interface ServerIslandDescriptor {
  /** Project-root-relative module path, e.g. "/src/server-islands/CartCount.tsx". */
  file: string;
  /** Human-readable name used in error messages. */
  name: string;
  component: ComponentType<any>;
  loader?: ServerIslandModule["loader"];
}

/** A server island the current inline render still has to fill in. */
interface PendingServerIsland {
  token: string;
  descriptor: ServerIslandDescriptor;
  props: Record<string, unknown>;
  fallback: ComponentChildren;
  runtime: PrachtRuntimeValue | undefined;
  islandCapture: IslandCapture | null;
  scriptCapture: ScriptCapture | null;
}

/** Per-render server island state, threaded through the page render via context. */
export interface ServerIslandRenderState {
  mode: "inline" | "defer";
  /**
   * The server islands the page's route and shell modules list in their
   * `serverIslands` exports. A page may render only these directly; `null`
   * outside a page render.
   */
  declared: ReadonlySet<ComponentType<any>> | null;
  /** Set when the render emitted at least one pending placeholder. */
  deferred: boolean;
  pending: PendingServerIsland[];
  /** Random per render, so markup cannot collide with a server island token. */
  token: string;
  depth: number;
}

/** What an inline server island needs from the page that embeds it. */
export interface ServerIslandRenderEnv {
  /** The embedding page's route arguments, after its middleware ran. */
  routeArgs: BaseRouteArgs<any>;
  /** Called for a server island whose loader or render failed. */
  onError: (error: unknown, descriptor: ServerIslandDescriptor) => void;
}

export const ServerIslandRenderContext = /* @__PURE__ */ createContext<ServerIslandRenderState | null>(
  null,
);

// Server islands render server islands: a server island's own markup is resolved inline too. Past
// this depth the nesting is almost certainly a server island rendering itself.
const MAX_SERVER_ISLAND_DEPTH = 8;

const serverIslandRegistry = new Map<ComponentType<any>, ServerIslandDescriptor>();
const serverIslandsByFile = new Map<string, ServerIslandDescriptor>();
let serverIslandsClientEntryUrl: string | undefined;

let vnodeHookInstalled = false;

// Same set-then-consume sentinel as islands: `h()` is synchronous, so the
// boundary can create a vnode for the original component without the hook
// wrapping it again.
let skipWrapForType: ComponentType<any> | null = null;

// Internal prop the vnode hook uses to hand the original component type to
// the boundary. Never reaches user components.
const SERVER_ISLAND_TYPE_PROP = "__prachtServerIslandType";

/** A loader that answered with a `Response` instead of data. */
class ServerIslandResponse {
  constructor(readonly response: Response) {}
}

/**
 * Register server island modules discovered from the server islands directory. Called by
 * the generated `virtual:pracht/server` module with the eager
 * `import.meta.glob` result. The default export is the server island; an optional
 * `loader` export runs at request time. Safe to call multiple times.
 */
export function registerServerIslandModules(modules: Record<string, unknown>): void {
  for (const [file, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== "object") continue;
    const { default: component, loader } = mod as Partial<ServerIslandModule>;
    if (typeof component !== "function") continue;
    const descriptor: ServerIslandDescriptor = {
      file,
      name: serverIslandNameFromFile(file),
      component,
      loader: typeof loader === "function" ? loader : undefined,
    };
    serverIslandRegistry.set(component, descriptor);
    serverIslandsByFile.set(file, descriptor);
  }

  if (serverIslandRegistry.size > 0) {
    installServerIslandVnodeHook();
    installServerIslandsRuntime({
      createRenderState: createServerIslandRenderState,
      declared: declaredServerIslands,
      getClientEntryUrl: getServerIslandsClientEntryUrl,
      handleRequest: handleServerIslandRequest,
      RenderContext: ServerIslandRenderContext,
      resolveInline: resolveInlineServerIslands,
    });
  }
}

export function setServerIslandsClientEntryUrl(url: string | undefined): void {
  serverIslandsClientEntryUrl = url ?? undefined;
}

export function getServerIslandsClientEntryUrl(): string | undefined {
  return serverIslandsClientEntryUrl;
}

/**
 * The server islands a page may render: those its route module and its shell
 * module list in their `serverIslands` exports. The endpoint runs a server island
 * only under a route that lists it, so the middleware and params it sees are
 * those of a page that renders it.
 */
export function declaredServerIslands(
  routeModule: Pick<RouteModule, "serverIslands"> | undefined,
  shellModule: Pick<ShellModule, "serverIslands"> | undefined,
): Set<ComponentType<any>> {
  const declared = new Set<ComponentType<any>>();
  for (const list of [routeModule?.serverIslands, shellModule?.serverIslands]) {
    if (!Array.isArray(list)) continue;
    for (const component of list) {
      if (typeof component === "function") declared.add(component);
    }
  }
  return declared;
}

/** @internal Reset module state for tests. */
export function _resetServerIslandsForTesting(): void {
  serverIslandRegistry.clear();
  serverIslandsByFile.clear();
  serverIslandsClientEntryUrl = undefined;
  installServerIslandsRuntime(undefined);
  skipWrapForType = null;
}

export function createServerIslandRenderState(
  mode: ServerIslandRenderState["mode"],
  depth = 0,
  declared: ReadonlySet<ComponentType<any>> | null = null,
): ServerIslandRenderState {
  return { mode, declared, deferred: false, pending: [], token: createRenderToken(), depth };
}

function createRenderToken(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function serverIslandNameFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.[^.]+$/, "");
}

function installServerIslandVnodeHook(): void {
  if (vnodeHookInstalled) return;
  vnodeHookInstalled = true;

  const previousHook = options.vnode;
  options.vnode = (vnode: VNode<any>) => {
    const type = vnode.type;
    if (typeof type === "function" && serverIslandRegistry.has(type as ComponentType<any>)) {
      if (skipWrapForType === type) {
        skipWrapForType = null;
      } else {
        vnode.props[SERVER_ISLAND_TYPE_PROP] = type;
        (vnode as { type: unknown }).type = ServerIslandBoundary;
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

function ServerIslandBoundary(props: Record<string, unknown>) {
  const {
    [SERVER_ISLAND_TYPE_PROP]: type,
    fallback,
    ...serverIslandProps
  } = props as Record<string, unknown> & { [SERVER_ISLAND_TYPE_PROP]: ComponentType<any> };
  const state = useContext(ServerIslandRenderContext);
  const runtime = useContext(RouteDataContext);
  const islandCapture = useContext(IslandCaptureContext);
  const scriptCapture = useContext(ScriptCaptureContext);
  const descriptor = serverIslandRegistry.get(type)!;

  const { children } = serverIslandProps;
  if (children != null && !(Array.isArray(children) && children.length === 0)) {
    throw new Error(
      `Server island "${descriptor.name}" (${descriptor.file}) received children. A server island renders ` +
        "on its own at request time, so it cannot take JSX from the page — pass " +
        "JSON-serializable props instead, and use `fallback` for what shows before it loads.",
    );
  }
  delete serverIslandProps.children;
  validateIslandProps(serverIslandProps, descriptor, "Server island");
  // Only the page's own server islands need listing: one rendered inside another
  // server island resolves inline with it and never reaches the endpoint alone.
  if (state && state.depth === 0 && state.declared && !state.declared.has(type)) {
    throw new Error(
      `Server island "${descriptor.name}" (${descriptor.file}) is rendered by a page that does not ` +
        "list it. Add it to `export const serverIslands = [...]` in the route module, or in the " +
        "shell module when the shell renders it.",
    );
  }

  const serializedProps = JSON.stringify(serverIslandProps);
  const attributes: Record<string, unknown> = {
    [SERVER_ISLAND_FILE_ATTRIBUTE]: descriptor.file,
    // Unknown custom elements default to inline display; keep the wrapper
    // out of layout entirely.
    style: "display:contents",
  };
  if (serializedProps !== "{}") {
    attributes[SERVER_ISLAND_PROPS_ATTRIBUTE] = serializedProps;
  }

  if (state?.mode === "inline") {
    const token = `<!--pracht-server-island:${state.token}:${state.pending.length}-->`;
    state.pending.push({
      token,
      descriptor,
      props: serverIslandProps,
      fallback: (fallback as ComponentChildren) ?? null,
      runtime,
      islandCapture,
      scriptCapture,
    });
    return h(SERVER_ISLAND_ELEMENT, { ...attributes, dangerouslySetInnerHTML: { __html: token } });
  }

  if (IS_STATIC_TARGET) {
    throw new Error(
      `Server island "${descriptor.name}" (${descriptor.file}) was rendered on a prerendered page, ` +
        "but the static adapter deploys no server to answer server island requests. Render the " +
        "content client-side from an island instead, or deploy with a server adapter.",
    );
  }
  if (state) state.deferred = true;
  attributes[SERVER_ISLAND_PENDING_ATTRIBUTE] = "";
  return h(SERVER_ISLAND_ELEMENT, attributes, (fallback as ComponentChildren) ?? null);
}

/**
 * Replace every inline server island token in `html` with that server island's markup.
 * Server islands load and render concurrently; a failing server island is reported through
 * `env.onError` and renders its fallback, so it can never fail the page.
 */
export async function resolveInlineServerIslands(
  html: string,
  state: ServerIslandRenderState,
  env: ServerIslandRenderEnv,
): Promise<string> {
  if (state.pending.length === 0) return html;
  const pending = state.pending.splice(0);
  const rendered = await Promise.all(
    pending.map(async (serverIsland) => {
      try {
        return await renderServerIslandMarkup(serverIsland, env, state.depth + 1);
      } catch (error: unknown) {
        if (!(error instanceof ServerIslandResponse) && !env.routeArgs.signal.aborted) {
          env.onError(error, serverIsland.descriptor);
        }
        return renderWithServerIslandContexts(
          serverIsland,
          serverIsland.fallback,
          state.depth + 1,
          env,
        );
      }
    }),
  );
  let result = html;
  pending.forEach((serverIsland, index) => {
    result = result.replace(serverIsland.token, () => rendered[index]);
  });
  return result;
}

async function renderServerIslandMarkup(
  serverIsland: PendingServerIsland,
  env: ServerIslandRenderEnv,
  depth: number,
): Promise<string> {
  const { descriptor, props } = serverIsland;
  if (depth > MAX_SERVER_ISLAND_DEPTH) {
    throw new Error(
      `Server island "${descriptor.name}" (${descriptor.file}) is nested more than ${MAX_SERVER_ISLAND_DEPTH} ` +
        "server islands deep. A server island that renders itself never finishes.",
    );
  }
  const data = await runServerIslandLoader(descriptor, props, env.routeArgs);
  const body = h(
    ServerIslandDataContext.Provider,
    { value: data },
    renderOriginal(descriptor.component, props),
  );
  return renderWithServerIslandContexts(serverIsland, body, depth, env);
}

async function runServerIslandLoader(
  descriptor: ServerIslandDescriptor,
  props: Record<string, unknown>,
  routeArgs: BaseRouteArgs<any>,
): Promise<unknown> {
  if (!descriptor.loader) return undefined;
  const args: ServerIslandLoaderArgs<any, Record<string, unknown>> = { ...routeArgs, props };
  let result: unknown;
  try {
    result = await descriptor.loader(args);
  } catch (error: unknown) {
    // A thrown `Response` (`throw redirect(...)`) is the loader answering, not
    // failing. A server island has no document to redirect, so it keeps its fallback.
    if (error instanceof Response) throw new ServerIslandResponse(error);
    throw error;
  }
  if (result instanceof Response) throw new ServerIslandResponse(result);
  return result;
}

/**
 * Render `content` as a server island subtree: the page's runtime, island, and
 * script contexts are re-provided so hooks like `useLocation()` behave as
 * they would inline, and islands inside a server island are captured by the page.
 */
async function renderWithServerIslandContexts(
  serverIsland: Pick<PendingServerIsland, "runtime" | "islandCapture" | "scriptCapture">,
  content: ComponentChildren,
  depth: number,
  env: ServerIslandRenderEnv,
): Promise<string> {
  if (content == null || content === false) return "";
  const nested = createServerIslandRenderState("inline", depth);
  let tree: VNode<any> = h(ServerIslandRenderContext.Provider, { value: nested }, content);
  tree = h(IslandCaptureContext.Provider, { value: serverIsland.islandCapture }, tree);
  tree = h(ScriptCaptureContext.Provider, { value: serverIsland.scriptCapture }, tree);
  if (serverIsland.runtime) {
    tree = h(RouteDataContext.Provider, { value: serverIsland.runtime }, tree);
  }
  const renderToString = await getRenderToStringAsync();
  const html = await renderToString(tree);
  return resolveInlineServerIslands(html, nested, env);
}

function serverIslandResponse(
  body: BodyInit | null,
  status: number,
  headers?: HeadersInit,
): Response {
  const response = new Response(body, { status, headers });
  // Server island HTML is per request and per visitor. Pinned after middleware ran,
  // so neither application code nor an adapter's cache can widen it.
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex");
  return withDefaultSecurityHeaders(response);
}

function serverIslandTextResponse(
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  return serverIslandResponse(message, status, {
    "content-type": "text/plain; charset=utf-8",
    ...Object.fromEntries(new Headers(headers)),
  });
}

/**
 * Answer `GET /__pracht/server-island` — render one server island at request time for the
 * page the browser is on.
 *
 * The request names the server island, its props, and the page path. The page path
 * is matched against the route table, and the server island must be listed in that
 * route's `serverIslands` export or its shell's (`declaredServerIslands`).
 * That route's middleware chain then runs around the server island, with a request
 * whose URL is the page's and whose headers (cookies included) are the server island
 * request's — so session and auth middleware populate `context` exactly as
 * they did, or would have, for the page. Then the server island loader runs and the
 * server island renders to an HTML fragment.
 *
 * - `200` — the fragment. Always `Cache-Control: private, no-store`.
 * - `204` — middleware or the loader answered with a `Response` (a redirect,
 *   a 401): the page keeps the fallback.
 * - `404` — a path no route matches, or a server island that route does not render
 *   (identical to a server island that does not exist).
 * - `4xx` — otherwise malformed request.
 * - `500` — the loader or render threw; reported through `onRouteError`.
 */
export async function handleServerIslandRequest<TContext>(
  ctx: PrachtRequestContext<TContext>,
): Promise<Response> {
  const { request, url, options } = ctx;
  if (request.method !== "GET") {
    return serverIslandTextResponse("Method not allowed", 405, { allow: "GET" });
  }
  if (request.headers.get(SERVER_ISLAND_REQUEST_HEADER) !== "1") {
    return serverIslandTextResponse(
      `Server island requests must send ${SERVER_ISLAND_REQUEST_HEADER}: 1`,
      400,
    );
  }

  const rawProps = url.searchParams.get(SERVER_ISLAND_QUERY_PROPS) ?? "{}";
  if (rawProps.length > MAX_SERVER_ISLAND_PROPS_LENGTH) {
    return serverIslandTextResponse("Server island props too large", 413);
  }
  let props: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawProps);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    props = parsed as Record<string, unknown>;
  } catch {
    return serverIslandTextResponse("Server island props must be a JSON object", 400);
  }

  const pagePath = url.searchParams.get(SERVER_ISLAND_QUERY_PATH) ?? "";
  if (!pagePath.startsWith("/") || pagePath.startsWith("//") || pagePath.includes("\\")) {
    return serverIslandTextResponse("Server island path must be a same-origin path", 400);
  }
  const pageUrl = new URL(pagePath, url.origin);
  // The URL parser drops tabs and newlines, so "/\t/evil.example" still
  // resolves off-origin; compare the result, not just the input.
  if (pageUrl.origin !== url.origin) {
    return serverIslandTextResponse("Server island path must be a same-origin path", 400);
  }
  const routePathname = stripBase(pageUrl.pathname);
  const match = routePathname === null ? undefined : matchAppRoute(ctx.resolvedApp, routePathname);
  if (!match) return serverIslandTextResponse("No route matches the server island path", 404);

  // The server island must be one this route or its shell lists. A server island
  // that does not exist and one the route does not list get the same answer,
  // checked at the same point, so a caller cannot tell them apart or probe for
  // server island names.
  const [routeModule, shellModule] = await Promise.all([
    resolveRegistryModule<RouteModule>(ctx.registry.routeModules, match.route.file),
    match.route.shellFile
      ? resolveRegistryModule<ShellModule>(ctx.registry.shellModules, match.route.shellFile)
      : undefined,
  ]);
  const file = url.searchParams.get(SERVER_ISLAND_QUERY_FILE) ?? "";
  const descriptor = serverIslandsByFile.get(file);
  if (!descriptor || !declaredServerIslands(routeModule, shellModule).has(descriptor.component)) {
    return serverIslandTextResponse("Unknown server island", 404);
  }

  // The page's URL with the server island request's headers: middleware and the
  // loader see the page they are rendering for, and the visitor's cookies.
  const pageRequest = new Request(pageUrl, {
    method: "GET",
    headers: new Headers(request.headers),
    signal: request.signal,
  });
  const signal = composeRequestSignal(pageRequest, ctx.loaderTimeoutMs);
  const routeArgs = createPageRouteArgs(options, match, {
    request: pageRequest,
    url: pageUrl,
    context: ctx.context,
    signal,
    requestPath: pagePath,
    errorContext: { serverIslandFile: descriptor.file },
  });
  const hydration: HydrationMode = match.route.hydration ?? "full";
  let phase: PrachtRuntimeDiagnosticPhase = "middleware";
  const reportContext = (errorPhase: PrachtRuntimeDiagnosticPhase) => ({
    middlewareFiles: [...(match.route.middlewareFiles ?? [])],
    phase: errorPhase,
    serverIslandFile: descriptor.file,
    routeFile: match.route.file,
    routeId: match.route.id,
    routePath: match.route.path,
  });

  const terminal = async (): Promise<Response> => {
    phase = "loader";
    // The loader sees the page's `search` exactly as an inline render would:
    // validated by the route module's `search` export.
    const searchError = await applyRouteSearch(routeArgs, routeModule?.search);
    if (searchError) return serverIslandTextResponse(searchError.message, 400);
    // The same app root state the page's loaders get inline.
    routeArgs.root = (await resolveRequestRoot(ctx, ctx.registry))?.state;
    const data = await runServerIslandLoader(descriptor, props, routeArgs);
    phase = "render";
    // Islands inside a server island hydrate only where the page runs the islands
    // bootstrap; on other pages they are plain server-rendered components.
    const islandCapture: IslandCapture | null = hydration === "islands" ? { islands: [] } : null;
    const env: ServerIslandRenderEnv = {
      routeArgs,
      onError: (error, nested) => {
        reportRequestError(options.onRouteError, error, pagePath, {
          ...reportContext("render"),
          serverIslandFile: nested.file,
        });
      },
    };
    const body = h(
      ServerIslandDataContext.Provider,
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
    const html = await renderWithServerIslandContexts(
      { runtime: undefined, islandCapture, scriptCapture: null },
      content,
      1,
      env,
    );
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      [SERVER_ISLAND_REQUEST_HEADER]: "1",
    });
    const islandsEntryUrl = options.islandsEntryUrl ?? getIslandsClientEntryUrl();
    if (islandCapture && islandCapture.islands.length > 0 && islandsEntryUrl) {
      headers.set(SERVER_ISLAND_ISLANDS_HEADER, islandsEntryUrl);
    }
    return new Response(html, { status: 200, headers });
  };

  try {
    const response = await runPageMiddlewareChain(routeArgs, ctx.registry, terminal, () => {
      phase = "middleware";
    });
    // Only the server island's own fragment is ever swapped into the page. Anything
    // else — a middleware redirect to a login page, a 401 — means "no server island
    // for this visitor", and the page keeps its fallback.
    if (response.headers.get(SERVER_ISLAND_REQUEST_HEADER) !== "1") {
      return serverIslandResponse(null, 204);
    }
    return serverIslandResponse(response.body, response.status, response.headers);
  } catch (error: unknown) {
    if (isClientDisconnect(request, signal)) {
      return new Response(null, { status: 499 });
    }
    if (error instanceof Response || error instanceof ServerIslandResponse) {
      return serverIslandResponse(null, 204);
    }
    reportRequestError(options.onRouteError, error, pagePath, reportContext(phase));
    return serverIslandTextResponse(
      ctx.exposeDiagnostics && error instanceof Error
        ? `Server island "${descriptor.name}" failed: ${error.message}`
        : "Internal Server Error",
      500,
    );
  }
}
