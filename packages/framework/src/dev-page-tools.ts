/**
 * Dev-only WebMCP page tools: the open tab exposes its own debugging surface
 * to an agent-driven browser.
 *
 * A WebMCP-capable agent or test harness driving a page in `pracht dev` can ask the tab
 * which route matched, what the loader returned, which islands hydrated, and
 * what the last error was — with the context of *this* navigation, instead of
 * correlating server logs or a separately configured MCP server with the page
 * it is looking at.
 *
 * Served exclusively by the vite-plugin dev SSR middleware through the
 * generated `virtual:pracht/dev-page-tools` module, which feature-detects
 * `document.modelContext` before importing this file. Nothing here reaches a
 * production bundle: no runtime module imports it, and the plugin only injects
 * the script in dev. Every tool is read-only; the static route and capability
 * shape comes from the same `/_pracht.json` the devtools page renders, and the
 * live state comes from the mounted route runtime (or the hydration state
 * script when no client router is present).
 */

import { stripBase } from "./base.ts";
import { isDeferred } from "./defer.ts";
import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_STRATEGY_ATTRIBUTE,
  ISLANDS_HYDRATED_MARKER,
} from "./islands-shared.ts";
import { matchRoutePath } from "./route-matching.ts";
import { DEV_ERROR_OVERLAY_DATA_ID, ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import { getMountedRuntimes, readHydrationState } from "./runtime-context.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { RouteParams } from "./types.ts";
import { registerWebmcpTools, type WebmcpTool } from "@pracht/capabilities/webmcp";

/** Every dev page tool name starts with this, so hosts and tests can tell them from app tools. */
export const DEV_PAGE_TOOL_PREFIX = "pracht_";

export { DEV_ERROR_OVERLAY_DATA_ID };

/** Structured payload of the dev error overlay document. */
export interface DevErrorOverlayData {
  message: string;
  name?: string;
  stack?: string;
  phase?: string;
  routeId?: string;
  file?: string;
  loaderFile?: string;
  shellFile?: string;
  status?: number;
}

export interface DevPageToolsOptions {
  /** Absolute or root-relative URL of `/_pracht.json`, deploy base included. */
  devtoolsJsonUrl: string;
  /** Test seam; defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Number of client-side errors `pracht_last_error` keeps. */
  clientErrorLimit?: number;
}

/** The capability envelope every pracht page tool resolves to. */
export type DevPageToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: string; message: string } };

