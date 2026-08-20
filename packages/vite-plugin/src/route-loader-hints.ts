import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { parse as parseModule } from "@babel/parser";
import { maskCommentsAndStrings } from "@pracht/capabilities/static";
import { initSync, parse } from "es-module-lexer";

import {
  DEFAULT_ROUTE_EXTENSIONS,
  normalizeAdditionalExtensions,
  withAdditionalExtensions,
} from "./route-extensions.ts";

initSync();

const HEAD_DECLARATION_RE = /export\s+(?:async\s+)?(?:function|const|let|var)\s+head\b/;
const EXPORT_BLOCK_RE = /export\s*\{([^}]*)\}\s*(?:from\s*["'][^"']+["'])?/g;
const EXPORT_ALL_RE = /export\s+\*\s+from\b/;
const EXPORT_VARIABLE_DECLARATION_RE = /export\s+(?:const|let|var)\b/g;

function isExportAllStatement(source: string): boolean {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, " ");
  return /^\s*export\s*\*/.test(withoutComments);
}

function exportedVariableDeclarationIncludesLoader(source: string): boolean {
  for (const declaration of source.matchAll(/\bexport\s+(?:const|let|var)\b/g)) {
    let index = (declaration.index ?? 0) + declaration[0].length;

    while (index < source.length) {
      while (/\s/.test(source[index] ?? "")) index += 1;

      const bindingStart = index;
      const opening = source[index];
      if (opening === "{" || opening === "[") {
        const closing = opening === "{" ? "}" : "]";
        let depth = 0;
        do {
          const char = source[index++];
          if (char === opening) depth += 1;
          if (char === closing) depth -= 1;
        } while (index < source.length && depth > 0);

        // Keep destructuring fail-closed. The lexer reports property keys
        // instead of local bindings for shapes such as `{ value: loader }`.
        if (/\bloader\b/.test(source.slice(bindingStart, index))) return true;
      } else {
        const binding = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
        if (!binding) break;
        if (binding[0] === "loader") return true;
        index += binding[0].length;
      }

      // Skip the type and initializer without treating identifiers inside
      // JSX props, objects, calls, or other nested expressions as bindings.
      // A top-level comma begins the next exported declarator.
      let parentheses = 0;
      let brackets = 0;
      let braces = 0;
      for (; index < source.length; index += 1) {
        const char = source[index];
        if (char === "(") parentheses += 1;
        else if (char === ")") parentheses = Math.max(0, parentheses - 1);
        else if (char === "[") brackets += 1;
        else if (char === "]") brackets = Math.max(0, brackets - 1);
        else if (char === "{") braces += 1;
        else if (char === "}") braces = Math.max(0, braces - 1);

        if (parentheses === 0 && brackets === 0 && braces === 0) {
          if (char === ";") break;
          if (char === ",") {
            index += 1;
            break;
          }
        }
      }

      if (source[index] === ";" || index >= source.length) break;
    }
  }

  return false;
}

function detectLoaderExportFallback(source: string): boolean {
  const masked = maskCommentsAndStrings(source);
  if (/\bexport\s+(?:async\s+)?function\s+loader\b/.test(masked)) return true;
  if (exportedVariableDeclarationIncludesLoader(masked)) return true;
  if (/\bexport\s*\*/.test(masked)) return true;

  for (const match of masked.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const hasLoader = match[1]
      .split(",")
      .map((specifier) => specifier.trim())
      .filter(Boolean)
      .some((specifier) => {
        const names = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
          specifier,
        );
        if (!names || specifier.startsWith("type ")) return false;
        return (names[2] ?? names[1]) === "loader";
      });
    if (hasLoader) return true;
  }

  return false;
}

function topLevelAssignmentIndex(source: string): number {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets = Math.max(0, brackets - 1);
    else if (char === "{") braces += 1;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "=" && parentheses === 0 && brackets === 0 && braces === 0) return index;
  }
  return -1;
}

function bindingExportsName(source: string, exportName: string): boolean {
  const assignmentIndex = topLevelAssignmentIndex(source);
  const binding = assignmentIndex === -1 ? source : source.slice(0, assignmentIndex);
  return new RegExp(`\\b${exportName}\\b`).test(binding);
}

