import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The public docs site pages, bundled into this package at build time by
 * `scripts/sync-docs.js`, so `pracht docs` and the dev-mcp docs tools serve
 * the documentation that matches the installed CLI — offline.
 */

export interface DocsPage {
  slug: string;
  /** Published path on the docs site, e.g. `/docs/recipes/auth`. */
  path: string;
  url: string;
  title: string;
  lead: string;
  section: string;
}

export interface DocsIndex {
  site: string;
  pages: DocsPage[];
}

export interface DocsSearchHit {
  slug: string;
  title: string;
  heading: string;
  /** Heading anchor; read just that section with `pracht docs <slug>#<anchor>`. */
  anchor: string;
  snippet: string;
  score: number;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** `<package>/docs/`, from both `src/` and the flat `dist/` chunks. */
export function defaultDocsDir(): string {
  return fileURLToPath(new URL("../docs/", import.meta.url));
}

export function loadDocsIndex(dir: string = defaultDocsDir()): DocsIndex {
  const indexFile = join(dir, "index.json");
  if (!existsSync(indexFile)) {
    throw new Error(
      `The bundled pracht docs are missing (${indexFile}). They ship inside the published ` +
        "@pracht/cli package; in a source checkout, run `pnpm build` first. " +
        "The same pages are online at https://pracht.resynapse.dev/docs.",
    );
  }
  let parsed: Partial<DocsIndex>;
  try {
    parsed = JSON.parse(readFileSync(indexFile, "utf-8")) as Partial<DocsIndex>;
  } catch (error) {
    throw new Error(
      `The bundled pracht docs index is unreadable (${indexFile}): ${error instanceof Error ? error.message : String(error)}. Reinstall @pracht/cli.`,
    );
  }
  const pages = Array.isArray(parsed.pages)
    ? parsed.pages.filter((page) => typeof page?.slug === "string" && SLUG_PATTERN.test(page.slug))
    : [];
  return { site: parsed.site ?? "https://pracht.resynapse.dev", pages };
}

/** Raw Markdown of one page from the index. */
export function readDocsPage(page: DocsPage, dir: string = defaultDocsDir()): string {
  // The slug comes from the bundled index and is validated on load, but never
  // let it address anything other than a sibling `.md` file.
  if (!SLUG_PATTERN.test(page.slug)) throw new Error(`Invalid docs slug "${page.slug}".`);
  return readFileSync(join(dir, `${page.slug}.md`), "utf-8");
}

/** Reduce a topic (slug, site path, site URL, file name, or title) to a comparable key. */
function normalizeTopic(topic: string): { key: string; anchor: string } {
  let value = topic.trim();
  const hashIndex = value.indexOf("#");
  const anchor = hashIndex === -1 ? "" : value.slice(hashIndex + 1).trim();
  if (hashIndex !== -1) value = value.slice(0, hashIndex);
  value = value
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^docs\//i, "")
    .replace(/\.md$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return { key: value, anchor };
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export type DocsTopicMatch =
  | { ok: true; page: DocsPage; anchor: string }
  | { ok: false; message: string; suggestions: string[] };

/**
 * Resolve a topic to a page. Exact slug, site path, and title matches win;
 * otherwise a topic naming exactly one page by a whole slug or title word
 * (`nextjs` → `migrate-nextjs`) resolves to it. Anything else is an error that
 * suggests the closest slugs.
 */
export function matchDocsTopic(index: DocsIndex, topic: string): DocsTopicMatch {
  const { key, anchor } = normalizeTopic(topic);
  const { pages } = index;
  if (key === "") {
    return {
      ok: false,
      message: "Pass a docs topic, e.g. `pracht docs routing`.",
      suggestions: [],
    };
  }

  const exact =
    pages.find((page) => page.slug === key) ??
    pages.find((page) => page.path.replace(/^\/docs\//, "") === key) ??
    pages.find((page) => page.slug === key.replace(/[/\s]+/g, "-")) ??
    pages.find((page) => page.title.toLowerCase() === key);
  if (exact) return { ok: true, page: exact, anchor };

  const keyWords = words(key);
  const containing = pages.filter((page) => {
    const pageWords = new Set([...words(page.slug), ...words(page.title)]);
    return keyWords.length > 0 && keyWords.every((word) => pageWords.has(word));
  });
  if (containing.length === 1) return { ok: true, page: containing[0], anchor };

  const suggestions = (
    containing.length > 1 ? containing : rankByDistance(pages, key).slice(0, 3)
  ).map((page) => page.slug);
  const hint =
    suggestions.length > 0
      ? containing.length > 1
        ? ` It matches several pages: ${suggestions.join(", ")}.`
        : ` Did you mean ${suggestions.join(", ")}?`
      : "";
  return {
    ok: false,
    message: `Unknown docs topic "${topic.trim()}".${hint} Run \`pracht docs\` to list every page, or \`pracht docs --search <query>\` to search them.`,
    suggestions,
  };
}

function rankByDistance(pages: DocsPage[], key: string): DocsPage[] {
  const scored = pages.map((page) => {
    const candidates = [page.slug, page.title.toLowerCase(), ...words(page.slug)];
    const distance = Math.min(...candidates.map((candidate) => levenshtein(key, candidate)));
    const contains = page.slug.includes(key) || key.includes(page.slug);
    return { page, distance: contains ? Math.min(distance, 1) : distance };
  });
  const limit = Math.max(2, Math.floor(key.length / 2));
  return scored
    .filter((entry) => entry.distance <= limit)
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.page);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/** The heading id the docs site emits (GitHub-style), so anchors match site links. */
export function headingAnchor(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/`/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

interface Section {
  level: number;
  heading: string;
  anchor: string;
  /** Line range in the page body, heading line included. */
  start: number;
  end: number;
}

function splitPage(markdown: string): { lines: string[]; bodyStart: number; sections: Section[] } {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let bodyStart = 0;
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) bodyStart = close + 1;
  }

  const sections: Section[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (let i = bodyStart; i < lines.length; i += 1) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(lines[i]);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!heading) continue;
    const base = headingAnchor(heading[2]) || `section-${seen.size + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    sections.push({
      level: heading[1].length,
      heading: heading[2].replace(/`/g, ""),
      anchor: count === 0 ? base : `${base}-${count}`,
      start: i,
      end: lines.length,
    });
  }
  for (const [i, section] of sections.entries()) {
    const next = sections.slice(i + 1).find((candidate) => candidate.level <= section.level);
    section.end = next ? next.start : lines.length;
  }
  return { lines, bodyStart, sections };
}

/** One `#anchor` section of a page, or an error listing the page's anchors. */
export function extractDocsSection(
  markdown: string,
  anchor: string,
): { ok: true; markdown: string } | { ok: false; message: string } {
  const { lines, sections } = splitPage(markdown);
  const wanted = anchor.toLowerCase();
  const section =
    sections.find((candidate) => candidate.anchor === wanted) ??
    sections.find((candidate) => candidate.anchor === headingAnchor(anchor));
  if (!section) {
    const available = sections
      .filter((candidate) => candidate.level <= 3)
      .map((candidate) => candidate.anchor);
    return {
      ok: false,
      message: `No section "#${anchor}" on this page. Sections: ${available.join(", ") || "(none)"}.`,
    };
  }
  return {
    ok: true,
    markdown: `${lines.slice(section.start, section.end).join("\n").trimEnd()}\n`,
  };
}

/**
 * Keyword search over headings, paragraphs, list items, and code blocks.
 * Every query word must appear in the block or its heading; a title match only
 * ranks. The best block per section is returned, prose ranked above code.
 */
export function searchDocs(
  query: string,
  options: { dir?: string; index?: DocsIndex; limit?: number } = {},
): DocsSearchHit[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) {
    throw new Error("Pass a search query, e.g. `pracht docs --search loader`.");
  }
  const dir = options.dir ?? defaultDocsDir();
  const index = options.index ?? loadDocsIndex(dir);
  const limit = options.limit ?? 10;

  const best = new Map<string, DocsSearchHit>();
  for (const page of index.pages) {
    let markdown: string;
    try {
      markdown = readDocsPage(page, dir);
    } catch {
      continue;
    }
    const { lines, bodyStart, sections } = splitPage(markdown);
    const titleText = page.title.toLowerCase();

    for (const block of pageBlocks(lines, bodyStart)) {
      const section = [...sections].reverse().find((candidate) => candidate.start <= block.line);
      const headingText = (section?.heading ?? "").toLowerCase();
      const blockText = block.text.toLowerCase();
      // Tables and code mention an API name many times without explaining it.
      const weight = block.code || block.text.startsWith("|") ? 0.5 : 1;
      let score = 0;
      let matchesAll = true;
      for (const term of terms) {
        const inBlock = countOccurrences(blockText, term);
        const inHeading = headingText.includes(term);
        if (inBlock === 0 && !inHeading) {
          matchesAll = false;
          break;
        }
        score += Math.min(inBlock, 3) * weight;
        if (inHeading) score += 4;
        if (titleText.includes(term)) score += 2;
      }
      if (!matchesAll) continue;
      // A heading that is about little more than the query is the section to read.
      const headingWords = words(headingText);
      if (
        headingWords.length > 0 &&
        headingWords.length <= terms.length + 1 &&
        terms.every((term) => headingText.includes(term))
      ) {
        score += 4;
      }

      const anchor = section?.anchor ?? "";
      const key = `${page.slug}#${anchor}`;
      const existing = best.get(key);
      if (existing && existing.score >= score) continue;
      best.set(key, {
        slug: page.slug,
        title: page.title,
        heading: section?.heading ?? page.title,
        anchor,
        snippet: snippetFor(block.text, terms),
        score,
      });
    }
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, limit);
}

function pageBlocks(
  lines: string[],
  bodyStart: number,
): { line: number; text: string; code: boolean }[] {
  const blocks: { line: number; text: string; code: boolean }[] = [];
  let current: string[] = [];
  let currentStart = bodyStart;
  let fence: string | null = null;
  const flush = (code = false) => {
    const text = current.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ line: currentStart, text, code });
    current = [];
  };

  for (let i = bodyStart; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) {
        flush();
        fence = fenceMatch[1][0];
        currentStart = i;
      } else if (fenceMatch[1][0] === fence) {
        fence = null;
        flush(true);
      }
      continue;
    }
    if (fence !== null) {
      current.push(line);
      continue;
    }
    if (!line.trim() || /^\s*(?:#{1,6}\s|---\s*$)/.test(line)) {
      flush();
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(line)) flush();
    if (current.length === 0) currentStart = i;
    current.push(line.replace(/^\s*(?:>\s?)?(?:(?:[-*+]|\d+\.)\s+)?/, ""));
  }
  flush(fence !== null);
  return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    count += 1;
    from = haystack.indexOf(needle, from + needle.length);
  }
  return count;
}

function snippetFor(text: string, terms: string[], width = 180): string {
  const lower = text.toLowerCase();
  const first = Math.min(
    ...terms.map((term) => lower.indexOf(term)).filter((position) => position !== -1),
  );
  if (!Number.isFinite(first) || text.length <= width) {
    return text.length <= width ? text : `${text.slice(0, width).trimEnd()}…`;
  }
  const start = Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}
