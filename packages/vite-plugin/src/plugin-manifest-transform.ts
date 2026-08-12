import { canonicalFilePath, resolveConfigPath } from "./plugin-paths.ts";

const MANIFEST_CORE_IMPORTS = new Set(["defineApp", "group", "route", "timeRevalidate"]);

export interface AppManifestTransformOptions {
  appFile: string;
  root: string;
}

/**
 * Convert author-friendly manifest imports into the string-based runtime graph
 * and redirect manifest-only helpers to the lean package entry.
 */
export function transformAppManifestModule(
  code: string,
  id: string,
  options: AppManifestTransformOptions,
): { code: string; map: null } | null {
  const appFile = canonicalFilePath(resolveConfigPath(options.root, options.appFile));
  const moduleId = canonicalFilePath(id.split("?")[0]);
  if (moduleId !== appFile) return null;

  // Let authors keep import() expressions for IDE navigation while the runtime
  // receives stable module references that it can resolve itself.
  const withStringModuleRefs = code.replace(
    /\(\)\s*=>\s*import\(\s*(['"])([^'"]+)\1\s*\)/g,
    "$1$2$1",
  );
  const transformed = rewriteManifestCoreImports(withStringModuleRefs);
  return transformed === code ? null : { code: transformed, map: null };
}

function rewriteManifestCoreImports(code: string): string {
  return code.replace(
    /import\s+(type\s+)?\{([^}]+)\}\s+from\s+(['"])@pracht\/core\3/g,
    (match, typeKeyword: string | undefined, specifiers: string, quote: string) => {
      const valueImports = specifiers
        .split(",")
        .map((specifier) => specifier.trim())
        .filter(Boolean)
        .filter((specifier) => !specifier.startsWith("type "))
        .map((specifier) => specifier.split(/\s+as\s+/)[0]?.trim())
        .filter(Boolean);

      if (!typeKeyword && valueImports.some((specifier) => !MANIFEST_CORE_IMPORTS.has(specifier))) {
        return match;
      }

      return `import ${typeKeyword ?? ""}{${specifiers}} from ${quote}@pracht/core/manifest${quote}`;
    },
  );
}
