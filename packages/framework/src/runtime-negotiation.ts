import { appendVaryHeader } from "./runtime-header-values.ts";
import { applyDefaultSecurityHeaders } from "./runtime-headers.ts";
import { normalizeRoutePath } from "./route-matching.ts";
import type { ResolvedRoute, RouteModule } from "./types.ts";

export const MARKDOWN_MEDIA_TYPE = "text/markdown";

export type MarkdownManifest = Record<string, true>;

/** Whether a route exposes Markdown through metadata or a raw module export. */
export function hasMarkdownRepresentation(
  route: Pick<ResolvedRoute, "markdown">,
  routeModule: Pick<RouteModule, "markdown"> | undefined,
): boolean {
  return route.markdown === true || typeof routeModule?.markdown === "string";
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

/** Whether the build recorded a raw Markdown representation for this route. */
export function routeSupportsMarkdown(
  markdownManifest: MarkdownManifest,
  pathname: string,
): boolean {
  const normalized = normalizeRoutePath(pathname);
  const withoutIndex = normalized.replace(/\/index\.html$/, "") || "/";
  return Boolean(markdownManifest[normalized] ?? markdownManifest[withoutIndex]);
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
