/** Trusted image-source resolution, redirect validation, and bounded reads. */

import type { FetchImage, ImageFailure, ImageSourceResult, RemotePattern } from "./node-types.ts";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function normalizeLocalOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "createImageHandler({ localOrigin }) expects an http(s) origin without a path.",
    );
  }
  return url.origin;
}

export function resolveImageTarget(
  source: string,
  localOrigin: string | undefined,
  remotePatterns: RemotePattern[],
): URL | ImageFailure {
  if (source.startsWith("//")) {
    return failure(400, 'Protocol-relative "url" values are not allowed.');
  }

  if (/^https?:\/\//i.test(source)) {
    let target: URL;
    try {
      target = new URL(source);
    } catch {
      return failure(400, `Invalid "url" parameter: ${source}`);
    }
    if (target.username || target.password) {
      return failure(400, 'The "url" parameter may not contain credentials.');
    }
    if (!matchesRemotePatterns(target, remotePatterns)) {
      return failure(
        403,
        `Remote image "${source}" is not allowed. Add its host to the ` +
          "remotePatterns option of createImageHandler() to opt it in.",
      );
    }
    return target;
  }

  if (source.startsWith("/")) {
    if (!localOrigin) {
      return failure(500, "Relative image sources require createImageHandler({ localOrigin }).");
    }
    const target = new URL(source, localOrigin);
    if (target.origin !== localOrigin) {
      return failure(400, 'Relative "url" values must remain on the configured localOrigin.');
    }
    return target;
  }

  return failure(
    400,
    'The "url" parameter must be a relative path (starting with "/") or an absolute http(s) URL.',
  );
}

export interface ImageSourceFetcherOptions {
  fetchImage?: FetchImage;
  localOrigin?: string;
  maxRedirects: number;
  maxSourceBytes: number;
  remotePatterns: RemotePattern[];
}

export function createImageSourceFetcher(options: ImageSourceFetcherOptions) {
  if (!Number.isInteger(options.maxRedirects) || options.maxRedirects < 0) {
    throw new Error("createImageHandler({ maxRedirects }) expects a non-negative integer.");
  }

  const fetchImage: FetchImage =
    options.fetchImage ??
    ((url, _request, signal) =>
      fetch(url, {
        headers: { accept: "image/*,*/*;q=0.8" },
        redirect: "manual",
        signal,
      }));

  return async function fetchImageSource(
    target: URL,
    source: string,
    request: Request,
    signal?: AbortSignal,
  ): Promise<ImageSourceResult> {
    let upstream: Response;
    let currentTarget = target;
    let redirectCount = 0;
    while (true) {
      try {
        upstream = await fetchImage(currentTarget, request, signal);
      } catch {
        return failure(502, `Failed to fetch source image "${source}".`);
      }

      if (!REDIRECT_STATUSES.has(upstream.status)) break;

      const location = upstream.headers.get("location");
      if (!location) {
        return failure(502, `Source image "${source}" returned a redirect without Location.`);
      }
      if (redirectCount >= options.maxRedirects) {
        return failure(502, `Source image "${source}" exceeded ${options.maxRedirects} redirects.`);
      }

      let nextTarget: URL;
      try {
        nextTarget = new URL(location, currentTarget);
      } catch {
        return failure(502, `Source image "${source}" returned an invalid redirect.`);
      }
      if (!isAllowedTarget(nextTarget, options.localOrigin, options.remotePatterns)) {
        return failure(403, `Source image "${source}" redirected to a host that is not allowed.`);
      }

      try {
        await upstream.body?.cancel();
      } catch {
        // The redirect response body is intentionally discarded.
      }
      currentTarget = nextTarget;
      redirectCount += 1;
    }

    // Custom fetch hooks may accidentally follow redirects themselves. Keep
    // the final response check as defense in depth; the built-in fetcher uses
    // manual redirects so every hop is checked before it is requested.
    if (upstream.url) {
      let finalUrl: URL | undefined;
      try {
        finalUrl = new URL(upstream.url);
      } catch {
        finalUrl = undefined;
      }
      if (finalUrl && !isAllowedTarget(finalUrl, options.localOrigin, options.remotePatterns)) {
        return failure(403, `Source image "${source}" redirected to a host that is not allowed.`);
      }
    }

    if (!upstream.ok) {
      return failure(502, `Source image "${source}" responded with ${upstream.status}.`);
    }

    const contentType = (upstream.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!contentType.startsWith("image/")) {
      return failure(415, `Source "${source}" is not an image (got "${contentType}").`);
    }

    const bytes = await readCappedBody(upstream, options.maxSourceBytes);
    if (bytes == null) {
      return failure(413, `Source image "${source}" exceeds ${options.maxSourceBytes} bytes.`);
    }

    return { ok: true, bytes, contentType };
  };
}

function matchesHostname(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase();
  const expected = pattern.toLowerCase();
  if (expected.startsWith("*.")) {
    return host.endsWith(expected.slice(1)) && host.length > expected.length - 1;
  }
  return host === expected;
}

function matchesRemotePatterns(url: URL, patterns: RemotePattern[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.protocol && `${pattern.protocol}:` !== url.protocol) return false;
    if (pattern.port !== undefined && pattern.port !== url.port) return false;
    if (!matchesHostname(url.hostname, pattern.hostname)) return false;
    if (pattern.pathname) {
      const prefix = pattern.pathname.endsWith("/") ? pattern.pathname : `${pattern.pathname}/`;
      if (url.pathname !== pattern.pathname && !url.pathname.startsWith(prefix)) return false;
    }
    return true;
  });
}

function isAllowedTarget(
  url: URL,
  localOrigin: string | undefined,
  patterns: RemotePattern[],
): boolean {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    return false;
  }
  return (
    (localOrigin !== undefined && url.origin === localOrigin) ||
    matchesRemotePatterns(url, patterns)
  );
}

async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function failure(status: number, message: string): ImageFailure {
  return { ok: false, status, message };
}
