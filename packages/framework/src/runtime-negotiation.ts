import { applyDefaultSecurityHeaders, appendVaryHeader } from "./runtime-headers.ts";
import { normalizeRoutePath } from "./route-matching.ts";
import type { PrachtMarkdownConfig } from "./types.ts";

export const MARKDOWN_MEDIA_TYPE = "text/markdown";

/**
 * Exact build metadata for prerendered Markdown routes. Canonical paths map
 * to `true`; native `.md` aliases map to their canonical route pathname.
 */
export type MarkdownManifest = Record<string, true | string>;

export interface RouteRequestKind {
  /** Pathname used for application route matching. */
  pathname: string;
  /** A route-state transport marker must bypass static HTML and never become Markdown. */
  routeState: boolean;
  /** The request asks for the route's Markdown representation. */
  markdown: boolean;
  /** The request used a native `.md` pathname instead of Accept negotiation. */
  markdownAlias: boolean;
}

export interface ClassifyRouteRequestOptions {
  /** The runtime can supply its provenance-gated route-state decision. */
  routeState?: boolean;
  /** Preserve an exact declared `.md` route instead of treating it as an alias. */
  preservePathname?: boolean;
}

interface AcceptEntry {
  type: string;
  quality: number;
}

function parseAccept(header: string | null): AcceptEntry[] {
  if (!header) return [];
  const entries: AcceptEntry[] = [];
  for (const raw of header.split(",")) {
    const parts = raw.trim().split(";");
    const type = parts.shift()?.trim().toLowerCase();
    if (!type) continue;
    let quality = 1;
    for (const param of parts) {
      const [key, value] = param.split("=").map((p) => p.trim());
      if (key?.toLowerCase() === "q" && value != null) {
        // RFC 9110 qvalues are between 0 and 1 with at most three fractional
        // digits. Invalid values make the media range unacceptable rather
        // than accidentally increasing its preference.
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)) {
          quality = 0;
        } else {
          quality = Number(value);
        }
        break;
      }
    }
    entries.push({ type, quality });
  }
  return entries;
}

// Return true when the client explicitly prefers text/markdown over the
// default text/html. We deliberately ignore wildcard entries (text/*, */*)
// so browsers that send `Accept: */*` keep getting HTML.
export function prefersMarkdown(accept: string | null): boolean {
  const entries = parseAccept(accept);
  if (!entries.length) return false;
  const markdownQuality = highestQuality(entries, MARKDOWN_MEDIA_TYPE);
  if (markdownQuality <= 0) return false;
  const htmlQuality = highestQuality(entries, "text/html");
  return markdownQuality >= htmlQuality;
}

function highestQuality(entries: AcceptEntry[], type: string): number {
  let quality = -1;
  for (const entry of entries) {
    if (entry.type === type && entry.quality > quality) quality = entry.quality;
  }
  return quality;
}

export function isRouteStateTransportRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.headers.get("x-pracht-route-state-request") === "1" ||
    url.searchParams.get("_data") === "1"
  );
}

/** Resolve a native Markdown alias to the pathname used for route matching. */
export function resolveMarkdownAliasPath(
  pathname: string,
  config?: PrachtMarkdownConfig,
): string | undefined {
  return resolveMarkdownAliasPaths(pathname, config)[0];
}

/** Return every possible canonical target for a native Markdown alias. */
export function resolveMarkdownAliasPaths(
  pathname: string,
  config?: PrachtMarkdownConfig,
): string[] {
  const normalized = normalizeRoutePath(pathname);
  const homeAlias = config?.homeAlias === false ? undefined : (config?.homeAlias ?? "/index.md");
  const candidates: string[] = [];
  if (homeAlias && normalized === normalizeRoutePath(homeAlias)) candidates.push("/");
  if (normalized !== "/" && normalized.toLowerCase().endsWith(".md")) {
    const suffixTarget = normalizeRoutePath(normalized.slice(0, -3));
    if (!candidates.includes(suffixTarget)) candidates.push(suffixTarget);
  }
  return candidates;
}

