export function ensureCoreNamedImport(source: string, name: string): string {
  const match = source.match(/import\s*\{([^}]+)\}\s*from\s*["']@pracht\/core["'];?/);
  if (!match) {
    return `import { ${name} } from "@pracht/core";\n${source}`;
  }

  const names = match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!names.includes(name)) {
    names.push(name);
  }

  return source.replace(match[0], `import { ${names.join(", ")} } from "@pracht/core";`);
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

export function extractRegistryEntries(
  source: string,
  key: string,
): { name: string; path: string }[] {
  const block = findNamedBlock(source, key, "{", "}");
  if (!block) return [];
  const inner = source.slice(block.openIndex + 1, block.closeIndex);
  const entries: { name: string; path: string }[] = [];
  const pattern =
    /([A-Za-z0-9_-]+)\s*:\s*(?:(["'`])([^"'`]+)\2|\(\)\s*=>\s*import\(\s*(["'`])([^"'`]+)\4\s*\))/g;

  for (const match of inner.matchAll(pattern)) {
    entries.push({ name: match[1], path: match[3] ?? match[5] });
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

function insertBlockEntry(source: string, block: BlockLocation, entry: string): string {
  const inner = source.slice(block.openIndex + 1, block.closeIndex);
  const closingIndent = block.indent;
  const childIndent = `${closingIndent}  `;
  const trimmed = inner.trim();

  if (!trimmed) {
    return `${source.slice(0, block.openIndex + 1)}\n${indentMultiline(entry, childIndent)}\n${closingIndent}${source.slice(block.closeIndex)}`;
  }

  const needsComma = !/[,[{(]\s*$/.test(inner) && !/,\s*$/.test(trimmed);
  const insertPrefix = needsComma ? "," : "";
  return `${source.slice(0, block.closeIndex)}${insertPrefix}\n${indentMultiline(entry, childIndent)}\n${closingIndent}${source.slice(block.closeIndex)}`;
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
  const closeIndex = findMatchingDelimiter(source, openIndex, openChar, closeChar);
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
