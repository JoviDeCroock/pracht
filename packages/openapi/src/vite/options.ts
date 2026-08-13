import type { PrachtOpenApiOptions, ResolvedPrachtOpenApiOptions } from "./model.ts";

export function resolvePrachtOpenApiOptions(
  options: PrachtOpenApiOptions,
): ResolvedPrachtOpenApiOptions {
  if (!options || typeof options !== "object") {
    throw new TypeError("prachtOpenApi() expects an options object.");
  }
  if (!options.info || typeof options.info.title !== "string" || !options.info.title.trim()) {
    throw new TypeError("prachtOpenApi() info.title must be a non-empty string.");
  }
  if (typeof options.info.version !== "string" || !options.info.version.trim()) {
    throw new TypeError("prachtOpenApi() info.version must be a non-empty string.");
  }

  const documentPath = normalizeEndpointPath(
    options.documentPath ?? "/openapi.json",
    "documentPath",
  );
  if (!documentPath.endsWith(".json")) {
    throw new TypeError(
      "prachtOpenApi() documentPath must end in .json so static hosts send the correct media type.",
    );
  }
  const ui = resolveUiOptions(options.ui);
  if (ui) {
    const documentOutputPath = documentPath.slice(1);
    const uiOutputPath = `${ui.path.slice(1)}/index.html`;
    if (outputPathsOverlap(documentOutputPath, uiOutputPath)) {
      throw new TypeError(
        "prachtOpenApi() UI and document paths must not overlap in static build output.",
      );
    }
  }

  return {
    documentPath,
    document: options.document ? { ...options.document } : {},
    failOnWarnings: options.failOnWarnings ?? false,
    info: { ...options.info },
    ui,
  };
}

function resolveUiOptions(value: PrachtOpenApiOptions["ui"]): ResolvedPrachtOpenApiOptions["ui"] {
  if (value === undefined || value === false) return null;
  if (value === "scalar" || value === "swagger") {
    return { path: "/docs", provider: value };
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(
      'prachtOpenApi() ui must be false, "scalar", "swagger", or an options object.',
    );
  }
  if (value.provider !== "scalar" && value.provider !== "swagger") {
    throw new TypeError('prachtOpenApi() ui.provider must be "scalar" or "swagger".');
  }
  if (value.provider === "scalar" && value.styleUrl !== undefined) {
    throw new TypeError("prachtOpenApi() ui.styleUrl is only supported by Swagger UI.");
  }
  return {
    ...value,
    path: normalizeEndpointPath(value.path ?? "/docs", "ui.path"),
  };
}

function normalizeEndpointPath(path: string, name: string): string {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    pathHasUnsafeSegment(path)
  ) {
    throw new TypeError(`prachtOpenApi() ${name} must be a safe root-relative URL path.`);
  }
  const canonicalPath = new URL(path, "http://pracht.local").pathname.replace(/\/{2,}/g, "/");
  const normalized = canonicalPath.length > 1 ? canonicalPath.replace(/\/+$/, "") : canonicalPath;
  if (normalized === "/") {
    throw new TypeError(`prachtOpenApi() ${name} must not replace the app root.`);
  }
  return normalized;
}

function outputPathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathHasUnsafeSegment(path: string): boolean {
  try {
    return path.split("/").some((segment) => {
      const decoded = decodeURIComponent(segment);
      return (
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\") ||
        hasControlCharacter(decoded)
      );
    });
  } catch {
    return true;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