function variableDeclarationExports(source: string, exportName: string): boolean {
  for (const match of source.matchAll(EXPORT_VARIABLE_DECLARATION_RE)) {
    let declarationStart = (match.index ?? 0) + match[0].length;
    let parentheses = 0;
    let brackets = 0;
    let braces = 0;
    for (let index = declarationStart; index <= source.length; index += 1) {
      const char = source[index];
      if (char === "(") parentheses += 1;
      else if (char === ")") parentheses = Math.max(0, parentheses - 1);
      else if (char === "[") brackets += 1;
      else if (char === "]") brackets = Math.max(0, brackets - 1);
      else if (char === "{") braces += 1;
      else if (char === "}") braces = Math.max(0, braces - 1);

      const atTopLevel = parentheses === 0 && brackets === 0 && braces === 0;
      if (atTopLevel && (char === "," || char === ";" || char === undefined)) {
        if (bindingExportsName(source.slice(declarationStart, index), exportName)) return true;
        if (char !== ",") break;
        declarationStart = index + 1;
      }
    }
  }
  return false;
}

function exportSpecifiersInclude(specifiers: string, exportName: string): boolean {
  return specifiers
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean)
    .some((specifier) => {
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(specifier);
      if (!match) return false;
      const [, localName, exportedName] = match;
      return (exportedName ?? localName) === exportName;
    });
}

export function detectHeadExport(source: string): boolean {
  // Markdown and MDX transforms can synthesize a head export from frontmatter.
  // Keep them conservative even when the raw source has no JS declaration.
  const analysisSource = maskCommentsAndStrings(source);
  if (
    HEAD_DECLARATION_RE.test(analysisSource) ||
    variableDeclarationExports(analysisSource, "head")
  ) {
    return true;
  }
  for (const match of analysisSource.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersInclude(match[1], "head")) return true;
  }
  return EXPORT_ALL_RE.test(analysisSource);
}

interface SyntaxNode {
  [key: string]: unknown;
  type: string;
}

function isSyntaxNode(value: unknown): value is SyntaxNode {
  return (
    typeof value === "object" && value !== null && typeof (value as SyntaxNode).type === "string"
  );
}

function bindingIncludesLoader(node: unknown): boolean {
  if (!isSyntaxNode(node)) return false;
  if (node.type === "Identifier") return node.name === "loader";
  if (node.type === "AssignmentPattern") return bindingIncludesLoader(node.left);
  if (node.type === "RestElement") return bindingIncludesLoader(node.argument);
  if (node.type === "ArrayPattern") {
    return Array.isArray(node.elements) && node.elements.some(bindingIncludesLoader);
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        if (!isSyntaxNode(property)) return false;
        return property.type === "RestElement"
          ? bindingIncludesLoader(property.argument)
          : bindingIncludesLoader(property.value);
      })
    );
  }
  return false;
}

function exportedNameIsLoader(node: unknown): boolean {
  if (!isSyntaxNode(node)) return false;
  if (node.type === "Identifier") return node.name === "loader";
  if (node.type === "StringLiteral") return node.value === "loader";
  return false;
}

function inspectParsedModule(source: string): boolean | undefined {
  for (const plugins of [["typescript", "jsx"], ["typescript"]] as const) {
    let body: SyntaxNode[];
    try {
      const parsed = parseModule(source, {
        plugins: [...plugins],
        sourceType: "module",
      }) as unknown as { program: { body: SyntaxNode[] } };
      body = parsed.program.body;
    } catch {
      continue;
    }

    for (const statement of body) {
      if (statement.type === "ExportAllDeclaration") {
        if (statement.exportKind !== "type") return true;
        continue;
      }
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

      if (
        Array.isArray(statement.specifiers) &&
        statement.specifiers.some(
          (specifier) =>
            isSyntaxNode(specifier) &&
            specifier.exportKind !== "type" &&
            exportedNameIsLoader(specifier.exported),
        )
      ) {
        return true;
      }

      const declaration = statement.declaration;
      if (!isSyntaxNode(declaration)) continue;
      if (declaration.declare === true || declaration.type.startsWith("TS")) continue;
      if (declaration.type === "VariableDeclaration") {
        if (
          Array.isArray(declaration.declarations) &&
          declaration.declarations.some(
            (declarator) => isSyntaxNode(declarator) && bindingIncludesLoader(declarator.id),
          )
        ) {
          return true;
        }
      } else if (bindingIncludesLoader(declaration.id)) {
        return true;
      }
    }

    return false;
  }

  return undefined;
}

