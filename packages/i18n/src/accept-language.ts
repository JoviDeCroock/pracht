/**
 * `Accept-Language` parsing with q-value ordering.
 *
 * The parser fails closed on hostile input: oversized headers are bounded and
 * any entry cut by the limit is discarded, the entry count is capped,
 * malformed language tags are skipped, and an entry with an unparsable q
 * parameter (`;q=`, `;q=abc`) is dropped rather than promoted to top
 * preference.
 */

const MAX_HEADER_LENGTH = 1024;
const MAX_ENTRIES = 24;
// `*` or a BCP 47-shaped tag: 1-8 alpha primary subtag plus alphanumeric
// subtags. Anything else (garbage bytes, path characters, quotes) is skipped.
const TAG_PATTERN = /^(?:\*|[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*)$/;
// Require the entire q-value to be a decimal number. `parseFloat()` alone
// accepts valid-looking prefixes such as `0.5junk`, which would let malformed
// preferences outrank a well-formed fallback.
const QUALITY_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export interface AcceptLanguageEntry {
  /** Lowercased language tag, or `"*"`. */
  tag: string;
  /** Parsed q-value, clamped to `(0, 1]`. */
  quality: number;
}

function parseAcceptLanguageEntries(
  header: string | null | undefined,
  includeRejected: boolean,
): AcceptLanguageEntry[] {
  if (!header) return [];
  let source = header;
  if (header.length > MAX_HEADER_LENGTH) {
    const truncated = header.slice(0, MAX_HEADER_LENGTH);
    // Never parse an entry cut in half by the defensive length limit. A
    // missing tail can hide a later `q=0` and accidentally promote the partial
    // range to the default quality of 1. Preserve the last entry only when the
    // cutoff itself lands exactly on its comma boundary.
    if (header[MAX_HEADER_LENGTH] === ",") {
      source = truncated;
    } else {
      const lastComma = truncated.lastIndexOf(",");
      source = lastComma === -1 ? "" : truncated.slice(0, lastComma);
    }
  }
  const entries: Array<{ entry: AcceptLanguageEntry; index: number }> = [];
  let index = 0;
  for (const part of source.split(",")) {
    if (index >= MAX_ENTRIES) break;
    const entryIndex = index++;
    const [rawTag = "", ...params] = part.split(";");
    const tag = rawTag.trim();
    if (!tag || !TAG_PATTERN.test(tag)) continue;
    let quality = 1;
    let sawQuality = false;
    let invalidQuality = false;
    for (const param of params) {
      const equals = param.indexOf("=");
      const name = (equals === -1 ? param : param.slice(0, equals)).trim().toLowerCase();
      if (name !== "q") continue;
      // The grammar permits one weight. Reject duplicates instead of allowing
      // a later value to revive an entry whose earlier value was malformed.
      if (sawQuality) {
        invalidQuality = true;
        break;
      }
      sawQuality = true;
      const value = equals === -1 ? "" : param.slice(equals + 1).trim();
      const parsed = QUALITY_PATTERN.test(value) ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        invalidQuality = true;
        break;
      }
      quality = Math.min(Math.max(parsed, 0), 1);
    }
    if (invalidQuality || (!includeRejected && quality <= 0)) continue;
    entries.push({ entry: { tag: tag.toLowerCase(), quality }, index: entryIndex });
  }
  return entries
    .sort((a, b) => b.entry.quality - a.entry.quality || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * Parse an `Accept-Language` header into entries ordered by descending
 * q-value (header order breaks ties). Entries with `q=0`, malformed tags,
 * or unparsable q parameters are omitted.
 */
export function parseAcceptLanguage(header: string | null | undefined): AcceptLanguageEntry[] {
  return parseAcceptLanguageEntries(header, false);
}

function rangeSpecificity(tag: string): number {
  return tag === "*" ? 0 : tag.split("-").length;
}

function rangeMatchesLocale(range: string, locale: string): boolean {
  return range === "*" || locale === range || locale.startsWith(`${range}-`);
}

function scriptSubtag(tag: string): string | null {
  return (
    tag
      .split("-")
      .slice(1)
      .find((subtag) => /^[a-z]{4}$/.test(subtag)) ?? null
  );
}

export interface MatchAcceptLanguageOptions {
  /**
   * Locale a `*` wildcard entry resolves to (typically the default locale).
   * When omitted, wildcard entries are ignored.
   */
  wildcard?: string;
}

/**
 * Pick the best registered locale for an `Accept-Language` header.
 *
 * Matching per entry, in q-value order:
 * 1. exact tag match (case-insensitive) — `nl` → `nl`
 * 2. RFC 4647 lookup: the tag progressively truncated from the right —
 *    `zh-Hant-TW` → `zh-Hant` → `zh`, so `nl-BE` → `nl`
 * 3. a registered locale sharing the tag's primary language — `en` → `en-US`
 *    and `en-GB` → `en-US`
 *
 * Returns `null` when nothing matches; only values from `locales` are ever
 * returned, so arbitrary header input cannot be reflected downstream.
 */
export function matchAcceptLanguage(
  header: string | null | undefined,
  locales: readonly string[],
  options: MatchAcceptLanguageOptions = {},
): string | null {
  const lowered = locales.map((locale) => locale.toLowerCase());
  const entries = parseAcceptLanguageEntries(header, true);
  const rejected = entries.filter(({ quality }) => quality === 0);

  function isRejected(locale: string, activeRange: string): boolean {
    const activeSpecificity = rangeSpecificity(activeRange);
    return rejected.some(
      ({ tag }) => rangeSpecificity(tag) >= activeSpecificity && rangeMatchesLocale(tag, locale),
    );
  }

  for (const { tag, quality } of entries) {
    if (quality === 0) continue;
    if (tag === "*") {
      if (options.wildcard !== undefined) {
        const preferred = lowered.indexOf(options.wildcard.toLowerCase());
        if (preferred !== -1) {
          const candidates = [preferred, ...lowered.keys()].filter(
            (candidate, index, all) => all.indexOf(candidate) === index,
          );
          for (const candidate of candidates) {
            const locale = lowered[candidate] as string;
            if (!isRejected(locale, tag)) return locales[candidate] as string;
          }
        }
      }
      continue;
    }
    // RFC 4647 lookup: try the tag, then progressively strip subtags from
    // the right until a registered locale matches (`zh-hant-tw` → `zh-hant`
    // → `zh`). A range also matches a longer registered tag, so `en-gb`
    // prefers `en-gb-oxendict` over an unrelated same-language best fit.
    const requestedScript = scriptSubtag(tag);
    let candidate: string = tag;
    let index = -1;
    while (true) {
      // Use the range that actually matched the registered locale when
      // applying q=0 exclusions. If `en-US` had to truncate to `en`, a client
      // that explicitly rejected `en` must not receive it.
      const exact = lowered.indexOf(candidate);
      index =
        exact !== -1 && !isRejected(lowered[exact] as string, candidate)
          ? exact
          : lowered.findIndex((locale) => {
              if (!locale.startsWith(`${candidate}-`) || isRejected(locale, candidate)) {
                return false;
              }
              const candidateScript = scriptSubtag(locale);
              return (
                requestedScript === null ||
                candidateScript === null ||
                candidateScript === requestedScript
              );
            });
      if (index !== -1) break;
      const dash = candidate.lastIndexOf("-");
      if (dash === -1) break;
      candidate = candidate.slice(0, dash);
    }
    if (index === -1) {
      // Best-fit fallback across regions: a registered locale whose primary
      // language matches the tag's (`en` → `en-US`, `en-GB` → `en-US`) is a
      // better answer than falling through to a lower-q language. An explicit
      // script remains significant: `zh-Hans` must not best-fit `zh-Hant`.
      const language = tag.split("-", 1)[0] ?? tag;
      index = lowered.findIndex((locale) => {
        // Best fit only establishes a primary-language match, so a q=0 range
        // for that language still excludes the candidate. The more-specific
        // request cannot override a rejection it did not directly match.
        if (!locale.startsWith(`${language}-`) || isRejected(locale, language)) return false;
        const candidateScript = scriptSubtag(locale);
        return (
          requestedScript === null ||
          candidateScript === null ||
          candidateScript === requestedScript
        );
      });
    }
    if (index !== -1) return locales[index] as string;
  }
  return null;
}
