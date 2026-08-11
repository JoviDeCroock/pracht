import { extractDefineAppObjectBody, scanTopLevelProperties } from "@pracht/capabilities/static";

export function ensureCoreNamedImport(source: string, name: string): string {
  const match = source.match(/import\s*\{([^}]+)\}\s*from\s*["']@pracht\/core["'];?/);
  if (!match) {
    return `import { ${name} } from "@pracht/core";\n${source}`;
  }

  const names = match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  // Already imported: leave the statement byte-for-byte alone. Rewriting it
  // would reflow a multi-line import the author never touched, so every
  // `pracht generate` produced an unrelated diff hunk.
  if (names.includes(name)) return source;

  // Appended, not sorted: re-ordering an existing list would reintroduce the
  // unrelated diff hunk this function exists to avoid, just on the other path.
  names.push(name);

  // Preserve the author's single-line vs multi-line shape.
  const replacement = match[0].includes("\n")
    ? `import {\n${names.map((item) => `  ${item},`).join("\n")}\n} from "@pracht/core";`
    : `import { ${names.join(", ")} } from "@pracht/core";`;

  return source.replace(match[0], replacement);
}

export function upsertObjectEntry(source: string, key: string, entry: string): string {
  const property = findNamedBlock(source, key, "{", "}");
  if (!property) {
    const routesMatch = source.match(/^(\s*)routes\s*:/m);
    if (!routesMatch || routesMatch.index == null) {
      throw new Error(`Could not find a "${key}" or "routes" block in the app manifest.`);
    }

    const indent = routesMatch[1];
    const block = `${indent}${key}: {\n${indent}  ${entry},\n${indent}},\n`;
    return `${source.slice(0, routesMatch.index)}${block}${source.slice(routesMatch.index)}`;
  }

  return insertBlockEntry(source, property, entry);
}

export function insertArrayItem(source: string, key: string, item: string): string {
  const property = findNamedBlock(source, key, "[", "]");
  if (!property) {
    throw new Error(`Could not find "${key}" in the app manifest.`);
  }

  return insertBlockEntry(source, property, item);
}

export function toManifestModulePath(manifestPath: string, targetFilePath: string): string {
  const relativePath = targetFilePath
    .replaceAll("\\", "/")
    .replace(manifestPath.replaceAll("\\", "/").replace(/\/[^/]+$/, ""), "")
    .replace(/^\//, "");

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

/**
 * Replace `//` line and block comments with spaces, leaving string/template
 * contents untouched so a `//` inside a path is not mistaken for a comment.
 * Length is preserved so callers can still slice by original offsets.
 */
function maskComments(source: string): string {
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

export function extractRegistryEntries(
  source: string,
  key: string,
): { name: string; path: string }[] {
  // Mask comments BEFORE locating the block so a block-commented example
  // (`/* capabilities: { ... } */`) cannot be selected instead of the live
  // registry, and commented-out registrations inside the live block are not
  // treated as registered (mirrors the analyzer in @pracht/capabilities).
  // Masking preserves offsets, so slicing the masked source is safe.
  const appBody = extractDefineAppObjectBody(source);
  if (!appBody) return [];
  const value = scanTopLevelProperties(appBody).get(key);
  if (!value) return [];
  const openIndex = value.search(/\S/);
  if (openIndex === -1 || value[openIndex] !== "{") return [];
  const closeIndex = findMatchingDelimiter(value, openIndex, "{", "}");
  const inner = maskComments(value.slice(openIndex + 1, closeIndex));
  const entries: { name: string; path: string }[] = [];
  // Keys may be bare identifiers (shells, middleware) or quoted strings —
  // capability names like "notes.search" require quoting.
  const pattern =
    /(?:(["'])([^"'\n]+)\1|([A-Za-z0-9_-]+))\s*:\s*(?:(["'`])([^"'`]+)\4|\(\)\s*=>\s*import\(\s*(["'`])([^"'`]+)\6\s*\))/g;

  for (const match of inner.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], path: match[5] ?? match[7] });
  }

  return entries;
}

export function extractRelativeModulePaths(source: string): Set<string> {
  const results = new Set<string>();
  for (const match of source.matchAll(/["'`]((?:\.\.\/|\.\/)[^"'`]+)["'`]/g)) {
    results.add(match[1]);
  }
  return results;
}

interface BlockLocation {
  closeIndex: number;
  indent: string;
  openIndex: number;
}

/**
 * Append `entry` as the last member of an object/array block.
 *
 * The output has to be canonically formatted: `pracht generate` advertises
 * machine-made wiring, and an app with a formatter check in CI should not have
 * to reformat after every scaffold. Two details matter — the block's existing
 * content ends with the newline and indentation that precede the closing
 * delimiter (reusing it verbatim leaves a blank line with trailing
 * whitespace), and the new entry needs its own trailing comma to match the
 * entries around it.
 */
function insertBlockEntry(source: string, block: BlockLocation, entry: string): string {
  const inner = source.slice(block.openIndex + 1, block.closeIndex);
  const closingIndent = block.indent;
  const childIndent = `${closingIndent}  `;
  const item = `${indentMultiline(entry.replace(/,\s*$/, ""), childIndent)},`;
  const before = source.slice(0, block.openIndex + 1);
  const after = source.slice(block.closeIndex);

  if (!inner.trim()) {
    return `${before}\n${item}\n${closingIndent}${after}`;
  }

  // The separating comma has to land after the last piece of *code*, not after
  // the last non-whitespace character: when the previous entry carries a
  // trailing `// comment`, appending there writes the comma inside the comment
  // and the two entries end up with no separator at all — a syntax error that
  // `pracht generate` would report as success. Masking preserves offsets, so
  // the index found in the masked copy is valid in the original.
  const masked = maskComments(inner);
  const codeLength = masked.trimEnd().length;
  const code = masked.slice(0, codeLength);
  const needsComma = codeLength > 0 && !/[,[{(]$/.test(code);

  // Everything after the last code character (a trailing comment, say) is kept
  // on its own line, minus the whitespace that ran up to the closing delimiter.
  const trailing = inner.slice(codeLength).trimEnd();

  return `${before}${inner.slice(0, codeLength)}${needsComma ? "," : ""}${trailing}\n${item}\n${closingIndent}${after}`;
}

function findNamedBlock(
  source: string,
  key: string,
  openChar: string,
  closeChar: string,
): BlockLocation | null {
  const pattern = new RegExp(`^([ \\t]*)${key}\\s*:\\s*\\${openChar}`, "m");
  const match = source.match(pattern);
  if (!match || match.index == null) {
    return null;
  }

  const openIndex = source.indexOf(openChar, match.index);
  // Scan a comment-masked copy. `findMatchingDelimiter` tracks quotes but not
  // comments, so an apostrophe in `// don't` opened a phantom string that
  // swallowed the rest of the file, and a stray `]` inside a comment closed the
  // block early — producing broken source with exit 0. Masking preserves
  // offsets, so the index it returns is valid in the original.
  const closeIndex = findMatchingDelimiter(maskComments(source), openIndex, openChar, closeChar);
  return {
    closeIndex,
    indent: match[1],
    openIndex,
  };
}

function findMatchingDelimiter(
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

function indentMultiline(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}
