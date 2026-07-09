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
  /** Cache-Control for successful responses. Defaults to immutable, 1 year. */
  cacheControl?: string;
  /** Reject source images larger than this many bytes. Defaults to 25 MiB. */
  maxSourceBytes?: number;
  /** Override how source images are fetched (useful for tests/CDNs). */
  fetchImage?: (url: URL, request: Request) => Promise<Response>;
  /** Override how sharp is imported (useful for tests). */
  loadSharp?: () => Promise<unknown>;
}

const SHARP_INSTALL_HINT =
  'Image optimization requires the optional "sharp" dependency. ' +
  'Install it in your app with "pnpm add sharp" (or npm install / yarn add) ' +
  "to enable the pracht image endpoint.";

const DEFAULT_CACHE_CONTROL = "public, max-age=31536000, immutable";
const DEFAULT_MAX_WIDTH = 3840;
const DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;

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

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
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
 * const imageHandler = createImageHandler();
 * export const GET = imageHandler;
 * export const HEAD = imageHandler;
 * ```
 *
 * The handler resizes and re-encodes images with sharp (an optional peer
 * dependency — install it in your app), negotiates WebP/AVIF via the `Accept`
 * header, and answers with long-lived immutable cache headers keyed on the
 * query string. Only relative `url` values (same origin) are allowed unless
 * `remotePatterns` opts specific remote hosts in.
 */
export function createImageHandler(
  options: CreateImageHandlerOptions = {},
): (args: { request: Request }) => Promise<Response> {
  const remotePatterns = options.remotePatterns ?? [];
  const allowedWidths = new Set(
    options.allowedWidths ?? [...DEFAULT_IMAGE_SIZES, ...DEFAULT_DEVICE_SIZES],
  );
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const formats = options.formats ?? ["image/webp"];
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const fetchImage =
    options.fetchImage ??
    ((url: URL) => fetch(url, { headers: { accept: "image/*,*/*;q=0.8" }, redirect: "follow" }));
  const importSharp = createSharpImporter(options.loadSharp ?? (() => import("sharp")));

  return async function handleImageRequest({ request }: { request: Request }): Promise<Response> {
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
      if (!matchesRemotePatterns(target, remotePatterns)) {
        return errorResponse(
          403,
          `Remote image "${source}" is not allowed. Add its host to the ` +
            "remotePatterns option of createImageHandler() to opt it in.",
        );
      }
    } else if (source.startsWith("/")) {
      target = new URL(source, requestUrl.origin);
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

    let upstream: Response;
    try {
      upstream = await fetchImage(target, request);
    } catch {
      return errorResponse(502, `Failed to fetch source image "${source}".`);
    }

    // Redirects may escape the requested origin/allowlist; re-validate the
    // final URL the fetch actually landed on.
    if (upstream.url) {
      let finalUrl: URL | undefined;
      try {
        finalUrl = new URL(upstream.url);
      } catch {
        finalUrl = undefined;
      }
      if (
        finalUrl &&
        finalUrl.origin !== requestUrl.origin &&
        !matchesRemotePatterns(finalUrl, remotePatterns)
      ) {
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
      return new Response(imageResponseBody(request, sourceBytes), { headers });
    }

    let sharp: SharpFactory;
    try {
      sharp = await importSharp();
    } catch {
      return errorResponse(500, SHARP_INSTALL_HINT);
    }

    const accept = request.headers.get("accept") ?? "";
    let pipeline = sharp(sourceBytes).rotate().resize({ width, withoutEnlargement: true });
    let contentType: string;
    if (formats.includes("image/avif") && accept.includes("image/avif")) {
      pipeline = pipeline.avif({ quality });
      contentType = "image/avif";
    } else if (formats.includes("image/webp") && accept.includes("image/webp")) {
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

    return new Response(imageResponseBody(request, output), {
      headers: { ...baseHeaders, "content-type": contentType },
    });
  };
}
