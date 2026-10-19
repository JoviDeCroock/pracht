/**
 * jsdom harness for the client router's `navigate()`.
 *
 * It boots `initClientRouter()` against a fake `fetch`, fake route and shell
 * chunks and the real jsdom history, and records every time the router hands
 * a URL back to the browser — `location.href = …`, `location.assign()`,
 * `location.replace()` and `location.reload()` — instead of letting jsdom
 * attempt (and fail) a document navigation.
 *
 * Reads of `window.location` go to the real jsdom location, so `pushState`
 * and `replaceState` stay visible to the router exactly as in a browser.
 *
 * A test file that needs the static-export target mocks
 * `../src/runtime-static.ts` before importing this module; route-state
 * replies are then served from the static state-file URLs.
 */
import { render } from "preact";
import { vi, type Mock } from "vitest";

import { _resetForTesting as resetHydrationForTesting } from "../src/hydration.ts";
import { _resetHydrationMismatchForTesting } from "../src/hydration-mismatch.ts";
import { _resetNavigationForTesting } from "../src/navigation-state.ts";
import { clearPrefetchCache } from "../src/prefetch-cache.ts";
import { initClientRouter, type InitClientRouterOptions } from "../src/router.ts";
import { buildRouteStateUrl } from "../src/runtime-client-fetch.ts";
import { buildStaticRouteStateUrl, IS_STATIC_TARGET } from "../src/runtime-static.ts";

export const NOT_FOUND_ROUTE_ID = "__pracht_not_found__";

// --- Document hand-offs ------------------------------------------------------

export type HandoffKind = "href" | "assign" | "replace" | "reload";

export interface Handoff {
  kind: HandoffKind;
  /** Path + query + fragment for a same-origin URL, the full URL otherwise. */
  url: string;
}

function describeUrl(raw: string, base: string): string {
  try {
    const url = new URL(raw, base);
    return url.origin === new URL(base).origin ? url.pathname + url.search + url.hash : url.href;
  } catch {
    return raw;
  }
}

export interface LocationRecorder {
  handoffs: Handoff[];
  restore(): void;
}

/**
 * Replace `window.location` with one that reads through to jsdom's location
 * and records, rather than performs, every document navigation.
 */
export function installLocationRecorder(): LocationRecorder {
  const real = window.location;
  const handoffs: Handoff[] = [];
  const record = (kind: HandoffKind, raw: string) =>
    handoffs.push({ kind, url: describeUrl(String(raw), real.href) });
  const fake = {
    get href() {
      return real.href;
    },
    set href(value: string) {
      record("href", value);
    },
    get origin() {
      return real.origin;
    },
    get protocol() {
      return real.protocol;
    },
    get host() {
      return real.host;
    },
    get hostname() {
      return real.hostname;
    },
    get port() {
      return real.port;
    },
    get pathname() {
      return real.pathname;
    },
    get search() {
      return real.search;
    },
    get hash() {
      return real.hash;
    },
    assign(value: string) {
      record("assign", value);
    },
    replace(value: string) {
      record("replace", value);
    },
    reload() {
      record("reload", real.href);
    },
    toString() {
      return real.href;
    },
  };
  Object.defineProperty(window, "location", { configurable: true, value: fake });
  return {
    handoffs,
    restore() {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    },
  };
}

// --- Expected hand-offs ------------------------------------------------------

/** A hand-off matcher: the URL, and every kind that means the same thing here. */
export interface HandoffMatcher {
  url: string;
  kinds: readonly HandoffKind[];
}

/** A document navigation that adds a history entry, as a push should. */
export function pushes(url: string): HandoffMatcher {
  return { url, kinds: ["href", "assign"] };
}

/** A document navigation that takes over the current history entry. */
export function replaces(url: string): HandoffMatcher {
  return { url, kinds: ["replace"] };
}

