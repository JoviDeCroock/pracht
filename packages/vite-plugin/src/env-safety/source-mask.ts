/**
 * Marks source offsets that belong to executable JavaScript rather than
 * comments, string contents, template text, or regular-expression literals.
 */
export function getCodePositionMask(code: string): Uint8Array {
  const mask = new Uint8Array(code.length);
  const templateExpressionDepths: number[] = [];
  let mode: "block-comment" | "code" | "double" | "line-comment" | "regex" | "single" | "template" =
    "code";
  let regexCharClass = false;
  let index = 0;

  while (index < code.length) {
    const char = code[index];
    const next = code[index + 1];

    if (mode === "line-comment") {
      if (char === "\n" || char === "\r") {
        mode = "code";
        mask[index] = 1;
      }
      index++;
      continue;
    }

    if (mode === "block-comment") {
      if (char === "*" && next === "/") {
        mode = "code";
        index += 2;
      } else {
        index++;
      }
      continue;
    }

    if (mode === "single" || mode === "double") {
      const quote = mode === "single" ? "'" : '"';
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === quote || char === "\n" || char === "\r") mode = "code";
      index++;
      continue;
    }

    if (mode === "regex") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") {
        regexCharClass = true;
        index++;
        continue;
      }
      if (char === "]") {
        regexCharClass = false;
        index++;
        continue;
      }
      if (char === "/" && !regexCharClass) {
        regexCharClass = false;
        index++;
        while (index < code.length && isIdentifierChar(code[index])) index++;
        mode = "code";
        continue;
      }
      if (char === "\n" || char === "\r") {
        regexCharClass = false;
        mode = "code";
      }
      index++;
      continue;
    }

    if (mode === "template") {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "`") {
        mode = "code";
        index++;
        continue;
      }
      if (char === "$" && next === "{") {
        mask[index] = 1;
        mask[index + 1] = 1;
        templateExpressionDepths.push(1);
        mode = "code";
        index += 2;
        continue;
      }
      index++;
      continue;
    }

    mask[index] = 1;

    if (char === "/" && next === "/") {
      mask[index + 1] = 1;
      mode = "line-comment";
      index += 2;
      continue;
    }

    if (char === "/" && next === "*") {
      mask[index + 1] = 1;
      mode = "block-comment";
      index += 2;
      continue;
    }

    if (char === "/" && isRegexLiteralStart(code, index)) {
      mode = "regex";
      regexCharClass = false;
      index++;
      continue;
    }

    if (char === "'") {
      mode = "single";
      index++;
      continue;
    }

    if (char === '"') {
      mode = "double";
      index++;
      continue;
    }

    if (char === "`") {
      mode = "template";
      index++;
      continue;
    }

    if (templateExpressionDepths.length > 0) {
      const top = templateExpressionDepths.length - 1;
      if (char === "{") {
        templateExpressionDepths[top]++;
      } else if (char === "}") {
        templateExpressionDepths[top]--;
        if (templateExpressionDepths[top] === 0) {
          templateExpressionDepths.pop();
          mode = "template";
        }
      }
    }

    index++;
  }

  return mask;
}

function isRegexLiteralStart(code: string, slashIndex: number): boolean {
  let index = slashIndex - 1;
  while (index >= 0 && /\s/.test(code[index])) index--;
  if (index < 0) return true;

  const previous = code[index];
  if (previous === ">" && code[index - 1] === "=") return true;
  if ("([{=,:;!?&|^~<>*%+-".includes(previous)) return true;

  if (isIdentifierChar(previous)) {
    let start = index;
    while (start >= 0 && isIdentifierChar(code[start])) start--;
    const word = code.slice(start + 1, index + 1);
    return new Set([
      "await",
      "case",
      "delete",
      "do",
      "else",
      "in",
      "instanceof",
      "new",
      "of",
      "return",
      "throw",
      "typeof",
      "void",
      "yield",
    ]).has(word);
  }

  return false;
}

function isIdentifierChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char);
}
