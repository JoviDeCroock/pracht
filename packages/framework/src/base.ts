/**
 * Vite `base` support — deploying an app under a sub-path
 * (`https://user.github.io/my-project/`, an S3 key prefix, a reverse proxy
 * mount point) rather than at an origin root.
 *
 * The framework keeps two kinds of path:
 *
 * - **Route paths** (`/about`, `/blog/:slug`) — what the manifest declares and
 *   what route matching and prerender output are keyed by. Never contain the
 *   base.
 * - **URL paths** (`/my-project/about`) — what the browser shows, requests, and
 *   what `useLocation()` reports. Always contain the base.
 *
 * `withBase()` converts the first into the second (hrefs, fetch URLs, preload
 * URLs) and `stripBase()` converts back (route matching). Everything else is
 * unchanged, and with the default base of `/` both are the identity function,
 * so no adapter pays for a feature it does not use.
 */

/**
 * Vite defines `import.meta.env.BASE_URL` in client *and* SSR bundles, so both
 * the browser runtime and the prerendered server bundle see the configured
 * base without extra plumbing. Under plain Node — the CLI, unit tests — it is
 * undefined and the base is the origin root.
 */
function normalizeBase(raw: unknown): string {
  if (typeof raw !== "string" || raw === "" || raw === "./" || raw === ".") return "/";
  // An absolute or protocol-relative base points *assets* at a CDN. It is not
  // a route prefix: the documents themselves still live at the origin root, so
  // routing must not adopt it.
  if (raw.includes("://") || raw.startsWith("//")) return "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.endsWith("/") ? withLeadingSlash : `${withLeadingSlash}/`;
}

/** The configured base, normalized to leading and trailing slashes (`"/"` by default). */
export const PRACHT_BASE: string = normalizeBase(import.meta.env?.BASE_URL);

/** True when the app is deployed under a sub-path. */
export const HAS_BASE: boolean = PRACHT_BASE !== "/";

/** Route path → URL path. Leaves relative and absolute URLs alone. */
export function withBase(path: string): string {
  if (!HAS_BASE || !path.startsWith("/") || path.startsWith("//")) return path;
  return `${PRACHT_BASE}${path.slice(1)}`;
}

/**
 * URL path → route path, or `null` when the URL is outside the base.
 *
 * `null` means "not this app": the client router hands such a link back to the
 * browser instead of trying to match it.
 */
export function stripBase(pathname: string): string | null {
  if (!HAS_BASE) return pathname;
  const baseSegments = PRACHT_BASE.slice(1, -1).split("/");
  const pathSegments = pathname.startsWith("/") ? pathname.slice(1).split("/") : null;
  if (!pathSegments || pathSegments.length < baseSegments.length) return null;

  for (let index = 0; index < baseSegments.length; index += 1) {
    const baseSegment = canonicalizeBaseSegment(baseSegments[index]);
    const pathSegment = canonicalizeBaseSegment(pathSegments[index]);
    if (baseSegment === null || pathSegment === null || baseSegment !== pathSegment) return null;
  }

  // The base without its trailing slash is the app root as a user would type
  // it (`/my-project`); hosts usually redirect it to `/my-project/`.
  const remaining = pathSegments.slice(baseSegments.length);
  return remaining.length === 0 ? "/" : `/${remaining.join("/")}`;
}

/**
 * Return the canonical trailing-slash URL for a bare deploy base.
 *
 * The route matcher intentionally accepts both `/app` and `/app/` as the root
 * route. Documents must still redirect to the latter so their relative links
 * and assets resolve inside the deploy base rather than at the origin root.
 *
 * @internal
 */
export function resolveBaseRedirectLocation(pathname: string, search = ""): string | null {
  if (!HAS_BASE || pathname.endsWith("/") || stripBase(pathname) !== "/") return null;
  return `${PRACHT_BASE}${search}`;
}