/**
 * A document load of the URL the current history entry already shows. The
 * browser treats a navigation to the current URL as a replacement, so a
 * reload, a `replace()` and an `href` assignment are all the same here.
 */
export function inPlace(url: string): HandoffMatcher {
  return { url, kinds: ["href", "assign", "replace", "reload"] };
}

export function matchesHandoffs(
  actual: readonly Handoff[],
  expected: readonly HandoffMatcher[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((handoff, i) => {
      const want = expected[i];
      return handoff.url === want.url && want.kinds.includes(handoff.kind);
    })
  );
}

// --- Route-state replies -----------------------------------------------------

export type StateReply =
  | { kind: "data"; data: unknown }
  | { kind: "redirect"; location: string }
  | { kind: "error"; status: number; message?: string }
  | { kind: "opaque-redirect" }
  | { kind: "network-error" }
  | { kind: "deferred"; promise: Promise<StateReply> };

export const reply = {
  data: (data: unknown = null): StateReply => ({ kind: "data", data }),
  redirect: (location: string): StateReply => ({ kind: "redirect", location }),
  error: (status: number, message = "Not found"): StateReply => ({
    kind: "error",
    status,
    message,
  }),
  opaqueRedirect: (): StateReply => ({ kind: "opaque-redirect" }),
  networkError: (): StateReply => ({ kind: "network-error" }),
  deferred: (promise: Promise<StateReply>): StateReply => ({ kind: "deferred", promise }),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function toResponse(stateReply: StateReply): Promise<Response> {
  switch (stateReply.kind) {
    case "data":
      return json({ data: stateReply.data });
    case "redirect":
      return json({ redirect: stateReply.location });
    case "error":
      return json(
        {
          error: {
            message: stateReply.message,
            name: "PrachtHttpError",
            status: stateReply.status,
          },
        },
        stateReply.status,
      );
    case "opaque-redirect":
      // `fetch(…, { redirect: "manual" })` hides a 3xx behind an opaque
      // response, which a `Response` constructor cannot produce.
      return {
        headers: new Headers(),
        ok: false,
        status: 0,
        type: "opaqueredirect",
      } as Response;
    case "network-error":
      throw new TypeError("Failed to fetch");
    case "deferred":
      return toResponse(await stateReply.promise);
  }
}

// --- Fixtures ----------------------------------------------------------------

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function chunkFailure(): Promise<never> {
  return Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
}

/** Let fetches, chunk imports and Preact's debounced renders run out. */
export async function settle(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

// --- Mounting ----------------------------------------------------------------

type ModuleMap = Record<string, () => Promise<unknown>>;
type InitialState = InitClientRouterOptions["initialState"];

export interface MountOptions {
  app: InitClientRouterOptions["app"];
  routeModules: ModuleMap;
  shellModules?: ModuleMap;
  /** The URL the document was served at. Default `/`. */
  url?: string;
  /** The server-rendered markup in the root element. */
  html?: string;
  /** Default: the hydration state of an SSR page for `routeId` at `url`. */
  initialState?: InitialState;
  routeId?: string;
  /**
   * Boot the static-export SPA fallback document (`200.html`) at `url`. The
   * static target must be mocked on for the file.
   */
  staticFallbackBoot?: boolean;
  /** Route-state replies keyed by the browser path the router requests. */
  state?: Record<string, StateReply>;
  /** Answers any other request (API calls); `undefined` falls through. */
  onFetch?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  rootModule?: InitClientRouterOptions["rootModule"];
}

export interface RouterHarness {
  root: HTMLDivElement;
  handoffs: Handoff[];
  fetch: Mock;
  /** Every URL `fetch()` was called with, in order. */
  fetched: string[];
  errors: Mock;
  /** The error `initClientRouter()` rejected with, when it did. */
  bootError: unknown;
  /** The router's own navigate, internal options included. */
  navigate(to: string, options?: Record<string, unknown>): Promise<void>;
  /** A history traversal to `url` that the router did not commit itself. */
  popstate(url: string): Promise<void>;
  setState(path: string, stateReply: StateReply): void;
  teardown(): void;
}

let active: RouterHarness | null = null;

/** Tear down whichever harness is still mounted; call from `afterEach`. */
export function teardownRouterHarness(): void {
  active?.teardown();
  active = null;
}

function stateUrlFor(path: string): string[] {
  if (IS_STATIC_TARGET) return [buildStaticRouteStateUrl(path)];
  return [path, buildRouteStateUrl(path)];
}

export async function mountRouter(options: MountOptions): Promise<RouterHarness> {
  teardownRouterHarness();
  const url = options.url ?? "/";

  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-pracht-hydrated");
  const root = document.createElement("div");
  root.innerHTML = options.html ?? (options.staticFallbackBoot ? "" : "<main>home</main>");
  document.body.appendChild(root);
  history.replaceState(null, "", url);
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  sessionStorage.clear();
  clearPrefetchCache();
  _resetNavigationForTesting();

  const state = new Map<string, StateReply>();
  const setState = (path: string, stateReply: StateReply) => {
    for (const key of stateUrlFor(path)) state.set(key, stateReply);
  };
  for (const [path, stateReply] of Object.entries(options.state ?? {})) setState(path, stateReply);

  const fetched: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requested = typeof input === "string" ? input : String(input);
    fetched.push(requested);
    const custom = options.onFetch?.(requested, init);
    if (custom) return custom;
    const stateReply = state.get(requested);
    return stateReply ? toResponse(stateReply) : json({ data: null });
  });
  vi.stubGlobal("fetch", fetchMock);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {}) as unknown as Mock;

  const recorder = installLocationRecorder();

  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
  const targets: EventTarget[] = [window, document];
  const originals = targets.map((target) => target.addEventListener.bind(target));
  targets.forEach((target, i) => {
    target.addEventListener = ((type: string, handler: EventListenerOrEventListenerObject) => {
      listeners.push([target, type, handler]);
      originals[i](type, handler);
    }) as typeof target.addEventListener;
  });

  const initialState: InitialState =
    options.initialState ??
    (options.staticFallbackBoot
      ? {
          data: undefined,
          error: null,
          fallback: true,
          pending: true,
          routeId: NOT_FOUND_ROUTE_ID,
          url: "/",
        }
      : { data: null, routeId: options.routeId ?? "home", url });

  let tornDown = false;
  const harness: RouterHarness = {
    root,
    handoffs: recorder.handoffs,
    fetch: fetchMock,
    fetched,
    errors,
    bootError: undefined,
    async navigate(to, navigateOptions) {
      await window.__PRACHT_NAVIGATE__!(to, navigateOptions);
      await settle();
    },
    async popstate(to) {
      history.pushState(null, "", to);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      await settle();
    },
    setState,
    teardown() {
      if (tornDown) return;
      tornDown = true;
      recorder.restore();
      for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
      try {
        render(null, root);
      } catch {
        // A route that threw while booting can throw again on unmount.
      }
      root.remove();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete window.__PRACHT_NAVIGATE__;
      delete window.__PRACHT_ROUTER_READY__;
      document.documentElement.removeAttribute("data-pracht-hydrated");
      history.replaceState(null, "", "/");
      clearPrefetchCache();
      _resetNavigationForTesting();
      resetHydrationForTesting();
      _resetHydrationMismatchForTesting();
    },
  };
  active = harness;

  try {
    await initClientRouter({
      app: options.app,
      routeModules: options.routeModules,
      shellModules: options.shellModules ?? {},
      initialState,
      root,
      findModuleKey: (_modules, file) => file,
      rootModule: options.rootModule,
    });
  } catch (error) {
    harness.bootError = error;
  } finally {
    targets.forEach((target, i) => {
      target.addEventListener = originals[i] as typeof target.addEventListener;
    });
  }
  await settle();
  return harness;
}
