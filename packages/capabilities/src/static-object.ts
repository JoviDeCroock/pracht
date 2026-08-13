import {
  evaluateLiteral,
  findMatchingBrace,
  findQuotedObjectProperty,
  findStringEnd,
  maskComments,
  maskCommentsAndStrings,
  skipInsignificant,
  skipToTopLevelComma,
} from "./static-source-parser.ts";

/**
 * Result of scanning an object literal without executing its source.
 */
export interface TopLevelPropertyScan {
  properties: Map<string, string>;
  /**
   * True when the scan hit a token it could not parse as a key (a spread, a
   * computed key) and stopped. Everything from that point on is missing from
   * `properties`, so a caller must not read an absent key as "not declared".
   */
  truncated: boolean;
}

/**
 * Scan an object literal body for its top-level properties, returning a map
 * of property name to raw value text. Nested schemas never leak fields into
 * the containing capability or app contract.
 */
export function scanTopLevelProperties(objectBody: string): Map<string, string> {
  return scanTopLevelPropertyEntries(objectBody).properties;
}

export function scanTopLevelPropertyEntries(objectBody: string): TopLevelPropertyScan {
  const properties = new Map<string, string>();
  let index = 0;
  let truncated = false;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    // Property key: identifier or quoted string.
    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) {
        truncated = true;
        break;
      }
      const decoded = evaluateLiteral(objectBody.slice(index, end + 1));
      if (typeof decoded !== "string") {
        truncated = true;
        break;
      }
      key = decoded;
      index = end + 1;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) {
        truncated = true;
        break;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      // Shorthand or method definitions — skip to the next top-level comma.
      index = skipToTopLevelComma(objectBody, index) + 1;
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return { properties, truncated };
}

/** Find the raw object body for a named property in source text. */
export function findTopLevelObjectProperty(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeOnly = maskCommentsAndStrings(source);
  const commentsRemoved = maskComments(source);
  const unquotedMatch = new RegExp(`\\b${escapedKey}\\s*:\\s*\\{`).exec(codeOnly);
  const quotedIndex = findQuotedObjectProperty(source, key);
  const matchIndex = [unquotedMatch?.index, quotedIndex]
    .filter((candidate): candidate is number => candidate !== undefined && candidate !== null)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return null;
  const braceStart = commentsRemoved.indexOf("{", matchIndex);
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}
