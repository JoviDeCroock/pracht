/** Node image endpoint request validation and response orchestration. */

import { DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "./config.ts";
import { DEFAULT_QUALITY } from "./loaders.ts";
import {
  createImageSourceFetcher,
  normalizeLocalOrigin,
  resolveImageTarget,
} from "./node-source.ts";
import { createImageTransformer } from "./node-transform.ts";
import type { CreateImageHandlerOptions, ImageFailure, ImageHandlerArgs } from "./node-types.ts";

export type { CreateImageHandlerOptions, RemotePattern } from "./node-types.ts";

const DEFAULT_CACHE_CONTROL = "public, max-age=14400, must-revalidate";
const DEFAULT_MAX_WIDTH = 3840;
const DEFAULT_MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

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
  const localOrigin = normalizeLocalOrigin(options.localOrigin);
  const allowedWidths = new Set(
    options.allowedWidths ?? [...DEFAULT_IMAGE_SIZES, ...DEFAULT_DEVICE_SIZES],
  );
  const maxWidth = options.maxWidth ?? DEFAULT_MAX_WIDTH;
  const cacheControl = options.cacheControl ?? DEFAULT_CACHE_CONTROL;
  const fetchImageSource = createImageSourceFetcher({
    fetchImage: options.fetchImage,
    localOrigin,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    maxSourceBytes: options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    remotePatterns,
  });
  const transformImage = createImageTransformer({
    formats: options.formats ?? ["image/webp"],
    loadSharp: options.loadSharp,
  });

  return async function handleImageRequest({ request, signal }): Promise<Response> {
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

    const target = resolveImageTarget(source, localOrigin, remotePatterns);
    if (!(target instanceof URL)) return failureResponse(target);

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

    const imageSource = await fetchImageSource(target, source, request, signal);
    if (!imageSource.ok) return failureResponse(imageSource);

    const transformed = await transformImage({
      accept: request.headers.get("accept") ?? "",
      bytes: imageSource.bytes,
      contentType: imageSource.contentType,
      quality,
      source,
      width,
    });
    if (!transformed.ok) return failureResponse(transformed);

    const headers: Record<string, string> = {
      "cache-control": cacheControl,
      "content-type": transformed.contentType,
      vary: "Accept",
      "x-content-type-options": "nosniff",
    };
    if (transformed.contentDisposition) {
      headers["content-disposition"] = transformed.contentDisposition;
    }

    return new Response(imageResponseBody(request, transformed.bytes), { headers });
  };
}

function failureResponse(failure: ImageFailure): Response {
  return errorResponse(failure.status, failure.message);
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

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return body;
}

function imageResponseBody(request: Request, bytes: Uint8Array): ArrayBuffer | null {
  return request.method === "HEAD" ? null : responseBody(bytes);
}
