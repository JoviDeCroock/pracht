/**
 * Browser-provenance same-origin check used for CSRF protection on
 * state-changing endpoints (capability HTTP dispatch, API mutations).
 *
 * Priority: `Sec-Fetch-Site` (modern browsers), then `Origin`, then `Referer`.
 * `same-site` is deliberately not accepted — sibling subdomains can be
 * attacker-controlled. Requests with no browser provenance headers at all are
 * treated as non-browser callers (curl, server-to-server, tests): CSRF via a
 * browser form cannot produce a request with none of these headers set.
 */

const SAME_ORIGIN_FETCH_SITE = "same-origin";

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

  // No Sec-Fetch-Site AND no Origin: fall back to Referer. Browsers
  // always send Origin on POST to same-origin endpoints, so a POST
  // missing both is almost certainly a non-browser caller.
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin === url.origin;
    } catch {
      return false;
    }
  }

  // No browser-provided signals at all — allow (curl, server-to-server,
  // tests). The threat model here is CSRF via browser forms, which
  // cannot produce a request with none of these headers set.
  return true;
}