// `pracht({ trailingSlash })`, defined for the client and server bundles
// alike. Plain Node (the CLI, unit tests) leaves it undefined: the default.
declare const __PRACHT_TRAILING_SLASH__: string | undefined;

/**
 * The trailing-slash policy: `"ignore"` (default) generates `/about` and
 * accepts `/about/`; `"never"` and `"always"` make one spelling canonical.
 *
 * Every caller compares it against `"ignore"` first, so an app that keeps the
 * default constant-folds the whole feature out of its bundles.
 */
export const TRAILING_SLASH: "ignore" | "never" | "always" =
  typeof __PRACHT_TRAILING_SLASH__ === "undefined"
    ? "ignore"
    : (__PRACHT_TRAILING_SLASH__ as "ignore" | "never" | "always");

/**
 * The canonical spelling of a page path under the trailing-slash policy.
 * Works on route paths (`/about`) and URL paths (`/app/about`) alike, and on
 * paths alone, never a query or hash.
 *
 * The root — and with it a deploy base, which is the root as a URL — always
 * keeps its slash. A last segment containing a dot (`/feed.xml`) is a file
 * name and never gets one, so `"always"` leaves it slashless.
 */
export function applyTrailingSlash(pathname: string): string {
  if (TRAILING_SLASH === "ignore" || !pathname.startsWith("/")) return pathname;
  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || (HAS_BASE && `${trimmed}/` === PRACHT_BASE)) return pathname;
  if (TRAILING_SLASH === "never") return trimmed;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).includes(".") ? trimmed : `${trimmed}/`;
}

/**
 * `applyTrailingSlash()` for a root-absolute route href that may carry a query
 * or hash. Relative and absolute URLs are returned unchanged, and so are API
 * routes (always under `/api`) and framework endpoints, which keep answering
 * the spelling they were given.
 */
export function applyTrailingSlashToHref(href: string): string {
  if (TRAILING_SLASH === "ignore" || !href.startsWith("/") || href.startsWith("//")) return href;
  const end = href.search(/[?#]/);
  const pathname = end === -1 ? href : href.slice(0, end);
  if (/^\/(?:api|_pracht|__pracht)(?:\/|$)/.test(pathname)) return href;
  return `${applyTrailingSlash(pathname)}${end === -1 ? "" : href.slice(end)}`;
}

/**
 * The location a page document request should be redirected to under the
 * trailing-slash policy, or `null` when its URL is already canonical.
 *
 * @internal
 */
export function resolveTrailingSlashRedirectLocation(pathname: string, search = ""): string | null {
  if (TRAILING_SLASH === "ignore") return null;
  const canonical = applyTrailingSlash(pathname);
  if (canonical === pathname) return null;
  // Route matching collapses repeated slashes, so `//evil.example/` can match
  // a page. Its canonical spelling must not become a protocol-relative
  // Location that sends the visitor to another host.
  return `${canonical.replace(/^\/{2,}/, "/")}${search}`;
}

function canonicalizeBaseSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === "..") return null;
    for (const character of decoded) {
      const codePoint = character.codePointAt(0);
      if (
        character === "/" ||
        character === "\\" ||
        codePoint === 0 ||
        (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f))
      ) {
        return null;
      }
    }
    return encodeURIComponent(decoded);
  } catch {
    return null;
  }
}

/**
 * `stripBase()` for callers that must always produce a route path: synthetic
 * build-time requests carry no base, and a serverful host may mount the app
 * under the base without rewriting the path it forwards.
 */
export function stripBaseLenient(pathname: string): string {
  return stripBase(pathname) ?? pathname;
}

/** @internal Restore a trusted proxy-stripped pathname before app code sees the Request. */
export function restoreBasePathInRequest(request: Request): Request {
  if (!HAS_BASE) return request;
  const url = new URL(request.url);
  url.pathname = withBase(url.pathname);
  return new Request(url, request);
}