export interface DevPageTools {
  tools: WebmcpTool[];
  dispatch: (name: string, input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  /** Start recording uncaught client errors for `pracht_last_error`. Returns the uninstaller. */
  observeClientErrors: () => () => void;
}

interface DevPageToolsGraphRoute {
  id: string;
  path: string;
  file: string;
  render: string | null;
  hydration: string | null;
  shell: string | null;
  shellFile: string | null;
  loaderFile: string | null;
  loaderCache: number | false | null;
  middleware: string[];
  capabilities?: string[];
  streaming: boolean | null;
  prefetch: string | null;
  markdown?: true;
}

interface DevPageToolsGraphCapability {
  name: string;
  title: string | null;
  description: string | null;
  effect: string | null;
  transports: string[];
  httpPath: string | null;
  input: Record<string, unknown> | null;
  agentPolicy?: string | null;
  webmcpRoutes?: string[];
}

interface DevPageToolsGraph {
  routes: DevPageToolsGraphRoute[];
  notFound?: DevPageToolsGraphRoute | null;
  capabilities: DevPageToolsGraphCapability[];
  mcpEndpoint?: string | null;
}

interface CurrentRouteState {
  /** `runtime` when read from the mounted client router, `hydration-state` from the SSR script. */
  source: "runtime" | "hydration-state";
  routeId: string;
  url: string;
  params: RouteParams | null;
  data: unknown;
  error: SerializedRouteError | null;
}

interface ClientErrorRecord {
  at: number;
  kind: "error" | "unhandledrejection";
  message: string;
  stack?: string;
}

const EMPTY_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

export function createDevPageTools(options: DevPageToolsOptions): DevPageTools {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const clientErrorLimit = options.clientErrorLimit ?? 5;
  const clientErrors: ClientErrorRecord[] = [];

  function recordClientError(record: ClientErrorRecord): void {
    clientErrors.unshift(record);
    if (clientErrors.length > clientErrorLimit) clientErrors.length = clientErrorLimit;
  }

  async function loadGraph(signal?: AbortSignal): Promise<DevPageToolsGraph> {
    const response = await fetchImpl(options.devtoolsJsonUrl, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new DevPageToolError(
        "devtools_unavailable",
        `${options.devtoolsJsonUrl} answered ${response.status}; is this a pracht dev server?`,
      );
    }
    return (await response.json()) as DevPageToolsGraph;
  }

  function graphRouteFor(graph: DevPageToolsGraph, state: CurrentRouteState | null) {
    if (state) {
      const byId = graph.routes.find((route) => route.id === state.routeId);
      if (byId) return byId;
      if (graph.notFound?.id === state.routeId) return graph.notFound;
    }
    const pathname = currentPathname();
    if (pathname === null) return null;
    return graph.routes.find((route) => matchRoutePath(route.path, pathname) !== null) ?? null;
  }

  const handlers: Record<string, (input: unknown, signal?: AbortSignal) => Promise<unknown>> = {
    async [`${DEV_PAGE_TOOL_PREFIX}route`](_input, signal) {
      const state = currentRouteState();
      const graph = await loadGraph(signal);
      const route = graphRouteFor(graph, state);
      return {
        url: state?.url ?? currentHref(),
        routeId: state?.routeId ?? route?.id ?? null,
        params:
          state?.params ?? (route ? matchRoutePath(route.path, currentPathname() ?? "") : null),
        source: state?.source ?? null,
        matched: route
          ? {
              id: route.id,
              path: route.path,
              file: route.file,
              render: route.render,
              hydration: route.hydration ?? "full",
              streaming: route.streaming,
              shell: route.shell,
              shellFile: route.shellFile,
              loaderFile: route.loaderFile,
              loaderCache: route.loaderCache,
              middleware: route.middleware,
              prefetch: route.prefetch,
              capabilities: route.capabilities ?? [],
              ...(route.markdown ? { markdown: true } : {}),
              notFound: route === graph.notFound,
            }
          : null,
        clientRouter: hasClientRouter(),
      };
    },

    async [`${DEV_PAGE_TOOL_PREFIX}loader_data`](input, signal) {
      const state = currentRouteState();
      if (!state) {
        const graph = await loadGraph(signal).catch(() => null);
        const route = graph ? graphRouteFor(graph, null) : null;
        const hydration = route?.hydration;
        throw new DevPageToolError(
          "no_route_state",
          hydration === "islands" || hydration === "none"
            ? `Route ${JSON.stringify(route!.id)} renders with hydration: ${JSON.stringify(hydration)}, so its loader data never reaches the browser. Fetch the route URL with the "${ROUTE_STATE_REQUEST_HEADER}: 1" header (the request the client router makes) to read the serialized route state from the server.`
            : "This document carries no route state: it is not a rendered pracht route (an error overlay or dev 404 page, for example).",
        );
      }
      const path = readPathInput(input);
      const selected = path ? selectPath(state.data, path) : { found: true, value: state.data };
      if (!selected.found) {
        throw new DevPageToolError(
          "path_not_found",
          `No value at ${JSON.stringify(path)} in the loader data.`,
        );
      }
      return {
        routeId: state.routeId,
        url: state.url,
        source: state.source,
        ...(path ? { path } : {}),
        data: toSerializable(selected.value),
      };
    },

    async [`${DEV_PAGE_TOOL_PREFIX}islands`](_input, signal) {
      const state = currentRouteState();
      const graph = await loadGraph(signal).catch(() => null);
      const route = graph ? graphRouteFor(graph, state) : null;
      const elements =
        typeof document === "undefined"
          ? []
          : Array.from(document.querySelectorAll(ISLAND_ELEMENT));
      return {
        routeId: state?.routeId ?? route?.id ?? null,
        hydration: route ? (route.hydration ?? "full") : null,
        // The islands bootstrap sets the marker once every `load` island has
        // hydrated; a document without islands never gets one.
        allHydrated:
          elements.length === 0
            ? null
            : typeof document !== "undefined" &&
              document.documentElement.getAttribute(ISLANDS_HYDRATED_MARKER) === "true",
        islands: elements.map((element) => {
          const rawProps = element.getAttribute(ISLAND_PROPS_ATTRIBUTE);
          let props: unknown = null;
          let propsError: string | undefined;
          if (rawProps !== null) {
            try {
              props = JSON.parse(rawProps);
            } catch (error) {
              propsError = error instanceof Error ? error.message : String(error);
            }
          }
          return {
            file: element.getAttribute(ISLAND_FILE_ATTRIBUTE),
            export: element.getAttribute(ISLAND_EXPORT_ATTRIBUTE) ?? "default",
            strategy: element.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load",
            hydrated: element.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "true",
            props,
            ...(propsError ? { propsError } : {}),
          };
        }),
      };
    },

    async [`${DEV_PAGE_TOOL_PREFIX}last_error`]() {
      const state = currentRouteState();
      return {
        server: readOverlayError() ?? state?.error ?? null,
        client: clientErrors.map((record) => ({ ...record })),
      };
    },

    async [`${DEV_PAGE_TOOL_PREFIX}page_tools`](_input, signal) {
      const state = currentRouteState();
      const graph = await loadGraph(signal);
      const route = graphRouteFor(graph, state);
      const declared = route?.capabilities ?? [];
      const byName = new Map(graph.capabilities.map((capability) => [capability.name, capability]));
      const active: unknown[] = [];
      const inactive: unknown[] = [];
      for (const name of declared) {
        const capability = byName.get(name);
        if (!capability) {
          inactive.push({ name, reason: "not registered in defineApp({ capabilities })" });
          continue;
        }
        if (!capability.transports.includes("webmcp")) {
          inactive.push({ name, reason: "capability does not set expose.webmcp" });
          continue;
        }
        active.push({
          name: capability.name,
          title: capability.title,
          description: capability.description,
          effect: capability.effect,
          httpPath: capability.httpPath,
          input: capability.input,
        });
      }
      return {
        routeId: state?.routeId ?? route?.id ?? null,
        active,
        inactive,
        mcpEndpoint: graph.mcpEndpoint ?? null,
      };
    },
  };

  const tools: WebmcpTool[] = [
    {
      name: `${DEV_PAGE_TOOL_PREFIX}route`,
      title: "Pracht: matched route",
      description:
        "Dev-only. Which pracht route this tab is showing: route id, URL, params, render and hydration mode, shell chain, files, and middleware. Read this first when a page looks wrong.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      effect: "read",
    },
    {
      name: `${DEV_PAGE_TOOL_PREFIX}loader_data`,
      title: "Pracht: loader data",
      description:
        'Dev-only. The loader data the current route is rendering with, as the page holds it right now (revalidation included). Pass a dotted path such as "notes.0.title" to read one value.',
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Dotted path into the loader data; omit for everything.",
          },
        },
        additionalProperties: false,
      },
      effect: "read",
    },
    {
      name: `${DEV_PAGE_TOOL_PREFIX}islands`,
      title: "Pracht: islands",
      description:
        "Dev-only. The route's hydration mode and every island on the page with its source file, client strategy, serialized props, and whether it has hydrated.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      effect: "read",
    },
    {
      name: `${DEV_PAGE_TOOL_PREFIX}last_error`,
      title: "Pracht: last error",
      description:
        "Dev-only. The server-side error this document rendered (error overlay or ErrorBoundary state) plus the most recent uncaught client errors, with stack traces.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      effect: "read",
    },
    {
      name: `${DEV_PAGE_TOOL_PREFIX}page_tools`,
      title: "Pracht: page tools on this route",
      description:
        "Dev-only. The app's own WebMCP tools active on this route (the production agent surface), plus declared capabilities that are not exposed as page tools and why.",
      inputSchema: EMPTY_INPUT_SCHEMA,
      effect: "read",
    },
  ];

  return {
    tools,
    async dispatch(name, input, { signal } = {}): Promise<DevPageToolResult> {
      const handler = handlers[name];
      if (!handler) {
        return {
          ok: false,
          error: { code: "unknown_tool", message: `Unknown dev page tool ${name}` },
        };
      }
      try {
        return { ok: true, data: await handler(input, signal) };
      } catch (error) {
        if (error instanceof DevPageToolError) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
        return {
          ok: false,
          error: {
            code: "tool_failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
    observeClientErrors() {
      if (typeof window === "undefined") return () => {};
      const onError = (event: ErrorEvent) => {
        const error = event.error;
        recordClientError({
          at: Date.now(),
          kind: "error",
          message: error instanceof Error ? error.message : event.message,
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
      };
      const onRejection = (event: PromiseRejectionEvent) => {
        const reason = event.reason;
        recordClientError({
          at: Date.now(),
          kind: "unhandledrejection",
          message: reason instanceof Error ? reason.message : String(reason),
          ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
        });
      };
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      return () => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      };
    },
  };
}

export interface DevPageToolsRegistration {
  /** Removes the tools from the document's model context and stops observing errors. */
  abort(): void;
}

/**
 * Register the dev page tools with the browser's model context. Returns
 * `null` when the WebMCP API is absent — the generated module already
 * feature-detects, so this is a second guard, not the primary one.
 */
export function registerDevPageTools(
  options: DevPageToolsOptions,
): DevPageToolsRegistration | null {
  const controller = new AbortController();
  const pageTools = createDevPageTools(options);
  const registered = registerWebmcpTools(pageTools.tools, pageTools.dispatch, {
    signal: controller.signal,
  });
  if (!registered) return null;
  const stopObserving = pageTools.observeClientErrors();
  return {
    abort() {
      stopObserving();
      controller.abort();
    },
  };
}

class DevPageToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DevPageToolError";
  }
}

function currentRouteState(): CurrentRouteState | null {
  let current: CurrentRouteState | null = null;
  for (const runtime of getMountedRuntimes()) {
    // A provider whose `isCurrent` says no is an outgoing route still
    // unmounting; the newest current one wins.
    if (runtime.isCurrent?.() === false) continue;
    current = {
      source: "runtime",
      routeId: runtime.routeId,
      url: runtime.url,
      params: runtime.params,
      data: runtime.data,
      error: null,
    };
  }
  if (current) {
    const state = readHydrationState();
    // The SSR error only describes the initial document; after a client
    // navigation it belongs to a different route.
    if (state && state.routeId === current.routeId && state.url === current.url) {
      current.error = state.error ?? null;
    }
    return current;
  }
  const state = readHydrationState();
  if (!state) return null;
  return {
    source: "hydration-state",
    routeId: state.routeId,
    url: state.url,
    params: null,
    data: state.data,
    error: state.error ?? null,
  };
}

function hasClientRouter(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __PRACHT_ROUTER_READY__?: boolean }).__PRACHT_ROUTER_READY__ === true
  );
}

