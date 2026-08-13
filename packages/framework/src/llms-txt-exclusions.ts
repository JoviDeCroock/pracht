import { matchRoutePattern } from "./constraints.ts";

/**
 * Path segments pracht reserves for its own endpoints. `/api/_pracht/image` is
 * the image-optimization handler the `@pracht/image` loaders post to, and
 * `/__pracht/*` covers the revalidation webhook and devtools. They are
 * framework plumbing, not part of the app's agent surface, so listing them
 * invites agents to call endpoints that are not theirs to call. Users cannot
 * be expected to exclude them by hand in every app.
 */
const RESERVED_PATH_SEGMENTS = new Set(["_pracht", "__pracht"]);

function isReservedPath(path: string): boolean {
  return path.split("/").some((segment) => RESERVED_PATH_SEGMENTS.has(segment));
}

/** Validate publication exclusions eagerly and include framework-reserved paths. */
export function createLlmsTxtExclusionMatcher(
  patterns: readonly string[] | undefined,
): (path: string) => boolean {
  if (!patterns || patterns.length === 0) return isReservedPath;

  // Validated structurally rather than by probing with a sample path:
  // `matchRoutePattern` bails at the first segment that has no counterpart, so
  // probing with "/" never reaches a later `**` — `/admin/**/secret` would
  // slip through and either throw lazily (depending on which routes exist) or,
  // worse, match nothing at all and silently publish the URLs the pattern was
  // written to hide.
  for (const pattern of patterns) {
    // An empty entry — from a filtered array or a split env var — would match
    // "/" and quietly drop the homepage.
    if (pattern === "") {
      throw new Error(
        'Invalid llmsTxt.exclude pattern: empty string. Remove it, or use "/" to exclude the homepage.',
      );
    }
    // `defineApp({ constraints })` patterns are absolute; accepting a relative
    // one here would contradict "the same segment globs".
    if (!pattern.startsWith("/") && pattern !== "**") {
      throw new Error(
        `Invalid llmsTxt.exclude pattern ${JSON.stringify(pattern)}: patterns are absolute and must ` +
          'start with "/" (or be "**" to match everything).',
      );
    }

    const segments = pattern.split("/").filter(Boolean);
    const wildcardIndex = segments.indexOf("**");
    if (wildcardIndex !== -1 && wildcardIndex !== segments.length - 1) {
      throw new Error(
        `Invalid llmsTxt.exclude pattern ${JSON.stringify(pattern)}: ` +
          '"**" is only supported as the final segment. Patterns use the same segment globs as ' +
          'defineApp({ constraints }) — "*" matches exactly one segment and a trailing "**" ' +
          "matches the rest.",
      );
    }
  }

  return (path) =>
    isReservedPath(path) || patterns.some((pattern) => matchRoutePattern(pattern, path));
}
