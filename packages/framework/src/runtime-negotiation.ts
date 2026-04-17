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

export function markdownResponse(source: string): Response {
  const headers = new Headers({
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "public, max-age=0, must-revalidate",
  });
  appendVaryHeader(headers, "Accept");
  applyDefaultSecurityHeaders(headers);
  return new Response(source, { status: 200, headers });
}
