/** Site-wide constants shared by the shells, the content compiler, and the build plugins. */

export const SITE_ORIGIN = "https://pracht.resynapse.dev";
export const SITE_NAME = "pracht";

/** Absolute, canonical URL for a site path (no trailing slash). */
export function absoluteUrl(path: string): string {
  return path === "/" ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}${path.replace(/\/$/, "")}`;
}
