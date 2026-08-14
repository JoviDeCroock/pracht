import type { ServerResponse } from "node:http";
import type { Transform } from "node:stream";
import { promisify } from "node:util";
import {
  brotliCompress,
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
  gzip,
} from "node:zlib";

/** Content encodings the Node adapter can produce, in preference order. */
export type ContentEncoding = "br" | "gzip";

/**
 * Bodies below this many bytes are not worth compressing: the encoding
 * overhead can exceed the savings and every compressed variant costs CPU.
 * Applied whenever the body size is known (static files, `Content-Length`).
 */
export const COMPRESSION_MIN_SIZE = 1024;

/**
 * Static files up to this size are compressed once as a whole buffer (better
 * ratio than streaming) and kept in the in-memory LRU. Larger files are
 * streamed through zlib per request instead of being buffered.
 */
export const MAX_CACHEABLE_ASSET_SIZE = 1024 * 1024;

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const COMPRESSIBLE_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/wasm",
  "application/x-javascript",
  "application/xml",
]);

const INTEGRITY_HEADER_NAMES = ["content-digest", "repr-digest", "digest", "content-md5"];

/**
 * Whether a `Content-Type` names a representation that compresses well.
 * `text/*`, well-known application types, and any `+json`/`+xml` structured
 * syntax suffix (`image/svg+xml`, `application/manifest+json`, ...). Binary
 * media (images, fonts, video, archives) is already compressed and excluded.
 */
export function isCompressibleContentType(value: string | null): boolean {
  if (!value) return false;
  const mime = value.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (COMPRESSIBLE_MIME_TYPES.has(mime)) return true;
  return mime.endsWith("+json") || mime.endsWith("+xml");
}

/**
 * Pick the response encoding for an `Accept-Encoding` header. Honors
 * q-values, `*` wildcards, and explicit `q=0` exclusions. Per RFC 9110
 * §12.5.3 the acceptable coding with the highest non-zero qvalue is
 * preferred; an explicitly higher `identity` preference wins, while brotli
 * wins ties (including the common unweighted `gzip, deflate, br`). Returns
 * `null` (identity) when neither coding is acceptable — including
 * `identity;q=0` alone, where falling back to an uncompressed 200 is the
 * robust interpretation of the SHOULD-level 406.
 */
export function negotiateEncoding(header: string | null): ContentEncoding | null {
  if (!header) return null;

  const qualities = new Map<string, number>();
  for (const part of header.split(",")) {
    const [token, ...params] = part.trim().split(";");
    const name = token?.trim().toLowerCase();
    if (!name) continue;

    let quality = 1;
    for (const param of params) {
      const [key, value] = param.trim().split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat(value ?? "");
      if (!Number.isNaN(parsed)) quality = parsed;
    }
    qualities.set(name === "x-gzip" ? "gzip" : name, quality);
  }

  const qualityOf = (encoding: string): number =>
    qualities.get(encoding) ?? qualities.get("*") ?? 0;

  const brQuality = qualityOf("br");
  const gzipQuality = qualityOf("gzip");
  const encoding = brQuality >= gzipQuality ? "br" : "gzip";
  const encodingQuality = Math.max(brQuality, gzipQuality);
  const identityQuality = qualities.get("identity");

  // `identity` is special: when it is absent, keep the server's freedom to
  // choose any acceptable coding (including the common `gzip;q=0.5` case).
  // When the client explicitly assigns it a higher weight, however, that is a
  // real preference for no content coding and must win the negotiation.
  if (identityQuality !== undefined && identityQuality > encodingQuality) return null;
  return encodingQuality > 0 ? encoding : null;
}

/**
 * Whether a response may be transformed at all: informational/empty/not-
 * modified statuses have no body to compress, Range responses would corrupt
 * byte offsets, an existing `Content-Encoding` means someone already encoded
 * the body, and `Cache-Control: no-transform` is an explicit opt-out.
 */
export function isTransformableResponse(status: number, headers: Headers): boolean {
  if (status < 200 || status === 204 || status === 205 || status === 206 || status === 304) {
    return false;
  }
  const existingEncoding = headers.get("content-encoding");
  if (existingEncoding && existingEncoding.toLowerCase() !== "identity") return false;
  if (headers.has("content-range")) return false;
  const cacheControl = headers.get("cache-control");
  if (cacheControl && /(?:^|[\s,])no-transform(?:$|[\s,;=])/i.test(cacheControl)) return false;
  // Integrity fields are calculated over the selected content/representation,
  // which includes its Content-Encoding. Streaming compression cannot
  // recompute them before the headers are sent, so preserve the identity body
  // instead of forwarding a digest that no longer matches the wire bytes.
  if (INTEGRITY_HEADER_NAMES.some((name) => headers.has(name))) return false;
  return true;
}

/** Append `Accept-Encoding` to a `Vary` header value, preserving existing members. */
export function mergeVaryValue(existing: string | null | undefined): string {
  if (!existing) return "Accept-Encoding";
  const members = existing.split(",").map((member) => member.trim().toLowerCase());
  if (members.includes("*") || members.includes("accept-encoding")) return existing;
  return `${existing}, Accept-Encoding`;
}

/** Merge `Accept-Encoding` into the `Vary` header already written to `res`. */
export function mergeVaryOnNodeResponse(res: ServerResponse): void {
  const existing = res.getHeader("vary");
  const value = Array.isArray(existing) ? existing.join(", ") : (existing?.toString() ?? null);
  res.setHeader("vary", mergeVaryValue(value));
}

