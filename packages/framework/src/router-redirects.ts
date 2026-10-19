/**
 * Classifying the location a route-state redirect points at.
 *
 * Lives beside the router rather than inside it because the answer is a pure
 * function of the URL and the current document location: none of the
 * navigation's state is involved, and none of it should be reachable from
 * here.
 *
 * @internal
 */
import { parseSafeNavigationUrl } from "./runtime-client-fetch.ts";

/**
 * Redirect hops one client navigation follows before handing the chain to the
 * browser as a document navigation. Twenty is
 * the limit browsers apply to document redirects, so a chain a full page load
 * would survive is a chain client navigation survives too.
 */
export const MAX_REDIRECT_HOPS = 20;

export interface RedirectTarget {
  /** Another origin, or a URL with a fragment: the browser loads it as a document. */
  documentUrl?: string;
  /** Same origin, no fragment: the router navigates to it. */
  internalPath?: string;
  /** The redirect points at the URL already on screen. */
  isCurrentLocation?: boolean;
  unsafe?: boolean;
}

export function resolveRedirectTarget(location: string): RedirectTarget {
  const targetUrl = parseSafeNavigationUrl(location, window.location.href);
  if (!targetUrl) return { unsafe: true };
  const { hash, origin, pathname, search } = window.location;
  if (targetUrl.origin !== origin) return { documentUrl: targetUrl.toString() };
  if (targetUrl.pathname + targetUrl.search + targetUrl.hash === pathname + search + hash) {
    return { isCurrentLocation: true };
  }
  return targetUrl.hash
    ? { documentUrl: targetUrl.toString() }
    : { internalPath: targetUrl.pathname + targetUrl.search };
}
