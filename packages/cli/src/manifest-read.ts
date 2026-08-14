import { extractDefineAppObjectBody, scanTopLevelProperties } from "@pracht/capabilities/static";
import { findMatchingDelimiter, maskComments } from "./manifest-source.js";

export interface ManifestRegistryEntry {
  name: string;
  path: string;
}

export function extractRegistryEntries(source: string, key: string): ManifestRegistryEntry[] {
  // Mask comments BEFORE locating the block so a block-commented example
  // (`/* capabilities: { ... } */`) cannot be selected instead of the live
  // registry, and commented-out registrations inside the live block are not
  // treated as registered (mirrors the analyzer in @pracht/capabilities).
  // Masking preserves offsets, so slicing the masked source is safe.
  const appBody = extractDefineAppObjectBody(source);
  if (!appBody) return [];
  const value = scanTopLevelProperties(appBody).get(key);
  if (!value) return [];
  const openIndex = value.search(/\S/);
  if (openIndex === -1 || value[openIndex] !== "{") return [];
  const closeIndex = findMatchingDelimiter(value, openIndex, "{", "}");
  const inner = maskComments(value.slice(openIndex + 1, closeIndex));
  const entries: ManifestRegistryEntry[] = [];
  // Keys may be bare identifiers (shells, middleware) or quoted strings —
  // capability names like "notes.search" require quoting.
  const pattern =
    /(?:(["'])([^"'\n]+)\1|([A-Za-z0-9_-]+))\s*:\s*(?:(["'`])([^"'`]+)\4|\(\)\s*=>\s*import\(\s*(["'`])([^"'`]+)\6\s*\))/g;

  for (const match of inner.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], path: match[5] ?? match[7] });
  }

  return entries;
}

export function extractRelativeModulePaths(source: string): Set<string> {
  const results = new Set<string>();
  for (const match of source.matchAll(/["'`]((?:\.\.\/|\.\/)[^"'`]+)["'`]/g)) {
    results.add(match[1]);
  }
  return results;
}
