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
   * Prefix a path with a locale, replacing any existing locale prefix and
   * preserving query/hash: `localePath("/en/shop?page=2", "nl")` →
   * `"/nl/shop?page=2"`. Throws on unregistered locales so user input can
   * never be reflected into a path.
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

/** Append a Set-Cookie header, cloning when the headers are immutable. */
function withSetCookie(response: Response, cookie: string): Response {
  try {
    response.headers.append("set-cookie", cookie);
    return response;
  } catch {
    const clone = new Response(response.body, response);
    clone.headers.append("set-cookie", cookie);
    return clone;
  }
}

function normalizePathname(path: string): string {
  let pathname = typeof path === "string" ? path : "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  // Collapse leading slash runs so `//host` can never read as
  // protocol-relative once an origin is prepended.
  return pathname.replace(/^\/{2,}/, "/");
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
  const detectOrder = config.detect ?? DETECT_SOURCES;
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

  /** Map arbitrary input to a registered locale (canonical casing) or null. */
  function toLocale(value: unknown): L | null {
    if (typeof value !== "string" || value.length === 0 || value.length > 35) return null;
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
    return { locale, pathname: rest.length === 0 ? "/" : `/${rest}` };
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

  function serializeCookie(locale: L, url: URL): string {
    if (cookie === false) throw new TypeError("i18n cookie is disabled.");
    const attributes = [
      `${cookie.name}=${locale}`,
      `Path=${cookie.path}`,
      `Max-Age=${cookie.maxAge}`,
      `SameSite=${cookie.sameSite}`,
    ];
    if (cookie.domain !== undefined) attributes.push(`Domain=${cookie.domain}`);
    const secure = cookie.secure ?? (cookie.sameSite === "None" || url.protocol === "https:");
    if (secure) attributes.push("Secure");
    return attributes.join("; ");
  }

  const middleware: MiddlewareFn = async (args, next) => {
    const detection = detect(args.request, args.url);
    if (args.context !== null && typeof args.context === "object") {
      (args.context as Record<string, unknown>).locale = detection.locale;
    }
    const response = await next();
    // Persist only an *explicit* choice — the URL prefix the user navigated
    // to — so unprefixed pages remember it. Header-derived locales are not
    // persisted: they would pin a first-request guess forever, and
    // prerendered (SSG/ISG) documents must never carry Set-Cookie.
    if (
      cookie !== false &&
      detection.source === "path" &&
      readLocaleCookie(args.request) !== detection.locale
    ) {
      return withSetCookie(response, serializeCookie(detection.locale, args.url));
    }
    return response;
  };

  return {
    locales,
    defaultLocale,
    cookieName: cookie === false ? null : cookie.name,
    isLocale,
    detect,
    localePath,
    splitLocale,
    hreflang,
    middleware,
  };
}
