import { lstat, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { ISGManifestEntry } from "@pracht/core/server";

import { getManifestHeaders, staticContentType, staticPathCandidates } from "@pracht/core/server";
export { applyHeadersManifest, getManifestHeaders } from "@pracht/core/server";
import type { HeadersManifest } from "@pracht/core/server";
export type { HeadersManifest } from "@pracht/core/server";

/**
 * Hashed assets (e.g. `assets/chunk-AbCd1234.js`) are safe to cache
 * indefinitely.  Everything else gets a conservative policy.
 */
const HASHED_ASSET_RE = /\/assets\//;

/**
 * Suffix of the file that records a regenerated ISG snapshot's document
 * headers next to its HTML. It lives in the static directory but is never
 * served as a static file.
 */
export const ISG_SNAPSHOT_HEADERS_SUFFIX = ".pracht-headers.json";

export function getCacheControl(urlPath: string): string {
  if (HASHED_ASSET_RE.test(urlPath)) {
    return "public, max-age=31536000, immutable";
  }

  return "public, max-age=0, must-revalidate";
}

export interface StaticFileResult {
  filePath: string;
  contentType: string;
  cacheControl: string;
  /**
   * The URL named a page and was answered with its `index.html`, rather than
   * naming a file exactly — the response that follows the trailing-slash policy.
   */
  document?: boolean;
}

/**
 * Resolve a URL pathname to a static file inside `staticDir`.
 *
 * Tries the exact path first (e.g. `/assets/chunk-Ab12.js`), then falls back
 * to `{pathname}/index.html` for clean-URL pages (e.g. `/about` →
 * `about/index.html`). Each lookup tries the spellings core's
 * `staticPathCandidates()` names, so a percent-encoded URL finds both a
 * decoded `public/` file and an encoded prerendered page. Returns `null` when
 * no matching file is found.
 */
export async function resolveStaticFile(
  staticDir: string,
  pathname: string,
  isgManifest: Record<string, ISGManifestEntry> = {},
): Promise<StaticFileResult | null> {
  const staticRoot = resolve(staticDir);
  const exactCandidates = staticPathCandidates(pathname);
  if (!exactCandidates) return null;

  for (const candidate of exactCandidates) {
    const exactPath = resolveCandidate(staticRoot, candidate);
    if (!exactPath || basename(exactPath).endsWith(ISG_SNAPSHOT_HEADERS_SUFFIX)) continue;
    const exactStat = await lstat(exactPath).catch(() => null);
    if (!exactStat?.isFile() || exactStat.isSymbolicLink()) continue;
    if (!(await realPathIsInside(staticRoot, exactPath))) return null;
    return {
      filePath: exactPath,
      contentType: staticContentType(exactPath),
      cacheControl: getCacheControl(pathname),
    };
  }

  // ISG routes need staleness checks — let the ISG handler below deal with them.
  // The manifest is keyed by route path, which carries no trailing slash.
  if (toRouteKey(pathname) in isgManifest) {
    return null;
  }

  for (const candidate of staticPathCandidates(pathname, { index: true }) ?? []) {
    const indexPath = resolveCandidate(staticRoot, candidate);
    if (!indexPath) continue;
    const indexStat = await lstat(indexPath).catch(() => null);
    if (!indexStat?.isFile() || indexStat.isSymbolicLink()) continue;
    if (!(await realPathIsInside(staticRoot, indexPath))) return null;
    return {
      filePath: indexPath,
      contentType: "text/html; charset=utf-8",
      cacheControl: "public, max-age=0, must-revalidate",
      document: true,
    };
  }

  return null;
}

/**
 * The route-path key the build manifests use for a URL path: `/about/` and
 * `/about` are one page, recorded without the slash.
 */
export function toRouteKey(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.replace(/\/+$/, "") || "/"
    : pathname;
}

function resolveCandidate(staticRoot: string, candidate: string): string | null {
  const resolved = resolve(staticRoot, `.${candidate}`);
  return pathIsInside(staticRoot, resolved) ? resolved : null;
}

function pathIsInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function realPathIsInside(staticRoot: string, candidate: string): Promise<boolean> {
  const [rootReal, candidateReal] = await Promise.all([
    realpath(staticRoot).catch(() => staticRoot),
    realpath(candidate).catch(() => null),
  ]);
  return candidateReal !== null && pathIsInside(resolve(rootReal), resolve(candidateReal));
}
