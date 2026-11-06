import type { IslandProps } from "@pracht/core";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";

/** Mirrors `SearchIndex` in `vite-plugin-search-index.ts`. */
interface SearchIndex {
  pages: [string, string, string][];
  entries: [number, string, string, string][];
}

interface Result {
  href: string;
  page: string;
  section: string;
  heading: string;
  snippet: string;
}

const MAX_RESULTS = 12;
let indexPromise: Promise<SearchIndex> | undefined;

function loadIndex(): Promise<SearchIndex> {
  indexPromise ??= fetch("/search-index.json").then((response) => {
    if (!response.ok) throw new Error(`search index: HTTP ${response.status}`);
    return response.json() as Promise<SearchIndex>;
  });
  indexPromise.catch(() => (indexPromise = undefined));
  return indexPromise;
}

/** Query words, lightly stemmed so "cache" also finds "caching" and "cached". */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$.-]+/u)
    .filter(Boolean)
    .map((word) => (word.length > 4 ? word.replace(/(?:ing|ed|es|s|e)$/, "") : word));
}

/** True when `term` starts a word in `text` (both lower case). */
function startsWord(text: string, term: string): boolean {
  let at = text.indexOf(term);
  while (at !== -1) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1])) return true;
    at = text.indexOf(term, at + 1);
  }
  return false;
}

function snippet(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const hit = words.map((word) => lower.indexOf(word)).find((at) => at >= 0) ?? 0;
  const start = Math.max(0, hit - 40);
  const cut = text.slice(start, start + 140);
  return `${start > 0 ? "…" : ""}${cut}${start + 140 < text.length ? "…" : ""}`;
}

function search(index: SearchIndex, query: string): Result[] {
  const words = terms(query);
  if (words.length === 0) return [];
  const scored: { score: number; entry: SearchIndex["entries"][number] }[] = [];
  for (const entry of index.entries) {
    const [pageIndex, anchor, heading, text] = entry;
    const title = index.pages[pageIndex][1].toLowerCase();
    const head = heading.toLowerCase();
    const body = text.toLowerCase();
    let score = 0;
    let matched = true;
    for (const word of words) {
      const inHeading = startsWord(head, word);
      const inTitle = startsWord(title, word);
      const inBody = body.includes(word);
      if (!inHeading && !inTitle && !inBody) {
        matched = false;
        break;
      }
      score += (inHeading ? 8 : 0) + (inTitle ? 5 : 0) + (inBody ? 1 : 0);
      if (head === word || title === word) score += 6;
    }
    if (!matched) continue;
    if (anchor === "") score += 2;
    scored.push({ score, entry });
  }
  scored.sort((a, b) => b.score - a.score || a.entry[0] - b.entry[0]);
  const perPage = new Map<number, number>();
  const results: Result[] = [];
  for (const { entry } of scored) {
    const [pageIndex, anchor, heading, text] = entry;
    const seen = perPage.get(pageIndex) ?? 0;
    if (seen >= 3) continue;
    perPage.set(pageIndex, seen + 1);
    const [path, title, section] = index.pages[pageIndex];
    results.push({
      href: anchor ? `${path}#${anchor}` : path,
      page: title,
      section,
      heading: anchor ? heading : "",
      snippet: snippet(text, words),
    });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

/** Header search: a button that opens a dialog over a lazily fetched index. Opens on ⌘K, Ctrl+K, and `/`. */
export default function DocsSearch(_props: IslandProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [index, setIndex] = useState<SearchIndex | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [shortcut, setShortcut] = useState("⌘K");
  const results = useMemo(() => (index ? search(index, query) : []), [index, query]);

  const open = () => {
    dialog.current?.showModal();
    input.current?.select();
    loadIndex().then(setIndex, () => setFailed(true));
  };

  useEffect(() => {
    if (!/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setShortcut("Ctrl K");
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "");
      if (
        (event.key === "k" && (event.metaKey || event.ctrlKey)) ||
        (event.key === "/" && !typing)
      ) {
        event.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => setActive(0), [query]);

  const go = (href: string) => {
    dialog.current?.close();
    location.assign(href);
  };

  const onInputKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((value) => (results.length ? (value + step + results.length) % results.length : 0));
    } else if (event.key === "Escape") {
      // A search input swallows the first Escape to clear itself; close instead.
      event.preventDefault();
      dialog.current?.close();
    } else if (event.key === "Enter" && results[active]) {
      event.preventDefault();
      go(results[active].href);
    }
  };

  const activeId = results[active] ? `search-result-${active}` : undefined;

  return (
    <>
      <button type="button" class="search-trigger" onClick={open} aria-label="Search docs">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            d="M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm11 4-6-6"
          />
        </svg>
        <span class="search-trigger-label">Search docs</span>
        <kbd>{shortcut}</kbd>
      </button>
      <dialog
        ref={dialog}
        class="search-dialog"
        aria-label="Search the docs"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <div class="search-panel">
          <div class="search-field">
            <input
              ref={input}
              type="search"
              placeholder="Search the docs"
              value={query}
              onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
              onKeyDown={onInputKey}
              aria-label="Search the docs"
              aria-controls="search-results"
              aria-activedescendant={activeId}
              autoComplete="off"
              spellcheck={false}
            />
            <kbd>Esc</kbd>
          </div>
          <ul id="search-results" class="search-results" role="listbox" aria-label="Results">
            {results.map((result, position) => (
              <li
                key={result.href}
                id={`search-result-${position}`}
                role="option"
                aria-selected={position === active}
              >
                <a
                  href={result.href}
                  onMouseMove={() => setActive(position)}
                  onClick={(event) => {
                    event.preventDefault();
                    go(result.href);
                  }}
                >
                  <span class="search-result-path">
                    {result.section ? `${result.section} › ` : ""}
                    {result.page}
                  </span>
                  <span class="search-result-heading">{result.heading || result.page}</span>
                  <span class="search-result-snippet">{result.snippet}</span>
                </a>
              </li>
            ))}
          </ul>
          <p class="search-status" role="status">
            {failed
              ? "Search is unavailable. Try again, or use the sidebar."
              : !index && query
                ? "Loading…"
                : query && results.length === 0
                  ? `No results for “${query}”.`
                  : !query
                    ? "Type to search pages and sections. ↑↓ to move, Enter to open."
                    : ""}
          </p>
        </div>
      </dialog>
    </>
  );
}
