/**
 * The docs site's canonical content collection and Markdown compiler.
 *
 * Markdown files with frontmatter become full route components:
 *   - `title` → head() export
 *   - Body → Component() with doc-page structure
 *   - Code fences → syntax-highlighted code blocks
 *   - Tables → doc-table styled tables
 *   - Blockquotes with [!NOTE]/[!INFO] → callout boxes
 *   - `---` separators → doc-sep dividers
 *   - h2/h3 headings → the "On this page" rail
 *
 * The breadcrumb and previous/next links come from `src/nav.ts`, rendered by
 * the docs shell.
 */

import { llmsTxtArtifacts } from "@pracht/content";
import { defineMarkdownCollection } from "@pracht/markdown";
import { Marked, Renderer } from "marked";

import { NAV, navContext } from "./src/nav";
import { SITE_NAME, SITE_ORIGIN, absoluteUrl } from "./src/site";
import { esc, highlight, languageLabel } from "./src/utils/highlight";
import { slugify } from "./src/utils/heading-slug";

/**
 * Render a one-line Markdown string (the frontmatter `lead`) to HTML.
 *
 * The lead is the single field that reaches two renderers: this one, and the
 * llms.txt generator, which emits it verbatim into a Markdown document. Authors
 * therefore write Markdown — `` `pracht eval` `` — and the code-span conversion
 * happens here. Writing raw `<code>` in the source instead put literal HTML
 * tags (and HTML entities like `&lt;Form&gt;`) into the published llms.txt.
 *
 * Everything outside a code span is escaped, so the lead can never inject
 * markup.
 */
function renderLead(lead: string): string {
  return lead
    .split(/(`[^`]+`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 2
        ? `<code>${esc(part.slice(1, -1))}</code>`
        : esc(part),
    )
    .join("");
}

/** The lead as plain text, for `<meta name="description">` and structured data. */
export function plainLead(lead: string): string {
  return lead
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

// ── Frontmatter ──────────────────────────────────────────────────────────────

interface Frontmatter {
  title: string;
  lead?: string;
  [key: string]: unknown;
}

// ── Marked renderer ──────────────────────────────────────────────────────────

const CALLOUTS: Record<string, string> = {
  NOTE: "Note",
  INFO: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

function createRenderer(): Renderer {
  const renderer = new Renderer();
  // Slugs are unique per document; the counter resets with each renderer, and
  // `createMarked` builds one per compile.
  const usedSlugs = new Map<string, number>();

  renderer.heading = function ({
    tokens,
    depth,
  }: {
    tokens: import("marked").Tokens.Generic[];
    depth: number;
  }) {
    const inner = this.parser.parseInline(tokens);
    const base = slugify(inner) || `section-${usedSlugs.size + 1}`;
    const seen = usedSlugs.get(base) ?? 0;
    usedSlugs.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen}`;
    // An empty permalink keeps the heading text (and its accessible name)
    // unchanged; the docs index reads the text back from this HTML.
    return `<h${depth} id="${id}">${inner}<a class="heading-anchor" href="#${id}" aria-hidden="true" tabindex="-1"></a></h${depth}>`;
  };

  renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    // A fence info string may carry a filename: "ts [src/routes.ts]".
    let filename = "";
    let language = (lang || "").trim();

    const bracketMatch = language.match(/^(\w*)\s*\[([^\]]+)\]$/);
    if (bracketMatch) {
      language = bracketMatch[1];
      filename = bracketMatch[2];
    }

    const title = filename || languageLabel(language);
    const header =
      `<div class="code-block-header">` +
      `<span class="code-block-title">${esc(title)}</span>` +
      `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>` +
      `</div>`;

    return `<div class="code-block" data-lang="${escAttr(language)}">${header}<pre><code>${highlight(text, language)}</code></pre></div>`;
  };

  renderer.hr = function () {
    return '<div class="doc-sep"></div>';
  };

  renderer.blockquote = function ({ tokens }: { tokens: import("marked").Tokens.Generic[] }) {
    // In marked v18 the blockquote callback receives the unparsed inline
    // markdown as `text`; render the child tokens to get HTML.
    const inner = this.parser.parse(tokens);
    // GitHub-style alerts: > [!NOTE], > [!TIP], > [!WARNING], …
    const alert = inner.match(/^\s*<p>\[!(NOTE|INFO|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/);
    if (alert) {
      const kind = alert[1];
      const content = inner.replace(alert[0], "<p>");
      const tone = kind === "WARNING" || kind === "CAUTION" ? "warning" : kind.toLowerCase();
      return `<aside class="callout callout-${tone === "info" ? "note" : tone}" role="note"><p class="callout-title">${CALLOUTS[kind]}</p>${content}</aside>`;
    }
    return `<blockquote>${inner}</blockquote>`;
  };

  return renderer;
}

// ── Build full doc page HTML ─────────────────────────────────────────────────

interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

/** h2/h3 headings from the compiled HTML, for the "On this page" rail. */
function tableOfContents(html: string): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const match of html.matchAll(/<h([23]) id="([^"]+)">([\s\S]*?)<\/h[23]>/g)) {
    const text = match[3].replace(/<[^>]*>/g, "").trim();
    entries.push({ depth: Number(match[1]), id: match[2], text });
  }
  return entries;
}

