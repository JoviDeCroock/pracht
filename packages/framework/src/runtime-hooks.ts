import { createContext, h } from "preact";
import type { ComponentChildren, JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import {
  EMPTY_ROUTE_PARAMS,
  HYDRATION_STATE_ELEMENT_ID,
  SAFE_METHODS,
} from "./runtime-constants.ts";
import { deserializeRouteError, type SerializedRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type { RouteParams } from "./types.ts";

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

export interface Location {
  pathname: string;
  search: string;
}

declare global {
  interface Window {
    __PRACHT_STATE__?: PrachtHydrationState;
    __PRACHT_NAVIGATE__?: (to: string, options?: { replace?: boolean }) => Promise<void>;
  }
}

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

  const state = JSON.parse(raw) as PrachtHydrationState<TData>;
  window.__PRACHT_STATE__ = state as PrachtHydrationState;
  return state;
}

export function useRouteData<TData = unknown>(): TData {
  return useContext(RouteDataContext)?.data as TData;
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

export function parseLocation(value: string): Location {
  const url = new URL(value, "http://pracht.local");
  return {
    pathname: url.pathname,
    search: url.search,
  };
}
