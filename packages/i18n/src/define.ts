import type { MiddlewareFn } from "@pracht/core";

import { matchAcceptLanguage } from "./accept-language.ts";

/**
 * BCP 47-shaped locale identifiers only (`en`, `nl`, `en-US`, `pt-BR`).
 * Locales end up in URL paths, cookie values, and hreflang attributes, so
 * anything outside this shape is rejected at `defineI18n()` time.
 */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
// Semicolons/commas/whitespace or anything outside printable ASCII in an
// attribute value could smuggle extra cookie attributes or split the header.
const COOKIE_ATTRIBUTE_UNSAFE = /[;,\s]|[^ -~]/;

export const DEFAULT_LOCALE_COOKIE = "pracht_locale";

export type I18nDetectSource = "path" | "cookie" | "header";

export interface I18nCookieOptions {
  /** Cookie name. Default: `"pracht_locale"`. */
  name?: string;
  /** `Max-Age` in seconds. Default: one year. */
  maxAge?: number;
  /** Cookie `Path`. Default: `"/"`. */
  path?: string;
  /** `SameSite` attribute. Default: `"Lax"`. */
  sameSite?: "Lax" | "Strict" | "None";
  /**
   * Add the `Secure` attribute. Default: automatic — set when the request is
   * https or when `sameSite` is `"None"` (which requires it).
   */
  secure?: boolean;
  /** Optional cookie `Domain`. */
  domain?: string;
}

export interface I18nConfig<L extends string> {
  /** Every locale the app serves. Only these can ever win detection. */
  locales: readonly L[];
  /** Fallback when no detection source matches. Must be in `locales`. */
  defaultLocale: NoInfer<L>;
  /**
   * Detection order. Default: `["path", "cookie", "header"]` — an explicit
   * URL prefix beats a remembered cookie beats `Accept-Language`.
   */
  detect?: readonly I18nDetectSource[];
  /**
   * Locale cookie configuration, or `false` to disable the cookie entirely
   * (both persistence and the `"cookie"` detection source).
   */
  cookie?: I18nCookieOptions | false;
}

export interface I18nDetection<L extends string> {
  locale: L;
  /** Which source produced the locale; `"default"` when nothing matched. */
  source: I18nDetectSource | "default";
}

export interface LocaleCookieOptions {
  /**
   * Request URL, used to infer the `Secure` attribute (set on https) exactly
   * like the middleware does. API routes and loaders get one in their args.
   */
  url?: URL | string;
  /** Force the `Secure` attribute instead of inferring it from `url`. */
  secure?: boolean;
}

export interface HreflangOptions<L extends string = string> {
  /**
   * Absolute origin (`https://example.com`) prepended to every href. Google
   * wants absolute hreflang URLs; omit only for same-origin previews. The
   * value is parsed and reduced to its origin, so paths or credentials in
   * the value are dropped.
   */
  origin?: string;
  /**
   * `x-default` target: the unprefixed path by default (your locale
   * detector/redirect route), a registered locale to point at that locale's
   * URL, or `false` to omit the entry.
   */
  xDefault?: L | false;
}

/** Shaped to drop straight into `head()`'s `link` array. */
export type HreflangLink = {
  rel: "alternate";
  hreflang: string;
  href: string;
};

/**
 * Context field the i18n middleware populates. Merge it into your app's
 * registered context so loaders see `context.locale` without casts:
 *
 * ```ts
 * // src/env.d.ts
 * declare module "@pracht/core" {
 *   interface Register {
 *     context: I18nRequestContext<"en" | "nl">;
 *   }
 * }
 * ```
 */
export interface I18nRequestContext<L extends string = string> {
  locale: L;
}

