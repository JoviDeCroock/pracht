/**
 * Minimal but correct tokenizer-based syntax highlighter for TypeScript/TSX.
 * Processes tokens left-to-right so spans are never double-wrapped.
 */

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "as",
  "default",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "return",
  "type",
  "interface",
  "class",
  "extends",
  "implements",
  "new",
  "if",
  "else",
  "for",
  "while",
  "of",
  "in",
  "break",
  "continue",
  "throw",
  "try",
  "catch",
  "finally",
  "null",
  "undefined",
  "true",
  "false",
  "void",
  "typeof",
  "instanceof",
  "keyof",
]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlight(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    // ── Line comment //
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // ── Block comment /* ... */
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // ── Strings: " ' `
    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const q = code[i];
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (code[j] === q) {
          j++;
          break;
        }
        j++;
      }
      out.push(`<span class="str">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // ── Word: identifier, keyword, or type
    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        out.push(`<span class="kw">${esc(word)}</span>`);
      } else if (/^[A-Z]/.test(word)) {
        // Capitalized → type/constructor
        out.push(`<span class="typ">${esc(word)}</span>`);
      } else {
        out.push(esc(word));
      }
      i = j;
      continue;
    }

    // ── Number
    if (/[0-9]/.test(code[i])) {
      let j = i;
      while (j < n && /[0-9._]/.test(code[j])) j++;
      out.push(`<span class="num">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // ── Punctuation / operators / whitespace — pass through
    out.push(esc(code[i]));
    i++;
  }

  return out.join("");
}
