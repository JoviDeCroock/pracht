/**
 * An ISG response is safe to persist in a shared cache only when it doesn't
 * depend on request-specific state (cookies, auth) that the cached copy would
 * replay to every visitor. `Cache-Control: private` / `no-store`, any
 * `Set-Cookie`, and a `Vary` that implies per-request output (cookie,
 * authorization) all signal "don't cache this across users".
 */
export function isCacheableISGResponse(response: Response): boolean {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (/\b(no-store|private)\b/.test(cacheControl)) return false;

  if (response.headers.get("set-cookie")) return false;

  const vary = response.headers.get("vary")?.toLowerCase() ?? "";
  if (!vary) return true;
  if (vary.includes("*")) return false;
  const varied = vary.split(",").map((s) => s.trim());
  for (const name of varied) {
    if (name === "cookie" || name === "authorization") return false;
  }
  return true;
}

const DANGEROUS_PRERENDER_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "www-authenticate",
]);
const SECRET_SHAPED_PRERENDER_HEADER_RE =
  /^x-.*(?:api[-_]?key|client[-_]?secret|credential|jwt[-_]?secret|password|private[-_]?key|refresh[-_]?token|secret|session[-_]?secret|token|webhook[-_]?secret)(?:$|[-_])/i;

/**
 * Headers that must never ride along with output stored in a shared cache.
 * Prerendered documents — and ISG responses regenerated at runtime — are
 * replayed verbatim to every visitor, so a `Set-Cookie` or credential header
 * produced by one render would be handed to all of them.
 */
export function isDangerousPrerenderHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    DANGEROUS_PRERENDER_HEADER_NAMES.has(normalized) ||
    SECRET_SHAPED_PRERENDER_HEADER_RE.test(normalized)
  );
}
