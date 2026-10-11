/**
 * The search and read model behind the docs site's MCP tools.
 *
 * Everything is derived from the `docs` content collection — the same registry
 * that compiles the pages and generates `llms.txt` — so the tools cannot drift
 * from the site. On the Worker that registry is the Vite-generated runtime
 * snapshot (`virtual:pracht/content/docs`); tests pass the filesystem-backed
 * authoring collection from `content.ts` instead.
 *
 * Section anchors are read from the compiled HTML rather than re-derived from
 * the Markdown, so a `section` returned here is exactly the `#fragment` the
 * rendered page carries.
 */

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

// ── Source shape ────────────────────────────────────────────────────────────

export interface DocsSourceDocument {
  id: string;
  path: string;
  frontmatter: Readonly<Record<string, unknown>>;
  body?: string;
  compiled: unknown;
}

/** The subset of a content registry this module reads. */
export interface DocsSource {
  all(): Promise<readonly DocsSourceDocument[]>;
}

export interface DocsNavGroup {
  label: string;
  links: readonly { href: string }[];
}

// ── Index model ─────────────────────────────────────────────────────────────

export interface DocsSection {
  /** Heading id on the rendered page; `""` for the text above the first heading. */
  anchor: string;
  heading: string;
  depth: number;
  /** Character range of this section in the page body, subsections included. */
  start: number;
  end: number;
  /** Plain text of this section alone (up to the next heading of any depth). */
  text: string;
  lower: string;
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
  byKey: Map<string, DocsPage>;
}

export async function buildDocsIndex(source: DocsSource): Promise<DocsIndex> {
  const documents = [...(await source.all())].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const pages = documents.map(toPage);
  const byKey = new Map<string, DocsPage>();
  for (const page of pages) {
    for (const key of pageKeys(page)) if (!byKey.has(key)) byKey.set(key, page);
  }
  return { pages, byKey };
}

function toPage(document: DocsSourceDocument): DocsPage {
  const title = stringField(document.frontmatter.title) || document.path;
  const lead = stringField(document.frontmatter.lead);
  const body = typeof document.body === "string" ? document.body : "";
  return {
    id: document.id,
    path: document.path,
    title,
    lead,
    body,
    sections: splitSections(body, title, compiledHeadingIds(document.compiled)),
  };
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pageKeys(page: DocsPage): string[] {
  const withoutBase = page.path.replace(/^\/docs\//, "");
  return [page.path, page.path.slice(1), withoutBase, page.id].map((key) => key.toLowerCase());
}

/** `<hN id="…">` ids in document order, from the HTML the page renders. */
function compiledHeadingIds(compiled: unknown): { id: string; text: string }[] {
  const html =
    compiled &&
    typeof compiled === "object" &&
    typeof (compiled as { html?: unknown }).html === "string"
      ? (compiled as { html: string }).html
      : "";
  const headings: { id: string; text: string }[] = [];
  for (const match of html.matchAll(/<h[1-6] id="([^"]+)">([\s\S]*?)<\/h[1-6]>/g)) {
    headings.push({ id: decodeEntities(match[1]), text: decodeEntities(stripTags(match[2])) });
  }
  return headings;
}

interface MarkdownHeading {
  depth: number;
  text: string;
  offset: number;
}

/** ATX headings outside fenced code, with their offsets in `body`. */
export function markdownHeadings(body: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  let offset = 0;
  for (const line of body.split("\n")) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.char &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null;
      }
    } else if (fenceMatch) {
      fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
    } else {
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
      if (heading) headings.push({ depth: heading[1].length, text: heading[2] ?? "", offset });
    }
    offset += line.length + 1;
  }
  return headings;
}

function splitSections(
  body: string,
  title: string,
  ids: { id: string; text: string }[],
): DocsSection[] {
  const headings = markdownHeadings(body);
  // The compiled ids and the Markdown headings describe the same headings in
  // the same order. If a construct ever makes them disagree, fall back to a
  // slug of the Markdown text rather than pairing every later heading with
  // its neighbour's anchor. `test/docs-mcp.test.ts` asserts they agree.
  const paired = ids.length === headings.length;
  const used = new Map<string, number>();
  const sections: DocsSection[] = [];
  const firstOffset = headings.length ? headings[0].offset : body.length;
  sections.push(section("", title, 1, 0, body.length, body.slice(0, firstOffset)));
  headings.forEach((heading, index) => {
    let anchor: string;
    let label: string;
    if (paired) {
      anchor = ids[index].id;
      label = ids[index].text;
    } else {
      const base = fallbackSlug(heading.text) || `section-${index + 1}`;
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      anchor = seen === 0 ? base : `${base}-${seen}`;
      label = plainText(heading.text);
    }
    let end = body.length;
    for (let next = index + 1; next < headings.length; next++) {
      if (headings[next].depth <= heading.depth) {
        end = headings[next].offset;
        break;
      }
    }
    const ownEnd = index + 1 < headings.length ? headings[index + 1].offset : body.length;
    const bodyStart = body.indexOf("\n", heading.offset);
    const own = bodyStart === -1 || bodyStart > ownEnd ? "" : body.slice(bodyStart + 1, ownEnd);
    sections.push(section(anchor, label, heading.depth, heading.offset, end, own));
  });
  return sections;
}

