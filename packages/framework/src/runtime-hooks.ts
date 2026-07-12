import { h } from "preact";
import type { JSX } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  formDataToRecord,
  isApiValidationErrorBody,
  validateStandardSchema,
  type ApiValidationIssue,
} from "./api-validation.ts";
import { buildHref } from "./route-matching.ts";
import {
  beginSubmittingNavigation,
  createNavigationLocation,
  getNavigation,
  settleNavigation,
  subscribeToNavigation,
  type Navigation,
} from "./navigation-state.ts";
import {
  PREFETCH_ATTRIBUTE,
  PRESERVE_SCROLL_ATTRIBUTE,
  SAFE_METHODS,
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
import { clearPrefetchCache } from "./prefetch-cache.ts";
import { deserializeRouteError } from "./runtime-errors.ts";
import { fetchPrachtRouteState, navigateToClientLocation } from "./runtime-client-fetch.ts";
import type {
  ApiPath,
  LinkPrefetchStrategy,
  LoaderData,
  LoaderLike,
  RouteDataFor,
  RouteId,
  RouteParams,
  RouteTarget,
} from "./types.ts";

export { PrachtRuntimeProvider, readHydrationState, startApp };
export type { PrachtHydrationState, StartAppOptions };
export type { Navigation, NavigationLocation } from "./navigation-state.ts";

export interface FormProps extends Omit<JSX.HTMLAttributes<HTMLFormElement>, "action" | "method"> {
  /**
   * Form action. Autocompletes API route paths registered by `pracht typegen`
   * while still accepting any URL string (dynamic segments must be
   * interpolated by the caller).
   */
  action?: ApiPath | (string & {});
  method?: string;
  /**
   * Standard Schema validated against the form's data (one entry per field,
   * arrays for repeated fields) before submitting. When validation fails the
   * request is skipped and `onValidationIssues` fires with the issues.
   */
  schema?: StandardSchemaV1;
  /**
   * Called with normalized validation issues when the client-side `schema`
   * rejects a submission, or when the server responds with the standardized
   * validation failure produced by `defineApi()` (HTTP 400/422,
   * `{ error: "validation", issues }`).
   */
  onValidationIssues?: (issues: ApiValidationIssue[]) => void;
  /**
   * Called with the server's response for every non-redirect fetch
   * submission — success payloads (2xx) and failures (4xx/5xx) alike. Read
   * the body with `response.json()`; validation-issue handling parses a
   * clone, so the body is never consumed before this callback.
   */
  onResponse?: (response: Response) => void;
}

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

const validatedNativeSubmissions = new WeakSet<HTMLFormElement>();

export interface Location {
  pathname: string;
  search: string;
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
    const result = await fetchPrachtRouteState(path, { cache: "reload" });

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
    props as LinkProps<RouteId> & {
      hash?: string;
      params?: Record<string, string | number | boolean>;
      search?: unknown;
    };

  return h("a", {
    ...anchorProps,
    href: buildHref(routes, route, { params, search, hash } as never),
    // Read by the client router's click handler and the prefetch listeners.
    [PREFETCH_ATTRIBUTE]: prefetch,
    [PRESERVE_SCROLL_ATTRIBUTE]: preserveScroll ? "" : undefined,
    [VIEW_TRANSITION_ATTRIBUTE]: viewTransition ? "" : undefined,
  } as JSX.HTMLAttributes<HTMLAnchorElement>);
}

export function Form(props: FormProps) {
  const { onSubmit, method, schema, onValidationIssues, onResponse, ...rest } = props;

  return h("form", {
    ...rest,
    method,
    onSubmit: async (event: Event) => {
      const form = event.currentTarget;
      if (!(form instanceof HTMLFormElement)) {
        return;
      }
      if (validatedNativeSubmissions.delete(form)) {
        return;
      }

      onSubmit?.(event as never);
      if (event.defaultPrevented) {
        return;
      }

      const submitter =
        typeof SubmitEvent !== "undefined" && event instanceof SubmitEvent ? event.submitter : null;
      const nativeSubmitter =
        (submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement) &&
        submitter.form === form
          ? submitter
          : undefined;
      const submitterMethod = nativeSubmitter?.getAttribute("formmethod") || undefined;
      const formMethod = (submitterMethod ?? method ?? form.method ?? "post").toUpperCase();
      const isSafeMethod = SAFE_METHODS.has(formMethod);
      if (isSafeMethod && !schema) {
        return;
      }

      event.preventDefault();
      const submitterAction = nativeSubmitter?.getAttribute("formaction");
      const actionUrl = submitterAction ?? props.action ?? form.action;
      const formData = new FormData(form, nativeSubmitter);

      if (schema) {
        const result = await validateStandardSchema(schema, formDataToRecord(formData), "body");
        if (result.issues) {
          onValidationIssues?.(result.issues);
          return;
        }
      }

      if (isSafeMethod) {
        validatedNativeSubmissions.add(form);
        try {
          form.requestSubmit(nativeSubmitter);
        } finally {
          validatedNativeSubmissions.delete(form);
        }
        return;
      }

      clearPrefetchCache();
      // Expose the in-flight submission through useNavigation().
      const navigationToken = beginSubmittingNavigation(
        createNavigationLocation(actionUrl),
        formData,
      );
      try {
        const response = await fetch(actionUrl, {
          method: formMethod,
          body: formData,
          redirect: "manual",
        });

        if (
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          const location = response.headers.get("location");
          await navigateToClientLocation(location ?? actionUrl, { reloadRouteState: true });
        } else {
          if ((response.status === 400 || response.status === 422) && onValidationIssues) {
            const body = await response
              .clone()
              .json()
              .catch(() => null);
            if (isApiValidationErrorBody(body)) {
              onValidationIssues(body.issues);
            }
          }
          onResponse?.(response);
        }
      } finally {
        settleNavigation(navigationToken);
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
