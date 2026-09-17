/**
 * Comparison of a generated file against what the generator would write now,
 * ignoring differences no formatter is allowed to change meaning with.
 *
 * `pracht typegen` writes `src/pracht.d.ts` and `src/pracht-routes.ts` in one
 * fixed style. A project with a formatter reformats them on the next commit,
 * and a byte-for-byte check then reports them as stale forever: running
 * `pracht typegen` fixes the check and un-formats the files, and the formatter
 * undoes that again on the next commit. Comparing token streams instead makes
 * `--check` mean "are these declarations stale", which is the question CI is
 * actually asking.
 *
 * Quoting, semicolons, trailing commas, indentation and line breaks are the
 * formatter's business and are normalized away. Everything a reader would call
 * content — identifiers, string values, and the JSDoc carried over from a
 * capability's `title`/`description` — still has to match.
 */
export function generatedSourceMatches(existing: string, generated: string): boolean {
  if (existing === generated) return true;

  const existingTokens = tokenize(existing);
  const generatedTokens = tokenize(generated);
  if (existingTokens.length !== generatedTokens.length) return false;
  return existingTokens.every((token, index) => token === generatedTokens[index]);
}

/**
 * A deliberately small lexer: enough to keep strings and comments whole, and
 * to treat everything else as runs of word characters and single punctuation
 * marks. The generated files contain no regex literals or template
 * interpolation, so the two constructs a real TypeScript lexer needs context
 * for cannot appear.
 */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (WHITESPACE.test(char)) {
      index++;
      continue;
    }

    // Semicolons and commas are punctuation a formatter adds and removes
    // (`semi: false`, trailing-comma style) without changing a declaration.
    if (char === ";" || char === ",") {
      index++;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      tokens.push(`//${normalizeComment(source.slice(index + 2, stop))}`);
      index = stop;
      continue;
    }

    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const body = source.slice(index + 2, end === -1 ? source.length : end);
      tokens.push(`/*${normalizeComment(body)}`);
      index = end === -1 ? source.length : end + 2;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      const string = readString(source, index);
      tokens.push(`s${JSON.stringify(string.value)}`);
      index = string.next;
      continue;
    }

    if (WORD.test(char)) {
      let end = index + 1;
      while (end < source.length && WORD.test(source[end])) end++;
      tokens.push(source.slice(index, end));
      index = end;
      continue;
    }

    tokens.push(char);
    index++;
  }

  return tokens;
}

const WHITESPACE = /\s/;
const WORD = /[A-Za-z0-9_$]/;

/**
 * Comment text with the decoration a formatter owns removed: per-line indent
 * and the leading `*` of a block comment, then whitespace collapsed. The prose
 * itself is content — a capability's `description` reaches the generated types
 * as JSDoc and nowhere else — so it is compared, not dropped.
 */
function normalizeComment(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*?[\t ]?/, "").trimEnd())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The string's value, so `'a'` and `"a"` compare equal. */
function readString(source: string, start: number): { value: string; next: number } {
  const quote = source[start];
  let value = "";
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      value += unescape(source[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (char === quote) {
      return { value, next: index + 1 };
    }
    value += char;
    index++;
  }

  // Unterminated: keep what is there rather than throwing. A malformed
  // generated file must report as stale, not crash the check.
  return { value, next: source.length };
}

const ESCAPES: Record<string, string> = {
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "0": "\0",
};

function unescape(char: string): string {
  return ESCAPES[char] ?? char;
}
