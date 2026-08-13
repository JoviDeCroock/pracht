/**
 * Resolve the first assignment of a variable declaration and accept it only
 * when its initializer is immediately the requested call. This avoids crossing
 * an ASI boundary into a later declaration while still supporting multiline
 * and arrow-function type annotations.
 */
export function findCallInitializer(
  searchable: string,
  start: number,
  callName: string,
  callPattern = `${callName}\\s*(?:<[^(]*?>)?\\s*\\(`,
): number {
  let depth = 0;
  for (let index = start; index < searchable.length; index += 1) {
    const char = searchable[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return -1;
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === ";") return -1;
    if (char === "\n" || char === "\r") {
      const next = searchable.slice(skipWhitespace(searchable, index + 1));
      if (/^(?:(?:export|import)\b|(?:const|let|var|function|class)\b)/.test(next)) {
        return -1;
      }
      continue;
    }
    if (
      char === "=" &&
      searchable[index + 1] !== ">" &&
      searchable[index - 1] !== "=" &&
      searchable[index - 1] !== "!" &&
      searchable[index - 1] !== "<" &&
      searchable[index - 1] !== ">"
    ) {
      const initializerStart = skipWhitespace(searchable, index + 1);
      const call = new RegExp(`^${callPattern}`).exec(searchable.slice(initializerStart));
      return call ? initializerStart + call[0].length - 1 : -1;
    }
  }
  return -1;
}

export function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/**
 * Brace/paren/bracket nesting depth at `index` in an already comment- and
 * string-masked source. Depth 0 means module scope.
 */
export function braceDepthAt(searchable: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = searchable[cursor];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
  }
  return depth;
}