/** Classify a page request once for the framework and every adapter. */
export function classifyRouteRequest(
  request: Request,
  config?: PrachtMarkdownConfig,
  options: ClassifyRouteRequestOptions = {},
): RouteRequestKind {
  const url = new URL(request.url);
  const routeState = options.routeState ?? isRouteStateTransportRequest(request);
  const normalized = normalizeRoutePath(url.pathname);

  if (routeState) {
    return { pathname: normalized, routeState: true, markdown: false, markdownAlias: false };
  }

  const aliasPathname = options.preservePathname
    ? undefined
    : resolveMarkdownAliasPath(normalized, config);
  if (aliasPathname) {
    return { pathname: aliasPathname, routeState: false, markdown: true, markdownAlias: true };
  }

  return {
    pathname: normalized,
    routeState: false,
    markdown: prefersMarkdown(request.headers.get("accept")),
    markdownAlias: false,
  };
}

/** Whether the build recorded a raw Markdown representation for this route. */
export function routeSupportsMarkdown(
  markdownManifest: MarkdownManifest,
  pathname: string,
): boolean {
  const normalized = normalizeRoutePath(pathname);
  const withoutIndex = normalized.replace(/\/index\.html$/, "") || "/";
  return Boolean(markdownManifest[normalized] ?? markdownManifest[withoutIndex]);
}

/** Whether a request must reach the route runtime instead of prerendered HTML. */
export function bypassesPrerenderedDocument(
  request: Request,
  markdownManifest: MarkdownManifest | undefined,
  config?: PrachtMarkdownConfig,
): boolean {
  const kind = classifyRouteRequest(request, config);
  if (kind.routeState) return true;
  const requestPathname = normalizeRoutePath(new URL(request.url).pathname);
  // A canonical route is allowed to end in `.md`. The manifest distinguishes
  // that exact route (`true`) from an alias (its canonical pathname), so keep
  // serving its prerendered HTML unless the Accept header requests Markdown.
  if (kind.markdownAlias && markdownManifest?.[requestPathname] === true) {
    return prefersMarkdown(request.headers.get("accept"));
  }
  if (!kind.markdown) return false;
  if (markdownManifest === undefined) return true;
  return (
    routeSupportsMarkdown(markdownManifest, new URL(request.url).pathname) ||
    routeSupportsMarkdown(markdownManifest, kind.pathname)
  );
}

/** Add canonical and native alias entries for one concrete Markdown path. */
export function addMarkdownManifestRoute(
  manifest: MarkdownManifest,
  pathname: string,
  config?: PrachtMarkdownConfig,
  literalRoutePaths?: ReadonlySet<string>,
): void {
  const canonical = normalizeRoutePath(pathname);
  const existingCanonical = manifest[canonical];
  if (existingCanonical !== undefined && existingCanonical !== true) {
    throw new Error(
      `Markdown route ${JSON.stringify(canonical)} collides with the native alias for ${JSON.stringify(existingCanonical)}.`,
    );
  }
  manifest[canonical] = true;
  const homeAlias = config?.homeAlias === false ? undefined : (config?.homeAlias ?? "/index.md");
  const alias = canonical === "/" ? homeAlias : `${canonical}.md`;
  if (alias) {
    const normalizedAlias = normalizeRoutePath(alias);
    if (literalRoutePaths?.has(normalizedAlias)) {
      throw new Error(
        `Markdown alias ${JSON.stringify(normalizedAlias)} for ${JSON.stringify(canonical)} collides with the declared route ${JSON.stringify(normalizedAlias)}. Change one of the route paths or configure a different defineApp({ markdown: { homeAlias } }) value.`,
      );
    }
    const existingAlias = manifest[normalizedAlias];
    if (existingAlias !== undefined && existingAlias !== canonical) {
      const existingTarget = existingAlias === true ? normalizedAlias : existingAlias;
      throw new Error(
        `Markdown alias ${JSON.stringify(normalizedAlias)} is ambiguous between ${JSON.stringify(existingTarget)} and ${JSON.stringify(canonical)}. Configure a different defineApp({ markdown: { homeAlias } }) value or change one of the route paths.`,
      );
    }
    manifest[normalizedAlias] = canonical;
  }
}

export function markdownResponse(
  source: string,
  initHeaders?: HeadersInit,
  status = 200,
): Response {
  const headers = new Headers(initHeaders);
  headers.set("content-type", "text/markdown; charset=utf-8");
  appendVaryHeader(headers, "Accept");
  applyDefaultSecurityHeaders(headers);
  return new Response(source, { status, headers });
}
