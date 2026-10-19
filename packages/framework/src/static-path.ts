// The one rule for "URL path to file in the client output directory", shared
// by every static file reader (Node, Netlify, the static preview server) and
// every build writer. Adapters keep their own file IO; only the spelling rule
// and the content-type table live here. A second copy of either is a bug: the
// seam guard in test/static-path.test.ts fails on a `decodeURIComponent` in an
// adapter or build writer.

/** Why a path has no decoded filesystem spelling. */
export type StaticPathDecodeFailure =
  /** A `%` escape that is not valid UTF-8 percent-encoding (`/100%.txt`). */
  | "malformed"
  /** A segment that decodes to `/`, `\` or NUL (`a%2Fb`). */
  | "separator"
  /** A segment that decodes to `.` or `..` (`%2e%2e`). */
  | "relative";

export type StaticPathDecodeResult =
  | { ok: true; path: string }
  | { ok: false; reason: StaticPathDecodeFailure; segment: string };

export interface StaticPathCandidateOptions {
  /** Name the directory's `index.html` (clean URLs) instead of the path itself. */
  index?: boolean;
}

/**
 * Percent-decode a URL path one segment at a time into the spelling a static
 * host looks up on disk. A decoded segment never adds path structure: one that
 * decodes to a separator, NUL, `.` or `..` is reported instead of returned.
 */
export function decodeStaticPath(pathname: string): StaticPathDecodeResult {
  if (!pathname.includes("%")) {
    for (const segment of pathname.split("/")) {
      const reason = segmentProblem(segment);
      if (reason) return { ok: false, reason, segment };
    }
    return { ok: true, path: pathname };
  }

  const decodedSegments: string[] = [];
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { ok: false, reason: "malformed", segment };
    }
    const reason = segmentProblem(decoded);
    if (reason) return { ok: false, reason, segment };
    decodedSegments.push(decoded);
  }
  return { ok: true, path: decodedSegments.join("/") };
}

/**
 * The filesystem spellings to try for a URL path, in order, as root-relative
 * paths that start with `/`. Returns `null` when the path is unsafe: it does
 * not start with `/`, or it holds a backslash, a NUL byte, or a `.`/`..`
 * segment either raw or percent-encoded.
 *
 * 1. The decoded spelling (`/posts/café`): what static exports write and what
 *    Vite copies `public/` files as. Omitted when a segment decodes to a
 *    separator or NUL, or an escape is malformed (`/100%.txt`).
 * 2. The encoded spelling with every escape's hex digits in upper case
 *    (`/posts/caf%C3%A9`): what `pracht build` writes for prerendered pages
 *    of server deployments, because `encodeURIComponent` emits upper case.
 * 3. The request's own spelling, when its escape case differs from (2).
 *
 * Percent-escape case: RFC 3986 makes `%c3%a9` and `%C3%A9` the same
 * character, so a reader matches either request spelling against the
 * upper-case file the build wrote. The build never rewrites escape case: a
 * route path is written exactly as the manifests record it.
 */
export function staticPathCandidates(
  pathname: string,
  options: StaticPathCandidateOptions = {},
): string[] | null {
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) {
    return null;
  }
  for (const segment of pathname.split("/")) {
    if (segment === "." || segment === "..") return null;
  }

  const decoded = decodeStaticPath(pathname);
  if (!decoded.ok && decoded.reason === "relative") return null;

  const candidates: string[] = [];
  const add = (path: string): void => {
    const withIndex = options.index ? `${path.endsWith("/") ? path : `${path}/`}index.html` : path;
    if (!candidates.includes(withIndex)) candidates.push(withIndex);
  };
  if (decoded.ok) add(decoded.path);
  add(canonicalizePercentEscapes(pathname));
  add(pathname);
  return candidates;
}

/**
 * The same URL path with every percent-escape in upper case, the spelling the
 * build writes and records in its manifests.
 */
export function canonicalizePercentEscapes(pathname: string): string {
  return pathname.includes("%")
    ? pathname.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase())
    : pathname;
}

function segmentProblem(segment: string): StaticPathDecodeFailure | null {
  if (segment === "." || segment === "..") return "relative";
  if (segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    return "separator";
  }
  return null;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".atom": "application/atom+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".cjs": "application/javascript",
  ".css": "text/css",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".markdown": "text/markdown; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mjs": "application/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/**
 * The `Content-Type` a static file is served with, from its extension
 * (case-insensitive). Unknown extensions get `fallback`, which defaults to
 * `application/octet-stream`; pass `null` to ask whether the extension is
 * known at all.
 */
export function staticContentType(filePath: string): string;
export function staticContentType<TFallback extends string | null>(
  filePath: string,
  fallback: TFallback,
): string | TFallback;
export function staticContentType(
  filePath: string,
  fallback: string | null = "application/octet-stream",
): string | null {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return fallback;
  return STATIC_CONTENT_TYPES[name.slice(dot).toLowerCase()] ?? fallback;
}
