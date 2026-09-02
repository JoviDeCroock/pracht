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
 * Redirect hops one client navigation may follow before giving up. Twenty is
 * the limit browsers apply to document redirects, so a chain a full page load
 * would survive is a chain client navigation survives too.
 */
export const MAX_REDIRECT_HOPS = 20;

export interface RedirectTarget {
  documentUrl?: string;
  externalUrl?: string;
  internalPath?: string;
  isCurrentLocation: boolean;
  unsafe?: boolean;
}

export function resolveRedirectTarget(location: string): RedirectTarget {
  const targetUrl = parseSafeNavigationUrl(location, window.location.href);
  if (!targetUrl) {
    return { isCurrentLocation: false, unsafe: true };
  }
  const fullInternalTarget = targetUrl.pathname + targetUrl.search + targetUrl.hash;
  const internalPath = targetUrl.pathname + targetUrl.search;
  const currentPath = window.location.pathname + window.location.search + window.location.hash;
  const isCurrentLocation =
    targetUrl.origin === window.location.origin && fullInternalTarget === currentPath;

  if (targetUrl.origin !== window.location.origin) {
    return {
      externalUrl: targetUrl.toString(),
      isCurrentLocation: false,
    };
  }

  if (targetUrl.hash) {
    return {
      documentUrl: targetUrl.toString(),
      isCurrentLocation,
    };
  }

  return {
    internalPath,
    isCurrentLocation,
  };
}
