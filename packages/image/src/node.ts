import { DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "./config.ts";
import { DEFAULT_QUALITY } from "./loaders.ts";

/**
 * Allowlist entry for remote image sources, mirroring next/image's
 * `remotePatterns`. Without any patterns only same-origin (relative) `url`
 * values are accepted, which keeps the endpoint from becoming an open proxy.
 */
export interface RemotePattern {
  /** Restrict to a protocol; both http and https match when omitted. */
  protocol?: "http" | "https";
  /** Exact hostname, or a `*.example.com` suffix wildcard. */
  hostname: string;
  /** Exact port; any port matches when omitted. */
  port?: string;
  /** Path prefix (e.g. `/uploads/`); any path matches when omitted. */
  pathname?: string;
}

export interface CreateImageHandlerOptions {
  /** Remote sources to allow. Defaults to none (same-origin only). */
  remotePatterns?: RemotePattern[];
  /**
   * Trusted origin used to resolve relative image paths. Required whenever
   * relative sources are served so an attacker-controlled Host header cannot
   * turn the endpoint into an open proxy.
   */
  localOrigin?: string;
  /**
   * Widths the endpoint will produce. Requests for other widths are rejected
   * so a caller cannot fill caches with arbitrary variants. Defaults to the
   * union of the default device and image sizes; keep this in sync with
   * `configureImage({ deviceSizes, imageSizes })` when you customize those.
   */
  allowedWidths?: number[];
  /** Hard cap on the `w` parameter. Defaults to 3840. */
  maxWidth?: number;
  /**
   * Modern formats to negotiate via the `Accept` header, tried in order.
   * Defaults to `["image/webp"]`; add `"image/avif"` to opt in to AVIF
   * (smaller files, noticeably slower to encode).
   */
  formats?: Array<"image/avif" | "image/webp">;
  /** Cache-Control for successful responses. Defaults to 4 hours with revalidation. */
  cacheControl?: string;
  /** Reject source images larger than this many bytes. Defaults to 25 MiB. */
  maxSourceBytes?: number;
  /** Maximum number of validated redirects to follow. Defaults to 3. */
  maxRedirects?: number;
  /**
   * Override how source images are fetched (useful for tests/CDNs). Redirect
   * responses must be returned without following them; the handler validates
   * each Location before making the next request. Passing one turns the
   * in-process `cache` off unless you set `cache` yourself, because its
   * results are shared by every caller.
   */
  fetchImage?: (url: URL, request: Request, signal?: AbortSignal) => Promise<Response>;
  /** Override how sharp is imported (useful for tests). */
  loadSharp?: () => Promise<unknown>;
  /**
   * Query parameters kept on a relative source that names an image file
   * (`/hero.png?v=2`). Every other parameter is dropped before the source is
   * fetched, so `/hero.png?bust=1` and `/hero.png?bust=2` are one image and
   * one cache entry. A relative source without an image file extension (an
   * API route that draws an image) keeps its whole query. Defaults to none.
   */
  sourceQueryParams?: string[];
  /**
   * In-process cache of optimized images, keyed on the source URL, width,
   * quality and output format, so a repeated request skips the fetch and the
   * encode. Defaults to `{ maxBytes: 50 MiB, maxAge: 3600 }` (seconds);
   * `false` turns it off, and so does a `cacheControl` with `private`,
   * `no-store` or `no-cache`. A cached result is served to every caller,
   * and concurrent requests for the same image share one fetch and encode.
   */
  cache?: { maxBytes?: number; maxAge?: number } | false;
  /**
   * How many images are fetched and optimized at once. Further requests wait
   * for a free slot; when 64 are already waiting, new ones get a `503`.
   * Defaults to 4.
   */
  maxConcurrency?: number;
}

const SHARP_INSTALL_HINT =
  'Image optimization requires the optional "sharp" dependency. ' +
  'Install it in your app with "pnpm add sharp" (or npm install / yarn add) ' +
  "to enable the pracht image endpoint.";

const DEFAULT_CACHE_CONTROL = "public, max-age=14400, must-revalidate";
const DEFAULT_MAX_WIDTH = 3840;
const DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_CACHE_MAX_AGE = 3600;
const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_QUEUED = 64;
const IMAGE_FILE_PATTERN = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp)$/i;

interface CachedImage {
  body: Uint8Array;
  headers: Record<string, string>;
  expiresAt: number;
  size: number;
}

