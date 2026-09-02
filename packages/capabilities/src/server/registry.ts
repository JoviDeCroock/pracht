/**
 * Module-registry resolution shared by the capability core and `@pracht/core`.
 *
 * Registered modules are keyed by whatever path the build emitted; lookups
 * accept root-relative, `./`-relative, and bare-suffix spellings, so one
 * canonical form resolves them all.
 */

import type { ModuleImporter } from "./types.ts";

/** Strip leading `./` and `/` so all module paths share one canonical form. */
export function normalizeModulePath(path: string): string {
  return path.replace(/^\.?\//, "");
}

function buildSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  const index = new Map<string, string>();
  for (const key of Object.keys(manifest)) {
    const normalized = normalizeModulePath(key);
    if (!normalized) continue;

    if (!index.has(normalized)) {
      index.set(normalized, key);
    }

    for (let i = normalized.indexOf("/"); i !== -1; i = normalized.indexOf("/", i + 1)) {
      const suffix = normalized.slice(i + 1);
      if (suffix && !index.has(suffix)) {
        index.set(suffix, key);
      }
    }
  }
  return index;
}

const suffixIndexCache = new WeakMap<object, Map<string, string>>();

export function getSuffixIndex<T>(manifest: Record<string, T>): Map<string, string> {
  let index = suffixIndexCache.get(manifest);
  if (index) return index;
  index = buildSuffixIndex(manifest);
  suffixIndexCache.set(manifest, index);
  return index;
}

export async function resolveRegistryModule<T>(
  modules: Record<string, ModuleImporter> | undefined,
  file: string,
): Promise<T | undefined> {
  if (!modules) return undefined;

  // Direct key match (fast path)
  if (file in modules) {
    return modules[file]() as Promise<T>;
  }

  // Indexed suffix match
  const resolved = getSuffixIndex(modules).get(normalizeModulePath(file));
  if (resolved) {
    return modules[resolved]() as Promise<T>;
  }

  return undefined;
}
