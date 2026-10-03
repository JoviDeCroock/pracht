import { ROUTE_STATE_REQUEST_HEADER, SHELL_DATA_REQUEST_HEADER } from "./runtime-constants.ts";
import { buildStaticRouteStateUrl, IS_STATIC_TARGET } from "./runtime-static.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";
import { decodeRouteData, mayContainEncodedRouteData } from "./route-data-codec.ts";
import type { FontHeadFragments } from "./font.ts";
import type { ResolvedRoute } from "./types.ts";

/**
 * Shell loader support, compiled out by the plugin (`false`) when no shell in
 * the build exports a `loader`. Declared per module so each folds its own
 * branches; absent (unit tests, direct imports) it stays on.
 */
declare const __PRACHT_SHELL_LOADERS__: boolean | undefined;

const SHELL_LOADERS_ENABLED =
  typeof __PRACHT_SHELL_LOADERS__ === "undefined" || __PRACHT_SHELL_LOADERS__ !== false;

// `client.richData` (see route-data-codec.ts). Declared in this module rather
// than imported: Rolldown folds the condition only within a module, so an
// imported flag would keep the codec chunk in every multi-chunk build.
declare const __PRACHT_RICH_DATA__: boolean | undefined;
const RICH_ROUTE_DATA =
  typeof __PRACHT_RICH_DATA__ !== "undefined" && __PRACHT_RICH_DATA__ === true;

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

/** See `router.ts`: compiled out when the app has no root module. */
declare const __PRACHT_APP_ROOT__: boolean | undefined;

const APP_ROOT_ENABLED =
  typeof __PRACHT_APP_ROOT__ === "undefined" || __PRACHT_APP_ROOT__ !== false;

let rootSnapshotHandler: ((snapshot: unknown) => void) | null = null;

/**
 * Where route-state root snapshots go: the app root's `hydrate()`, installed
 * by the client router at boot. Every route-state response passes through
 * `fetchPrachtRouteState()` — navigations, prefetches, revalidations — so
 * applying the snapshot here covers all of them.
 *
 * @internal
 */
export function setRootSnapshotHandler(handler: ((snapshot: unknown) => void) | null): void {
  rootSnapshotHandler = handler;
}

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
  if (route.hasLoader === false && route.hasHead === false && route.middlewareFiles.length === 0) {
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

/**
 * Whether a navigation to `route` needs its route state for the shell's loader
 * data alone: the shell has a loader and the client does not hold its data
 * yet. Callers combine it with `routeNeedsServerFetch()`.
 */
export function routeNeedsShellData(route: ResolvedRoute, holdsShellData: boolean): boolean {
  return (
    route.hasShellLoader === true &&
    !holdsShellData &&
    !(IS_STATIC_TARGET && route.hasStaticPaths === false && routeHasDynamicSegments(route))
  );
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
  // parsed as JSON, never interpreted as HTML — and carries the same
  // route-data encoding, decoded below when the app opted in to rich data.
  const fetchUrl = IS_STATIC_TARGET
    ? buildStaticRouteStateUrl(url)
    : options?.useDataParam
      ? buildRouteStateUrl(url)
      : url;
  const response = await fetch(fetchUrl, {
    cache: options?.cache,
    headers:
      SHELL_LOADERS_ENABLED && !IS_STATIC_TARGET && options?.heldShell !== undefined
        ? { [ROUTE_STATE_REQUEST_HEADER]: "1", [SHELL_DATA_REQUEST_HEADER]: options.heldShell }
        : IS_STATIC_TARGET || options?.useDataParam
          ? {}
          : { [ROUTE_STATE_REQUEST_HEADER]: "1" },
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

  // Rich data needs the raw text to tell whether the payload holds any tag.
  // Route and shell data share the encoding, so both are revived.
  const text = RICH_ROUTE_DATA ? await response.text() : "";
  const tagged = RICH_ROUTE_DATA && mayContainEncodedRouteData(text);
  const json = (RICH_ROUTE_DATA ? JSON.parse(text) : await response.json()) as {
    data?: unknown;
    shellData?: unknown;
    fontHead?: FontHeadFragments;
    error?: SerializedRouteError;
    redirect?: string;
    root?: unknown;
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
        fontHead: json.fontHead,
        type: "error",
        ...(SHELL_LOADERS_ENABLED && "shellData" in json
          ? { shell: { data: tagged ? decodeRouteData(json.shellData) : json.shellData } }
          : null),
      };
    }

    throw new Error(`Failed to fetch route state (${response.status})`);
  }

  if (APP_ROOT_ENABLED && json.root !== undefined && rootSnapshotHandler) {
    try {
      rootSnapshotHandler(json.root);
    } catch (error) {
      // The route data is still good; a broken snapshot only costs the
      // client a refetch of whatever it described.
      console.error("[pracht] The app root's hydrate() threw.", error);
    }
  }

  return {
    data: tagged ? decodeRouteData(json.data) : json.data,
    fontHead: json.fontHead,
    type: "data",
    ...(SHELL_LOADERS_ENABLED && "shellData" in json
      ? { shell: { data: tagged ? decodeRouteData(json.shellData) : json.shellData } }
      : null),
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
