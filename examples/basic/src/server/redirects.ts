/**
 * Resolve a user-supplied redirect target to a path on this origin, or return
 * `fallback`. A prefix check is not enough: URL parsing turns `\` into `/` and
 * drops tabs and newlines, so `/\evil.com` starts with `/` yet lands on
 * another origin. Parse first, then compare origins.
 */
export function safeRedirectPath(value: unknown, base: URL, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const target = new URL(value, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