export function detectLoaderExport(source: string): boolean {
  // Parse ordinary TS/TSX exactly so type-only exports and identifiers in
  // generic types are not mistaken for runtime loader bindings.
  const parsedResult = inspectParsedModule(source);
  if (parsedResult !== undefined) return parsedResult;

  try {
    const [imports, exports] = parse(source);
    if (exports.some((entry) => entry.n === "loader")) return true;

    // `export *` can expose a loader through a re-export. The lexer reports it
    // as an import record without a named export, so inspect only that exact
    // export statement. Ordinary imports and comments/strings mentioning a
    // loader must not turn a client-only SPA route into a false positive.
    for (const entry of imports) {
      if (entry.d === -1 && isExportAllStatement(source.slice(entry.ss, entry.se))) {
        return true;
      }
    }
  } catch {}

  // Custom route syntaxes such as TSRX may not be accepted by a standard
  // parser. Give es-module-lexer a chance first, then keep their conservative,
  // lexical fallback fail-closed.
  return detectLoaderExportFallback(source);
}

function scanRouteFiles(dir: string, files: string[], extensions: Set<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      scanRouteFiles(abs, files, extensions);
      continue;
    }

    if (extensions.has(extname(entry))) {
      files.push(abs);
    }
  }
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function createRouteLoaderHints(
  routesDir: string,
  options: {
    additionalExtensions?: readonly string[];
    appFileDir?: string;
    rootRelativePrefix?: string;
  } = {},
): Record<string, boolean> {
  const files: string[] = [];
  const hints: Record<string, boolean> = {};
  const extensions = withAdditionalExtensions(
    DEFAULT_ROUTE_EXTENSIONS,
    normalizeAdditionalExtensions(options.additionalExtensions),
  );
  scanRouteFiles(routesDir, files, extensions);

  for (const file of files) {
    const hasLoader = detectLoaderExport(readFileSync(file, "utf-8"));
    const relativeToRoutesDir = toPosixPath(relative(routesDir, file));
    const routeRootPrefix = options.rootRelativePrefix?.replace(/\/$/, "");
    const appFileDir = options.appFileDir;

    const keys = new Set<string>();
    if (appFileDir) {
      const relativeToAppFile = toPosixPath(relative(appFileDir, file));
      keys.add(relativeToAppFile.startsWith(".") ? relativeToAppFile : `./${relativeToAppFile}`);
    }
    if (routeRootPrefix) {
      keys.add(`${routeRootPrefix}/${relativeToRoutesDir}`);
    }

    for (const key of keys) {
      hints[key] = hasLoader;
    }
  }

  return hints;
}

export function createRouteHeadHints(
  routesDir: string,
  options: {
    additionalExtensions?: readonly string[];
    appFileDir?: string;
    rootRelativePrefix?: string;
  } = {},
): Record<string, boolean> {
  const files: string[] = [];
  const hints: Record<string, boolean> = {};
  const additionalExtensions = normalizeAdditionalExtensions(options.additionalExtensions);
  const extensions = withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, additionalExtensions);
  scanRouteFiles(routesDir, files, extensions);

  for (const file of files) {
    const extension = extname(file);
    const hasHead =
      extension === ".md" ||
      extension === ".mdx" ||
      // A companion Vite plugin may synthesize `head` while compiling a
      // configured format (for example, from frontmatter). Raw-source scanning
      // cannot prove such a module is headless, so keep navigation conservative.
      additionalExtensions.includes(extension) ||
      detectHeadExport(readFileSync(file, "utf-8"));
    const relativeToRoutesDir = toPosixPath(relative(routesDir, file));
    const routeRootPrefix = options.rootRelativePrefix?.replace(/\/$/, "");
    const keys = new Set<string>();
    if (options.appFileDir) {
      const relativeToAppFile = toPosixPath(relative(options.appFileDir, file));
      keys.add(relativeToAppFile.startsWith(".") ? relativeToAppFile : `./${relativeToAppFile}`);
    }
    if (routeRootPrefix) keys.add(`${routeRootPrefix}/${relativeToRoutesDir}`);
    for (const key of keys) hints[key] = hasHead;
  }

  return hints;
}