function section(
  anchor: string,
  heading: string,
  depth: number,
  start: number,
  end: number,
  markdown: string,
): DocsSection {
  const text = plainText(markdown);
  return { anchor, heading, depth, start, end, text, lower: text.toLowerCase() };
}

function fallbackSlug(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ /g, "-");
}

/** Markdown → searchable text. Code stays: identifiers are what people search for. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^ {0,3}(?:`{3,}|~{3,}).*$/gm, " ")
    .replace(/[`*]/g, "")
    .replace(/[>|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or the to use using what when where which why with you your".split(
    " ",
  ),
);

/** Lowercased, de-duplicated, lightly stemmed query terms. */
export function queryTerms(query: string): string[] {
  const words = query
    .slice(0, MAX_QUERY_CHARS)
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  // One letter matches nearly every section, so it carries no signal.
  const usable = words?.filter((word) => word.length > 1) ?? [];
  const meaningful = usable.filter((word) => !STOPWORDS.has(word));
  const chosen = meaningful.length ? meaningful : usable;
  return [...new Set(chosen.map(stem))].slice(0, MAX_QUERY_TERMS);
}

/** Trim common English suffixes so "capability" also finds "capabilities". */
function stem(word: string): string {
  if (word.length <= 4) return word;
  const stemmed = word.replace(/(?:ies|es|s|ing|ed|y)$/, "");
  return stemmed.length >= 4 ? stemmed : word;
}

function occurrences(haystack: string, needle: string, cap: number): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < cap; ) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

export function searchDocs(index: DocsIndex, query: string, limit: number): DocsSearchResult[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const phrase = query.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

  // Pass 1: which terms each section contains, and how many sections contain
  // each term, so a rare term ("defineapp") outweighs a common one ("agents").
  interface Hit {
    page: DocsPage;
    section: DocsSection;
    order: number;
    hits: { inHeading: boolean; inTitle: boolean; count: number }[];
  }
  const candidates: Hit[] = [];
  const frequency = terms.map(() => 0);
  let total = 0;
  for (const page of index.pages) {
    const title = page.title.toLowerCase();
    for (const entry of page.sections) {
      total++;
      const heading = entry.heading.toLowerCase();
      let any = false;
      const hits = terms.map((term, position) => {
        const inHeading = entry.anchor !== "" && heading.includes(term);
        const inTitle = title.includes(term);
        const count = occurrences(entry.lower, term, 8);
        if (inHeading || inTitle || count) {
          any = true;
          frequency[position]++;
        }
        return { inHeading, inTitle, count };
      });
      if (any) candidates.push({ page, section: entry, order: total, hits });
    }
  }
  const weight = frequency.map((seen) => Math.log(1 + total / Math.max(1, seen)));

  // Pass 2: coverage first — a section that mentions every term outranks one
  // that repeats a single term — then weighted heading, title, and body hits.
  const scored = candidates.map(({ page, section, order, hits }) => {
    let score = 0;
    hits.forEach((hit, position) => {
      if (!hit.inHeading && !hit.inTitle && !hit.count) return;
      score +=
        100 +
        weight[position] * ((hit.inHeading ? 30 : 0) + (hit.inTitle ? 15 : 0) + hit.count * 4);
    });
    if (terms.length > 1 && phrase.length > 2 && section.lower.includes(phrase)) score += 40;
    return { page, section, order, score: Math.round(score) };
  });
  scored.sort((left, right) => right.score - left.score || left.order - right.order);
  const perPage = new Map<string, number>();
  const results: DocsSearchResult[] = [];
  const bounded = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(limit) || DEFAULT_RESULTS));
  for (const { page, section, score } of scored) {
    const taken = perPage.get(page.path) ?? 0;
    if (taken >= MAX_RESULTS_PER_PAGE) continue;
    perPage.set(page.path, taken + 1);
    results.push({
      page: page.path,
      section: section.anchor,
      title: page.title,
      heading: section.anchor ? section.heading : page.title,
      url: pageUrl(page, section.anchor),
      snippet: snippet(section.anchor ? section.text : page.lead || section.text, terms),
      score,
    });
    if (results.length >= bounded) break;
  }
  return results;
}

function snippet(text: string, terms: readonly string[]): string {
  if (text.length <= SNIPPET_CHARS) return text;
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
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
    sections: outline,
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
  return queryTerms(value).filter((term) => term.length >= 3 && term !== "docs");
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
