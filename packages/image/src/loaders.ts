/**
 * A loader turns an image source plus a target width into a concrete URL.
 * Loaders mirror the next/image loader contract so migration is mechanical.
 */
export interface ImageLoaderArgs {
  src: string;
  width: number;
  quality?: number;
}

export type ImageLoader = (args: ImageLoaderArgs) => string;

export const DEFAULT_QUALITY = 75;

/**
 * The default optimization endpoint. It maps onto an API route file at
 * `src/api/_pracht/image.ts` that re-exports the handler from
 * `@pracht/image/node`, so it works on every adapter without extra wiring.
 */
export const DEFAULT_IMAGE_ENDPOINT = "/api/_pracht/image";

/**
 * Build a loader for a pracht image optimization endpoint. Use this when the
 * handler is mounted somewhere other than {@link DEFAULT_IMAGE_ENDPOINT}.
 */
export function createDefaultLoader(endpoint: string = DEFAULT_IMAGE_ENDPOINT): ImageLoader {
  return ({ src, width, quality }) =>
    `${endpoint}?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? DEFAULT_QUALITY}`;
}

/**
 * Targets the pracht image endpoint served by `createImageHandler()` from
 * `@pracht/image/node` (mounted as the `src/api/_pracht/image.ts` API route).
 */
export const defaultLoader: ImageLoader = createDefaultLoader();

/**
 * Cloudflare Image Resizing. Requires the zone to have Image Resizing
 * enabled; `format=auto` lets Cloudflare negotiate WebP/AVIF.
 * https://developers.cloudflare.com/images/transform-images/transform-via-url/
 */
export const cloudflareLoader: ImageLoader = ({ src, width, quality }) => {
  const source = src.startsWith("/") ? src.slice(1) : src;
  return `/cdn-cgi/image/width=${width},quality=${quality ?? DEFAULT_QUALITY},format=auto/${source}`;
};

/**
 * Vercel Image Optimization. Note that Vercel only serves widths listed in
 * the `images.sizes` field of your project configuration.
 * https://vercel.com/docs/image-optimization
 */
export const vercelLoader: ImageLoader = ({ src, width, quality }) =>
  `/_vercel/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? DEFAULT_QUALITY}`;

/**
 * No optimization: the browser fetches the original file. Use for static
 * hosts without an image service. `<Image>` skips `srcset` entirely when
 * every candidate resolves to the same URL.
 */
export const passthroughLoader: ImageLoader = ({ src }) => src;