/** Same shape as the runtime's `url`: path plus search, no origin. */
function currentHref(): string | null {
  return typeof window === "undefined" ? null : window.location.pathname + window.location.search;
}

/**
 * The route-space pathname: graph route paths carry no deploy base, so strip
 * it the way the client router does before matching. `null` outside the base.
 */
function currentPathname(): string | null {
  return typeof window === "undefined" ? null : stripBase(window.location.pathname);
}

function readOverlayError(): DevErrorOverlayData | null {
  if (typeof document === "undefined") return null;
  const element = document.getElementById(DEV_ERROR_OVERLAY_DATA_ID);
  if (!element || !element.textContent) return null;
  try {
    return JSON.parse(element.textContent) as DevErrorOverlayData;
  } catch {
    return null;
  }
}

function readPathInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  if (path === undefined || path === null || path === "") return undefined;
  if (typeof path !== "string") {
    throw new DevPageToolError(
      "invalid_input",
      '`path` must be a dotted string such as "notes.0.title".',
    );
  }
  return path;
}

function selectPath(value: unknown, path: string): { found: boolean; value: unknown } {
  let current = value;
  for (const segment of path.split(".")) {
    // Own data properties only: loader data is JSON, so a prototype hit
    // (`constructor`, `__proto__`) is never the value the caller meant.
    if (current === null || typeof current !== "object") return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

const SERIALIZE_MAX_DEPTH = 12;
const SERIALIZE_MAX_ITEMS = 500;
const SERIALIZE_MAX_STRING = 10_000;
/**
 * Total object nodes one call may visit. Cycle detection tracks the current
 * path, not every visited object (a subgraph shared by two keys is real data,
 * not a cycle), so this is what bounds a wide DAG rather than depth alone.
 */
const SERIALIZE_MAX_NODES = 20_000;

interface SerializeState {
  /** Objects on the current descent path — a repeat is a cycle. */
  path: WeakSet<object>;
  nodes: number;
}

function throwsMarker(error: unknown): { $throws: string } {
  return { $throws: error instanceof Error ? error.message : String(error) };
}

/**
 * Loader data is JSON on the wire, but the page may hold values that are not:
 * a `Deferred` whose promise is still pending, a `Date` a component stored, a
 * cycle introduced by a `setData()` call, a Proxy-backed row whose trap
 * throws. The host serializes the tool result itself, so hand it something
 * that always survives `JSON.stringify` — every probe and every recursion is
 * guarded, and one hostile value reports itself as `{ $throws }` for its own
 * key instead of taking the payload with it.
 */
export function toSerializable(
  value: unknown,
  depth: number = 0,
  state: SerializeState = { path: new WeakSet(), nodes: 0 },
): unknown {
  try {
    return serializeValue(value, depth, state);
  } catch (error) {
    return throwsMarker(error);
  }
}

function serializeValue(value: unknown, depth: number, state: SerializeState): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case "string":
      return value.length > SERIALIZE_MAX_STRING
        ? `${value.slice(0, SERIALIZE_MAX_STRING)}… [${value.length - SERIALIZE_MAX_STRING} more characters]`
        : value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return `${value}n`;
    case "function":
      return `[Function ${value.name || "anonymous"}]`;
    case "symbol":
      return value.toString();
    default:
      break;
  }
  const object = value as object;
  if (state.path.has(object)) return "[Circular]";
  if (depth >= SERIALIZE_MAX_DEPTH) return "[Truncated: max depth]";
  if (state.nodes++ >= SERIALIZE_MAX_NODES) return "[Truncated: node budget]";
  if (isDeferred(object)) return { $deferred: true, note: "read it with use() in the component" };
  if (object instanceof Promise) return { $promise: true };
  if (object instanceof Error) {
    return {
      $error: object.name,
      message: object.message,
      ...(object.stack ? { stack: object.stack } : {}),
    };
  }
  if (object instanceof Date) return object.toISOString();
  if (typeof URL !== "undefined" && object instanceof URL) return object.href;
  if (ArrayBuffer.isView(object)) {
    return `[${object.constructor.name} ${object.byteLength} bytes]`;
  }
  state.path.add(object);
  try {
    if (Array.isArray(object)) {
      const length = object.length;
      const items: unknown[] = [];
      for (let index = 0; index < Math.min(length, SERIALIZE_MAX_ITEMS); index += 1) {
        items.push(serializeChild(() => object[index], depth, state));
      }
      if (length > SERIALIZE_MAX_ITEMS) items.push(`[${length - SERIALIZE_MAX_ITEMS} more items]`);
      return items;
    }
    if (object instanceof Map) {
      return serializeValue(Array.from(object.entries()), depth, state);
    }
    if (object instanceof Set) {
      return serializeValue(Array.from(object.values()), depth, state);
    }
    const keys = Object.keys(object);
    const result: Record<string, unknown> = {};
    let count = 0;
    for (const key of keys) {
      if (count++ >= SERIALIZE_MAX_ITEMS) {
        result["…"] = `[${keys.length - SERIALIZE_MAX_ITEMS} more keys]`;
        break;
      }
      result[key] = serializeChild(() => (object as Record<string, unknown>)[key], depth, state);
    }
    return result;
  } finally {
    state.path.delete(object);
  }
}

/** Read one child and serialize it; a throw anywhere in that becomes the child's own marker. */
function serializeChild(read: () => unknown, depth: number, state: SerializeState): unknown {
  try {
    return serializeValue(read(), depth + 1, state);
  } catch (error) {
    return throwsMarker(error);
  }
}
