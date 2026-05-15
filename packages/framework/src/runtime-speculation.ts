import type {
  ResolvedPrachtApp,
  ResolvedRoute,
  RouteSegment,
  SpeculationConfig,
  SpeculationEagerness,
  SpeculationMode,
  SpeculationOption,
} from "./types.ts";

interface SpeculationRule {
  source: "document";
  where: { href_matches: string[] };
  eagerness: SpeculationEagerness;
}

export interface SpeculationRulesDocument {
  prefetch?: SpeculationRule[];
  prerender?: SpeculationRule[];
}

const DEFAULT_EAGERNESS: Record<SpeculationMode, SpeculationEagerness> = {
  prefetch: "moderate",
  prerender: "conservative",
};

export function normalizeSpeculation(
  option: SpeculationOption | undefined,
): SpeculationConfig | null {
  if (!option) return null;
  if (typeof option === "string") return { mode: option };
  return option;
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
      where: { href_matches: patterns },
      eagerness,
    });
  }
  return doc;
}

/**
 * Convert pracht route segments to a URLPattern string suitable for
 * `href_matches`. URLPattern supports `:name` and `*` natively, so this is
 * mostly a 1:1 translation.
 */
function segmentsToHrefMatch(segments: readonly RouteSegment[]): string | null {
  if (segments.length === 0) return "/";
  const parts = segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return `:${segment.name}`;
    return "*";
  });
  return "/" + parts.join("/");
}
