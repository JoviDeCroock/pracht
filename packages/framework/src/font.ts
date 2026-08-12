import type { HeadAttributes } from "./types.ts";

/**
 * First-party helper for self-hosted fonts.
 *
 * `defineFont()` turns a font file in `public/` into a typed object that
 * carries everything the head renderer needs: the `@font-face` CSS, an
 * optional adjusted local fallback face (metric overrides), a preload link
 * descriptor, and a ready-to-use `fontFamily`/`className` for components.
 *
 * The helper is pure data — it never reads or fetches font files, so it is
 * safe in every environment (server, browser, workers) and adds nothing to
 * build time. Fetching Google Fonts or computing fallback metrics from the
 * font binary is intentionally out of scope for now.
 */

export type FontDisplay = "auto" | "block" | "swap" | "fallback" | "optional";

export interface FontSourceInput {
  /** Public URL of the font file, e.g. `/fonts/inter-latin.woff2`. */
  url: string;
  /** `format()` hint for the `src` descriptor. Defaults to `"woff2"`. */
  format?: string;
}

export interface FontSource {
  url: string;
  format: string;
}

export interface DefineFontOptions {
  /** Font family name used in `@font-face` and the font stack. */
  family: string;
  /**
   * Public path of the font file (woff2 assumed), or an array of variants
   * (`string` or `{ url, format }`) for the same face.
   */
  src: string | ReadonlyArray<string | FontSourceInput>;
  /** `font-weight` descriptor: `400`, `"700"`, `"auto"`, or a variable range `"100 900"`. */
  weight?: number | string;
  /** `font-style` descriptor: `"normal"`, `"italic"`, `"auto"`, or an oblique angle/range. */
  style?: string;
  /** `font-display` descriptor. Defaults to `"swap"`. */
  display?: FontDisplay;
  /** Emit a `<link rel="preload" as="font">` for the font. Defaults to `true`. */
  preload?: boolean;
  /** `unicode-range` descriptor, e.g. `"U+0000-00FF, U+2192"`. */
  unicodeRange?: string;
  /**
   * Fallback families appended to the font stack, e.g.
   * `["Arial", "sans-serif"]`. When metric overrides are provided, the first
   * non-generic entry becomes the `local()` source of the adjusted fallback
   * face.
   */
  fallbacks?: readonly string[];
  /**
   * The locally installed font the metric overrides were computed against,
   * e.g. `"Arial"`. Defaults to the first non-generic entry in `fallbacks`.
   * Set this when the stack starts with names `local()` cannot match, such
   * as `-apple-system`.
   */
  metricsFallback?: string;
  /** `size-adjust` for the fallback face, e.g. `"107%"`. */
  sizeAdjust?: string;
  /** `ascent-override` for the fallback face, e.g. `"90%"`. */
  ascentOverride?: string;
  /** `descent-override` for the fallback face, e.g. `"22%"`. */
  descentOverride?: string;
  /** `line-gap-override` for the fallback face, e.g. `"0%"`. */
  lineGapOverride?: string;
}

export interface PrachtFont {
  /** Font family name as passed to `defineFont()`. */
  readonly family: string;
  /** Full font stack, e.g. `"Inter", "Inter Fallback", sans-serif`. */
  readonly fontFamily: string;
  /** Class name whose rule (emitted with the font CSS) applies the stack. */
  readonly className: string;
  /** Inline-style object for JSX: `<h1 style={font.style}>`. */
  readonly style: { readonly fontFamily: string };
  /** Resolved source variants (format defaulted to `"woff2"`). */
  readonly sources: readonly FontSource[];
  /** Whether the head renderer should emit preload links for this font. */
  readonly preload: boolean;
  /** @internal Preload link descriptors (deduped by `href` at render time). */
  readonly preloadLinks: readonly HeadAttributes[];
  /** @internal `@font-face` CSS for the web font. Fully escaped. */
  readonly faceCss: string;
  /** @internal Adjusted local fallback `@font-face`, when metrics are set. */
  readonly fallbackFaceCss?: string;
  /** @internal Class rule applying the font stack. Fully escaped. */
  readonly classCss: string;
}

const GENERIC_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

