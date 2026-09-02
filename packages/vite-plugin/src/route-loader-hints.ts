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

function namedDeclarationRe(exportName: string): RegExp {
  return new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${exportName}\\b`);
}

const HEAD_DECLARATION_RE = namedDeclarationRe("head");
const HEADERS_DECLARATION_RE = namedDeclarationRe("headers");
const STATIC_PATHS_DECLARATION_RE = namedDeclarationRe("getStaticPaths");
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

/**
 * Whether `source` exports `exportName`, via a declaration, an export block,
 * or an `export *` re-export (which could expose anything, so it counts).
 *
 * Ordinary TS/JS is parsed exactly, including string-literal export names.
 * Custom syntaxes fall back to masked lexical detection so prose or a string
 * literal mentioning the name cannot produce a false positive.
 */
function detectNamedExport(source: string, exportName: string, declarationRe: RegExp): boolean {
  const parsedResult = inspectParsedModule(source, exportName);
  if (parsedResult !== undefined) return parsedResult;

  return detectNamedExportInMasked(maskCommentsAndStrings(source), exportName, declarationRe);
}

/**
 * The lexical half of `detectNamedExport()`, over already-masked source. Every
 * hint table falls back for the same file, so the mask is computed once.
 */
function detectNamedExportInMasked(
  analysisSource: string,
  exportName: string,
  declarationRe: RegExp,
): boolean {
  if (
    declarationRe.test(analysisSource) ||
    variableDeclarationExports(analysisSource, exportName)
  ) {
    return true;
  }
  for (const match of analysisSource.matchAll(EXPORT_BLOCK_RE)) {
    if (exportSpecifiersInclude(match[1], exportName)) return true;
  }
  return EXPORT_ALL_RE.test(analysisSource);
}

export function detectHeadExport(source: string): boolean {
  // Markdown and MDX transforms can synthesize a head export from frontmatter.
  // Keep them conservative even when the raw source has no JS declaration.
  return detectNamedExport(source, "head", HEAD_DECLARATION_RE);
}

/** Whether the route or shell module exports document response headers. */
export function detectHeadersExport(source: string): boolean {
  return detectNamedExport(source, "headers", HEADERS_DECLARATION_RE);
}

/**
 * Whether the route module exports `getStaticPaths()`.
 *
 * Only a static export consumes this: it decides whether a dynamic route has
 * any prerendered path at all, and therefore whether the client should ever
 * request a route-state file for it. Unknown answers must stay `true` — the
 * cost of a wrong `true` is the request the client already makes today, while
 * a wrong `false` would drop state the build did write.
 */
export function detectStaticPathsExport(source: string): boolean {
  return detectNamedExport(source, "getStaticPaths", STATIC_PATHS_DECLARATION_RE);
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

function bindingIncludesName(node: unknown, exportName: string): boolean {
  if (!isSyntaxNode(node)) return false;
  if (node.type === "Identifier") return node.name === exportName;
  if (node.type === "AssignmentPattern") return bindingIncludesName(node.left, exportName);
  if (node.type === "RestElement") return bindingIncludesName(node.argument, exportName);
  if (node.type === "ArrayPattern") {
    return (
      Array.isArray(node.elements) &&
      node.elements.some((element) => bindingIncludesName(element, exportName))
    );
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        if (!isSyntaxNode(property)) return false;
        return property.type === "RestElement"
          ? bindingIncludesName(property.argument, exportName)
          : bindingIncludesName(property.value, exportName);
      })
    );
  }
  return false;
}

function exportedNameMatches(node: unknown, exportName: string): boolean {
  if (!isSyntaxNode(node)) return false;
  if (node.type === "Identifier") return node.name === exportName;
  if (node.type === "StringLiteral") return node.value === exportName;
  return false;
}

/**
 * Which of `exportNames` the module exports, or `undefined` when no parser
 * accepted the source (a custom route syntax such as TSRX).
 *
 * Every hint table asks the same question of the same file, so they share one
 * parse: four separate `inspectParsedModule()` calls used to parse each route
 * module four times, once per table.
 */
function inspectParsedModuleExports(
  source: string,
  exportNames: readonly string[],
): Record<string, boolean> | undefined {
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

    const found: Record<string, boolean> = {};
    for (const exportName of exportNames) found[exportName] = false;

    for (const statement of body) {
      if (statement.type === "ExportAllDeclaration") {
        // A re-export could expose any of them, so it answers for all at once.
        if (statement.exportKind !== "type") {
          for (const exportName of exportNames) found[exportName] = true;
          return found;
        }
        continue;
      }
      if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

      for (const exportName of exportNames) {
        if (found[exportName]) continue;

        if (
          Array.isArray(statement.specifiers) &&
          statement.specifiers.some(
            (specifier) =>
              isSyntaxNode(specifier) &&
              specifier.exportKind !== "type" &&
              exportedNameMatches(specifier.exported, exportName),
          )
        ) {
          found[exportName] = true;
          continue;
        }

        const declaration = statement.declaration;
        if (!isSyntaxNode(declaration)) continue;
        if (declaration.declare === true || declaration.type.startsWith("TS")) continue;
        if (declaration.type === "VariableDeclaration") {
          if (
            Array.isArray(declaration.declarations) &&
            declaration.declarations.some(
              (declarator) =>
                isSyntaxNode(declarator) && bindingIncludesName(declarator.id, exportName),
            )
          ) {
            found[exportName] = true;
          }
        } else if (bindingIncludesName(declaration.id, exportName)) {
          found[exportName] = true;
        }
      }
    }

    return found;
  }

  return undefined;
}

function inspectParsedModule(source: string, exportName: string): boolean | undefined {
  return inspectParsedModuleExports(source, [exportName])?.[exportName];
}

export function detectLoaderExport(source: string): boolean {
  // Parse ordinary TS/TSX exactly so type-only exports and identifiers in
  // generic types are not mistaken for runtime loader bindings.
  const parsedResult = inspectParsedModule(source, "loader");
  if (parsedResult !== undefined) return parsedResult;

  return detectLoaderExportWithoutParser(source);
}

/** The `loader` detection that applies once no standard parser accepted the source. */
function detectLoaderExportWithoutParser(source: string): boolean {
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

interface RouteFileScan {
  files: string[];
  /**
   * An entry was skipped, so the table this scan feeds describes fewer files
   * than the directory holds. Callers use it to keep forcing a client-entry
   * reload until a clean scan replaces the table — silently dropping a subtree
   * would leave the browser trusting hints for files nobody looked at.
   */
  incomplete: boolean;
}

/** `readdirSync` failing because the directory is simply absent is not a gap. */
function isMissingDirectory(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function scanRouteFiles(dir: string, extensions: Set<string>, scan: RouteFileScan): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    // An app with no shells directory is ordinary; anything else — a
    // permission error, a directory removed mid-scan — hides real files.
    if (!isMissingDirectory(error)) scan.incomplete = true;
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    // A file can be observed while its editor replaces it, and a symlink can
    // dangle. Skipping that entry keeps the rest of the table intact — letting
    // the throw escape used to discard every hint the scan had collected — but
    // the skip is reported so callers know the table is partial.
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      scan.incomplete = true;
      continue;
    }
    if (stat.isDirectory()) {
      scanRouteFiles(abs, extensions, scan);
      continue;
    }

    if (extensions.has(extname(entry))) {
      scan.files.push(abs);
    }
  }
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export interface RouteHintOptions {
  additionalExtensions?: readonly string[];
  appFileDir?: string;
  rootRelativePrefix?: string;
}

/**
 * Every per-route hint table, from one directory walk and one parse per file.
 *
 * The four tables answer the same question — which of `loader`, `head`,
 * `headers`, and `getStaticPaths` does this module export — of exactly the same
 * files, so computing them separately walked the tree and re-parsed every route
 * module once per table. `handleHotUpdate` runs on every keystroke-triggered
 * save, which is where that cost lands.
 */
export interface RouteHints {
  head: Record<string, boolean>;
  headers: Record<string, boolean>;
  /** True when the walk skipped an entry, so these tables are partial. */
  incomplete: boolean;
  loader: Record<string, boolean>;
  staticPaths: Record<string, boolean>;
}

const ROUTE_HINT_EXPORTS = ["loader", "head", "headers", "getStaticPaths"] as const;

function analyzeRouteExports(source: string): Record<string, boolean> {
  const parsed = inspectParsedModuleExports(source, ROUTE_HINT_EXPORTS);
  if (parsed) return parsed;

  // No standard parser accepted this module (a custom route syntax such as
  // TSRX). Each detector keeps its own conservative fallback, over one shared
  // mask rather than one per table.
  const analysisSource = maskCommentsAndStrings(source);
  return {
    getStaticPaths: detectNamedExportInMasked(
      analysisSource,
      "getStaticPaths",
      STATIC_PATHS_DECLARATION_RE,
    ),
    head: detectNamedExportInMasked(analysisSource, "head", HEAD_DECLARATION_RE),
    headers: detectNamedExportInMasked(analysisSource, "headers", HEADERS_DECLARATION_RE),
    loader: detectLoaderExportWithoutParser(source),
  };
}

function routeHintKeys(routesDir: string, file: string, options: RouteHintOptions): Set<string> {
  const keys = new Set<string>();
  if (options.appFileDir) {
    const relativeToAppFile = toPosixPath(relative(options.appFileDir, file));
    keys.add(relativeToAppFile.startsWith(".") ? relativeToAppFile : `./${relativeToAppFile}`);
  }
  const routeRootPrefix = options.rootRelativePrefix?.replace(/\/$/, "");
  if (routeRootPrefix) {
    keys.add(`${routeRootPrefix}/${toPosixPath(relative(routesDir, file))}`);
  }
  return keys;
}

export function createRouteHints(routesDir: string, options: RouteHintOptions = {}): RouteHints {
  const additionalExtensions = normalizeAdditionalExtensions(options.additionalExtensions);
  const extensions = withAdditionalExtensions(DEFAULT_ROUTE_EXTENSIONS, additionalExtensions);
  const scan: RouteFileScan = { files: [], incomplete: false };
  scanRouteFiles(routesDir, extensions, scan);

  const hints: RouteHints = {
    head: {},
    headers: {},
    incomplete: scan.incomplete,
    loader: {},
    staticPaths: {},
  };

  for (const file of scan.files) {
    let source: string;
    try {
      source = readFileSync(file, "utf-8");
    } catch {
      // Same race as the stat above, one step later. Report it rather than
      // letting one half-written file discard the whole table.
      hints.incomplete = true;
      continue;
    }

    const extension = extname(file);
    // A companion Vite plugin may synthesize `head` or `headers` while
    // compiling a configured format (Markdown frontmatter, for example). Raw
    // source scanning cannot prove such a module is headless, so navigation
    // stays conservative. `getStaticPaths` has no Markdown equivalent, so only
    // configured extensions get that treatment.
    const compiledFormat = extension === ".md" || extension === ".mdx";
    const synthesizable = additionalExtensions.includes(extension);
    const exports = analyzeRouteExports(source);

    const values = {
      head: compiledFormat || synthesizable || exports.head,
      headers: compiledFormat || synthesizable || exports.headers,
      loader: exports.loader,
      staticPaths: synthesizable || exports.getStaticPaths,
    };

    for (const key of routeHintKeys(routesDir, file, options)) {
      hints.head[key] = values.head;
      hints.headers[key] = values.headers;
      hints.loader[key] = values.loader;
      hints.staticPaths[key] = values.staticPaths;
    }
  }

  return hints;
}

export function createRouteLoaderHints(
  routesDir: string,
  options: RouteHintOptions = {},
): Record<string, boolean> {
  return createRouteHints(routesDir, options).loader;
}

export function createRouteHeadHints(
  routesDir: string,
  options: RouteHintOptions = {},
): Record<string, boolean> {
  return createRouteHints(routesDir, options).head;
}

export function createRouteHeadersHints(
  routesDir: string,
  options: RouteHintOptions = {},
): Record<string, boolean> {
  return createRouteHints(routesDir, options).headers;
}

/**
 * Per-route-file `getStaticPaths()` presence, keyed the same way as the loader
 * and head hints.
 *
 * Formats compiled by a companion Vite plugin are reported as `true`: raw
 * source scanning cannot prove such a module has no `getStaticPaths`, and the
 * conservative answer keeps today's behavior.
 */
export function createRouteStaticPathsHints(
  routesDir: string,
  options: RouteHintOptions = {},
): Record<string, boolean> {
  return createRouteHints(routesDir, options).staticPaths;
}
