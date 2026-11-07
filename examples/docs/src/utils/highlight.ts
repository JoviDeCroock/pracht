/**
 * Build-time syntax highlighter shared by the Markdown compiler (`content.ts`)
 * and the homepage's `<CodeBlock>`. One left-to-right pass per language, so a
 * span is never wrapped twice.
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
  "satisfies",
]);

const SHELL = new Set(["sh", "bash", "shell", "console", "zsh"]);
const PLAIN = new Set(["", "text", "txt", "http", "dotenv", "sql", "toml", "yaml", "html", "css"]);
const JSON_LANGS = new Set(["json", "jsonc"]);

/** Human label for a fence language, shown in the code block header. */
export function languageLabel(lang: string): string {
  switch (lang) {
    case "ts":
      return "TypeScript";
    case "tsx":
      return "TSX";
    case "js":
      return "JavaScript";
    case "jsx":
      return "JSX";
    case "json":
    case "jsonc":
      return "JSON";
    case "sh":
    case "bash":
    case "shell":
    case "zsh":
    case "console":
      return "Terminal";
    case "css":
      return "CSS";
    case "html":
      return "HTML";
    case "sql":
      return "SQL";
    case "toml":
      return "TOML";
    case "yaml":
      return "YAML";
    case "http":
      return "HTTP";
    case "dotenv":
      return ".env";
    default:
      return "";
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Length of the quoted string starting at `i`, honouring backslash escapes. */
function stringEnd(code: string, i: number): number {
  const q = code[i];
  let j = i + 1;
  while (j < code.length) {
    if (code[j] === "\\" && j + 1 < code.length) {
      j += 2;
      continue;
    }
    if (code[j] === q) return j + 1;
    if (q !== "`" && code[j] === "\n") return j;
    j++;
  }
  return j;
}

function highlightShell(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("#")) return `<span class="cmt">${esc(line)}</span>`;
      const out: string[] = [];
      let i = 0;
      // The command word: first token of the line, after an optional `$ ` prompt.
      const prompt = /^(\s*\$\s+)/.exec(line);
      if (prompt) {
        out.push(`<span class="cmt">${esc(prompt[1])}</span>`);
        i = prompt[1].length;
      }
      const command = /^[\w@./-]+/.exec(line.slice(i));
      if (command) {
        out.push(`<span class="fn">${esc(command[0])}</span>`);
        i += command[0].length;
      }
      while (i < line.length) {
        const ch = line[i];
        if (ch === '"' || ch === "'") {
          const end = stringEnd(line, i);
          out.push(`<span class="str">${esc(line.slice(i, end))}</span>`);
          i = end;
          continue;
        }
        if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
          out.push(`<span class="cmt">${esc(line.slice(i))}</span>`);
          break;
        }
        if (ch === "-" && (i === 0 || /\s/.test(line[i - 1]))) {
          const flag = /^--?[\w-]+/.exec(line.slice(i));
          if (flag) {
            out.push(`<span class="kw">${esc(flag[0])}</span>`);
            i += flag[0].length;
            continue;
          }
        }
        out.push(esc(ch));
        i++;
      }
      return out.join("");
    })
    .join("\n");
}

function highlightJson(code: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < code.length) {
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }
    if (code[i] === '"') {
      const end = stringEnd(code, i);
      const isKey = /^\s*:/.test(code.slice(end));
      out.push(`<span class="${isKey ? "prop" : "str"}">${esc(code.slice(i, end))}</span>`);
      i = end;
      continue;
    }
    const literal = /^(true|false|null|-?\d[\d.eE+-]*)/.exec(code.slice(i));
    if (literal && (i === 0 || !/[\w$]/.test(code[i - 1]))) {
      out.push(`<span class="num">${esc(literal[0])}</span>`);
      i += literal[0].length;
      continue;
    }
    out.push(esc(code[i]));
    i++;
  }
  return out.join("");
}

function highlightScript(code: string): string {
  const out: string[] = [];
  let i = 0;
  const n = code.length;

  while (i < n) {
    // Line comment.
    if (code[i] === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }

    // Block comment.
    if (code[i] === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      const slice = end === -1 ? code.slice(i) : code.slice(i, end + 2);
      out.push(`<span class="cmt">${esc(slice)}</span>`);
      i += slice.length;
      continue;
    }

    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const end = stringEnd(code, i);
      out.push(`<span class="str">${esc(code.slice(i, end))}</span>`);
      i = end;
      continue;
    }

    if (/[a-zA-Z_$]/.test(code[i])) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_$]/.test(code[j])) j++;
      const word = code.slice(i, j);
      if (KEYWORDS.has(word)) {
        out.push(`<span class="kw">${esc(word)}</span>`);
      } else if (/^[A-Z]/.test(word)) {
        out.push(`<span class="typ">${esc(word)}</span>`);
      } else if (code[j] === "(") {
        out.push(`<span class="fn">${esc(word)}</span>`);
      } else {
        out.push(esc(word));
      }
      i = j;
      continue;
    }

    if (/[0-9]/.test(code[i]) && (i === 0 || !/[\w$]/.test(code[i - 1]))) {
      let j = i;
      while (j < n && /[0-9._]/.test(code[j])) j++;
      out.push(`<span class="num">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    out.push(esc(code[i]));
    i++;
  }

  return out.join("");
}

/** Highlight `code` written in `lang` (a Markdown fence language) to HTML. */
export function highlight(code: string, lang = "ts"): string {
  const language = lang.toLowerCase();
  if (SHELL.has(language)) return highlightShell(code);
  if (JSON_LANGS.has(language)) return highlightJson(code);
  if (PLAIN.has(language)) return esc(code);
  return highlightScript(code);
}
