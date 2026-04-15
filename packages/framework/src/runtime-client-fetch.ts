import { ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";

export type RouteStateResult =
  | { type: "data"; data: unknown }
  | { type: "redirect"; location: string }
  | { type: "error"; error: SerializedRouteError };

const SAFE_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Parse a possibly-server-supplied redirect target against a base URL and
 * return it only if it uses a safe navigation scheme (`http:` or `https:`).
 *
 * `javascript:`, `data:`, `vbscript:`, `blob:`, `file:` and similar schemes
 * can execute script or bypass same-origin assumptions when assigned to
 * `window.location.href` — a server-controlled redirect (from a loader,
 * middleware, form action response, or API route) must never be able to
 * trigger them. Returns `null` for unsafe or unparseable inputs.
 */
export function parseSafeNavigationUrl(location: string, base: string | URL): URL | null {
  let targetUrl: URL;
  try {
    targetUrl = new URL(location, base);
  } catch {
    return null;
  }
  if (!SAFE_NAVIGATION_PROTOCOLS.has(targetUrl.protocol)) {
    return null;
  }
  return targetUrl;
}

/**
 * A fetch implementation matching the standard Web fetch signature.
 *
 * Provided to {@link configureClient} to customize how the framework's
 * client runtime (navigation, revalidation, prefetch, `<Form>`) performs
 * HTTP requests — e.g. to forward an `Authorization` header from a
 * client-held token into loader requests.
 */
export type PrachtClientFetch = typeof fetch;

export interface ConfigureClientOptions {
  /**
   * Replacement fetch function used for every framework-initiated client
   * request: route-state fetches during navigation/revalidation/prefetch,
   * and `<Form>` submissions.
   *
   * The function receives the same `(input, init)` arguments as the
   * standard `fetch`. The framework sets its own required headers
   * (e.g. `x-pracht-route-state-request`) on `init.headers`; callers
   * should merge them when adding their own.
   */
  fetch?: PrachtClientFetch;
}

let configuredClientFetch: PrachtClientFetch | undefined;

/**
 * Configure the client runtime. Call this once at app startup (e.g. at the
 * top of your `src/routes.ts`) to install a custom fetch implementation
 * that every framework-initiated client request will flow through.
 *
 * Typical use is forwarding an `Authorization` header on client-side
 * navigations, revalidations, prefetches, and `<Form>` submissions so
 * server-side loaders can read it from `request.headers`.
 *
 * ```ts
 * configureClient({
 *   fetch: (input, init) =>
 *     fetch(input, {
 *       ...init,
 *       credentials: "include",
 *       headers: {
 *         ...(init?.headers as Record<string, string> | undefined),
 *         Authorization: `Bearer ${getToken()}`,
 *       },
 *     }),
 * });
 * ```
 *
 * Passing `undefined` for `fetch` resets to the global `fetch`.
 */
export function configureClient(options: ConfigureClientOptions = {}): void {
  configuredClientFetch = options.fetch;
}

export function getConfiguredClientFetch(): PrachtClientFetch {
  return configuredClientFetch ?? fetch;
}

export function buildRouteStateUrl(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_data=1`;
}

export async function fetchPrachtRouteState(
  url: string,
  options?: { useDataParam?: boolean },
): Promise<RouteStateResult> {
  const fetchUrl = options?.useDataParam ? buildRouteStateUrl(url) : url;
  const clientFetch = getConfiguredClientFetch();
  const response = await clientFetch(fetchUrl, {
    headers: options?.useDataParam
      ? {}
      : { [ROUTE_STATE_REQUEST_HEADER]: "1", "Cache-Control": "no-cache" },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    return {
      location: location ?? url,
      type: "redirect",
    };
  }

  const json = (await response.json()) as {
    data?: unknown;
    error?: SerializedRouteError;
    redirect?: string;
  };
  if (json.redirect) {
    return {
      location: json.redirect,
      type: "redirect",
    };
  }

  if (!response.ok) {
    if (json.error) {
      return {
        error: json.error,
        type: "error",
      };
    }

    throw new Error(`Failed to fetch route state (${response.status})`);
  }

  return {
    data: json.data,
    type: "data",
  };
}

export async function navigateToClientLocation(
  location: string,
  options?: { replace?: boolean },
): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const targetUrl = parseSafeNavigationUrl(location, window.location.href);
  if (!targetUrl) {
    console.error(`[pracht] refused to navigate to unsafe URL: ${location}`);
    return;
  }

  const target = targetUrl.pathname + targetUrl.search + targetUrl.hash;
  if (targetUrl.origin === window.location.origin && window.__PRACHT_NAVIGATE__) {
    await window.__PRACHT_NAVIGATE__(target, options);
    return;
  }

  if (options?.replace) {
    window.location.replace(targetUrl.toString());
    return;
  }

  window.location.href = targetUrl.toString();
}
