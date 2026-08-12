/** Runtime and source-only detection of callable API route exports. */

import type { AppGraphModuleAccess, AppGraphStaticModuleAccess } from "./app-graph.ts";
import {
  findTopLevelOffsets,
  hasStaticallyCallableDefaultExport,
  hasTopLevelMatch,
  maskJavaScriptCommentsAndStrings,
  readStringLiteral,
} from "./api-export-source-scan.ts";
import type { HttpMethod } from "./types.ts";

export const API_METHOD_ORDER: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export interface ApiRouteExports {
  /** `true` when the module exports a default catch-all request handler. */
  hasDefaultHandler: boolean;
  methods: HttpMethod[];
}

export async function detectApiExports(
  file: string,
  access: AppGraphModuleAccess,
): Promise<ApiRouteExports> {
  try {
    return apiExportsFromModule(await access.loadModule(file));
  } catch {
    let source: string;
    try {
      source = access.readSource(file);
    } catch {
      return { hasDefaultHandler: false, methods: [] };
    }

    const maskedSource = maskJavaScriptCommentsAndStrings(source);
    const topLevelOffsets = findTopLevelOffsets(maskedSource);
    return {
      hasDefaultHandler: hasStaticallyCallableDefaultExport(maskedSource, topLevelOffsets),
      methods: API_METHOD_ORDER.filter((method) =>
        hasTopLevelMatch(
          maskedSource,
          new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
          topLevelOffsets,
        ),
      ),
    };
  }
}

export function apiExportsFromModule(module: Record<string, unknown>): ApiRouteExports {
  return {
    hasDefaultHandler: typeof module.default === "function",
    methods: API_METHOD_ORDER.filter((method) => typeof module[method] === "function"),
  };
}

/** Detect API exports from source text only, following relative star re-exports. */
export async function detectApiExportsStatic(
  file: string,
  access: AppGraphStaticModuleAccess,
  seen: Set<string> = new Set(),
): Promise<ApiRouteExports> {
  if (seen.has(file)) {
    return { hasDefaultHandler: false, methods: [] };
  }
  seen.add(file);

  let rawSource: string;
  try {
    rawSource = access.readSource(file);
  } catch {
    return { hasDefaultHandler: false, methods: [] };
  }
  const source = maskJavaScriptCommentsAndStrings(rawSource);
  const topLevelOffsets = findTopLevelOffsets(source);

  const exportedNames = new Set<string>();
  const hasDefaultHandler = hasStaticallyCallableDefaultExport(source, topLevelOffsets);

  for (const method of API_METHOD_ORDER) {
    if (
      hasTopLevelMatch(
        source,
        new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
        topLevelOffsets,
      )
    ) {
      exportedNames.add(method);
    }
  }

  const namedExportPattern = /\bexport\s*\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?/g;
  for (const match of source.matchAll(namedExportPattern)) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    for (const entry of match[1].split(",")) {
      const normalized = entry.trim();
      if (!normalized) continue;
      // Inline type-only specifiers (`export { type GET }`) are erased by
      // TypeScript and therefore cannot be API handlers at runtime.
      if (/^type\s+/.test(normalized)) continue;
      const parts = normalized.split(/\s+as\s+/);
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (exportedName !== "default") exportedNames.add(exportedName);
    }
  }

  if (access.resolveModule) {
    const starExportPattern = /\bexport\s*\*\s*from\s*(["'])/g;
    for (const match of source.matchAll(starExportPattern)) {
      if (!topLevelOffsets[match.index ?? 0]) continue;
      const quoteIndex = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
      const specifier = readStringLiteral(rawSource, quoteIndex);
      if (!specifier) continue;
      const resolved = await access.resolveModule(specifier, file);
      if (!resolved) continue;
      const nested = await detectApiExportsStatic(resolved, access, seen);
      for (const method of nested.methods) exportedNames.add(method);
      // `export *` deliberately does not forward a default export.
    }
  }

  return {
    hasDefaultHandler,
    methods: API_METHOD_ORDER.filter((method) => exportedNames.has(method)),
  };
}

export async function detectApiMethods(
  file: string,
  access: AppGraphModuleAccess,
): Promise<HttpMethod[]> {
  return (await detectApiExports(file, access)).methods;
}