/** Bytes charged per cache entry on top of its body: key, headers and bookkeeping. */
const CACHE_ENTRY_OVERHEAD = 1024;

/** Least-recently-used byte-bounded cache; `Map` keeps insertion order. */
function createImageCache(maxBytes: number, maxAgeMs: number) {
  const entries = new Map<string, CachedImage>();
  let bytes = 0;

  function remove(key: string, entry: CachedImage): void {
    entries.delete(key);
    bytes -= entry.size;
  }

  return {
    get(key: string): CachedImage | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      remove(key, entry);
      if (entry.expiresAt <= Date.now()) return undefined;
      entries.set(key, entry);
      bytes += entry.size;
      return entry;
    },
    set(key: string, body: Uint8Array, headers: Record<string, string>): void {
      const size = body.byteLength + key.length + CACHE_ENTRY_OVERHEAD;
      if (size > maxBytes) return;
      const existing = entries.get(key);
      if (existing) remove(key, existing);
      entries.set(key, { body, headers, expiresAt: Date.now() + maxAgeMs, size });
      bytes += size;
      for (const [oldestKey, oldest] of entries) {
        if (bytes <= maxBytes) break;
        remove(oldestKey, oldest);
      }
    },
  };
}

/** A counting semaphore with a bounded wait queue. */
function createLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    /**
     * Resolves `"held"` once a slot is held, `"busy"` when the queue is full,
     * or `"aborted"` when `signal` aborts while waiting (no slot is held).
     */
    acquire(signal?: AbortSignal): Promise<"held" | "busy" | "aborted"> {
      if (signal?.aborted) return Promise.resolve("aborted");
      if (active < max) {
        active += 1;
        return Promise.resolve("held");
      }
      if (waiting.length >= MAX_QUEUED) return Promise.resolve("busy");
      return new Promise((resolve) => {
        const grant = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve("held");
        };
        const onAbort = () => {
          const index = waiting.indexOf(grant);
          if (index !== -1) waiting.splice(index, 1);
          resolve("aborted");
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiting.push(grant);
      });
    },
    release(): void {
      const next = waiting.shift();
      // The slot passes straight to the next waiter, so `active` is unchanged.
      if (next) next();
      else active -= 1;
    },
  };
}

/**
 * Rewrite equivalent spellings of a source to one URL: the fragment never
 * reaches the server, and a percent-escaped unreserved character (`%65`) is
 * the character itself (RFC 3986 section 6.2.2.2).
 */
function canonicalizeSource(target: URL): void {
  target.hash = "";
  target.pathname = target.pathname.replace(/%[0-9a-f]{2}/gi, (escape) => {
    const char = String.fromCharCode(parseInt(escape.slice(1), 16));
    return /[\w.~-]/.test(char) ? char : escape.toUpperCase();
  });
}

/**
 * Drop every query parameter not in `keep` from a relative image-file source.
 * A static file ignores its query, so the result fetches the same bytes.
 */
function normalizeLocalSource(target: URL, keep: ReadonlySet<string>): void {
  if (!IMAGE_FILE_PATTERN.test(target.pathname)) return;
  const kept = new URLSearchParams();
  for (const [name, value] of target.searchParams) {
    if (keep.has(name)) kept.append(name, value);
  }
  kept.sort();
  const search = kept.toString();
  target.search = search ? `?${search}` : "";
}

function preferredFormat(
  accept: string,
  formats: ReadonlyArray<"image/avif" | "image/webp">,
): "image/avif" | "image/webp" | null {
  if (formats.includes("image/avif") && acceptsFormat(accept, "image/avif")) return "image/avif";
  if (formats.includes("image/webp") && acceptsFormat(accept, "image/webp")) return "image/webp";
  return null;
}

/** Minimal structural typing for the parts of sharp we use. */
interface SharpPipeline {
  rotate(): SharpPipeline;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpPipeline;
  avif(options: { quality: number }): SharpPipeline;
  webp(options: { quality: number }): SharpPipeline;
  jpeg(options: { quality: number }): SharpPipeline;
  png(): SharpPipeline;
  toBuffer(): Promise<Uint8Array>;
}

type SharpFactory = (input: Uint8Array) => SharpPipeline;

interface ImageHandlerArgs {
  request: Request;
  signal?: AbortSignal;
}

function createSharpImporter(load: () => Promise<unknown>): () => Promise<SharpFactory> {
  let cached: Promise<SharpFactory> | undefined;
  return () => {
    cached ??= load().then(
      (mod) => ((mod as { default?: unknown }).default ?? mod) as SharpFactory,
      (error) => {
        cached = undefined;
        throw error;
      },
    );
    return cached;
  };
}

