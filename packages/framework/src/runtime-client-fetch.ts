import { ROUTE_STATE_REQUEST_HEADER, STATIC_ROUTE_STATE_DIR } from "./runtime-constants.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { ResolvedRoute } from "./types.ts";

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

export function routeNeedsServerFetch(route: ResolvedRoute): boolean {
  if (route.hasLoader === false && route.middlewareFiles.length === 0) return false;
  return true;
}

export function buildRouteStateUrl(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_data=1`;
}

/**
 * Static deployments have no route-state endpoint: the loader ran at build
 * time and its result was written next to the prerendered document. When this
 * is enabled the client reads those snapshots instead of asking a server that
 * is not there.
 */
let staticRouteStateEnabled = false;

/**
 * Point the client router at build-time route-state snapshots. Called by the
 * bootstrap the static adapter contributes to the client entry; apps never
 * call it directly.
 */
export function configureStaticRouteState(enabled = true): void {
  staticRouteStateEnabled = enabled;
}

/**
 * Map a navigation target onto its build-time route-state snapshot.
 *
 * Snapshots are keyed by pathname alone — a static build has one answer per
 * path — so the query string is dropped. A loader that reads
 * `url.searchParams` sees the same build-time values the prerendered document
 * was rendered with.
 */
export function buildStaticRouteStateUrl(url: string): string {
  const path = url.split(/[?#]/)[0];
  const normalized = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const routeDir = normalized === "/" || normalized === "" ? "" : normalized;
  return `${STATIC_ROUTE_STATE_DIR}${routeDir}/index.json`;
}

/**
 * Inverse of {@link buildStaticRouteStateUrl}: the route path a snapshot URL
 * belongs to, or `null` when the URL is not one. `pracht dev` uses it to
 * answer snapshot requests from the live app, so a static build's client code
 * path is exercised in development too.
 */
export function routePathFromStaticRouteStateUrl(pathname: string): string | null {
  const rootSnapshot = `${STATIC_ROUTE_STATE_DIR}/index.json`;
  if (pathname === rootSnapshot) return "/";

  const prefix = `${STATIC_ROUTE_STATE_DIR}/`;
  const suffix = "/index.json";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;

  const rest = pathname.slice(prefix.length, -suffix.length);
  if (rest === "" || rest.split("/").includes("..")) return null;
  return `/${rest}`;
}

export async function fetchPrachtRouteState(
  url: string,
  options?: { cache?: RequestCache; signal?: AbortSignal; useDataParam?: boolean },
): Promise<RouteStateResult> {
  // A static snapshot is a plain JSON file: no route-state header (nothing
  // reads it) and no `_data=1` param (there is no endpoint to disambiguate).
  const isStatic = staticRouteStateEnabled;
  const fetchUrl = isStatic
    ? buildStaticRouteStateUrl(url)
    : options?.useDataParam
      ? buildRouteStateUrl(url)
      : url;
  const response = await fetch(fetchUrl, {
    cache: options?.cache,
    headers: isStatic || options?.useDataParam ? {} : { [ROUTE_STATE_REQUEST_HEADER]: "1" },
    redirect: "manual",
    signal: options?.signal,
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
  options?: { reloadRouteState?: boolean; replace?: boolean },
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
    await window.__PRACHT_NAVIGATE__(target, {
      _reloadRouteState: options?.reloadRouteState,
      replace: options?.replace,
    });
    return;
  }

  if (options?.replace) {
    window.location.replace(targetUrl.toString());
    return;
  }

  window.location.href = targetUrl.toString();
}
