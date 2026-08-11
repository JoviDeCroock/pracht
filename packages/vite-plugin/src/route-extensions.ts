export const BUILT_IN_ROUTE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".md", ".mdx"];
export const LEGACY_BARE_ROUTE_EXTENSIONS = [".tsrx"];
export const DEFAULT_ROUTE_EXTENSIONS = [
  ...BUILT_IN_ROUTE_EXTENSIONS,
  ...LEGACY_BARE_ROUTE_EXTENSIONS,
];
export const DEFAULT_SHELL_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ...LEGACY_BARE_ROUTE_EXTENSIONS,
];

const EXTENSION_RE = /^\.[a-z0-9][a-z0-9_-]*$/i;

export function normalizeAdditionalExtensions(extensions: readonly string[] | undefined): string[] {
  if (extensions === undefined) return [];
  if (!Array.isArray(extensions)) {
    throw new Error(
      "pracht({ additionalExtensions }) expects an array of dot-prefixed extensions.",
    );
  }

  const normalized = extensions.map((extension) => {
    if (typeof extension !== "string" || !EXTENSION_RE.test(extension)) {
      throw new Error(
        `pracht({ additionalExtensions }) expects dot-prefixed extensions such as ".vue", got ${JSON.stringify(extension)}.`,
      );
    }
    return extension.toLowerCase();
  });

  // Keep `.tsrx` when it is explicitly configured even though it remains a
  // compatibility default. That lets the TSRX example exercise the same bare
  // custom-format glob path as every newly configured extension.
  const defaults = new Set(BUILT_IN_ROUTE_EXTENSIONS);
  return [...new Set(normalized)].filter((extension) => !defaults.has(extension));
}

export function extensionGlob(extensions: readonly string[]): string {
  const names = extensions.map((extension) => extension.slice(1));
  return names.length === 1 ? names[0] : `{${names.join(",")}}`;
}

export function withAdditionalExtensions(
  defaults: readonly string[],
  additionalExtensions: readonly string[],
): Set<string> {
  return new Set([...defaults, ...additionalExtensions]);
}