const FONT_DISPLAY_VALUES = new Set<string>(["auto", "block", "swap", "fallback", "optional"]);
const FONT_WEIGHT_RE = /^(auto|normal|bold|(?:\d+(?:\.\d+)?|\.\d+)(?: +(?:\d+(?:\.\d+)?|\.\d+))?)$/;
const FONT_STYLE_RE =
  /^(auto|normal|italic|left|right|oblique(?: +([+-]?(?:\d+(?:\.\d+)?|\.\d+))deg(?: +([+-]?(?:\d+(?:\.\d+)?|\.\d+))deg)?)?)$/;
const METRIC_OVERRIDE_RE = /^(normal|\d{1,4}(\.\d+)?%)$/;
const SRC_FORMAT_RE = /^[a-z0-9-]{1,32}$/i;

const FORMAT_MIME_TYPES: Record<string, string> = {
  otf: "font/otf",
  opentype: "font/otf",
  truetype: "font/ttf",
  ttf: "font/ttf",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Escape a value for interpolation inside a double-quoted CSS string. Escapes
 * the CSS string metacharacters (`"`, `\`) and hex-escapes control characters
 * plus `<`, `>`, and `&` so the output can never terminate the surrounding
 * `<style>` element or smuggle markup, even after CSS unescaping.
 */
export function escapeCssString(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"' || ch === "\\") {
      out += `\\${ch}`;
    } else if (code < 0x20 || code === 0x7f || ch === "<" || ch === ">" || ch === "&") {
      out += `\\${code.toString(16)} `;
    } else {
      out += ch;
    }
  }
  return out;
}

function fail(family: string, message: string): never {
  throw new Error(`[pracht] defineFont(${JSON.stringify(family)}): ${message}`);
}

const UNICODE_MAX_CODE_POINT = 0x10ffff;

/**
 * One `<urange>` token per css-syntax-3: a single code point (`U+26`), an
 * interval (`U+0-7F`, start <= end), or a trailing-wildcard form (`U+4??`).
 * Wildcards cannot be combined with an interval, and code points cannot
 * exceed U+10FFFF — a browser drops the whole descriptor for such tokens,
 * silently widening the face to every code point.
 */
function isValidUnicodeRangeToken(token: string): boolean {
  if (!/^[Uu]\+/.test(token)) return false;
  const body = token.slice(2);
  if (body.length === 0 || body.length > 13) return false;
  const parts = body.split("-");
  if (parts.length === 2) {
    if (!/^[0-9A-Fa-f]{1,6}$/.test(parts[0]) || !/^[0-9A-Fa-f]{1,6}$/.test(parts[1])) return false;
    const start = Number.parseInt(parts[0], 16);
    const end = Number.parseInt(parts[1], 16);
    return start <= end && end <= UNICODE_MAX_CODE_POINT;
  }
  if (parts.length !== 1) return false;
  if (body.length > 6) return false;
  if (body.includes("?")) {
    // Hex digits followed only by trailing `?` wildcards.
    return (
      /^[0-9A-Fa-f]*\?+$/.test(body) &&
      Number.parseInt(body.replaceAll("?", "F"), 16) <= UNICODE_MAX_CODE_POINT
    );
  }
  if (!/^[0-9A-Fa-f]{1,6}$/.test(body)) return false;
  return Number.parseInt(body, 16) <= UNICODE_MAX_CODE_POINT;
}

function validateUnicodeRange(family: string, value: string): string {
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => !isValidUnicodeRangeToken(token))) {
    fail(family, `invalid unicodeRange ${JSON.stringify(value)}`);
  }
  return tokens.join(", ");
}

/**
 * `font-weight` descriptor values must sit in the CSS range [1, 1000], and a
 * variable range must be ascending. Out-of-range values are not a security
 * problem (the grammar is already digit-only) but browsers drop the invalid
 * descriptor silently, so the face falls back to `font-weight: normal` and
 * matches the wrong styles.
 */
function validateWeight(family: string, value: string): string {
  if (!FONT_WEIGHT_RE.test(value)) {
    fail(family, `invalid weight ${JSON.stringify(value)}`);
  }
  if (value !== "auto" && value !== "normal" && value !== "bold") {
    const parts = value.split(/ +/).map(Number);
    for (const part of parts) {
      if (part < 1 || part > 1000) {
        fail(family, `invalid weight ${JSON.stringify(value)} — values must be between 1 and 1000`);
      }
    }
    if (parts.length === 2 && parts[0] > parts[1]) {
      fail(family, `invalid weight range ${JSON.stringify(value)} — must be ascending`);
    }
  }
  return value;
}

function validateStyle(family: string, value: string): string {
  const match = FONT_STYLE_RE.exec(value);
  if (!match) {
    fail(family, `invalid style ${JSON.stringify(value)}`);
  }
  const angles = match
    .slice(2)
    .filter((angle): angle is string => angle !== undefined)
    .map(Number);
  for (const angle of angles) {
    if (angle < -90 || angle > 90) {
      fail(
        family,
        `invalid style ${JSON.stringify(value)} — angles must be between -90deg and 90deg`,
      );
    }
  }
  if (angles.length === 2 && angles[0] > angles[1]) {
    fail(family, `invalid style range ${JSON.stringify(value)} — must be ascending`);
  }
  return value;
}

function validateMetric(
  family: string,
  name: string,
  value: string,
  options?: { allowNormal?: boolean },
): string {
  const normalized = value.trim();
  if (!METRIC_OVERRIDE_RE.test(normalized) || (normalized === "normal" && !options?.allowNormal)) {
    fail(family, `invalid ${name} ${JSON.stringify(value)} — expected a percentage like "105%"`);
  }
  return normalized;
}

function hasWhitespaceOrControlCharacters(value: string): boolean {
  if (/\s/.test(value)) return true;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function resolveSources(family: string, src: DefineFontOptions["src"]): FontSource[] {
  const list = typeof src === "string" ? [src] : src;
  if (!Array.isArray(list) || list.length === 0) {
    fail(family, "src must be a public path or a non-empty array of variants");
  }
  return list.map((entry) => {
    const url = typeof entry === "string" ? entry : entry.url;
    const format = typeof entry === "string" ? "woff2" : (entry.format ?? "woff2");
    if (typeof url !== "string" || url.trim() === "") {
      fail(family, "src entries need a non-empty url");
    }
    if (hasWhitespaceOrControlCharacters(url)) {
      fail(family, `src url ${JSON.stringify(url)} contains whitespace or control characters`);
    }
    if (!SRC_FORMAT_RE.test(format)) {
      fail(family, `invalid src format ${JSON.stringify(format)}`);
    }
    return { url, format: format.toLowerCase() };
  });
}

/**
 * Vendor keywords like `-apple-system` stop working when quoted (a quoted
 * value is matched as a family *name*, not the keyword). The pattern only
 * admits identifier characters, so emitting them unquoted stays injection-safe.
 */
const VENDOR_FONT_KEYWORD_RE = /^-[a-z][a-z0-9-]*$/i;

function quoteFamily(name: string): string {
  if (GENERIC_FAMILIES.has(name.toLowerCase()) || VENDOR_FONT_KEYWORD_RE.test(name)) return name;
  return `"${escapeCssString(name)}"`;
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Define a self-hosted font. Register the returned object in a shell or route
 * `head()` via the `fonts` array; use `font.className` / `font.style` /
 * `font.fontFamily` in components:
 *
 * ```ts
 * // src/fonts.ts
 * export const inter = defineFont({
 *   family: "Inter",
 *   src: "/fonts/inter-latin.woff2",
 *   weight: "100 900",
 *   fallbacks: ["Arial", "sans-serif"],
 *   sizeAdjust: "107%",
 * });
 *
 * // src/shells/public.tsx
 * export function head() {
 *   return { title: "My Site", fonts: [inter] };
 * }
 * ```
 *
 * The head renderer expands each font into `<link rel="preload" as="font"
 * type="font/woff2" crossorigin>` plus one inline `<style>` with the
 * `@font-face` rules, deduped across shell and route contributions.
 */
export function defineFont(options: DefineFontOptions): PrachtFont {
  const family = options.family;
  if (typeof family !== "string" || family.trim() === "") {
    throw new Error("[pracht] defineFont: family must be a non-empty string");
  }

  const sources = resolveSources(family, options.src);
  const display = options.display ?? "swap";
  if (!FONT_DISPLAY_VALUES.has(display)) {
    fail(family, `invalid display ${JSON.stringify(display)}`);
  }

  const weight =
    options.weight != null ? validateWeight(family, String(options.weight).trim()) : undefined;
  const style =
    options.style !== undefined ? validateStyle(family, options.style.trim()) : undefined;
  const unicodeRange =
    options.unicodeRange !== undefined
      ? validateUnicodeRange(family, options.unicodeRange)
      : undefined;

  const fallbacks = (options.fallbacks ?? []).map((fallback) =>
    typeof fallback === "string" ? fallback.trim() : fallback,
  );
  for (const fallback of fallbacks) {
    if (typeof fallback !== "string" || fallback.trim() === "") {
      fail(family, "fallbacks must be non-empty family names");
    }
  }

  const metricEntries: Array<[descriptor: string, value: string]> = [];
  if (options.sizeAdjust !== undefined) {
    metricEntries.push(["size-adjust", validateMetric(family, "sizeAdjust", options.sizeAdjust)]);
  }
  if (options.ascentOverride !== undefined) {
    metricEntries.push([
      "ascent-override",
      validateMetric(family, "ascentOverride", options.ascentOverride, { allowNormal: true }),
    ]);
  }
  if (options.descentOverride !== undefined) {
    metricEntries.push([
      "descent-override",
      validateMetric(family, "descentOverride", options.descentOverride, { allowNormal: true }),
    ]);
  }
  if (options.lineGapOverride !== undefined) {
    metricEntries.push([
      "line-gap-override",
      validateMetric(family, "lineGapOverride", options.lineGapOverride, { allowNormal: true }),
    ]);
  }

  // The adjusted fallback face needs a real local font to remap; generic
  // keywords like sans-serif cannot appear inside local().
  const metricsFallback = options.metricsFallback?.trim();
  if (metricsFallback !== undefined && metricsFallback === "") {
    fail(family, "metricsFallback must be a non-empty font name");
  }
  if (
    metricsFallback !== undefined &&
    (GENERIC_FAMILIES.has(metricsFallback.toLowerCase()) ||
      VENDOR_FONT_KEYWORD_RE.test(metricsFallback))
  ) {
    fail(family, "metricsFallback must name a locally installed font, not a CSS keyword");
  }
  // Vendor keywords are skipped too: local() matches installed family names,
  // never CSS keywords.
  const localFallback =
    metricsFallback ??
    fallbacks.find(
      (name) => !GENERIC_FAMILIES.has(name.toLowerCase()) && !VENDOR_FONT_KEYWORD_RE.test(name),
    );
  const hasFallbackFace = metricEntries.length > 0 && localFallback !== undefined;
  // The fallback family name carries a hash of the local font + metrics.
  // Without it, two faces of the same family with different metric overrides
  // (e.g. per-weight sizeAdjust values from fontpie) would both register
  // "<family> Fallback" and the last face would clobber the other's metrics.
  // Identical metrics still hash identically, so the shared-face dedupe and
  // shared class name across weights are preserved.
  const fallbackFamilyName = hasFallbackFace
    ? `${family} Fallback ${hashString(
        `${localFallback}|${metricEntries.map(([descriptor, value]) => `${descriptor}:${value}`).join(";")}`,
      )}`
    : `${family} Fallback`;

  const stack = [
    quoteFamily(family),
    ...(hasFallbackFace ? [quoteFamily(fallbackFamilyName)] : []),
    ...fallbacks.map(quoteFamily),
  ];
  const fontFamily = stack.join(", ");

  const srcValue = sources
    .map((source) => `url("${escapeCssString(source.url)}") format("${source.format}")`)
    .join(", ");
  const faceDescriptors = [
    `font-family:"${escapeCssString(family)}"`,
    `src:${srcValue}`,
    ...(weight !== undefined ? [`font-weight:${weight}`] : []),
    ...(style !== undefined ? [`font-style:${style}`] : []),
    `font-display:${display}`,
    ...(unicodeRange !== undefined ? [`unicode-range:${unicodeRange}`] : []),
  ];
  const faceCss = `@font-face{${faceDescriptors.join(";")}}`;

  const fallbackFaceCss = hasFallbackFace
    ? `@font-face{font-family:"${escapeCssString(fallbackFamilyName)}";src:local("${escapeCssString(localFallback)}");${metricEntries.map(([descriptor, value]) => `${descriptor}:${value}`).join(";")}}`
    : undefined;

  const slug = family
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const className = `pracht-font-${slug || "custom"}-${hashString(`${fontFamily}|${fallbackFaceCss ?? ""}`)}`;
  const classCss = `.${className}{font-family:${fontFamily}}`;

  const preload = options.preload ?? true;
  const preferredPreload = sources.find((source) => source.format === "woff2") ?? sources[0];
  const preloadSources = [preferredPreload];
  const preloadLinks: HeadAttributes[] = preloadSources.map((source) => ({
    rel: "preload",
    as: "font",
    type: FORMAT_MIME_TYPES[source.format] ?? `font/${source.format}`,
    href: source.url,
    // Font preloads must be sent in anonymous CORS mode even for same-origin
    // files, or the browser fetches the font twice.
    crossorigin: "anonymous",
  }));

  return {
    family,
    fontFamily,
    className,
    style: { fontFamily },
    sources,
    preload,
    preloadLinks,
    faceCss,
    fallbackFaceCss,
    classCss,
  };
}

export interface FontHeadFragments {
  /** Preload link descriptors, deduped by `href`. */
  preloadLinks: HeadAttributes[];
  /** Combined CSS for one inline `<style>` block. Already escaped. */
  css: string;
}

/**
 * Collapse the merged `fonts` head array into deduped preload links and one
 * CSS payload. The same font registered by both a shell and a route (or by
 * several routes sharing a shell) emits exactly one preload and one
 * `@font-face` block.
 */
export function collectFontHeadFragments(fonts: readonly PrachtFont[]): FontHeadFragments {
  const preloadLinks: HeadAttributes[] = [];
  const seenPreloadHrefs = new Set<string>();
  const faceBlocks: string[] = [];
  // Faces dedupe by content, not by family/weight/style: unicode-range
  // subsets of one family legitimately share all three (only src and
  // unicode-range differ), and every subset must keep its own @font-face.
  const seenFaceBlocks = new Set<string>();
  const fallbackBlocks: string[] = [];
  const seenFallbackBlocks = new Set<string>();
  const classBlocks: string[] = [];
  const seenClassNames = new Set<string>();

  // defineFont escapes every `<` it interpolates, so a raw `<` can only come
  // from a hand-built object impersonating a PrachtFont. Refusing those blocks
  // keeps the inline <style> unbreakable regardless of where the object came
  // from, matching the head renderer's posture for other injected content.
  const isSafeCssBlock = (css: string): boolean => !css.includes("<");

  for (const font of fonts) {
    if (font == null || typeof font !== "object" || typeof font.faceCss !== "string") continue;
    if (!seenFaceBlocks.has(font.faceCss) && isSafeCssBlock(font.faceCss)) {
      seenFaceBlocks.add(font.faceCss);
      faceBlocks.push(font.faceCss);
    }
    if (font.preload) {
      for (const link of font.preloadLinks) {
        const href = link.href;
        if (typeof href !== "string" || seenPreloadHrefs.has(href)) continue;
        seenPreloadHrefs.add(href);
        preloadLinks.push(link);
      }
    }
    if (
      font.fallbackFaceCss &&
      !seenFallbackBlocks.has(font.fallbackFaceCss) &&
      isSafeCssBlock(font.fallbackFaceCss)
    ) {
      seenFallbackBlocks.add(font.fallbackFaceCss);
      fallbackBlocks.push(font.fallbackFaceCss);
    }
    if (
      typeof font.classCss === "string" &&
      !seenClassNames.has(font.className) &&
      isSafeCssBlock(font.classCss)
    ) {
      seenClassNames.add(font.className);
      classBlocks.push(font.classCss);
    }
  }

  return {
    preloadLinks,
    css: [...faceBlocks, ...fallbackBlocks, ...classBlocks].join("\n"),
  };
}
