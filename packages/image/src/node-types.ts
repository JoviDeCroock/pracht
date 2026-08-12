/** Public configuration and internal result types for the Node image endpoint. */

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

export type ImageOutputFormat = "image/avif" | "image/webp";
export type FetchImage = (url: URL, request: Request, signal?: AbortSignal) => Promise<Response>;

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
  formats?: ImageOutputFormat[];
  /** Cache-Control for successful responses. Defaults to 4 hours with revalidation. */
  cacheControl?: string;
  /** Reject source images larger than this many bytes. Defaults to 25 MiB. */
  maxSourceBytes?: number;
  /** Maximum number of validated redirects to follow. Defaults to 3. */
  maxRedirects?: number;
  /**
   * Override how source images are fetched (useful for tests/CDNs). Redirect
   * responses must be returned without following them; the handler validates
   * each Location before making the next request.
   */
  fetchImage?: FetchImage;
  /** Override how sharp is imported (useful for tests). */
  loadSharp?: () => Promise<unknown>;
}

export interface ImageHandlerArgs {
  request: Request;
  signal?: AbortSignal;
}

export interface ImageFailure {
  ok: false;
  status: number;
  message: string;
}

export interface ImageSource {
  ok: true;
  bytes: Uint8Array;
  contentType: string;
}

export interface TransformedImage {
  ok: true;
  bytes: Uint8Array;
  contentType: string;
  contentDisposition?: string;
}

export type ImageSourceResult = ImageSource | ImageFailure;
export type TransformImageResult = TransformedImage | ImageFailure;
