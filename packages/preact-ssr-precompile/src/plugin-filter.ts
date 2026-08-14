import type { FilterPattern } from "./types.js";

export function createSimpleFilter(
  include: FilterPattern,
  exclude: FilterPattern,
): (id: string) => boolean {
  const includes = normalizeFilterPattern(include);
  const excludes = normalizeFilterPattern(exclude);
  return (id) => matchesAny(id, includes) && !matchesAny(id, excludes);
}

function normalizeFilterPattern(pattern: FilterPattern): Array<string | RegExp> {
  if (Array.isArray(pattern)) return [...(pattern as ReadonlyArray<string | RegExp>)];
  return [pattern as string | RegExp];
}

function matchesAny(id: string, patterns: Array<string | RegExp>): boolean {
  return patterns.some((pattern) => {
    if (typeof pattern === "string") return id.includes(pattern);
    return pattern.test(id);
  });
}
