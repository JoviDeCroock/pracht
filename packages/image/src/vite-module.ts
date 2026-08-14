import type { PrachtImageMetadata } from "./metadata.ts";

export const PRACHT_IMAGE_QUERY = "pracht";

/** `/path/to/hero.jpg?pracht` → true; `?pracht` may combine with other params. */
export function isPrachtImageId(id: string): boolean {
  const queryStart = id.indexOf("?");
  if (queryStart === -1) return false;
  return id
    .slice(queryStart + 1)
    .split("&")
    .some((part) => part === PRACHT_IMAGE_QUERY);
}

/** Strip the entire query, leaving the file path. */
export function stripImageQuery(id: string): string {
  const queryStart = id.indexOf("?");
  return queryStart === -1 ? id : id.slice(0, queryStart);
}

/**
 * Generate the virtual module for a `?pracht` import. The `?url` import
 * delegates the actual file to Vite's asset pipeline, so hashing, `base`,
 * and dev serving all behave exactly like a plain asset import. `no-inline`
 * opts out of `assetsInlineLimit`: without it, images under the limit
 * (default 4 KB) turn `src` into a `data:` URI, which breaks
 * optimization-endpoint loaders (`/api/_pracht/image?url=data%3A…` is not a
 * fetchable same-origin path) and double-ships the bytes next to
 * `blurDataURL`. The metadata contract promises a real asset URL (hashed for
 * source files, stable for publicDir files). Exported for tests.
 */
export function createImageModuleCode(
  assetId: string,
  analyzed: Omit<PrachtImageMetadata, "src">,
): string {
  // Vite ids always use forward slashes, including Windows drive paths
  // (`C:/…`). Normalize before embedding the path in the generated import.
  const assetImport = `${assetId.replace(/\\/g, "/")}?url&no-inline`;
  return [
    `import src from ${JSON.stringify(assetImport)};`,
    `export const width = ${JSON.stringify(analyzed.width)};`,
    `export const height = ${JSON.stringify(analyzed.height)};`,
    `export const blurDataURL = ${JSON.stringify(analyzed.blurDataURL)};`,
    "export { src };",
    "export default { src, width, height, blurDataURL };",
  ].join("\n");
}
