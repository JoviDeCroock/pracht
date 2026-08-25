import { h } from "preact";
import type { JSX } from "preact";
import { useContext, useEffect, useMemo, useState } from "preact/hooks";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import {
  formDataToRecord,
  isApiValidationErrorBody,
  validateStandardSchema,
  type ApiValidationIssue,
} from "./api-validation.ts";
import { withBase } from "./base.ts";
import { buildHrefUntyped } from "./route-matching.ts";
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
  SPECULATE_ATTRIBUTE,
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
import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
  CAPABILITY_SETTLED_EVENT,
  capabilityHttpPath,
} from "@pracht/capabilities";
import { clearPrefetchCache } from "./prefetch-cache.ts";
import { ensureCapabilityRevalidation } from "./runtime-capability-revalidate.ts";
import { navigateToClientLocation, parseSafeNavigationUrl } from "./runtime-client-fetch.ts";
import { revalidateRouteData } from "./runtime-revalidate.ts";
import type {
  ApiPath,
  CapabilityEnvelope,
  CapabilityOutputFor,
  HttpCapabilityName,
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

/** Envelope data type for a capability name, when typegen has registered it. */
type CapabilityFormResult<TName extends string> = CapabilityEnvelope<CapabilityOutputFor<TName>>;

export interface FormProps<TName extends HttpCapabilityName = HttpCapabilityName> extends Omit<
  JSX.HTMLAttributes<HTMLFormElement>,
  "action" | "method"
> {
  /**
   * Form action. Autocompletes API route paths registered by `pracht typegen`
   * while still accepting any URL string (dynamic segments must be
   * interpolated by the caller).
   */
  action?: ApiPath | (string & {});
  method?: string;
  /**
   * Post this form to a capability's HTTP projection instead of an `action`
   * URL — the same endpoint agents call, so the human form and the agent
   * tool literally share one contract. Fields are coerced onto the
   * capability's input schema server-side; after a successful submission the
   * active route's data revalidates automatically. Works without JavaScript:
   * the endpoint accepts the form-encoded fallback and redirects back to the
   * page. Set `action` explicitly for capabilities with a custom
   * `expose.http.path`; root-absolute actions receive the deploy base. A
   * button-level `formaction` is native child markup, so wrap a local
   * root-absolute override with `withBase()` when the app uses a deploy base.
   *
   * Only http-exposed capabilities are accepted: a private one has no endpoint
   * to post to, so naming it here is a compile error rather than a 404 at
   * submit time. Before `pracht typegen` has run, any name is accepted.
   */
  capability?: TName;
  /** Called with the typed envelope after a `capability` submission settles. */
  onCapabilityResult?: (envelope: CapabilityFormResult<TName>) => void;
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

/**
 * Carried by `LinkProps["href"]` purely so the compiler error names the fix.
 *
 * Omitting `href` from the props type leaves TypeScript to guess: it reports
 * `Property 'href' does not exist … Did you mean 'ref'?`, which sends the
 * reader looking for a typo rather than at the actual API. `href` is the
 * muscle-memory prop from every other router, so this is the first wall a new
 * app hits — and the runtime accepted it, so `pracht dev` said nothing either
 * (that part is guarded in `Link` itself). A single-value string type puts the
 * guidance in the error message.
 *
 * Two callers hit it, so the sentence has to read correctly for both. One wrote
 * `href` instead of `route`. The other already wrote `route` and reached the
 * error through a spread — JSX does not excess-property-check spreads, so an
 * `href` arriving that way used to compile and be silently dropped; naming only
 * the first case would tell that author to do what they already did.
 *
 * Keep it under ~260 characters as TypeScript prints it. Both TypeScript 5.4
 * and 6.0 print a 261-character type in full and truncate a 361-character one
 * with `...`, which would swallow the end of the sentence.
 */
export type LinkHrefGuidance =
  "`href` is not a <Link> prop: <Link> builds its own href from `route` and `params`. Use a generated route id with <Link route={routeId}>, a plain <a href> for external and user-provided URLs, or omit href from the props you spread here.";

/**
 * `JSX.AnchorHTMLAttributes`, not `JSX.HTMLAttributes`. Preact keeps the
 * anchor-specific attributes — `target`, `rel`, `download`, `ping`,
 * `referrerpolicy`, `hreflang` — on the anchor interface, so basing `LinkProps`
 * on the generic one rejected all of them: `<Link route="home" target="_blank">`
 * did not typecheck. It also meant the `Omit<…, "href">` below removed nothing,
 * because `href` was never in the generic interface either; that, not the
 * `Omit`, is why the compiler used to answer `<Link href>` with
 * `Did you mean 'ref'?`.
 */
export type LinkProps<TRoute extends RouteId = RouteId> = Omit<
  JSX.AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> &
  RouteTarget<TRoute> & {
    /**
     * Not a real prop — see {@link LinkHrefGuidance}. `<Link>` builds its own
     * `href` from `route` and `params`.
     */
    href?: LinkHrefGuidance;
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
    /**
     * Opt this link out of (`false`) or back into (`true`) the browser's
     * speculation rules, overriding any enclosing
     * `data-pracht-speculate="off"` scope. Independent of `prefetch`, which
     * controls the JS route-state prefetch; disable both on links with side
     * effects.
     */
    speculate?: boolean;
  };

const validatedNativeSubmissions = new WeakSet<HTMLFormElement>();

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

  const {
    route,
    params,
    search,
    hash,
    prefetch,
    preserveScroll,
    viewTransition,
    speculate,
    href,
    ...anchorProps
  } = props as unknown as Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> &
    UntypedRouteTarget & {
      href?: unknown;
      prefetch?: LinkPrefetchStrategy;
      preserveScroll?: boolean;
      viewTransition?: boolean;
      speculate?: boolean;
    };

  // `<Link href="/blog">` is a TypeScript error, but untyped JSX and JS callers
  // can still reach here, including through a spread alongside a valid route.
  // Fail directly instead of letting a missing id produce an unrelated error
  // or silently overwriting the supplied href. Dev-only, like the rest of
  // pracht's authoring diagnostics.
  if (import.meta.env?.DEV !== false && (typeof route !== "string" || href !== undefined)) {
    throw new Error(
      "<Link> navigates by route id, not href: use a generated route id with " +
        "<Link route={routeId}> (with `params` for dynamic segments), or a plain <a href> for " +
        "external and user-provided URLs.",
    );
  }

  return h("a", {
    ...anchorProps,
    href: buildHrefUntyped(routes, route, { params, search, hash }),
    // Read by the client router's click handler and the prefetch listeners.
    [PREFETCH_ATTRIBUTE]: prefetch,
    [PRESERVE_SCROLL_ATTRIBUTE]: preserveScroll ? "" : undefined,
    [VIEW_TRANSITION_ATTRIBUTE]: viewTransition ? "" : undefined,
    [SPECULATE_ATTRIBUTE]: speculate === undefined ? undefined : speculate ? "on" : "off",
  } as JSX.HTMLAttributes<HTMLAnchorElement>);
}

export function Form<TName extends HttpCapabilityName = HttpCapabilityName>(
  props: FormProps<TName>,
) {
  const {
    onSubmit,
    method,
    action,
    capability,
    onCapabilityResult,
    schema,
    onValidationIssues,
    onResponse,
    ...rest
  } = props;
  // Capability forms post to the capability's HTTP projection; the action
  // attribute keeps the no-JS fallback working (the endpoint accepts
  // form-encoded bodies and redirects document posts back on success).
  // Capability endpoints are declared without the deploy base, so the URL the
  // browser posts to gets it back.
  const actionAttribute = capability ? withBase(action ?? capabilityHttpPath(capability)) : action;

  return h("form", {
    ...rest,
    method: capability ? "post" : method,
    action: actionAttribute,
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

      if (capability) {
        // This branch dispatches CAPABILITY_SETTLED_EVENT below, so it owns
        // installing the listener that acts on it. Registering here rather
        // than in the runtime provider keeps route revalidation out of the
        // client bundle of every app that has no capabilities.
        ensureCapabilityRevalidation();
        const submitterAction = nativeSubmitter?.getAttribute("formaction");
        const endpoint = submitterAction ?? actionAttribute ?? form.action;
        const endpointUrl = parseSafeNavigationUrl(endpoint, window.location.href);
        if (!endpointUrl) {
          event.preventDefault();
          console.error(`[pracht] refused to submit capability form to unsafe URL: ${endpoint}`);
          return;
        }
        const isCrossOriginEndpoint = endpointUrl.origin !== window.location.origin;
        // A cross-origin form target cannot participate in the enhanced
        // response handshake. Let the browser perform the native submission
        // so redirects and authentication flows retain document semantics.
        if (isCrossOriginEndpoint && !schema) {
          return;
        }
        event.preventDefault();
        const formData = new FormData(form, nativeSubmitter);

        if (schema) {
          const result = await validateStandardSchema(schema, formDataToRecord(formData), "body");
          if (result.issues) {
            onValidationIssues?.(result.issues);
            return;
          }
        }
        if (isCrossOriginEndpoint) {
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
          createNavigationLocation(endpoint),
          formData,
        );
        let envelope: CapabilityEnvelope;
        let response: Response | undefined;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            body: formData,
            credentials: "same-origin",
            headers: { [CAPABILITY_FORM_REQUEST_HEADER]: "1" },
          });
          const enhancedRedirect = response.headers.get(CAPABILITY_FORM_REDIRECT_HEADER);
          if (
            enhancedRedirect ||
            response.redirected ||
            (response.status >= 300 && response.status < 400)
          ) {
            const location =
              enhancedRedirect ??
              (response.redirected ? response.url : response.headers.get("location"));
            await navigateToClientLocation(location ?? endpoint, { reloadRouteState: true });
            return;
          }
          try {
            envelope = (await response.clone().json()) as CapabilityEnvelope;
          } catch {
            envelope = {
              ok: false,
              error: {
                code: "invalid_response",
                message: `Capability endpoint returned a non-JSON response (status ${response.status}).`,
              },
            };
          }
        } catch (error: unknown) {
          envelope = {
            ok: false,
            error: {
              code: "network_error",
              message: error instanceof Error ? error.message : String(error),
            },
          };
        } finally {
          settleNavigation(navigationToken);
        }

        if (response) {
          onResponse?.(response);
        }
        if (envelope.ok) {
          form.reset();
        }
        // The runtime provider revalidates route data on this event. The
        // server returns the matched capability's effect class so read-only
        // form submissions avoid invalidating the active route.
        window.dispatchEvent(
          new CustomEvent(CAPABILITY_SETTLED_EVENT, {
            detail: {
              name: capability,
              ok: envelope.ok,
              effect: response?.headers.get(CAPABILITY_EFFECT_HEADER) ?? null,
            },
          }),
        );
        onCapabilityResult?.(envelope as CapabilityFormResult<TName>);
        return;
      }

      const submitterMethod = nativeSubmitter?.getAttribute("formmethod") || undefined;
      const formMethod = (submitterMethod ?? method ?? form.method ?? "post").toUpperCase();
      const isSafeMethod = SAFE_METHODS.has(formMethod);
      if (isSafeMethod && !schema) {
        return;
      }

      const submitterAction = nativeSubmitter?.getAttribute("formaction");
      const actionUrl = submitterAction ?? action ?? form.action;
      const actionTarget = parseSafeNavigationUrl(actionUrl, window.location.href);
      const isCrossOriginAction =
        actionTarget !== null && actionTarget.origin !== window.location.origin;
      // Cross-origin targets cannot participate in Pracht's custom redirect
      // handshake: its request header would force a CORS preflight that a
      // normal form post does not need. Preserve native form semantics, while
      // still intercepting first when a shared client schema must run.
      if (isCrossOriginAction && !schema) {
        return;
      }

      event.preventDefault();
      const formData = new FormData(form, nativeSubmitter);

      if (schema) {
        const result = await validateStandardSchema(schema, formDataToRecord(formData), "body");
        if (result.issues) {
          onValidationIssues?.(result.issues);
          return;
        }
      }

      if (isSafeMethod || isCrossOriginAction) {
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
        // Opt into the same redirect handshake capability forms use. Pracht
        // API dispatch turns a 3xx into a readable 204 response carrying the
        // target, so fetch neither loads the destination before the router
        // does nor tries to CORS-fetch an external login/SSO page.
        const response = await fetch(actionUrl, {
          method: formMethod,
          body: formData,
          credentials: "same-origin",
          headers: { [CAPABILITY_FORM_REQUEST_HEADER]: "1" },
        });

        const enhancedRedirect = response.headers.get(CAPABILITY_FORM_REDIRECT_HEADER);
        if (
          enhancedRedirect ||
          response.redirected ||
          (response.status >= 300 && response.status < 400)
        ) {
          const location =
            enhancedRedirect ??
            (response.redirected ? response.url : response.headers.get("location"));
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
