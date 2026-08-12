/**
 * Browser request provenance policy.
 *
 * These checks intentionally distinguish exact-origin requests from
 * same-site requests: sibling subdomains may be attacker-controlled. Requests
 * without browser provenance headers remain available to server-to-server and
 * command-line callers.
 */

const SAME_ORIGIN_FETCH_SITE = "same-origin";

/**
 * Stricter variant of first-party detection used to protect API requests that
 * a cross-site page must not be able to make on the user's behalf:
 * state-changing methods (CSRF) and WebSocket upgrades (cross-site WebSocket
 * hijacking). It rejects any browser signal that points outside this exact
 * origin.
 */
export function isSameOriginRequest(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== SAME_ORIGIN_FETCH_SITE) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === url.origin;
    } catch {
      return false;
    }
  }

  if (site === SAME_ORIGIN_FETCH_SITE) {
    return true;
  }

  // No Sec-Fetch-Site AND no Origin: fall back to Referer. Browsers always
  // send Origin on POST to same-origin endpoints, so a POST missing both is
  // almost certainly a non-browser caller.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }

  // No browser-provided signals at all — allow curl, server-to-server calls,
  // and tests. The threat model is browser CSRF, whose requests carry one of
  // the provenance signals above.
  return true;
}

/**
 * Heuristic "this request came from our own page" check. Used to gate the
 * `_data=1` query-param form of the route-state endpoint, which is otherwise
 * reachable via any cross-origin link or redirect.
 *
 * Accepts a request as first-party when:
 *
 * - `Sec-Fetch-Site` is `same-origin`;
 * - or it is absent and `Origin` matches the request URL;
 * - or both are absent and `Referer` matches the request URL;
 * - or all browser provenance headers are absent (non-browser callers).
 */
export function isFirstPartyFetch(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== SAME_ORIGIN_FETCH_SITE) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  if (site === SAME_ORIGIN_FETCH_SITE) {
    return true;
  }

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  return true;
}
