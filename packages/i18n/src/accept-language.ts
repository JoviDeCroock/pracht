/**
 * `Accept-Language` parsing with q-value ordering.
 *
 * The parser fails closed on hostile input: oversized headers are truncated,
 * the entry count is capped, malformed language tags are skipped, and an
 * entry with an unparsable q parameter (`;q=`, `;q=abc`) is dropped rather
 * than promoted to top preference.
 */

const MAX_HEADER_LENGTH = 1024;
const MAX_ENTRIES = 24;
// `*` or a BCP 47-shaped tag: 1-8 alpha primary subtag plus alphanumeric
// subtags. Anything else (garbage bytes, path characters, quotes) is skipped.
const TAG_PATTERN = /^(?:\*|[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*)$/;

export interface AcceptLanguageEntry {
  /** Lowercased language tag, or `"*"`. */
  tag: string;
  /** Parsed q-value, clamped to `(0, 1]`. */
  quality: number;
}

/**
 * Parse an `Accept-Language` header into entries ordered by descending
 * q-value (header order breaks ties). Entries with `q=0`, malformed tags,
 * or unparsable q parameters are omitted.
 */
export function parseAcceptLanguage(header: string | null | undefined): AcceptLanguageEntry[] {
  if (!header) return [];
  const source = header.length > MAX_HEADER_LENGTH ? header.slice(0, MAX_HEADER_LENGTH) : header;
  const entries: AcceptLanguageEntry[] = [];
  for (const part of source.split(",")) {
    if (entries.length >= MAX_ENTRIES) break;
    const [rawTag = "", ...params] = part.split(";");
    const tag = rawTag.trim();
    if (!tag || !TAG_PATTERN.test(tag)) continue;
    let quality = 1;
    for (const param of params) {
      const equals = param.indexOf("=");
      const name = (equals === -1 ? param : param.slice(0, equals)).trim().toLowerCase();
      if (name !== "q") continue;
      const value = equals === -1 ? "" : param.slice(equals + 1).trim();
      const parsed = Number.parseFloat(value);
      // `;q=` and `;q=abc` are dropped instead of defaulting to 1 — a
      // malformed preference must never outrank a well-formed one.
      quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    if (quality <= 0) continue;
    entries.push({ tag: tag.toLowerCase(), quality });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.quality - a.entry.quality || a.index - b.index)
    .map(({ entry }) => entry);
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
  for (const { tag } of parseAcceptLanguage(header)) {
    if (tag === "*") {
      if (options.wildcard !== undefined) return options.wildcard;
      continue;
    }
    // RFC 4647 lookup: try the tag, then progressively strip subtags from
    // the right until a registered locale matches (`zh-hant-tw` → `zh-hant`
    // → `zh`).
    let candidate: string = tag;
    let index = lowered.indexOf(candidate);
    while (index === -1) {
      const dash = candidate.lastIndexOf("-");
      if (dash === -1) break;
      candidate = candidate.slice(0, dash);
      index = lowered.indexOf(candidate);
    }
    if (index === -1) {
      // Best-fit fallback across regions: a registered locale whose primary
      // language matches the tag's (`en` → `en-US`, `en-GB` → `en-US`) is a
      // better answer than falling through to a lower-q language.
      const language = tag.split("-", 1)[0] ?? tag;
      index = lowered.findIndex((locale) => locale.startsWith(`${language}-`));
    }
    if (index !== -1) return locales[index] as string;
  }
  return null;
}
