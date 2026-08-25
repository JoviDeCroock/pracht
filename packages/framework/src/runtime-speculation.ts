import { PRACHT_BASE } from "./base.ts";
import { SPECULATE_ATTRIBUTE } from "./runtime-constants.ts";
import type {
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteSegment,
  SpeculationConfig,
  SpeculationEagerness,
  SpeculationMode,
  SpeculationOption,
} from "./types.ts";

interface HrefMatchesClause {
  href_matches: string[];
}

interface ExclusionClause {
  not: { selector_matches: string[] };
}

interface SpeculationRule {
  source: "document";
  where: { and: [HrefMatchesClause, ExclusionClause] };
  eagerness: SpeculationEagerness;
}

export interface SpeculationRulesDocument {
  prefetch?: SpeculationRule[];
  prerender?: SpeculationRule[];
}

/**
 * Links the browser must never speculate, regardless of the route patterns
 * a rule matches. Emitted as a `not: { selector_matches }` conjunct on every
 * rule, and mirrored on the client by `isSpeculationSuppressed()`.
 *
 * - `rel="nofollow"` marks a link the page does not vouch for.
 * - `data-pracht-speculate="off"` opts an element and every hyperlink in its
 *   subtree out. A link can explicitly re-enable itself with `"on"`.
 *   Container-level `"on"` scopes are deliberately unsupported because CSS
 *   selectors cannot express nearest-ancestor precedence for arbitrarily
 *   nested scopes; keeping `"off"` fail-closed makes the browser and client
 *   agree for every nesting depth.
 */
export const SPECULATION_EXCLUSION_SELECTORS: readonly string[] = [
  'a[rel~="nofollow"]',
  'area[rel~="nofollow"]',
  `a[${SPECULATE_ATTRIBUTE}="off"]`,
  `area[${SPECULATE_ATTRIBUTE}="off"]`,
  `[${SPECULATE_ATTRIBUTE}="off"] a:not([${SPECULATE_ATTRIBUTE}="on"])`,
  `[${SPECULATE_ATTRIBUTE}="off"] area:not([${SPECULATE_ATTRIBUTE}="on"])`,
];

/**
 * True when this link is excluded from the emitted speculation rules — the
 * client-side counterpart of `SPECULATION_EXCLUSION_SELECTORS`. The router and
 * prefetch listeners consult it before handing a link to the browser: if the
 * browser will not prerender it, the normal SPA prefetch/navigation path has
 * to keep working.
 */
export function isSpeculationSuppressed(anchor: Element): boolean {
  const rel = anchor.getAttribute("rel");
  if (rel && rel.split(/\s+/).some((token) => token.toLowerCase() === "nofollow")) return true;
  const ownSetting = anchor.getAttribute(SPECULATE_ATTRIBUTE);
  if (ownSetting === "on") return false;
  return anchor.closest(`[${SPECULATE_ATTRIBUTE}="off"]`) !== null;
}

const DEFAULT_EAGERNESS: Record<SpeculationMode, SpeculationEagerness> = {
  prefetch: "moderate",
  prerender: "conservative",
};

const URL_PATTERN_STATIC_SEGMENT_CHARS_RE = /[:+*?{}()[\]\\]/g;

export function normalizeSpeculation(
  option: SpeculationOption | undefined,
): SpeculationConfig | null {
  if (!option) return null;
  if (typeof option === "string") return { mode: option };
  return option;
}

export function supportsSpeculationRules(): boolean {
  return (
    typeof HTMLScriptElement !== "undefined" &&
    typeof HTMLScriptElement.supports === "function" &&
    HTMLScriptElement.supports("speculationrules")
  );
}

const appRulesCache = new WeakMap<ResolvedPrachtApp, SpeculationRulesDocument | null>();

/**
 * Returns the cached speculation rules document for a resolved app, computing
 * it on first access. Routes are static per resolved app so the result is
 * stable for the lifetime of the app object.
 */
export function getAppSpeculationRules(app: ResolvedPrachtApp): SpeculationRulesDocument | null {
  let cached = appRulesCache.get(app);
  if (cached === undefined) {
    cached = buildSpeculationRules(app.routes);
    appRulesCache.set(app, cached);
  }
  return cached;
}

export function buildSpeculationRules(
  routes: readonly ResolvedRoute[],
): SpeculationRulesDocument | null {
  const buckets = new Map<
    string,
    { mode: SpeculationMode; eagerness: SpeculationEagerness; patterns: string[] }
  >();

  for (const route of routes) {
    const config = normalizeSpeculation(route.speculation);
    if (!config) continue;
    const eagerness = config.eagerness ?? DEFAULT_EAGERNESS[config.mode];
    const pattern = segmentsToHrefMatch(route.segments);
    if (!pattern) continue;

    const key = `${config.mode}:${eagerness}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { mode: config.mode, eagerness, patterns: [] };
      buckets.set(key, bucket);
    }
    if (!bucket.patterns.includes(pattern)) bucket.patterns.push(pattern);
  }

  if (buckets.size === 0) return null;

  const doc: SpeculationRulesDocument = {};
  for (const { mode, eagerness, patterns } of buckets.values()) {
    const list = doc[mode] ?? (doc[mode] = []);
    list.push({
      source: "document",
      where: {
        and: [
          { href_matches: patterns },
          { not: { selector_matches: [...SPECULATION_EXCLUSION_SELECTORS] } },
        ],
      },
      eagerness,
    });
  }
  return doc;
}

/**
 * Convert pracht route segments to a URLPattern string suitable for
 * `href_matches`. URLPattern supports `:name` and `*` natively, so this is
 * mostly a 1:1 translation.
 *
 * The rules are matched by the browser against real document hrefs, so the
 * pattern carries the deploy base — route segments do not.
 */
function segmentsToHrefMatch(segments: readonly RouteSegment[]): string | null {
  // `PRACHT_BASE` always ends in a slash ("/" at the origin root), so it is
  // the pattern prefix as-is. It is user-configured text, not a pattern.
  const base = escapeStaticSegmentForUrlPattern(PRACHT_BASE);
  if (segments.length === 0) return base;
  const parts = segments.map((segment) => {
    if (segment.type === "static") return escapeStaticSegmentForUrlPattern(segment.value);
    if (segment.type === "param") return `:${segment.name}`;
    return "*";
  });
  return base + parts.join("/");
}

function escapeStaticSegmentForUrlPattern(segment: string): string {
  return segment.replace(URL_PATTERN_STATIC_SEGMENT_CHARS_RE, "\\$&");
}
