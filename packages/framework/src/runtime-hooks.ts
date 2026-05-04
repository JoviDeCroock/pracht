import { createContext, h } from "preact";
import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import { buildHref } from "./app.ts";
import {
  EMPTY_ROUTE_PARAMS,
  HYDRATION_STATE_ELEMENT_ID,
  SAFE_METHODS,
} from "./runtime-constants.ts";
import { clearPrefetchCache } from "./prefetch.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type {
  HrefRouteDefinition,
  LoaderData,
  LoaderLike,
  RouteId,
  RouteParams,
  RouteTarget,
} from "./types.ts";

export interface PrachtHydrationState<TData = unknown> {
  url: string;
  routeId: string;
  data: TData;
  error?: SerializedRouteError | null;
  pending?: boolean;
}

export interface StartAppOptions<TData = unknown> {
  initialData?: TData;
}

export interface FormProps extends Omit<JSX.HTMLAttributes<HTMLFormElement>, "action" | "method"> {
  action?: string;
  method?: string;
}

export type LinkProps<TRoute extends RouteId = RouteId> = Omit<
  JSX.HTMLAttributes<HTMLAnchorElement>,
  "href"
> &
  RouteTarget<TRoute>;

export interface Location {
  pathname: string;
  search: string;
}

declare global {
  var __PRACHT_ROUTE_DEFINITIONS__: readonly HrefRouteDefinition[] | undefined;

  interface Window {
    __PRACHT_STATE__?: PrachtHydrationState;
  }
}

interface PrachtRuntimeValue {
  data: unknown;
  params: RouteParams;
  routeId: string;
  routes?: readonly HrefRouteDefinition[];
  url: string;
  setData: (data: unknown) => void;
}

const RouteDataContext = createContext<PrachtRuntimeValue | undefined>(undefined);

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

export function useRouteData<TLoader extends LoaderLike>(): LoaderData<TLoader>;
export function useRouteData<TData = unknown>(): TData;
export function useRouteData(): unknown {
  return useContext(RouteDataContext)?.data;
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

export function Link<TRoute extends RouteId>(props: LinkProps<TRoute>) {
  const runtime = useContext(RouteDataContext);
  const routes = runtime?.routes ?? globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  if (!routes) {
    throw new Error("<Link route=...> must render inside a pracht route tree.");
  }

  const { route, params, search, hash, ...anchorProps } = props as LinkProps<RouteId> & {
    hash?: string;
    params?: Record<string, string | number | boolean>;
    search?: unknown;
  };

  return h("a", {
    ...anchorProps,
    href: buildHref(routes, route, { params, search, hash } as never),
  } as unknown as JSX.HTMLAttributes<HTMLAnchorElement>);
}

function registerRuntimeRoutes(routes: readonly HrefRouteDefinition[] | undefined): void {
  if (!routes) return;
  globalThis.__PRACHT_ROUTE_DEFINITIONS__ = routes;
}

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
      clearPrefetchCache();
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

export function parseLocation(value: string): Location {
  const url = new URL(value, "http://pracht.local");
  return {
    pathname: url.pathname,
    search: url.search,
  };
}