export interface I18n<L extends string> {
  readonly locales: readonly L[];
  readonly defaultLocale: L;
  /** Cookie name in use, or `null` when the cookie is disabled. */
  readonly cookieName: string | null;
  /** Type guard: `true` only for registered locales. */
  isLocale(value: unknown): value is L;
  /** Run detection outside the middleware (e.g. in a standalone loader). */
  detect(request: Request, url?: URL): I18nDetection<L>;
  /**
   * Browser-side counterpart of `detect()`: resolves the locale from the same
   * configured sources, reading `location.pathname`, `document.cookie`, and
   * `navigator.languages`. Sources unavailable in the current environment are
   * skipped, so calling it during SSR yields the default locale.
   */
  detectClient(): I18nDetection<L>;
  /**
   * Serialize a `Set-Cookie` value that remembers `locale`, or an expired one
   * when passed `null` (back to automatic detection). Use it wherever an
   * explicit locale choice is made without a URL prefix — typically an API
   * route behind a language switcher. Throws when the cookie is disabled or
   * the locale is not registered.
   */
  localeCookie(locale: L | null, options?: LocaleCookieOptions): string;
  /**
   * Browser-only: write the locale cookie through `document.cookie` with the
   * same name and attributes the middleware reads, so a client-side switch
   * survives the next server render. Returns the serialized value.
   */
  setLocaleCookie(locale: L | null, options?: LocaleCookieOptions): string;
  /**
   * Prefix a path with a locale, replacing any existing locale prefix and
   * preserving query/hash: `localePath("/en/shop?page=2", "nl")` →
   * `"/nl/shop?page=2"`. Browser-recognized dot segments are resolved before
   * prefixing so the resulting URL cannot escape the locale namespace. Throws
   * on unregistered locales so user input can never be reflected into a path.
   */
  localePath(path: string, locale: L): string;
  /** Split a pathname into its locale prefix (if any) and the rest. */
  splitLocale(path: string): { locale: L | null; pathname: string };
  /** Build `link[]` alternate entries for `head()`. */
  hreflang(path: string, options?: HreflangOptions<L>): HreflangLink[];
  /**
   * Locale-detection middleware: resolves the locale via the configured
   * detection order, sets `context.locale`, and — when the URL prefix chose
   * the locale — persists it in the locale cookie.
   */
  middleware: MiddlewareFn;
}

interface ResolvedCookie {
  name: string;
  maxAge: number;
  path: string;
  sameSite: "Lax" | "Strict" | "None";
  secure: boolean | undefined;
  domain: string | undefined;
}

function resolveCookie(options: I18nCookieOptions): ResolvedCookie {
  const name = options.name ?? DEFAULT_LOCALE_COOKIE;
  if (!COOKIE_NAME_PATTERN.test(name)) {
    throw new TypeError(`defineI18n: invalid cookie name "${name}".`);
  }
  const maxAge = options.maxAge ?? 31536000;
  if (!Number.isInteger(maxAge) || maxAge < 0) {
    throw new TypeError(`defineI18n: cookie maxAge must be a non-negative integer.`);
  }
  const path = options.path ?? "/";
  if (!path.startsWith("/") || COOKIE_ATTRIBUTE_UNSAFE.test(path)) {
    throw new TypeError(`defineI18n: invalid cookie path "${path}".`);
  }
  const domain = options.domain;
  if (domain !== undefined && (domain.length === 0 || COOKIE_ATTRIBUTE_UNSAFE.test(domain))) {
    throw new TypeError(`defineI18n: invalid cookie domain "${domain}".`);
  }
  return {
    name,
    maxAge,
    path,
    sameSite: options.sameSite ?? "Lax",
    secure: options.secure,
    domain,
  };
}

