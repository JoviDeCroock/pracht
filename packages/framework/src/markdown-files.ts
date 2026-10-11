/**
 * Build-time `.md` companions for prerendered pages.
 *
 * An SSG route with a Markdown representation (a `markdown` export, or
 * `markdown: true` for middleware-owned negotiation) answers
 * `Accept: text/markdown` at its own URL. Many agent fetchers never send that
 * header, and a static host cannot negotiate at all, so `pracht build` also
 * writes the Markdown next to the page: `/about` → `/about.md`, with the root
 * at `/index.md`. These helpers own that path mapping so the build, the dev
 * server, and the llms.txt generator agree on it.
 */

import {
  ISLANDS_NAVIGATION_DATA_ID,
  ISLANDS_NAVIGATION_OWNED_ATTRIBUTE,
} from "./islands-shared.ts";
import { escapeHtml } from "./runtime-html.ts";

/** Route path → the route-space path of its Markdown file (base-free). */
export function markdownFilePath(routePath: string): string {
  const trimmed = routePath.length > 1 ? routePath.replace(/\/+$/, "") : routePath;
  return trimmed === "/" || trimmed === "" ? "/index.md" : `${trimmed}.md`;
}

/**
 * Markdown file path → the page paths that could own it, most specific first.
 *
 * `/index.md` belongs to the root page, or to a literal `/index` route when the
 * root has no Markdown file. An empty stem (`/.md`, `/docs/.md`) owns nothing.
 */
export function markdownFilePagePaths(pathname: string): string[] {
  if (!pathname.endsWith(".md")) return [];
  const stem = pathname.slice(0, -".md".length);
  if (stem === "" || stem.endsWith("/")) return [];
  return stem === "/index" ? ["/", "/index"] : [stem];
}

/**
 * Add `<link rel="alternate" type="text/markdown">` to a prerendered document
 * so an agent that fetched the HTML can find the Markdown.
 *
 * Documents that carry islands-navigation data mark every head node they own;
 * the link carries the same marker so an in-place navigation adds and removes
 * it like any other page-specific head node.
 */
export function injectMarkdownAlternateLink(html: string, href: string): string {
  const owned = html.includes(`id="${ISLANDS_NAVIGATION_DATA_ID}"`)
    ? ` ${ISLANDS_NAVIGATION_OWNED_ATTRIBUTE}`
    : "";
  const tag = `<link${owned} rel="alternate" type="text/markdown" href="${escapeHtml(href)}">`;
  // The document prefix is generated (runtime-html.ts), so the exact
  // `</head>` + `<body>` sequence identifies the real head end even if a head
  // script happens to mention `</head>` in its text.
  const anchor = html.indexOf("\n  </head>\n  <body>");
  const index = anchor === -1 ? html.indexOf("</head>") : anchor;
  if (index === -1) return html;
  const indent = anchor === -1 ? "" : "\n    ";
  return `${html.slice(0, index)}${indent}${tag}${html.slice(index)}`;
}
