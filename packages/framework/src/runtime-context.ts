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
}: {
  children: ComponentChildren;
  data: TData;
  params?: RouteParams;
  routeId: string;
  routes?: readonly HrefRouteDefinition[];
  stateVersion?: number;
  url: string;
}) {
  registerRuntimeRoutes(routes);

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
      routes,
      setData: (nextData: unknown) =>
        setRouteDataState({
          data: nextData as TData,
          stateVersion,
        }),
      url,
    }),
    [routeData, params, routeId, routes, stateVersion, url],
  );

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
