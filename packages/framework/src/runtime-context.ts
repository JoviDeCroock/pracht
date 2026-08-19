import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";
import { createContext, h } from "preact";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";

import { EMPTY_ROUTE_PARAMS, HYDRATION_STATE_ELEMENT_ID } from "./runtime-constants.ts";
import { revalidateRouteData, shouldRevalidateAfterCapability } from "./runtime-revalidate.ts";
import type { HrefRouteDefinition, RouteParams } from "./types.ts";

export interface PrachtHydrationState<TData = unknown> {
  url: string;
  routeId: string;
  data: TData;
  error?: import("./runtime-errors.ts").SerializedRouteError | null;
  pending?: boolean;
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

  // Effect-driven revalidation: capabilities are effect-classed, so the
  // runtime can refresh route data after any successful non-`read` call made
  // from the browser — `callCapability()` and `<Form capability>` announce
  // themselves via CAPABILITY_SETTLED_EVENT instead of importing the router.
  useEffect(() => {
    const handleSettled = (event: Event) => {
      if (!shouldRevalidateAfterCapability((event as CustomEvent).detail)) return;
      void revalidateRouteData(context).catch(() => {
        // Revalidation is best-effort; the mutation itself already succeeded.
      });
    };
    window.addEventListener(CAPABILITY_SETTLED_EVENT, handleSettled);
    return () => window.removeEventListener(CAPABILITY_SETTLED_EVENT, handleSettled);
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
  window.__PRACHT_STATE__ = state as PrachtHydrationState;
  return state;
}

function registerRuntimeRoutes(routes: readonly HrefRouteDefinition[] | undefined): void {
  if (!routes) return;
  globalThis.__PRACHT_ROUTE_DEFINITIONS__ = routes;
}