const ERROR_HEADERS: Record<string, string> = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
};

function errorResponse(status: number, message: string): Response {
  return new Response(message, { status, headers: ERROR_HEADERS });
}

type Optimized = { body: Uint8Array; headers: Record<string, string> };
/** An optimized image, or an error kept as plain data so several requests can share it. */
type SharedResult = Optimized | { status: number; text: string; headers: Record<string, string> };

function toResponse(request: Request, result: SharedResult): Response {
  if ("status" in result) {
    return new Response(result.text, { status: result.status, headers: result.headers });
  }
  return new Response(imageResponseBody(request, result.body), { headers: result.headers });
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

function normalizeLocalOrigin(value: string | undefined): string | undefined {
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

function acceptsFormat(accept: string, format: string): boolean {
  return accept.split(",").some((entry) => {
    const [mediaType, ...parameters] = entry.split(";");
    if (mediaType.trim().toLowerCase() !== format) return false;

    for (const parameter of parameters) {
      const [name, value] = parameter.trim().split("=");
      if (name?.toLowerCase() === "q" && Number(value) === 0) return false;
    }
    return true;
  });
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

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}

function imageResponseBody(request: Request, bytes: Uint8Array): ArrayBuffer | null {
  return request.method === "HEAD" ? null : responseBody(bytes);
}

/**
 * Create the pracht image optimization endpoint.
 *
 * Mount it as an API route so it works with every adapter and in `pracht dev`
 * without extra wiring:
 *
 * ```ts
 * // src/api/_pracht/image.ts
 * import { createImageHandler } from "@pracht/image/node";
 * const imageHandler = createImageHandler({
 *   localOrigin: process.env.PRACHT_ORIGIN,
 * });
 * export const GET = imageHandler;
 * export const HEAD = imageHandler;
 * ```
 *
 * The handler resizes and re-encodes images with sharp (an optional peer
 * dependency — install it in your app), negotiates WebP/AVIF via the `Accept`
 * header, and answers with cacheable responses keyed on the query string.
 * Relative sources resolve only against a configured, trusted `localOrigin`;
 * `remotePatterns` opts specific remote hosts in.
 */
export function createImageHandler(
  options: CreateImageHandlerOptions = {},
): (args: ImageHandlerArgs) => Promise<Response> {
  const remotePatterns = options.remotePatterns ?? [];
  const configuredLocalOrigin = normalizeLocalOrigin(options.localOrigin);
  const allowedWidths = new Set(
    options.allowedWidths ?? [...DEFAULT_IMAGE_SIZES, ...DEFAULT_DEVICE_SIZES],
  );
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const formats = options.formats ?? ["image/webp"];
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("createImageHandler({ maxRedirects }) expects a non-negative integer.");
  }
  const fetchImage =
    options.fetchImage ??
    ((url: URL, _request: Request, signal?: AbortSignal) =>
      fetch(url, {
        headers: { accept: "image/*,*/*;q=0.8" },
        redirect: "manual",
        signal,
      }));
  const importSharp = createSharpImporter(options.loadSharp ?? (() => import("sharp")));
  const sourceQueryParams = new Set(options.sourceQueryParams ?? []);
  // A response the endpoint itself marks private must not be replayed from a
  // cache shared by every caller (a custom `fetchImage` may forward cookies).
  const shareable = !/\b(?:private|no-store|no-cache)\b/i.test(cacheControl);
  const cacheOptions =
    options.cache === undefined ? (options.fetchImage ? false : {}) : options.cache;
  const cacheMaxBytes = cacheOptions ? (cacheOptions.maxBytes ?? DEFAULT_CACHE_MAX_BYTES) : 0;
  const cacheMaxAge = cacheOptions ? (cacheOptions.maxAge ?? DEFAULT_CACHE_MAX_AGE) : 0;
  if (!Number.isFinite(cacheMaxBytes) || cacheMaxBytes < 0) {
    throw new Error("createImageHandler({ cache: { maxBytes } }) expects a non-negative number.");
  }
  if (!Number.isFinite(cacheMaxAge) || cacheMaxAge < 0) {
    throw new Error("createImageHandler({ cache: { maxAge } }) expects a non-negative number.");
  }
  const cache =
    cacheOptions === false || !shareable
      ? null
      : createImageCache(cacheMaxBytes, cacheMaxAge * 1000);
  // Identical concurrent misses share one fetch and encode. The work aborts
  // only once every request waiting on it has aborted.
  const inFlight = new Map<
    string,
    { result: Promise<SharedResult>; controller: AbortController; waiters: number }
  >();
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("createImageHandler({ maxConcurrency }) expects a positive integer.");
  }
  const limiter = createLimiter(maxConcurrency);

  async function handleImageRequest({ request, signal }: ImageHandlerArgs): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const requestUrl = new URL(request.url);
    const source = requestUrl.searchParams.get("url");
    const widthParam = requestUrl.searchParams.get("w");
    const qualityParam = requestUrl.searchParams.get("q");

    if (!source) {
      return errorResponse(400, 'Missing required "url" query parameter.');
    }
    if (source.startsWith("//")) {
      return errorResponse(400, 'Protocol-relative "url" values are not allowed.');
    }

    let target: URL;
    if (/^https?:\/\//i.test(source)) {
      try {
        target = new URL(source);
      } catch {
        return errorResponse(400, `Invalid "url" parameter: ${source}`);
      }
      if (target.username || target.password) {
        return errorResponse(400, 'The "url" parameter may not contain credentials.');
      }
      canonicalizeSource(target);
      if (!matchesRemotePatterns(target, remotePatterns)) {
        return errorResponse(
          403,
          `Remote image "${source}" is not allowed. Add its host to the ` +
            "remotePatterns option of createImageHandler() to opt it in.",
        );
      }
    } else if (source.startsWith("/")) {
      if (!configuredLocalOrigin) {
        return errorResponse(
          500,
          "Relative image sources require createImageHandler({ localOrigin }).",
        );
      }
      target = new URL(source, configuredLocalOrigin);
      if (target.origin !== configuredLocalOrigin) {
        return errorResponse(
          400,
          'Relative "url" values must remain on the configured localOrigin.',
        );
      }
      canonicalizeSource(target);
      normalizeLocalSource(target, sourceQueryParams);
    } else {
      return errorResponse(
        400,
        'The "url" parameter must be a relative path (starting with "/") or an absolute http(s) URL.',
      );
    }

    if (!widthParam) {
      return errorResponse(400, 'Missing required "w" query parameter.');
    }
    const width = Number(widthParam);
    if (!Number.isInteger(width) || width <= 0) {
      return errorResponse(400, 'The "w" parameter must be a positive integer.');
    }
    if (width > maxWidth) {
      return errorResponse(400, `The "w" parameter may not exceed ${maxWidth}.`);
    }
    if (allowedWidths.size > 0 && !allowedWidths.has(width)) {
      return errorResponse(
        400,
        `The width ${width} is not allowed. Allowed widths: ${[...allowedWidths]
          .sort((a, b) => a - b)
          .join(", ")}.`,
      );
    }

    let quality = DEFAULT_QUALITY;
    if (qualityParam !== null) {
      quality = Number(qualityParam);
      if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
        return errorResponse(400, 'The "q" parameter must be an integer between 1 and 100.');
      }
    }

    const accept = request.headers.get("accept") ?? "";
    const format = preferredFormat(accept, formats);
    const cacheKey = `${target.href}\n${width}\n${quality}\n${format ?? ""}`;
    const cached = cache?.get(cacheKey);
    if (cached) {
      return new Response(imageResponseBody(request, cached.body), { headers: cached.headers });
    }

    if (!cache) {
      return toResponse(
        request,
        await run(request, signal, source, target, width, quality, format),
      );
    }

    let shared = inFlight.get(cacheKey);
    if (!shared) {
      const controller = new AbortController();
      const created = {
        controller,
        waiters: 0,
        result: run(request, controller.signal, source, target, width, quality, format)
          .then((result) => {
            if (!("status" in result)) cache.set(cacheKey, result.body, result.headers);
            return result;
          })
          .finally(() => inFlight.delete(cacheKey)),
      };
      inFlight.set(cacheKey, created);
      shared = created;
    }
    const entry = shared;
    entry.waiters += 1;
    const onAbort = () => {
      entry.waiters -= 1;
      if (entry.waiters === 0) entry.controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      return toResponse(request, await entry.result);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Wait for a slot, then fetch and optimize; every failure becomes a plain error. */
  async function run(
    request: Request,
    signal: AbortSignal | undefined,
    source: string,
    target: URL,
    width: number,
    quality: number,
    format: "image/avif" | "image/webp" | null,
  ): Promise<SharedResult> {
    const slot = await limiter.acquire(signal);
    if (slot === "busy") {
      return {
        status: 503,
        text: "The image endpoint is busy. Retry shortly.",
        headers: { ...ERROR_HEADERS, "retry-after": "1" },
      };
    }
    if (slot === "aborted") {
      return { status: 503, text: "The image request was aborted.", headers: ERROR_HEADERS };
    }
    try {
      const result = await optimize(request, signal, source, target, width, quality, format);
      if (!(result instanceof Response)) return result;
      return {
        status: result.status,
        text: await result.text(),
        headers: Object.fromEntries(result.headers),
      };
    } finally {
      limiter.release();
    }
  }

  async function optimize(
    request: Request,
    signal: AbortSignal | undefined,
    source: string,
    target: URL,
    width: number,
    quality: number,
    format: "image/avif" | "image/webp" | null,
  ): Promise<Response | Optimized> {
    let upstream: Response;
    let currentTarget = target;
    let redirectCount = 0;
    while (true) {
      try {
        upstream = await fetchImage(currentTarget, request, signal);
      } catch {
        return errorResponse(502, `Failed to fetch source image "${source}".`);
      }

      if (!REDIRECT_STATUSES.has(upstream.status)) break;

      const location = upstream.headers.get("location");
      if (!location) {
        return errorResponse(502, `Source image "${source}" returned a redirect without Location.`);
      }
      if (redirectCount >= maxRedirects) {
        return errorResponse(502, `Source image "${source}" exceeded ${maxRedirects} redirects.`);
      }

      let nextTarget: URL;
      try {
        nextTarget = new URL(location, currentTarget);
      } catch {
        return errorResponse(502, `Source image "${source}" returned an invalid redirect.`);
      }
      if (!isAllowedTarget(nextTarget, configuredLocalOrigin, remotePatterns)) {
        return errorResponse(
          403,
          `Source image "${source}" redirected to a host that is not allowed.`,
        );
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
      if (finalUrl && !isAllowedTarget(finalUrl, configuredLocalOrigin, remotePatterns)) {
        return errorResponse(
          403,
          `Source image "${source}" redirected to a host that is not allowed.`,
        );
      }
    }

    if (!upstream.ok) {
      return errorResponse(502, `Source image "${source}" responded with ${upstream.status}.`);
    }

    const sourceType = (upstream.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!sourceType.startsWith("image/")) {
      return errorResponse(415, `Source "${source}" is not an image (got "${sourceType}").`);
    }

    const sourceBytes = await readCappedBody(upstream, maxSourceBytes);
    if (sourceBytes == null) {
      return errorResponse(413, `Source image "${source}" exceeds ${maxSourceBytes} bytes.`);
    }

    const baseHeaders: Record<string, string> = {
      "cache-control": cacheControl,
      vary: "Accept",
      "x-content-type-options": "nosniff",
    };

    // SVG and GIF pass through untouched: sharp cannot meaningfully resize
    // them here (vector / animation). SVG additionally gets a download
    // disposition so an allowlisted remote SVG cannot run scripts same-origin
    // when opened directly.
    if (sourceType === "image/svg+xml" || sourceType === "image/gif") {
      const headers: Record<string, string> = { ...baseHeaders, "content-type": sourceType };
      if (sourceType === "image/svg+xml") {
        headers["content-disposition"] = "attachment";
      }
      return { body: sourceBytes, headers };
    }

    let sharp: SharpFactory;
    try {
      sharp = await importSharp();
    } catch {
      return errorResponse(500, SHARP_INSTALL_HINT);
    }

    let pipeline = sharp(sourceBytes).rotate().resize({ width, withoutEnlargement: true });
    let contentType: string;
    if (format === "image/avif") {
      pipeline = pipeline.avif({ quality });
      contentType = "image/avif";
    } else if (format === "image/webp") {
      pipeline = pipeline.webp({ quality });
      contentType = "image/webp";
    } else if (sourceType === "image/png") {
      pipeline = pipeline.png();
      contentType = "image/png";
    } else {
      pipeline = pipeline.jpeg({ quality });
      contentType = "image/jpeg";
    }

    let output: Uint8Array;
    try {
      output = await pipeline.toBuffer();
    } catch {
      return errorResponse(500, `Failed to optimize source image "${source}".`);
    }

    return { body: output, headers: { ...baseHeaders, "content-type": contentType } };
  }

  return handleImageRequest;
}
