/**
 * Files that live in a pracht-owned directory without being app modules: type
 * declarations, colocated tests, and test mocks.
 *
 * Every directory pracht discovers modules in — routes, shells, API routes,
 * middleware, server modules, capabilities, islands, the pages router — skips
 * them, so `src/api/health.test.ts` stays a test instead of becoming the API
 * route `/api/health.test`, and no test runner is bundled into the server or
 * the browser.
 */
const NON_MODULE_GLOBS = ["**/*.d.ts", "**/*.{test,spec}.*", "**/__tests__/**", "**/__mocks__/**"];

const NON_MODULE_DIRECTORY_NAMES = new Set(["__tests__", "__mocks__"]);
const NON_MODULE_FILE_RE = /\.d\.ts$|\.(?:test|spec)\.[^./\\]+$/;

/** Negated `import.meta.glob` / optimizer patterns that keep non-modules out of `directory`. */
export function nonModuleExcludes(directory: string): string[] {
  const base = directory.replace(/\/+$/, "");
  return NON_MODULE_GLOBS.map((pattern) => `!${base}/${pattern}`);
}

/** `glob` plus the patterns that keep non-modules out of `directory`. */
export function moduleGlob(directory: string, glob: string): string[] {
  return [glob, ...nonModuleExcludes(directory)];
}

/** A directory name whose whole subtree holds tests or mocks. */
export function isNonModuleDirectoryName(name: string): boolean {
  return NON_MODULE_DIRECTORY_NAMES.has(name);
}

/**
 * Whether `path`, relative to the directory being discovered, is a declaration,
 * test, or mock rather than an app module. The path must be relative: a project
 * that itself lives under a `__tests__` directory still has modules.
 */
export function isNonModuleFile(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  const name = segments.pop() ?? "";
  return NON_MODULE_FILE_RE.test(name) || segments.some(isNonModuleDirectoryName);
}
