/**
 * The `pracht build` half of `<path>.md` files: which planned files the
 * page's own headers allow, the headers each file is served with, and the
 * `<link rel="alternate">` that points the page at it. Which pages qualify at
 * all is `planMarkdownFiles()` in @pracht/core, shared with the dev server.
 */

const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";

/** Headers that describe the HTML body rather than the page. */
const HTML_BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding", "etag"]);

/**
 * The headers a page's Markdown file is served with: the page's own
 * `headers()` result as prerendered, with the Markdown content type — what the
 * runtime sends for `Accept: text/markdown` on that URL. Returns the reason
 * instead when the page's headers keep it out of search indexes or shared
 * caches: a public static copy of it would undo that.
 */
export function markdownFileHeaders(
  pageHeaders: Record<string, string> | undefined,
): { headers: Record<string, string> } | { reason: string } {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(pageHeaders ?? {})) {
    const key = name.toLowerCase();
    if (key === "x-robots-tag" && /\b(noindex|none)\b/i.test(value)) {
      return { reason: "the page sends X-Robots-Tag: noindex" };
    }
    if (key === "cache-control" && /\b(private|no-store)\b/i.test(value)) {
      return { reason: `the page sends Cache-Control: ${value}` };
    }
    if (!HTML_BODY_HEADERS.has(key)) headers[key] = value;
  }
  headers["content-type"] = MARKDOWN_CONTENT_TYPE;
  return { headers };
}

/**
 * The URL a page links its Markdown file at: the route-space path under the
 * deploy base. An absolute or protocol-relative base points assets at a CDN
 * and leaves documents at the origin root, as the runtime's `withBase()` does.
 */
export function markdownFileHref(buildBase: string, markdownPath: string): string {
  let base = buildBase;
  if (
    base === "" ||
    base === "." ||
    base === "./" ||
    base.includes("://") ||
    base.startsWith("//")
  ) {
    base = "/";
  }
  if (!base.startsWith("/")) base = `/${base}`;
  if (!base.endsWith("/")) base = `${base}/`;
  return `${base}${markdownPath.slice(1)}`;
}

/**
 * Add `<link rel="alternate" type="text/markdown">` to a prerendered document.
 *
 * Islands-navigation documents mark every head node they own; the link
 * carries the same marker so an in-place navigation swaps it with the rest of
 * the page's head.
 */
export function injectMarkdownAlternateLink(html: string, href: string): string {
  const owned = html.includes('id="pracht-nav"') ? " data-pracht-owned" : "";
  const escaped = href
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const tag = `<link${owned} rel="alternate" type="text/markdown" href="${escaped}">`;
  // The document prefix is generated, so this exact `</head>` + `<body>`
  // sequence is the real end of the head even if a head script mentions
  // `</head>` in its text.
  const anchor = html.indexOf("\n  </head>\n  <body>");
  const index = anchor === -1 ? html.indexOf("</head>") : anchor;
  if (index === -1) return html;
  const indent = anchor === -1 ? "" : "\n    ";
  return `${html.slice(0, index)}${indent}${tag}${html.slice(index)}`;
}

/** Name a handful of entries and count the rest, so a large site's log stays short. */
export function formatMarkdownSkipList(entries: { pagePath: string; reason: string }[]): string {
  const shown = entries
    .slice(0, 5)
    .map((entry) => `${entry.pagePath} (${entry.reason})`)
    .join(", ");
  return entries.length > 5 ? `${shown}, and ${entries.length - 5} more` : shown;
}
