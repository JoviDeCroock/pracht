import { applyDefaultSecurityHeaders, appendVaryHeader } from "./runtime-headers.ts";

export const MARKDOWN_MEDIA_TYPE = "text/markdown";

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
      if (key === "q" && value != null) {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed)) quality = parsed;
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
  const md = entries.find((e) => e.type === MARKDOWN_MEDIA_TYPE);
  if (!md || md.quality === 0) return false;
  const html = entries.find((e) => e.type === "text/html");
  if (!html) return true;
  return md.quality >= html.quality;
}

/**
 * Whether a route's prerendered document headers declare that the route
 * varies on `Accept`.
 *
 * Adapters serve prerendered SSG/ISG documents from disk (or the assets
 * binding) before the framework runs, so they need a cheap way to tell whether
 * a cached HTML file can answer a markdown-preferring request. Routes that
 * export `markdown` carry `Vary: Accept` in the headers manifest the build
 * emits; every other route — and every app without markdown routes — keeps its
 * cached response, so agent traffic can never push ordinary apps off their
 * static fast path.
 */
export function routeVariesOnAccept(routeHeaders: Record<string, string> | undefined): boolean {
  if (!routeHeaders) return false;
  for (const [key, value] of Object.entries(routeHeaders)) {
    if (key.toLowerCase() !== "vary") continue;
    for (const part of value.split(",")) {
      const token = part.trim().toLowerCase();
      if (token === "accept" || token === "*") return true;
    }
  }
  return false;
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
