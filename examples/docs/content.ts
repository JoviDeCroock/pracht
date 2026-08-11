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
 *   - `prev`/`next` frontmatter → bottom navigation
 */

import { defineCollection, llmsTxtArtifacts, type ContentCompileInput } from "@pracht/content";
import { Marked, Renderer } from "marked";

// ── Inline highlight (same tokenizer as utils/highlight.ts) ──────────────────

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "as",
  "default",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "type",
  "interface",
  "class",
  "extends",
  "implements",
  "new",
  "if",
  "else",
  "for",
  "while",
  "of",
  "in",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "null",
  "undefined",
  "true",
  "false",
  "void",
  "typeof",
  "instanceof",
  "keyof",
]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

function highlight(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }
    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const q = code[i];
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (code[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out.push(`<span class="str">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        out.push(`<span class="kw">${esc(word)}</span>`);
      } else if (/^[A-Z]/.test(word)) {
        out.push(`<span class="typ">${esc(word)}</span>`);
      } else {
        out.push(esc(word));
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < n && /[0-9._]/.test(code[j])) j++;
      out.push(`<span class="num">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    out.push(esc(code[i]));
    i++;
  }

  return out.join("");
}

// ── Frontmatter parser ───────────────────────────────────────────────────────

interface Frontmatter {
  title: string;
  lead?: string;
  breadcrumb?: string;
  prev?: { href: string; title: string };
  next?: { href: string; title: string };
  [key: string]: unknown;
}

// ── Marked renderer ──────────────────────────────────────────────────────────

function createRenderer(): Renderer {
  const renderer = new Renderer();

  renderer.code = function ({ text, lang }: { text: string; lang?: string }) {
    // Extract filename from lang like "ts [src/routes.ts]" or "ts filename="src/routes.ts""
    let filename = "";
    let language = lang || "";

    const bracketMatch = language.match(/^(\w*)\s*\[([^\]]+)\]$/);
    if (bracketMatch) {
      language = bracketMatch[1];
      filename = bracketMatch[2];
    }

    const highlighted = highlight(text);

    let header = "";
    if (filename) {
      header = `<div class="code-block-header"><div class="code-block-dots"><span></span><span></span><span></span></div><span class="code-block-title">${esc(filename)}</span></div>`;
    }

    return `<div class="code-block">${header}<pre><code>${highlighted}</code></pre></div>`;
  };

  renderer.hr = function () {
    return '<div class="doc-sep"></div>';
  };

  renderer.blockquote = function ({ tokens }: { tokens: import("marked").Tokens.Generic[] }) {
    // In marked v18 the blockquote callback receives the unparsed inline
    // markdown as `text`; we have to render the child tokens ourselves to
    // get HTML (otherwise `**bold**` and `` `code` `` come out raw).
    const inner = this.parser.parse(tokens);
    // Support GitHub-style alerts: > [!NOTE] or > [!INFO]
    const noteMatch = inner.match(/^\s*<p>\[!(NOTE|INFO|TIP|WARNING)\]\s*/);
    if (noteMatch) {
      const type = noteMatch[1].toLowerCase();
      const cssClass = type === "info" ? "callout-info" : "callout-note";
      const icon = type === "info" ? "\u2139\uFE0F" : "\uD83D\uDCA1";
      const content = inner.replace(/^\s*<p>\[!(NOTE|INFO|TIP|WARNING)\]\s*/, "<p>");
      return `<div class="callout ${cssClass}"><span class="callout-icon">${icon}</span><span>${content}</span></div>`;
    }
    return `<blockquote>${inner}</blockquote>`;
  };

  return renderer;
}

// ── Build full doc page HTML ─────────────────────────────────────────────────

function buildDocPage(fm: Frontmatter, contentHtml: string): string {
  const parts: string[] = [];

  // Breadcrumb
  const crumb = fm.breadcrumb || fm.title;
  parts.push(
    `<div class="breadcrumb"><a href="/">pracht</a><span class="breadcrumb-sep">/</span><span>${esc(crumb)}</span></div>`,
  );

  // Title
  parts.push(`<h1 class="doc-title">${esc(fm.title)}</h1>`);

  // Lead paragraph
  if (fm.lead) {
    parts.push(`<p class="doc-lead">${renderLead(fm.lead)}</p>`);
  }

  // Main content
  parts.push(contentHtml);

  // Prev/Next navigation
  if (fm.prev || fm.next) {
    parts.push('<div class="doc-nav">');
    if (fm.prev) {
      parts.push(
        `<a href="${fm.prev.href}" class="doc-nav-card prev"><div class="doc-nav-dir">Previous</div><div class="doc-nav-title">\u2190 ${esc(fm.prev.title)}</div></a>`,
      );
    } else {
      parts.push("<div></div>");
    }
    if (fm.next) {
      parts.push(
        `<a href="${fm.next.href}" class="doc-nav-card next"><div class="doc-nav-dir">Next</div><div class="doc-nav-title">${esc(fm.next.title)} \u2192</div></a>`,
      );
    } else {
      parts.push("<div></div>");
    }
    parts.push("</div>");
  }

  return parts.join("\n");
}

// ── Collection ───────────────────────────────────────────────────────────────

interface CompiledDoc {
  headTitle: string;
  pageHtml: string;
}

const marked = new Marked({ renderer: createRenderer() });

export const docsContent = defineCollection<Frontmatter, CompiledDoc>({
  name: "docs",
  root: new URL("./src/routes/docs", import.meta.url),
  routeBase: "/docs",
  route({ id }) {
    if (id.startsWith("recipes-")) return `/docs/recipes/${id.slice("recipes-".length)}`;
    if (id.startsWith("migrate-")) return `/docs/migrate/${id.slice("migrate-".length)}`;
    return `/docs/${id}`;
  },
  compile({ body, frontmatter }: ContentCompileInput<Frontmatter>) {
    let contentHtml = marked.parse(body) as string;
    contentHtml = contentHtml
      .replace(/<table>/g, '<div class="doc-table-wrap"><table class="doc-table">')
      .replace(/<\/table>/g, "</table></div>");
    return {
      headTitle: frontmatter.title ? `${frontmatter.title} \u2014 pracht docs` : "pracht docs",
      pageHtml: buildDocPage(frontmatter, contentHtml),
    };
  },
  module(document) {
    return [
      `import { h } from "preact";`,
      ``,
      `export const markdown = ${JSON.stringify(document.raw)};`,
      ``,
      `export function head() {`,
      `  return { title: ${JSON.stringify(document.compiled.headTitle)} };`,
      `}`,
      ``,
      `export function Component() {`,
      `  return h("div", { class: "doc-page", dangerouslySetInnerHTML: { __html: ${JSON.stringify(document.compiled.pageHtml)} } });`,
      `}`,
    ].join("\n");
  },
  artifacts: [
    llmsTxtArtifacts({
      origin: "https://pracht.resynapse.dev",
      title: "pracht",
      description:
        "A full-stack Preact framework built on Vite with hybrid rendering (SSG, SSR, ISG, SPA) and a unified data-loading model.",
      sections: [{ heading: "Docs", match: "/docs" }],
    }),
  ],
});