/** Read one cookie value from a `Cookie` header; malformed pairs are skipped. */
function readCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    if (pair.slice(0, equals).trim() !== name) continue;
    const raw = pair.slice(equals + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Append a value to `Vary` without duplicating entries (case-insensitive)
 * and respecting an existing `Vary: *`.
 */
function appendVary(headers: Headers, value: string): void {
  const current = headers.get("vary");
  if (!current) {
    headers.set("vary", value);
    return;
  }
  const values = current
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (values.includes("*") || values.includes(value.toLowerCase())) return;
  headers.set("vary", `${current}, ${value}`);
}

/**
 * True for responses that switch protocols instead of carrying a body (a
 * WebSocket `101` handshake). Reconstructing one drops the socket handle and
 * the `Response` constructor rejects sub-200 statuses, so they must pass
 * through untouched.
 */
function isProtocolSwitchResponse(response: Response): boolean {
  return response.status < 200 || (response as { webSocket?: unknown }).webSocket != null;
}

/**
 * Apply detection headers (`Vary`, optionally `Set-Cookie`), cloning when
 * the response's headers are immutable.
 */
function withDetectionHeaders(
  response: Response,
  setCookie: string | null,
  vary: readonly string[],
): Response {
  if (isProtocolSwitchResponse(response)) return response;
  const apply = (headers: Headers): void => {
    for (const value of vary) appendVary(headers, value);
    if (setCookie !== null) headers.append("set-cookie", setCookie);
  };
  try {
    apply(response.headers);
    return response;
  } catch {
    const clone = new Response(response.body, response);
    apply(clone.headers);
    return clone;
  }
}

function normalizePathname(path: string): string {
  let pathname = typeof path === "string" ? path : "/";
  // Browsers treat backslashes as path separators for http(s) URLs. Normalize
  // them before collapsing leading slash runs so a path such as `\\evil.test`
  // cannot become protocol-relative during the URL normalization below.
  pathname = pathname.replaceAll("\\", "/");
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  // Collapse leading slash runs so `//host` can never read as
  // protocol-relative once an origin is prepended.
  pathname = pathname.replace(/^\/{2,}/, "/");
  // Resolve literal and percent-encoded dot segments before adding a locale
  // prefix. If they were left in the returned value, the browser would resolve
  // `/nl/%2e%2e/admin` to `/admin` and silently escape the locale namespace.
  return new URL(pathname, "https://pracht.invalid").pathname;
}

function splitTarget(path: string): { pathname: string; suffix: string } {
  const search = path.indexOf("?");
  const hash = path.indexOf("#");
  const cut = Math.min(search === -1 ? path.length : search, hash === -1 ? path.length : hash);
  return { pathname: normalizePathname(path.slice(0, cut)), suffix: path.slice(cut) };
}

function normalizeOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError(`hreflang: invalid origin "${origin}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`hreflang: origin must be http(s), got "${origin}".`);
  }
  return parsed.origin;
}

const DETECT_SOURCES: readonly I18nDetectSource[] = ["path", "cookie", "header"];

/**
 * Create the app's i18n instance: locale registry, detection middleware, and
 * URL/hreflang helpers. Define it once in a shared module and re-export
 * `middleware` from `src/middleware/i18n.ts` for the manifest.
 */
export function defineI18n<const L extends string>(config: I18nConfig<L>): I18n<L> {
  const locales = Object.freeze([...config.locales]) as readonly L[];
  if (locales.length === 0) {
    throw new TypeError("defineI18n: `locales` must contain at least one locale.");
  }
  const seen = new Set<string>();
  for (const locale of locales) {
    if (typeof locale !== "string" || !LOCALE_PATTERN.test(locale)) {
      throw new TypeError(
        `defineI18n: invalid locale "${String(locale)}". Locales must be BCP 47-shaped, e.g. "en", "nl", "en-US".`,
      );
    }
    const lowered = locale.toLowerCase();
    if (seen.has(lowered)) {
      throw new TypeError(`defineI18n: duplicate locale "${locale}".`);
    }
    seen.add(lowered);
  }
  const defaultLocale = config.defaultLocale;
  if (!locales.includes(defaultLocale)) {
    throw new TypeError(
      `defineI18n: defaultLocale "${defaultLocale}" is not in locales (${locales.join(", ")}).`,
    );
  }
  const detectOrder = Object.freeze([...(config.detect ?? DETECT_SOURCES)]);
  if (detectOrder.length === 0) {
    throw new TypeError("defineI18n: `detect` must contain at least one source.");
  }
  for (const source of detectOrder) {
    if (!DETECT_SOURCES.includes(source)) {
      throw new TypeError(
        `defineI18n: unknown detection source "${String(source)}". Valid sources: ${DETECT_SOURCES.join(", ")}.`,
      );
    }
  }
  const cookie = config.cookie === false ? false : resolveCookie(config.cookie ?? {});

  const lowered = locales.map((locale) => locale.toLowerCase());
  const maxLocaleLength = Math.max(...locales.map((locale) => locale.length));

  /** Map arbitrary input to a registered locale (canonical casing) or null. */
  function toLocale(value: unknown): L | null {
    if (typeof value !== "string" || value.length === 0 || value.length > maxLocaleLength) {
      return null;
    }
    const index = lowered.indexOf(value.toLowerCase());
    return index === -1 ? null : (locales[index] as L);
  }

  function isLocale(value: unknown): value is L {
    return typeof value === "string" && locales.includes(value as L);
  }

  function splitLocale(path: string): { locale: L | null; pathname: string } {
    const pathname = normalizePathname(path);
    const segments = pathname.split("/");
    const locale = toLocale(segments[1] ?? "");
    if (locale === null) return { locale: null, pathname };
    const rest = segments.slice(2).join("/");
    // Removing the locale can expose an internal duplicate slash as a leading
    // `//`, which consumers would interpret as a protocol-relative URL.
    // Re-normalize the remainder so the public result stays root-relative.
    return { locale, pathname: normalizePathname(rest.length === 0 ? "/" : `/${rest}`) };
  }

  function localePath(path: string, locale: L): string {
    if (!isLocale(locale)) {
      throw new TypeError(
        `localePath: unknown locale "${String(locale)}". Registered locales: ${locales.join(", ")}.`,
      );
    }
    const { pathname, suffix } = splitTarget(path);
    const { pathname: rest } = splitLocale(pathname);
    return `/${locale}${rest === "/" ? "" : rest}${suffix}`;
  }

  function hreflang(path: string, options: HreflangOptions<L> = {}): HreflangLink[] {
    const origin = options.origin === undefined ? "" : normalizeOrigin(options.origin);
    const links: HreflangLink[] = locales.map((locale) => ({
      rel: "alternate",
      hreflang: locale,
      href: `${origin}${localePath(path, locale)}`,
    }));
    if (options.xDefault !== false) {
      const href =
        options.xDefault === undefined
          ? `${origin}${splitLocale(splitTarget(path).pathname).pathname}`
          : `${origin}${localePath(path, options.xDefault)}`;
      links.push({ rel: "alternate", hreflang: "x-default", href });
    }
    return links;
  }

  function readLocaleCookie(request: Request): L | null {
    if (cookie === false) return null;
    return toLocale(readCookieValue(request.headers.get("cookie"), cookie.name));
  }

  function detect(request: Request, url?: URL): I18nDetection<L> {
    const target = url ?? new URL(request.url);
    for (const source of detectOrder) {
      if (source === "path") {
        const { locale } = splitLocale(target.pathname);
        if (locale !== null) return { locale, source };
      } else if (source === "cookie") {
        const locale = readLocaleCookie(request);
        if (locale !== null) return { locale, source };
      } else {
        const locale = matchAcceptLanguage(request.headers.get("accept-language"), locales, {
          wildcard: defaultLocale,
        }) as L | null;
        if (locale !== null) return { locale, source };
      }
    }
    return { locale: defaultLocale, source: "default" };
  }

  function isHttps(url: URL | string | undefined): boolean {
    if (url === undefined) return false;
    if (typeof url !== "string") return url.protocol === "https:";
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  }

  function serializeCookie(locale: L | null, options: LocaleCookieOptions = {}): string {
    if (cookie === false) {
      throw new TypeError("i18n: the locale cookie is disabled (`cookie: false`).");
    }
    if (locale !== null && !isLocale(locale)) {
      throw new TypeError(
        `localeCookie: unknown locale "${String(locale)}". Registered locales: ${locales.join(", ")}.`,
      );
    }
    const attributes = [
      // Clearing keeps every other attribute identical so the browser matches
      // and replaces the existing cookie instead of adding a second one.
      `${cookie.name}=${locale ?? ""}`,
      `Path=${cookie.path}`,
      `Max-Age=${locale === null ? 0 : cookie.maxAge}`,
      `SameSite=${cookie.sameSite}`,
    ];
    if (cookie.domain !== undefined) attributes.push(`Domain=${cookie.domain}`);
    // Browsers reject SameSite=None cookies without Secure. Do not let an
    // explicit false override produce a cookie that silently fails to persist.
    const secure =
      cookie.sameSite === "None" || (options.secure ?? cookie.secure ?? isHttps(options.url));
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  function setLocaleCookie(locale: L | null, options: LocaleCookieOptions = {}): string {
    if (typeof document === "undefined") {
      throw new TypeError(
        "setLocaleCookie: no `document` in this environment. Use localeCookie() and send it as a Set-Cookie header instead.",
      );
    }
    const url =
      options.url ?? (typeof location === "undefined" ? undefined : (location.href as string));
    const serialized = serializeCookie(locale, { ...options, url });
    document.cookie = serialized;
    return serialized;
  }

  function detectClient(): I18nDetection<L> {
    // Node exposes a global `navigator` whose `language` is the *server's*
    // locale, so a server render must not fall through to the header source.
    // `document` is the browser marker every source here depends on.
    if (typeof document === "undefined") return { locale: defaultLocale, source: "default" };
    for (const source of detectOrder) {
      if (source === "path") {
        if (typeof location === "undefined") continue;
        const { locale } = splitLocale(location.pathname);
        if (locale !== null) return { locale, source };
      } else if (source === "cookie") {
        if (cookie === false || typeof document === "undefined") continue;
        const locale = toLocale(readCookieValue(document.cookie, cookie.name));
        if (locale !== null) return { locale, source };
      } else {
        if (typeof navigator === "undefined") continue;
        // `navigator.languages` is already in preference order and carries no
        // q-values, so joining it reads as an `Accept-Language` header where
        // position decides — which is exactly the matcher's tie-break.
        const languages =
          navigator.languages && navigator.languages.length > 0
            ? navigator.languages
            : navigator.language
              ? [navigator.language]
              : [];
        if (languages.length === 0) continue;
        const locale = matchAcceptLanguage(languages.join(","), locales, {
          wildcard: defaultLocale,
        }) as L | null;
        if (locale !== null) return { locale, source };
      }
    }
    return { locale: defaultLocale, source: "default" };
  }

  const middleware: MiddlewareFn = async (args, next) => {
    const detection = detect(args.request, args.url);
    if (args.context !== null && typeof args.context === "object") {
      (args.context as Record<string, unknown>).locale = detection.locale;
    }
    const response = await next();

    // `Vary` bookkeeping: every source consulted before detection settled —
    // up to and including the winner, or all of them when nothing matched —
    // is request state the response depends on, so shared caches must key
    // on the matching header. The path source contributes nothing (the URL
    // is already the cache key). Note this intentionally makes an ISG route
    // that relies on cookie/header detection uncacheable (`Vary: Cookie`
    // fails `isCacheableISGResponse`): a per-request locale can never be
    // served from a shared cache — keep ISG/SSG routes inside locale
    // `pathPrefix` groups with `"path"` first in the detect order.
    const consulted =
      detection.source === "default"
        ? detectOrder
        : detectOrder.slice(0, detectOrder.indexOf(detection.source) + 1);
    const vary: string[] = [];
    for (const source of consulted) {
      if (source === "cookie" && cookie !== false) vary.push("Cookie");
      else if (source === "header") vary.push("Accept-Language");
    }

    // Persist only an *explicit* choice — the URL prefix the user navigated
    // to. Header-derived locales are not persisted (they would pin a
    // first-request guess forever), and prerenderable (SSG/ISG) routes never
    // persist here: their output is stored and replayed to every visitor, so
    // a Set-Cookie would fail the prerender build and make every ISG
    // regeneration uncacheable. Prerendered locale routes that want
    // unprefixed detector pages to remember the choice call
    // `setLocaleCookie()` after hydration instead.
    const render = (args.route as { render?: string } | undefined)?.render;
    const prerenderable = render === "ssg" || render === "isg";
    const setCookie =
      !prerenderable &&
      cookie !== false &&
      detection.source === "path" &&
      readLocaleCookie(args.request) !== detection.locale
        ? serializeCookie(detection.locale, { url: args.url })
        : null;

    if (vary.length === 0 && setCookie === null) return response;
    return withDetectionHeaders(response, setCookie, vary);
  };

  return {
    locales,
    defaultLocale,
    cookieName: cookie === false ? null : cookie.name,
    isLocale,
    detect,
    detectClient,
    localeCookie: serializeCookie,
    setLocaleCookie,
    localePath,
    splitLocale,
    hreflang,
    middleware,
  };
}
