/**
 * Vite plugin that transforms .md files into pracht route modules.
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

import type { Plugin } from "vite";
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

function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: { title: "" }, body: raw };

  const yaml = match[1];
  const body = match[2];
  const fm: Record<string, unknown> = {};

  let currentKey = "";
  let _indent = 0;
  let nested: Record<string, string> | null = null;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;

    const nestedMatch = trimmed.match(/^(\s+)(\w+):\s*(.*)$/);
    if (nestedMatch && nested && currentKey) {
      nested[nestedMatch[2]] = nestedMatch[3].replace(/^["']|["']$/g, "");
      fm[currentKey] = nested;
      continue;
    }

    const topMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (topMatch) {
      if (nested && currentKey) {
        fm[currentKey] = nested;
      }
      currentKey = topMatch[1];
      const value = topMatch[2].replace(/^["']|["']$/g, "");
      if (value === "") {
        // Start of nested object
        nested = {};
        _indent = 0;
      } else {
        nested = null;
        fm[currentKey] = value;
      }
    }
  }
  if (nested && currentKey) {
    fm[currentKey] = nested;
  }

  return { frontmatter: fm as unknown as Frontmatter, body };
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

  renderer.blockquote = function ({ text }: { text: string }) {
    // Support GitHub-style alerts: > [!NOTE] or > [!INFO]
    const noteMatch = text.match(/^\s*<p>\[!(NOTE|INFO|TIP|WARNING)\]\s*/);
    if (noteMatch) {
      const type = noteMatch[1].toLowerCase();
      const cssClass = type === "info" ? "callout-info" : "callout-note";
      const icon = type === "info" ? "\u2139\uFE0F" : "\uD83D\uDCA1";
      const content = text.replace(/^\s*<p>\[!(NOTE|INFO|TIP|WARNING)\]\s*/, "<p>");
      return `<div class="callout ${cssClass}"><span class="callout-icon">${icon}</span><span>${content}</span></div>`;
    }
    return `<blockquote>${text}</blockquote>`;
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
    parts.push(`<p class="doc-lead">${fm.lead}</p>`);
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

// ── Plugin ───────────────────────────────────────────────────────────────────

export function markdown(): Plugin {
  const marked = new Marked({ renderer: createRenderer() });

  return {
    name: "pracht-md",
    enforce: "pre",

    transform(code, id) {
      // Strip query suffix (e.g. `?pracht-client`) before checking extension —
      // Vite adds queries for glob-imported client variants.
      const path = id.split("?")[0];
      if (!path.endsWith(".md")) return;

      const { frontmatter, body } = parseFrontmatter(code);
      let contentHtml = marked.parse(body) as string;

      // Wrap tables with doc-table styling
      contentHtml = contentHtml
        .replace(/<table>/g, '<div class="doc-table-wrap"><table class="doc-table">')
        .replace(/<\/table>/g, "</table></div>");
      const pageHtml = buildDocPage(frontmatter, contentHtml);

      const headTitle = frontmatter.title
        ? `${frontmatter.title} \u2014 pracht docs`
        : "pracht docs";

      const output = [
        `import { h } from "preact";`,
        ``,
        `export function head() {`,
        `  return { title: ${JSON.stringify(headTitle)} };`,
        `}`,
        ``,
        `export function Component() {`,
        `  return h("div", { class: "doc-page", dangerouslySetInnerHTML: { __html: ${JSON.stringify(pageHtml)} } });`,
        `}`,
      ].join("\n");

      return { code: output, map: null };
    },
  };
}
