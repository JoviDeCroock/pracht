import { formatUnknownNameError } from "./name-suggestions.ts";
import type { ResolvedRoute } from "./types.ts";

/**
 * Dev/build-time manifest validation. Vite folds this to false in production
 * client bundles; plain Node and build tooling keep validation enabled.
 */
export const VALIDATE_MANIFEST = import.meta.env?.DEV !== false;

// Unknown metadata keys remain fail-closed in production server bundles. The
// browser receives a manifest the server already accepted, so Vite removes
// this validation and its name-suggestion payload from client output.
const VALIDATE_META_KEYS = import.meta.env?.SSR !== false;

const ROUTE_META_KEYS = [
  "hasLoader",
  "hydration",
  "id",
  "loaderCache",
  "markdown",
  "middleware",
  "prefetch",
  "render",
  "revalidate",
  "shell",
  "speculation",
];
const ROUTE_NODE_KEYS = [...ROUTE_META_KEYS, "file", "kind", "loaderFile", "path"];
const GROUP_META_KEYS = [
  "hydration",
  "loaderCache",
  "middleware",
  "pathPrefix",
  "render",
  "shell",
  "speculation",
];
const NOT_FOUND_CONFIG_KEYS = ["component", "hydration", "loader", "middleware", "shell"];

export interface RegisteredManifestNameOptions {
  context: string;
  kind: string;
  kindPlural?: string;
}

export function assertRegisteredManifestName(
  registry: Record<string, string>,
  name: string,
  options: RegisteredManifestNameOptions,
): void {
  if (Object.prototype.hasOwnProperty.call(registry, name)) return;

  throw new Error(
    formatUnknownNameError({
      kind: options.kind,
      kindPlural: options.kindPlural,
      name,
      registered: Object.keys(registry),
      context: options.context,
    }),
  );
}

export function assertValidLoaderCache(
  loaderCache: ResolvedRoute["loaderCache"],
  context: string,
): void {
  if (
    loaderCache !== undefined &&
    loaderCache !== false &&
    (!Number.isInteger(loaderCache) || loaderCache < 0)
  ) {
    throw new Error(
      `Invalid loaderCache for ${context}: expected false or a non-negative integer number of seconds.`,
    );
  }
}

export function assertCompatibleRouteRendering(
  render: ResolvedRoute["render"],
  hydration: ResolvedRoute["hydration"],
  path: string,
): void {
  if (render !== "spa" || hydration === undefined || hydration === "full") return;

  throw new Error(
    `Route "${path}" combines render: "spa" with hydration: "${hydration}". ` +
      "SPA routes render entirely in the browser and always use full hydration — " +
      'remove the hydration option or use render: "ssg" / "isg" / "ssr".',
  );
}

export function assertKnownNotFoundConfig(config: object): void {
  assertKnownMetaKeys(config, NOT_FOUND_CONFIG_KEYS, "the notFound page");
}

export function assertKnownGroupMeta(meta: object, context: string): void {
  assertKnownMetaKeys(meta, GROUP_META_KEYS, context);
}

export function assertKnownRouteNode(node: object, context: string): void {
  // `resolveApp()` is idempotent. Already-resolved routes carry derived fields
  // that are deliberately absent from the author-facing key list.
  if ("segments" in node) return;
  assertKnownMetaKeys(node, ROUTE_NODE_KEYS, context);
}

/**
 * Reject metadata keys the resolver does not consume. This prevents a typo
 * such as `middlewares` from silently removing a security boundary in plain
 * JavaScript or when excess-property checking does not apply.
 */
function assertKnownMetaKeys(meta: object, allowed: string[], context: string): void {
  if (!VALIDATE_META_KEYS) return;

  for (const key of Object.keys(meta)) {
    if (allowed.includes(key)) continue;
    throw new Error(
      formatUnknownNameError({
        kind: "option",
        kindPlural: "options",
        name: key,
        registered: allowed,
        context,
      }),
    );
  }
}
