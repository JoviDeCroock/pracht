import { findMatchingDelimiter, maskComments } from "./manifest-source.js";

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

function indentMultiline(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}