/**
 * Derive the ETag of an encoded variant from the identity ETag. Encoded
 * variants must not share a validator with identity — a shared tag would let
 * a cache answer an `Accept-Encoding: identity` revalidation with a brotli
 * body — so the encoding is folded into the opaque tag.
 */
export function encodeEtagForEncoding(etag: string, encoding: ContentEncoding): string {
  if (etag.endsWith('"')) {
    return `${etag.slice(0, -1)}-${encoding}"`;
  }
  return `${etag}-${encoding}`;
}

export interface CompressionStreamOptions {
  /** Known total body size, forwarded to brotli as a size hint. */
  sizeHint?: number;
  /**
   * Flush the compressor after every written chunk (`Z_SYNC_FLUSH` /
   * `BROTLI_OPERATION_FLUSH`). Required for incrementally produced bodies —
   * SSE and other streamed responses — where zlib's default `Z_NO_FLUSH`
   * would sit on written events until its internal buffer fills or the
   * stream ends, breaking incremental delivery entirely (brotli emits zero
   * bytes until end-of-stream; gzip emits only its 10-byte header).
   */
  incremental?: boolean;
}

/**
 * Create a streaming zlib transform for `encoding`. Brotli runs at quality 4
 * for streamed (dynamic) bodies — near-gzip speed with a better ratio —
 * because SSR latency matters more than the last few percent of savings.
 */
export function createCompressionTransform(
  encoding: ContentEncoding,
  options: CompressionStreamOptions = {},
): Transform {
  if (encoding === "br") {
    const params: Record<number, number> = {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
    };
    if (options.sizeHint !== undefined) {
      params[zlibConstants.BROTLI_PARAM_SIZE_HINT] = options.sizeHint;
    }
    return createBrotliCompress({
      params,
      ...(options.incremental ? { flush: zlibConstants.BROTLI_OPERATION_FLUSH } : {}),
    });
  }
  return createGzip(options.incremental ? { flush: zlibConstants.Z_SYNC_FLUSH } : {});
}

/**
 * Pipe `source` through a compression transform, keeping the failure
 * semantics `pipeToResponse()` relies on: a source error destroys the
 * transform with that error (so the caller can still answer 500), and a
 * transform torn down mid-stream (client disconnect) releases the source so
 * file descriptors and pooled sockets do not leak.
 */
export function createCompressedStream(
  source: NodeJS.ReadableStream,
  encoding: ContentEncoding,
  options: CompressionStreamOptions = {},
): Transform {
  const transform = createCompressionTransform(encoding, options);

  source.on("error", (error: unknown) => {
    transform.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  transform.on("close", () => {
    if (!transform.writableFinished) {
      source.unpipe?.(transform);
      (source as { destroy?: () => void }).destroy?.();
    }
  });

  source.pipe(transform);
  return transform;
}

/**
 * Compress a whole buffer at higher quality than the streaming path — used
 * for static assets whose result lands in the LRU, where the one-time CPU
 * cost is amortized across every later request.
 */
export function compressBuffer(buffer: Buffer, encoding: ContentEncoding): Promise<Buffer> {
  if (encoding === "br") {
    return brotliCompressAsync(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
      },
    });
  }
  return gzipAsync(buffer, { level: 9 });
}

/**
 * Byte-bounded LRU of compressed static assets, keyed by file identity
 * (path + size + mtime) and encoding — an ISG regeneration that rewrites the
 * HTML on disk changes the mtime and naturally invalidates its entries.
 */
export class CompressedAssetCache {
  #entries = new Map<string, Buffer>();
  #pending = new Map<string, Promise<Buffer>>();
  #totalBytes = 0;
  readonly #maxBytes: number;

  constructor(maxBytes = 32 * 1024 * 1024) {
    this.#maxBytes = maxBytes;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  /**
   * Cached lookup with in-flight deduplication: concurrent first requests to
   * the same file version share one `produce()` call instead of compressing
   * the same bytes N times (the post-deploy thundering herd). A failed
   * `produce()` rejects every waiter and is not cached, so the next request
   * retries.
   */
  getOrCompress(key: string, produce: () => Promise<Buffer>): Promise<Buffer> {
    const cached = this.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    let pending = this.#pending.get(key);
    if (!pending) {
      pending = produce()
        .then((buffer) => {
          this.set(key, buffer);
          return buffer;
        })
        .finally(() => {
          this.#pending.delete(key);
        });
      this.#pending.set(key, pending);
    }
    return pending;
  }

  get(key: string): Buffer | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    // Refresh recency.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry;
  }

  set(key: string, value: Buffer): void {
    if (value.byteLength > this.#maxBytes) return;

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#entries.delete(key);
      this.#totalBytes -= existing.byteLength;
    }

    this.#entries.set(key, value);
    this.#totalBytes += value.byteLength;

    for (const [oldestKey, oldestValue] of this.#entries) {
      if (this.#totalBytes <= this.#maxBytes) break;
      this.#entries.delete(oldestKey);
      this.#totalBytes -= oldestValue.byteLength;
    }
  }
}

/** Per-handler compression state threaded through the static/dynamic paths. */
export interface CompressionState {
  request: Request;
  cache: CompressedAssetCache;
}
