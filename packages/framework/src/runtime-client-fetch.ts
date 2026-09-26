import { ROUTE_STATE_REQUEST_HEADER, SHELL_DATA_REQUEST_HEADER } from "./runtime-constants.ts";
import { buildStaticRouteStateUrl, IS_STATIC_TARGET } from "./runtime-static.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import type { FontHeadFragments } from "./font.ts";
import type { ResolvedRoute } from "./types.ts";

/**
 * `shell` is present when the response carried the shell loader's data: the
 * shell has a loader and the request did not claim to hold its data already.
 */
export type RouteStateResult =
  | { type: "data"; data: unknown; shell?: { data: unknown }; fontHead?: FontHeadFragments }
  /**
   * `location` is absent for an opaque redirect: the fetch was made with
   * `redirect: "manual"`, and an opaque response exposes neither the status
   * nor the `Location` header. The destination is unknowable here, so the
   * caller has to hand the URL back to the browser as a document navigation
   * and let it follow the 3xx itself.
   */
  | { type: "redirect"; location?: string }
  | {
      type: "error";
      error: SerializedRouteError;
      shell?: { data: unknown };
      fontHead?: FontHeadFragments;
    };

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
 * `holdsShellData` is true when the client already holds the loader data of
 * the route's shell, so a shell loader alone is no reason to ask the server.
 */
export function routeNeedsServerFetch(route: ResolvedRoute, holdsShellData?: boolean): boolean {
  if (
    route.hasLoader === false &&
    route.hasHead === false &&
    route.middlewareFiles.length === 0 &&
    (route.hasShellLoader !== true || holdsShellData === true)
  ) {
    return false;
  }
  // A static export writes one route-state file per prerendered path. A route
  // with dynamic segments is prerendered only for the paths `getStaticPaths()`
  // enumerates, so a route module that exports none has no state file for
  // *any* URL that matches it — the request is a guaranteed miss. That is the
  // ordinary shape of a dynamic `render: "spa"` route (a dynamic `ssg` route
  // without `getStaticPaths()` fails the build), and without this the client
  // asks for a file that can never exist on every navigation to one.
  //
  // Narrow only on a proven `false`: an unscanned route module leaves the hint
  // undefined and keeps fetching.
  if (IS_STATIC_TARGET && route.hasStaticPaths === false && routeHasDynamicSegments(route)) {
    return false;
  }
  return true;
}

function routeHasDynamicSegments(route: ResolvedRoute): boolean {
  return route.segments.some((segment) => segment.type === "param" || segment.type === "catchall");
}

export function buildRouteStateUrl(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_data=1`;
}

/**
 * The shell whose loader data the client router currently holds, or
 * `undefined` when it holds none. Route-state requests made by the router and
 * the prefetcher claim it so the server can skip that shell's loader.
 */
let heldShell: string | undefined;

/** @internal */
export function getHeldShell(): string | undefined {
  return heldShell;
}

/** @internal */
export function setHeldShell(shell: string | undefined): void {
  heldShell = shell;
}

export async function fetchPrachtRouteState(
  url: string,
  options?: {
    cache?: RequestCache;
    signal?: AbortSignal;
    useDataParam?: boolean;
    /** Ask the server to skip this shell's loader; the client already holds its data. */
    heldShell?: string;
  },
): Promise<RouteStateResult> {
  // Static-export builds have no server to answer the route-state header (or
  // the `_data=1` query form): the loader payload was serialized to a static
  // JSON file at build time instead. Same-origin fetch of `application/json`
  // keeps the exact escaping posture of the live endpoint — the payload is
  // parsed as JSON, never interpreted as HTML.
  const fetchUrl = IS_STATIC_TARGET
    ? buildStaticRouteStateUrl(url)
    : options?.useDataParam
      ? buildRouteStateUrl(url)
      : url;
  const headers: Record<string, string> =
    IS_STATIC_TARGET || options?.useDataParam ? {} : { [ROUTE_STATE_REQUEST_HEADER]: "1" };
  if (!IS_STATIC_TARGET && options?.heldShell !== undefined) {
    headers[SHELL_DATA_REQUEST_HEADER] = options.heldShell;
  }
  const response = await fetch(fetchUrl, {
    cache: options?.cache,
    headers,
    redirect: "manual",
    signal: options?.signal,
  });

  if (response.type === "opaqueredirect") {
    // Nothing readable to redirect to. Reporting `url` here — the URL just
    // requested — is what turned a same-URL 3xx into an endless client
    // redirect loop, so report the redirect without a destination instead.
    return { type: "redirect" };
  }

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    return {
      location: location ?? undefined,
      type: "redirect",
    };
  }

  const json = (await response.json()) as {
    data?: unknown;
    shellData?: unknown;
    fontHead?: FontHeadFragments;
    error?: SerializedRouteError;
    redirect?: string;
  };
  if (json.redirect) {
    return {
      location: json.redirect,
      type: "redirect",
    };
  }

  const shell = "shellData" in json ? { data: json.shellData } : undefined;

  if (!response.ok) {
    if (json.error) {
      return {
        error: json.error,
        fontHead: json.fontHead,
        type: "error",
        shell,
      };
    }

    throw new Error(`Failed to fetch route state (${response.status})`);
  }

  return {
    data: json.data,
    fontHead: json.fontHead,
    type: "data",
    shell,
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
