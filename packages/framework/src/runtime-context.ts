import { rehydrateDeferredData } from "./defer.ts";
import { createContext, h } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { EMPTY_ROUTE_PARAMS, HYDRATION_STATE_ELEMENT_ID } from "./runtime-constants.ts";
import type { HrefRouteDefinition, RouteParams } from "./types.ts";

export interface PrachtHydrationState<TData = unknown> {
  url: string;
  routeId: string;
  data: TData;
  error?: import("./runtime-errors.ts").SerializedRouteError | null;
  pending?: boolean;
  /**
   * Marks the static-export SPA fallback document (`200.html`). The document
   * is served for URLs with no prerendered file, so the client router ignores
   * the serialized `url` and boots from `window.location` instead.
   */
  fallback?: boolean;
}

export interface StartAppOptions<TData = unknown> {
  initialData?: TData;
}

declare global {
  var __PRACHT_ROUTE_DEFINITIONS__: readonly HrefRouteDefinition[] | undefined;

  interface Window {
    __PRACHT_STATE__?: PrachtHydrationState;
  }
}

export interface PrachtRuntimeValue {
  data: unknown;
  params: RouteParams;
  routeId: string;
  routes?: readonly HrefRouteDefinition[];
  url: string;
  /** True while this provider still owns the router's active route state. */
  isCurrent?: () => boolean;
  setData: (data: unknown) => void;
}

export const RouteDataContext = createContext<PrachtRuntimeValue | undefined>(undefined);

/**
 * Runtime values of every mounted provider, in mount order.
 *
 * Effect-driven revalidation (`runtime-capability-revalidate.ts`) reads this
 * instead of the provider subscribing to `CAPABILITY_SETTLED_EVENT` itself:
 * the listener is only installed by code that can *dispatch* the event, so an
 * app with no capabilities never pulls the revalidation machinery — or
 * `@pracht/capabilities` — into its client bundle. Keeping the set live rather
 * than registering a subscriber also makes the two independent of ordering: a
 * provider that mounted before the first `callCapability()` is still found.
 */
const mountedRuntimes = new Set<PrachtRuntimeValue>();

/** @internal Live runtime values of the currently mounted providers. */
export function getMountedRuntimes(): ReadonlySet<PrachtRuntimeValue> {
  return mountedRuntimes;
}

export function PrachtRuntimeProvider<TData>({
  children,
  data,
  params = EMPTY_ROUTE_PARAMS,
  routeId,
  routes,
  stateVersion = 0,
  url,
  isCurrent,
}: {
  children: ComponentChildren;
  data: TData;
  params?: RouteParams;
  routeId: string;
  routes?: readonly HrefRouteDefinition[];
  stateVersion?: number;
  url: string;
  isCurrent?: () => boolean;
}) {
  registerRuntimeRoutes(routes);

  // A locally committed value (revalidation) is stored with the props that
  // were current when it was committed, so later renders can tell whether it
  // still belongs to the route on screen.
  const [routeDataState, setRouteDataState] = useState(() => ({
    data,
    routeId,
    source: data,
    stateVersion,
    url,
  }));
  // A new route state (navigation) supersedes anything committed for the
  // previous one. This is derived during render rather than reset from an
  // effect so it cannot lag behind the props. A URL-only update within the
  // same route state (publishing the browser query after hydration) preserves
  // locally revalidated data.
  const isStaleRoute =
    routeDataState.stateVersion !== stateVersion || routeDataState.routeId !== routeId;
  const routeData = isStaleRoute ? data : routeDataState.data;

  const context = useMemo(
    () => ({
      data: routeData,
      params,
      routeId,
      routes,
      isCurrent,
      // Stamped with the route state this context belongs to, never with
      // whatever the provider rendered last: a revalidation started on one
      // route can settle after a navigation, and the commit has to be
      // discarded as stale rather than published as the new route's data.
      setData: (nextData: unknown) =>
        setRouteDataState({
          data: nextData as TData,
          routeId,
          source: data,
          stateVersion,
          url,
        }),
      url,
    }),
    // `data` is deliberately not a dependency: it is read only as the `source`
    // stamp, and adding it would fan out a new context value on every
    // re-render above the provider (see runtime-context.test.ts).
    [routeData, params, routeId, routes, stateVersion, url, isCurrent],
  );

  // A fresh `data` prop for the same route state (a re-render above the
  // provider) replaces the committed value. The functional update is what
  // makes this safe: effects are deferred to a frame, so this can run *after*
  // a revalidation has already committed newer data, and comparing against the
  // source the commit was made from keeps it from overwriting that.
  useEffect(() => {
    setRouteDataState((current) => {
      if (
        current.source !== data ||
        current.stateVersion !== stateVersion ||
        current.routeId !== routeId
      ) {
        return { data, routeId, source: data, stateVersion, url };
      }

      return current.url === url ? current : { ...current, url };
    });
  }, [data, routeId, stateVersion, url]);

  // Publish this runtime value for effect-driven revalidation: capabilities
  // are effect-classed, so the runtime refreshes route data after any
  // successful non-`read` call made from the browser. `callCapability()` and
  // `<Form capability>` announce themselves via CAPABILITY_SETTLED_EVENT, and
  // the listener that acts on it lives with those dispatchers — see
  // `runtime-capability-revalidate.ts`.
  useEffect(() => {
    mountedRuntimes.add(context);
    return () => {
      mountedRuntimes.delete(context);
    };
  }, [context]);

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

  const state = JSON.parse(raw) as PrachtHydrationState<TData>;
  // Streamed documents serialize unresolved defer() values as sentinels; swap
  // them back for Deferred values here, the one place the client reads data.
  state.data = rehydrateDeferredData(state.data);
  window.__PRACHT_STATE__ = state as PrachtHydrationState;
  return state;
}

function registerRuntimeRoutes(routes: readonly HrefRouteDefinition[] | undefined): void {
  if (!routes) return;
  globalThis.__PRACHT_ROUTE_DEFINITIONS__ = routes;
}
