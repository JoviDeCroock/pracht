/**
 * Request-time half of the docs MCP tools: search, read, and list over the
 * index `docs-index-build.ts` produced at build time (see vite-plugin-docs-index.ts).
 *
 * The Worker imports that index as one JSON document
 * (`virtual:docs-mcp-index`) and turns it into lookups once per isolate —
 * no compiled HTML, no tokenizing the corpus, no filesystem.
 */

import { plainText, textStems } from "./docs-text.ts";

export const SITE_ORIGIN = "https://pracht.resynapse.dev";

/** Hard bounds. Inputs are also bounded by the capability schemas. */
export const MAX_QUERY_CHARS = 200;
export const MAX_RESULTS = 20;
export const DEFAULT_RESULTS = 8;
/** Results per page in one search, so one long page cannot crowd out the rest. */
const MAX_RESULTS_PER_PAGE = 3;
const MAX_QUERY_TERMS = 16;
const SNIPPET_CHARS = 220;
/** Larger than any page today; a page that outgrows it is cut at a section boundary. */
export const MAX_READ_CHARS = 60_000;
const MAX_SUGGESTIONS = 5;

export interface DocsNavGroup {
  label: string;
  links: readonly { href: string }[];
}

// ── Index model ─────────────────────────────────────────────────────────────

/** `[page, anchor, heading, depth, start, end, ownStart, ownEnd, words]` — see `DocsSection`. */
export type SectionPosition = [number, string, string, number, number, number, number, number];
export type DocsSectionTuple = [...SectionPosition, number];

export interface DocsIndexData {
  version: 1;
  pages: { id: string; path: string; title: string; lead: string; body: string }[];
  sections: DocsSectionTuple[];
  /** Stem → flat `[section, count, section, count, …]`, sections ascending. */
  postings: Record<string, number[]>;
}

export interface DocsSection {
  index: number;
  page: DocsPage;
  /** Heading id on the rendered page; `""` for the text above the first heading. */
  anchor: string;
  heading: string;
  depth: number;
  /** Character range of this section in the page body, subsections included. */
  start: number;
  end: number;
  /** This section's own text, up to the next heading of any depth. */
  ownStart: number;
  ownEnd: number;
  /** Distinct searchable stems in the heading (the page title, for an introduction). */
  headingSize: number;
  /** Indexed words in this section's own text, for length normalization. */
  words: number;
}

export interface DocsPage {
  id: string;
  path: string;
  title: string;
  lead: string;
  body: string;
  sections: DocsSection[];
}

export interface DocsIndex {
  pages: DocsPage[];
  sections: DocsSection[];
  /** Stem → flat `[section, count, …]` over section text (and the lead, for introductions). */
  postings: Map<string, number[]>;
  /** Stem → sections whose heading (or, for an introduction, page title) has it. */
  headings: Map<string, number[]>;
  byKey: Map<string, DocsPage>;
}

export function hydrateDocsIndex(data: DocsIndexData): DocsIndex {
  if (data?.version !== 1 || !Array.isArray(data.pages) || !Array.isArray(data.sections)) {
    throw new TypeError("The docs MCP index has an unexpected shape; rebuild the docs site.");
  }
  const pages: DocsPage[] = data.pages.map((page) => ({ ...page, sections: [] }));
  const headings = new Map<string, number[]>();
  const sections = data.sections.map(
    ([page, anchor, heading, depth, start, end, ownStart, ownEnd, words], index) => {
      const owner = pages[page];
      const section: DocsSection = {
        index,
        page: owner,
        anchor,
        heading,
        depth,
        start,
        end,
        ownStart,
        ownEnd,
        headingSize: 0,
        words,
      };
      owner.sections.push(section);
      // An introduction's "heading" is the page title.
      const seen = new Set<string>();
      for (const { stem } of textStems(anchor ? heading : owner.title)) {
        if (seen.has(stem)) continue;
        seen.add(stem);
        let list = headings.get(stem);
        if (!list) headings.set(stem, (list = []));
        list.push(index);
      }
      section.headingSize = seen.size;
      return section;
    },
  );
  const byKey = new Map<string, DocsPage>();
  for (const page of pages) {
    for (const key of pageKeys(page)) if (!byKey.has(key)) byKey.set(key, page);
  }
  return {
    pages,
    sections,
    postings: new Map(Object.entries(data.postings)),
    headings,
    byKey,
  };
}

