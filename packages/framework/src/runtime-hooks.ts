import { h } from "preact";
import type { JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";

import { buildHrefUntyped } from "./route-href.ts";
import { getNavigation, subscribeToNavigation, type Navigation } from "./navigation-state.ts";
import {
  PREFETCH_ATTRIBUTE,
  PRESERVE_SCROLL_ATTRIBUTE,
  VIEW_TRANSITION_ATTRIBUTE,
} from "./runtime-constants.ts";
import {
  PrachtRuntimeProvider,
  readHydrationState,
  RouteDataContext,
  startApp,
  type PrachtHydrationState,
  type StartAppOptions,
} from "./runtime-context.ts";
import { revalidateRouteData } from "./runtime-revalidate.ts";
import type {
  LinkPrefetchStrategy,
  LoaderData,
  LoaderLike,
  RouteDataFor,
  RouteId,
  RouteParams,
  RouteTarget,
  UntypedRouteTarget,
} from "./types.ts";

export { PrachtRuntimeProvider, readHydrationState, startApp };
export type { PrachtHydrationState, StartAppOptions };
export type { Navigation, NavigationLocation } from "./navigation-state.ts";
export { Form, type FormProps } from "./runtime-form.ts";

export type LinkProps<TRoute extends RouteId = RouteId> = Omit<
  JSX.HTMLAttributes<HTMLAnchorElement>,
  "href"
> &
  RouteTarget<TRoute> & {
    /**
     * Prefetch strategy for this link, overriding the route-level strategy:
     * `"intent"` (hover/focus), `"viewport"` (IntersectionObserver),
     * `"render"` (as soon as the link mounts), or `"none"`. When omitted the
     * route's `prefetch` meta applies (default: `"intent"`).
     */
    prefetch?: LinkPrefetchStrategy;
    /** Keep the current scroll position when this link navigates. */
    preserveScroll?: boolean;
    /**
     * Wrap the navigation triggered by this link in
     * `document.startViewTransition()` when supported.
     */
    viewTransition?: boolean;
  };

export interface Location {
  pathname: string;
  search: string;
}

export type ReadonlyURLSearchParams = Omit<URLSearchParams, "append" | "delete" | "set" | "sort">;

class PrachtReadonlyURLSearchParams extends URLSearchParams {
  readonly #mutationError =
    "useSearchParams() is read-only. Navigate to a new URL to change the query string.";

  override append(_name: string, _value: string): never {
    throw new TypeError(this.#mutationError);
  }

  override delete(_name: string, _value?: string): never {
    throw new TypeError(this.#mutationError);
  }

  override set(_name: string, _value: string): never {
    throw new TypeError(this.#mutationError);
  }

  override sort(): never {
    throw new TypeError(this.#mutationError);
  }
}

export function useRouteData<TRoute extends RouteId>(routeId: TRoute): RouteDataFor<TRoute>;
export function useRouteData<TLoader extends LoaderLike>(): LoaderData<TLoader>;
export function useRouteData<TData = unknown>(): TData;
export function useRouteData(routeId?: string): unknown {
  const runtime = useContext(RouteDataContext);
  if (import.meta.env?.DEV && routeId !== undefined && runtime && runtime.routeId !== routeId) {
    console.warn(
      `useRouteData("${routeId}") rendered inside route "${runtime.routeId}"; returning the active route's data.`,
    );
  }
  return runtime?.data;
}

export function useLocation(): Location {
  const url =
    useContext(RouteDataContext)?.url ??
    (typeof window !== "undefined" ? window.location.pathname + window.location.search : "/");
  return parseLocation(url);
}

/** Read the current URL search parameters reactively. */
export function useSearchParams(): ReadonlyURLSearchParams {
  const { search } = useLocation();
  return useMemo(() => new PrachtReadonlyURLSearchParams(search), [search]);
}

export function useParams(): RouteParams {
  return useContext(RouteDataContext)?.params ?? {};
}

export function useRevalidate() {
  const runtime = useContext(RouteDataContext);

  return () => revalidateRouteData(runtime);
}

/**
 * Reactive pending state for the current client navigation or `<Form>`
 * submission. Returns `{ state: "idle" }` when nothing is in flight,
 * `{ state: "loading", location }` while the router fetches and commits a
 * navigation, and `{ state: "submitting", location, formData }` while a
 * `<Form>` submission is awaiting its response. During SSR it always
 * returns the idle state.
 */
export function useNavigation(): Navigation {
  const [navigation, setNavigation] = useState<Navigation>(getNavigation);

  useEffect(() => {
    // Re-sync in case a navigation started between render and effect.
    setNavigation(getNavigation());
    return subscribeToNavigation(setNavigation);
  }, []);

  return navigation;
}

export function Link<TRoute extends RouteId>(props: LinkProps<TRoute>) {
  const runtime = useContext(RouteDataContext);
  const routes = runtime?.routes ?? globalThis.__PRACHT_ROUTE_DEFINITIONS__;
  if (!routes) {
    throw new Error("<Link route=...> must render inside a pracht route tree.");
  }

  const { route, params, search, hash, prefetch, preserveScroll, viewTransition, ...anchorProps } =
    props as unknown as Omit<JSX.HTMLAttributes<HTMLAnchorElement>, "href"> &
      UntypedRouteTarget & {
        prefetch?: LinkPrefetchStrategy;
        preserveScroll?: boolean;
        viewTransition?: boolean;
      };

  return h("a", {
    ...anchorProps,
    href: buildHrefUntyped(routes, route, { params, search, hash }),
    // Read by the client router's click handler and the prefetch listeners.
    [PREFETCH_ATTRIBUTE]: prefetch,
    [PRESERVE_SCROLL_ATTRIBUTE]: preserveScroll ? "" : undefined,
    [VIEW_TRANSITION_ATTRIBUTE]: viewTransition ? "" : undefined,
  } as JSX.HTMLAttributes<HTMLAnchorElement>);
}
export function parseLocation(value: string): Location {
  const url = new URL(value, "http://pracht.local");
  return {
    pathname: url.pathname,
    search: url.search,
  };
}
