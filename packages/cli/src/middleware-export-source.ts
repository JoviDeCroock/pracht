import { maskCommentsAndStrings } from "@pracht/capabilities/static";

/**
 * Whether a destructuring pattern binds a variable named `middleware`.
 *
 * `{ middleware }` and `[middleware]` do; `{ middleware: mw }` binds `mw`, and
 * `{ mw: middleware }` binds `middleware`. Renames are the whole point, so the
 * check reads which side of the `:` each name sits on.
 */
function bindsMiddleware(pattern: string): boolean {
  const parts = splitTopLevel(pattern.slice(1, -1));

  if (pattern.startsWith("[")) {
    return parts.some((element) => bindsName(element));
  }

  return parts.some((property) => {
    const separator = topLevelIndexOf(property, ":");
    // `{ auth: { middleware } }` binds `middleware`; `{ middleware: { inner } }`
    // does not. Only the value side can bind, so only it is inspected.
    return bindsName(separator === -1 ? property : property.slice(separator + 1));
  });
}

function bindsName(text: string): boolean {
  const bound = text
    .trim()
    .replace(/^\.\.\./, "")
    .replace(/\s*=.*$/, "")
    .trim();
  if (bound.startsWith("{") || bound.startsWith("[")) return bindsMiddleware(bound);
  return bound === "middleware";
}

/** Split on commas that are not inside a nested `{}` / `[]` / `()`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Index of the first `needle` at nesting depth 0, or -1. */
function topLevelIndexOf(text: string, needle: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === needle && depth === 0) return index;
  }
  return -1;
}

/**
 * Every destructuring pattern in an `export const|let|var` declaration.
 *
 * Scanned with a delimiter counter rather than a regex: a non-greedy match
 * stops at the first `}`, truncating a nested pattern
 * (`{ auth: { middleware } }`), and the optional type annotation between the
 * pattern and `=` is easier to skip explicitly than to express.
 */
function destructuredExportPatterns(code: string): string[] {
  const patterns: string[] = [];

  for (const match of code.matchAll(/export\s+(?:const|let|var)\s*(?=[{[])/g)) {
    const open = (match.index ?? 0) + match[0].length;
    const close = matchingDelimiter(code, open);
    if (close === -1) continue;

    // Skip an optional `: Type` annotation, then require the `=` that makes
    // this a declaration.
    if (!/^\s*(?::[^=]*)?=/.test(code.slice(close + 1))) continue;

    patterns.push(code.slice(open, close + 1));
  }

  return patterns;
}

/** Index of the delimiter closing the one at `open`, or -1. */
function matchingDelimiter(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Whether `source` exports a binding *named* `middleware`.
 *
 * Comments and string literals are masked first, and the `export { … }` clause
 * is read for the exported name rather than pattern-matched: `export
 * { middleware as default }` mentions the word but exports nothing called
 * `middleware`, and that is exactly the mistake this check exists to catch.
 * A re-export (`export * from`) is treated as a match because its names cannot
 * be known without resolving the other module — better to miss one than to
 * fail a working app.
 */
export function exportsMiddleware(source: string): boolean {
  const code = maskCommentsAndStrings(source);

  // export const/let/var/function/async function middleware
  if (/export\s+(?:async\s+)?(?:function|const|let|var)\s+middleware\b/.test(code)) return true;

  // export const { middleware } = …  /  export const [middleware] = …
  // The *bound* name has to be `middleware`: `{ middleware: mw }` binds `mw`
  // and exports nothing called `middleware`, the same trap as
  // `export { middleware as default }`.
  for (const pattern of destructuredExportPatterns(code)) {
    if (bindsMiddleware(pattern)) return true;
  }

  // Names cannot be resolved without the other module; assume the best.
  if (/export\s*\*\s*from/.test(code)) return true;

  for (const clause of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const specifier of clause[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts.length === 0 || parts[0] === "") continue;
      // `a as b` exports `b`; a bare `a` exports `a`.
      const exported = (parts.length > 1 ? parts[parts.length - 1] : parts[0]).trim();
      if (exported === "middleware") return true;
    }
  }

  return false;
}