function buildDocPage(fm: Frontmatter, contentHtml: string): string {
  const article: string[] = [];
  article.push(`<h1 class="doc-title">${esc(fm.title)}</h1>`);
  if (fm.lead) article.push(`<p class="doc-lead">${renderLead(fm.lead)}</p>`);
  article.push(contentHtml);

  const toc = tableOfContents(contentHtml);
  const items = toc
    .map(
      (entry) =>
        `<li class="toc-depth-${entry.depth}"><a href="#${entry.id}">${entry.text}</a></li>`,
    )
    .join("");
  const rail =
    toc.length >= 2
      ? `<nav class="doc-toc" aria-label="On this page"><p class="doc-toc-title">On this page</p><ul>${items}</ul></nav>`
      : "";
  // Below the rail's breakpoint the outline collapses above the content.
  if (toc.length >= 2) {
    article.splice(
      fm.lead ? 2 : 1,
      0,
      `<details class="doc-toc-inline"><summary>On this page</summary><ul>${items}</ul></details>`,
    );
  }

  return `<article class="doc-article">${article.join("\n")}</article>${rail}`;
}

// ── llms.txt sections ───────────────────────────────────────────────────────

/**
 * The llms.txt sections: the sidebar groups from `src/nav.ts`, in sidebar
 * order, each with its own full-text file so one fetch loads one area of the
 * docs. `test/site-content.test.ts` checks that every page sits in exactly one
 * section.
 */
export const LLMS_SECTIONS = NAV.map((section) => ({
  heading: section.label,
  fullPath: section.llms,
  pages: section.links.map((link) => link.href),
}));

// ── Collection ───────────────────────────────────────────────────────────────

export const docsContent = defineMarkdownCollection<Frontmatter>({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  route({ id }) {
    if (id.startsWith("recipes-")) return `/docs/recipes/${id.slice("recipes-".length)}`;
    if (id.startsWith("migrate-")) return `/docs/migrate/${id.slice("migrate-".length)}`;
    if (id.startsWith("reference-")) return `/docs/reference/${id.slice("reference-".length)}`;
    return `/docs/${id}`;
  },
  createMarked: () => new Marked({ renderer: createRenderer() }),
  render({ html, input }) {
    const contentHtml = html
      .replace(/<table>/g, '<div class="doc-table-wrap"><table class="doc-table">')
      .replace(/<\/table>/g, "</table></div>");
    return `<div class="doc-page">${buildDocPage(input.frontmatter, contentHtml)}</div>`;
  },
  head({ input }) {
    const { title, lead } = input.frontmatter;
    const description = lead ? plainLead(lead) : undefined;
    const section = navContext(input.path).entry?.section;
    const url = absoluteUrl(input.path);
    const article = {
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: title,
      ...(description ? { description } : {}),
      url,
      inLanguage: "en",
      ...(section ? { articleSection: section } : {}),
      isPartOf: { "@type": "WebSite", name: `${SITE_NAME} docs`, url: `${SITE_ORIGIN}/` },
    };
    return {
      title: `${title} \u2014 ${SITE_NAME} docs`,
      meta: [
        ...(description
          ? [
              { name: "description", content: description },
              { property: "og:description", content: description },
              { name: "twitter:description", content: description },
            ]
          : []),
        { property: "og:title", content: `${title} \u2014 ${SITE_NAME}` },
        { name: "twitter:title", content: `${title} \u2014 ${SITE_NAME}` },
      ],
      script: [
        {
          type: "application/ld+json",
          children: JSON.stringify(article),
        },
      ],
    };
  },
  images: { sizes: "(max-width: 960px) 100vw, 960px" },
  artifacts: [
    llmsTxtArtifacts({
      origin: SITE_ORIGIN,
      title: SITE_NAME,
      description:
        "A full-stack Preact framework on Vite: per-route rendering (SSG, SSR, ISG, SPA), loaders, API routes, and typed capabilities that agents call over HTTP, WebMCP, and MCP.",
      details: [
        `Each page link below points at the page's Markdown: append \`.md\` to any docs URL, or request the page URL with \`Accept: text/markdown\`. For example, ${SITE_ORIGIN}/docs/routing.md is the Markdown of ${SITE_ORIGIN}/docs/routing.`,
        "",
        `Each section also has a full-text file, listed under Optional, that holds all of its pages, so one fetch loads one area of the docs. ${SITE_ORIGIN}/llms-full.txt holds every page.`,
        "",
        `These docs are also a remote MCP server: add ${SITE_ORIGIN}/mcp as a Streamable HTTP server for the read-only \`docs_search\`, \`docs_read\`, and \`docs_list\` tools.`,
        "",
        `Agent skills for building pracht apps are indexed at ${SITE_ORIGIN}/.well-known/agent-skills/index.json.`,
      ],
      link: (document) => `${document.path}.md`,
      sections: LLMS_SECTIONS.map(({ heading, fullPath, pages }) => {
        const order: readonly string[] = pages;
        return {
          heading,
          fullPath,
          match: (document) => order.includes(document.path),
          // Sidebar order, so a section reads top to bottom like the nav.
          sort: (a, b) => order.indexOf(a.path) - order.indexOf(b.path),
        };
      }),
    }),
  ],
});
