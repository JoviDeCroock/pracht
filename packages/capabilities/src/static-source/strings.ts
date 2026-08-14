/** Index of the closing quote of the string starting at `start`. */
export function findStringEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote === "`") return findTemplateEnd(source, start);
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/**
 * Index of the closing backtick of the template literal starting at `start`.
 * Tracks `${ ... }` interpolations (including nested strings and templates
 * inside them) so an inner backtick or `}` does not end the template early.
 */
function findTemplateEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
    if (char === "$" && source[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === '"' || inner === "'" || inner === "`") {
          const end = findStringEnd(source, index);
          if (end === -1) return -1;
          index = end + 1;
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        index += 1;
      }
      if (depth > 0) return -1;
      index -= 1;
    }
  }
  return -1;
}