function pageKeys(page: DocsPage): string[] {
  const withoutBase = page.path.replace(/^\/docs\//, "");
  return [page.path, page.path.slice(1), withoutBase, page.id].map((key) => key.toLowerCase());
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface DocsSearchResult {
  page: string;
  section: string;
  title: string;
  heading: string;
  url: string;
  snippet: string;
  score: number;
}

export interface DocsSearchOutcome {
  results: DocsSearchResult[];
  message: string;
}

export const NO_SEARCHABLE_WORDS =
  'The query has no searchable words: words shorter than 3 letters and common words such as "how" or "the" are ignored.';

/** De-duplicated stems of the query, bounded. Empty when every word is ignored. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const { stem } of textStems(query.slice(0, MAX_QUERY_CHARS))) {
    terms.add(stem);
    if (terms.size >= MAX_QUERY_TERMS) break;
  }
  return [...terms];
}

export function searchDocs(index: DocsIndex, query: string, limit: number): DocsSearchOutcome {
  const terms = queryTerms(query);
  if (!terms.length) return { results: [], message: NO_SEARCHABLE_WORDS };

  // Per term: body counts and heading/title hits, keyed by section.
  const total = index.sections.length;
  const perTerm = terms.map((term) => {
    const counts = new Map<number, number>();
    const list = index.postings.get(term) ?? [];
    for (let at = 0; at < list.length; at += 2) counts.set(list[at], list[at + 1]);
    const headed = new Set(index.headings.get(term) ?? []);
    const matched = new Set([...counts.keys(), ...headed]);
    return { counts, headed, matched, weight: Math.log(1 + total / Math.max(1, matched.size)) };
  });

  // Coverage of rare terms dominates; a heading hit beats a passing mention
  // (more so when the term is most of the heading: "Loaders" over "Configure
  // Loaders"), and a page title only lifts that page's introduction.
  // Body mentions saturate and are normalized by section length (BM25), so a
  // short section about the term beats a long one that repeats it in passing.
  const averageWords = index.sections.reduce((sum, entry) => sum + entry.words, 0) / total || 1;
  const scores = new Map<number, number>();
  for (const { counts, headed, matched, weight } of perTerm) {
    for (const section of matched) {
      const { anchor, headingSize, words } = index.sections[section];
      const count = counts.get(section) ?? 0;
      const frequency = (count * 2.2) / (count + 1.2 * (0.25 + (0.75 * words) / averageWords));
      const boost = headed.has(section)
        ? (anchor ? 50 : 80) * (1 + 1 / Math.max(1, headingSize))
        : 0;
      scores.set(section, (scores.get(section) ?? 0) + weight * (100 + boost + frequency * 30));
    }
  }

  const ranked = [...scores]
    .map(([section, score]) => ({ section: index.sections[section], score: Math.round(score) }))
    .sort((left, right) => right.score - left.score || left.section.index - right.section.index);
  const perPage = new Map<string, number>();
  const results: DocsSearchResult[] = [];
  const bounded = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(limit) || DEFAULT_RESULTS));
  const termSet = new Set(terms);
  for (const { section, score } of ranked) {
    const page = section.page;
    const taken = perPage.get(page.path) ?? 0;
    if (taken >= MAX_RESULTS_PER_PAGE) continue;
    perPage.set(page.path, taken + 1);
    const own = plainText(page.body.slice(section.ownStart, section.ownEnd));
    results.push({
      page: page.path,
      section: section.anchor,
      title: page.title,
      heading: section.anchor ? section.heading : page.title,
      url: pageUrl(page, section.anchor),
      snippet: snippet(section.anchor || !page.lead ? own : `${page.lead} ${own}`, termSet),
      score,
    });
    if (results.length >= bounded) break;
  }
  return { results, message: results.length ? "" : "No docs section matches the query." };
}

function snippet(raw: string, terms: ReadonlySet<string>): string {
  const text = raw.normalize("NFKC");
  if (text.length <= SNIPPET_CHARS) return text;
  let first = -1;
  for (const { stem, index } of textStems(text)) {
    if (terms.has(stem)) {
      first = index;
      break;
    }
  }
  let start = Math.max(0, Math.min(text.length - SNIPPET_CHARS, first < 0 ? 0 : first - 60));
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space !== -1 && space - start < 20) start = space + 1;
  }
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

function pageUrl(page: DocsPage, anchor: string): string {
  return `${SITE_ORIGIN}${page.path}${anchor ? `#${anchor}` : ""}`;
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface DocsOutlineEntry {
  section: string;
  heading: string;
  depth: number;
}

export interface DocsReadResult {
  found: boolean;
  page: string;
  section: string;
  title: string;
  url: string;
  markdown: string;
  truncated: boolean;
  sections: DocsOutlineEntry[];
  message: string;
  suggestions: string[];
}

const MAX_OUTLINE = 120;

export function readDoc(
  index: DocsIndex,
  pageInput: string,
  sectionInput?: string,
): DocsReadResult {
  const reference = parsePageReference(pageInput);
  if (typeof reference === "string") return notFound(reference, []);
  const page = index.byKey.get(reference.key);
  if (!page) {
    const suggestions = suggestPages(index, reference.key);
    return notFound(
      `No docs page matches ${JSON.stringify(pageInput.slice(0, 200))}.${
        suggestions.length ? ` Closest pages: ${suggestions.join(", ")}.` : ""
      } Call docs_list for every page.`,
      suggestions,
    );
  }

  const outline = page.sections
    .filter((entry) => entry.anchor)
    .slice(0, MAX_OUTLINE)
    .map((entry) => ({ section: entry.anchor, heading: entry.heading, depth: entry.depth }));
  const requested = (sectionInput ?? reference.fragment ?? "").trim().replace(/^#/, "");
  if (!requested) {
    const header = `# ${page.title}\n\n${page.lead ? `${page.lead}\n\n` : ""}`;
    const { markdown, truncated } = bounded(page, header);
    return {
      found: true,
      page: page.path,
      section: "",
      title: page.title,
      url: pageUrl(page, ""),
      markdown,
      truncated,
      sections: outline,
      message: truncated
        ? `The page is longer than ${MAX_READ_CHARS} characters; read the remaining sections by anchor.`
        : "",
      suggestions: [],
    };
  }

  const match = page.sections.find(
    (entry) => entry.anchor && entry.anchor === requested.toLowerCase(),
  );
  if (!match) {
    const suggestions = suggestSections(page, requested);
    return {
      ...notFound(
        `${page.path} has no section ${JSON.stringify(requested.slice(0, 200))}.${
          suggestions.length ? ` Closest: ${suggestions.join(", ")}.` : ""
        } Valid anchors are listed in \`sections\`.`,
        suggestions,
      ),
      page: page.path,
      title: page.title,
      url: pageUrl(page, ""),
      sections: outline,
    };
  }
  const raw = page.body.slice(match.start, match.end).trimEnd();
  const truncated = raw.length > MAX_READ_CHARS;
  return {
    found: true,
    page: page.path,
    section: match.anchor,
    title: page.title,
    url: pageUrl(page, match.anchor),
    markdown: truncated ? `${raw.slice(0, MAX_READ_CHARS)}\n\n…` : `${raw}\n`,
    truncated,
    // The outline is on whole-page reads and not-found answers; a section
    // read already knows where it is.
    sections: [],
    message: truncated ? `The section is longer than ${MAX_READ_CHARS} characters.` : "",
    suggestions: [],
  };
}

/** The whole page, cut at the last section boundary that fits. */
function bounded(page: DocsPage, header: string): { markdown: string; truncated: boolean } {
  const body = page.body.trim();
  if (header.length + body.length <= MAX_READ_CHARS) {
    return { markdown: `${header}${body}\n`, truncated: false };
  }
  let cut = 0;
  for (const entry of page.sections) {
    if (entry.anchor && header.length + entry.start <= MAX_READ_CHARS) cut = entry.start;
  }
  if (cut === 0) cut = MAX_READ_CHARS - header.length;
  return { markdown: `${header}${page.body.slice(0, cut).trimEnd()}\n\n…\n`, truncated: true };
}

function notFound(message: string, suggestions: string[]): DocsReadResult {
  return {
    found: false,
    page: "",
    section: "",
    title: "",
    url: "",
    markdown: "",
    truncated: false,
    sections: [],
    message,
    suggestions,
  };
}

/**
 * Turn `capabilities`, `/docs/recipes/auth#anchor`, `recipes/auth`, or a full
 * site URL into a lookup key. Lookup is a map over the collection, so no input
 * can address anything outside it; this only normalizes spelling.
 */
function parsePageReference(input: string): { key: string; fragment?: string } | string {
  let value = input.trim();
  let fragment: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return (
        "The page must be a docs path such as /docs/capabilities, or a URL on " + SITE_ORIGIN + "."
      );
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.host !== new URL(SITE_ORIGIN).host
    ) {
      return `Only pages on ${SITE_ORIGIN} can be read.`;
    }
    value = url.pathname;
    fragment = url.hash ? safeDecode(url.hash.slice(1)) : undefined;
  } else {
    const hash = value.indexOf("#");
    if (hash !== -1) {
      fragment = value.slice(hash + 1);
      value = value.slice(0, hash);
    }
    value = value.replace(/[?].*$/, "");
  }
  const key = value.toLowerCase().replace(/\.md$/, "").replace(/\/+$/, "");
  return { key: key || "/", ...(fragment ? { fragment } : {}) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function suggestPages(index: DocsIndex, key: string): string[] {
  const wanted = suggestionTerms(key);
  const tail = (key.split("/").filter(Boolean).pop() ?? key).slice(0, 64);
  return rank(
    index.pages,
    (page) => {
      const haystack = `${page.path} ${page.title}`.toLowerCase();
      let score = 0;
      for (const term of wanted) if (haystack.includes(term)) score += 10;
      return score + closeness(tail, page.path.split("/").pop() ?? "");
    },
    (page) => page.path,
  );
}

function suggestSections(page: DocsPage, requested: string): string[] {
  const wanted = suggestionTerms(requested.replace(/-/g, " "));
  const lower = requested.toLowerCase().slice(0, 64);
  return rank(
    page.sections.filter((entry) => entry.anchor),
    (entry) => {
      let score = 0;
      for (const term of wanted) if (entry.anchor.includes(term)) score += 10;
      return score + closeness(lower, entry.anchor);
    },
    (entry) => entry.anchor,
  );
}

/** Query terms long enough to mean something inside a slug. */
function suggestionTerms(value: string): string[] {
  // "docs" is in every path, so it would suggest every page.
  return queryTerms(value).filter((term) => term !== "doc");
}

/** A typo-sized edit distance scores; anything further apart scores 0. */
function closeness(input: string, candidate: string): number {
  const allowed = Math.min(3, Math.floor(Math.max(input.length, candidate.length) / 4));
  const distance = editDistance(input, candidate);
  return distance <= allowed ? 8 - distance : 0;
}

function rank<T>(
  items: readonly T[],
  score: (item: T) => number,
  label: (item: T) => string,
): string[] {
  return items
    .map((item, order) => ({ item, order, score: score(item) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => label(entry.item));
}

/** Levenshtein distance; inputs are short (capped by callers). */
function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

// ── List ────────────────────────────────────────────────────────────────────

export interface DocsListGroup {
  label: string;
  pages: { page: string; title: string; lead: string; url: string }[];
}

/** Every page, grouped and ordered like the site navigation. */
export function listDocs(index: DocsIndex, nav: readonly DocsNavGroup[]): DocsListGroup[] {
  const listed = new Set<string>();
  const groups: DocsListGroup[] = [];
  const entry = (page: DocsPage) => ({
    page: page.path,
    title: page.title,
    lead: page.lead,
    url: pageUrl(page, ""),
  });
  for (const group of nav) {
    const pages: DocsListGroup["pages"] = [];
    for (const link of group.links) {
      const page = index.byKey.get(link.href.toLowerCase());
      if (!page || listed.has(page.path)) continue;
      listed.add(page.path);
      pages.push(entry(page));
    }
    if (pages.length) groups.push({ label: group.label, pages });
  }
  const rest = index.pages.filter((page) => !listed.has(page.path));
  if (rest.length) groups.push({ label: "Other", pages: rest.map(entry) });
  return groups;
}
