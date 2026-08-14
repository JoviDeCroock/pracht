/**
 * Replace `//` line and block comments with spaces, leaving string/template
 * contents untouched so a `//` inside a path is not mistaken for a comment.
 * Length is preserved so callers can still slice by original offsets.
 */
export function maskComments(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      result += char;
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        result += inner;
        index += 1;
        if (inner === "\\") {
          if (index < source.length) {
            result += source[index];
            index += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        result += "  ";
        index += 2;
      }
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

export function findMatchingDelimiter(
  source: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quoteChar: string | null = null;
  let escaping = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const current = source[index];
    if (quoteChar) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (current === "\\") {
        escaping = true;
        continue;
      }
      if (current === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (current === '"' || current === "'" || current === "`") {
      quoteChar = current;
      continue;
    }
    if (current === openChar) depth += 1;
    if (current === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`Could not find matching ${closeChar} for ${openChar}.`);
}
