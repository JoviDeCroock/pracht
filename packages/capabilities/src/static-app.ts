import { braceDepthAt, findCallInitializer } from "./static-module-binding.ts";
import { scanTopLevelProperties } from "./static-object.ts";
import {
  findMatchingBrace,
  maskComments,
  maskCommentsAndStrings,
  skipInsignificant,
} from "./static-source-lexical.ts";

/** Parse the `capabilities: { ... }` block of an exported app manifest. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  const appBody = extractDefineAppObjectBody(manifestSource);
  if (!appBody) return [];
  const capabilitiesValue = scanTopLevelProperties(appBody).get("capabilities");
  if (!capabilitiesValue) return [];
  const braceStart = skipInsignificant(capabilitiesValue, 0);
  if (capabilitiesValue[braceStart] !== "{") return [];
  const braceEnd = findMatchingBrace(capabilitiesValue, braceStart, "{", "}");
  if (braceEnd === -1) return [];
  const block = capabilitiesValue.slice(braceStart + 1, braceEnd);
  const searchableBlock = maskComments(block);

  const entries: { name: string; file: string }[] = [];
  // Keys are usually quoted ("notes.search"); values are either lazy import
  // functions or plain string paths (post-transform form).
  const pattern =
    /(?:(["'])((?:\\.|(?!\1).)+)\1|([A-Za-z0-9_$]+))\s*:\s*(?:\(\)\s*=>\s*import\(\s*(["'])([^"']+)\4\s*\)|(["'])([^"']+)\6)/g;
  for (const match of searchableBlock.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], file: match[5] ?? match[7] });
  }
  return entries;
}

/** Extract the inline object body passed to the exported app's `defineApp()`. */
export function extractDefineAppObjectBody(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const defaultExport = /export\s+default\s+defineApp\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  let parenIndex =
    defaultExport?.index != null ? defaultExport.index + defaultExport[0].length - 1 : -1;

  if (parenIndex === -1) {
    const declaration = /export\s+(?:const|let|var)\s+app\b/g;
    for (const match of searchable.matchAll(declaration)) {
      if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
      parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
      if (parenIndex !== -1) break;
    }
  }

  if (parenIndex === -1) {
    const localName = namedAppExportLocalName(searchable);
    if (localName) {
      const identifier = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\b`, "g");
      for (const match of searchable.matchAll(declaration)) {
        if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
        parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
        if (parenIndex !== -1) break;
      }
    }
  }

  if (parenIndex === -1) return null;
  const braceStart = skipInsignificant(source, parenIndex + 1);
  if (source[braceStart] !== "{") return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  return braceEnd === -1 ? null : source.slice(braceStart + 1, braceEnd);
}

function namedAppExportLocalName(searchable: string): string | null {
  const aliased = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+app\b/.exec(searchable);
  if (aliased) return aliased[1];
  return /export\s*\{[^}]*?\bapp\b(?:\s*,|\s*\})/.test(searchable) ? "app" : null;
}
