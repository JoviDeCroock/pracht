/**
 * Static analysis of capability sources — shared by the Vite plugin (client
 * projection codegen) and the CLI (`pracht verify`, `pracht typegen`). Every
 * consumer parses the same `defineCapability({ ... })` call sites without
 * executing application code, so keeping the parser here guarantees the build,
 * verification, and type generation can never disagree about what is
 * statically analyzable.
 *
 * Constraint this imposes on capability authors: values the tools need
 * (`expose`, `effect`, `input`, string fields) must be inline literals — no
 * imported constants or spreads. `evaluateLiteral()` parses the literal text
 * as data and returns `undefined` for anything else.
 */

import { capabilityHttpPath, isValidCapabilityHttpPath } from "./protocol.ts";

/**
 * The parts of a capability contract that decide what gets projected to the
 * browser: whether it has an HTTP endpoint, its effect class, whether it
 * registers a WebMCP page tool, and the input schema that tool advertises.
 */
export interface CapabilityProjection {
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  inputSchema: Record<string, unknown> | null;
  /**
   * Remote MCP exposure. Not part of the browser projection — the client
   * bundle never sees it — but the app graph falls back to this extractor
   * when a capability module cannot be executed, and omitting it there would
   * report an MCP-exposed capability as unexposed.
   */
  mcp: boolean;
  /**
   * Per-capability Web Bot Auth policy, or `null` when it inherits the app
   * default. `undefined` means "declared, but not as a literal we can read" —
   * a caller must not report that as "no policy".
   */
  agentPolicy: string | null | undefined;
  /**
   * Named middleware, or `undefined` when declared as something other than an
   * inline array of string literals. Distinguishing the two matters: reporting
   * an unreadable chain as `[]` says the capability is ungated.
   */
  middleware: string[] | undefined;
}

type StaticAnalysisNode = {
  type: string;
  [key: string]: unknown;
};

/**
 * Whether a parsed JavaScript/TypeScript module statically exposes a runtime
 * binding named `middleware`.
 *
 * Consumers parse with their own Vite/Oxc language mode and pass the resulting
 * ESTree-like program here. Keeping the classification shared prevents build
 * and CLI verification from accepting different middleware module shapes.
 */
export function hasNamedMiddlewareExport(program: unknown): boolean {
  const root = asStaticAnalysisNode(program);
  if (!root) return false;

  const { runtimeBindings, typeOnlyBindings } = collectTopLevelBindingKinds(root);

  for (const statement of nodeArray(root.body)) {
    if (statement.type === "ExportAllDeclaration") {
      // `export type *` has no runtime bindings, while
      // `export * as middleware` exposes a namespace object rather than the
      // required function. Only an ordinary value `export * from` can
      // conservatively re-export a working middleware binding.
      if (statement.exportKind === "type" || statement.exported) continue;
      return true;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    const declaration = asStaticAnalysisNode(statement.declaration);
    if (declaration?.type === "FunctionDeclaration") {
      if (getStaticIdentifierName(declaration.id) === "middleware") return true;
    } else if (declaration?.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of nodeArray(declaration.declarations)) {
        if (collectStaticBindingNames(declarator.id).includes("middleware")) return true;
      }
    }

    for (const specifier of nodeArray(statement.specifiers)) {
      if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue;
      if (getStaticIdentifierName(specifier.exported) !== "middleware") continue;

      // A re-export from another module cannot be resolved without loading it;
      // preserve working value barrels and let runtime validation fail closed.
      if (statement.source) return true;

      const localName = getStaticIdentifierName(specifier.local);
      if (localName && typeOnlyBindings.has(localName) && !runtimeBindings.has(localName)) continue;
      return true;
    }
  }

  return false;
}

function collectTopLevelBindingKinds(program: StaticAnalysisNode): {
  runtimeBindings: Set<string>;
  typeOnlyBindings: Set<string>;
} {
  const runtimeBindings = new Set<string>();
  const typeOnlyBindings = new Set<string>();

  for (const rawStatement of nodeArray(program.body)) {
    if (rawStatement.type === "ImportDeclaration") {
      for (const specifier of nodeArray(rawStatement.specifiers)) {
        const name = getStaticIdentifierName(specifier.local);
        if (!name) continue;
        if (rawStatement.importKind === "type" || specifier.importKind === "type") {
          typeOnlyBindings.add(name);
        } else {
          runtimeBindings.add(name);
        }
      }
      continue;
    }

    const statement =
      rawStatement.type === "ExportNamedDeclaration"
        ? asStaticAnalysisNode(rawStatement.declaration)
        : rawStatement;
    if (!statement) continue;

    if (
      statement.type === "TSTypeAliasDeclaration" ||
      statement.type === "TSInterfaceDeclaration"
    ) {
      const name = getStaticIdentifierName(statement.id);
      if (name) typeOnlyBindings.add(name);
      continue;
    }

    if (statement.type === "TSDeclareFunction" || statement.declare === true) {
      if (statement.type === "VariableDeclaration") {
        for (const declarator of nodeArray(statement.declarations)) {
          for (const name of collectStaticBindingNames(declarator.id)) {
            typeOnlyBindings.add(name);
          }
        }
      } else {
        const name = getStaticIdentifierName(statement.id);
        if (name) typeOnlyBindings.add(name);
      }
      continue;
    }

    if (statement.type === "VariableDeclaration") {
      for (const declarator of nodeArray(statement.declarations)) {
        for (const name of collectStaticBindingNames(declarator.id)) runtimeBindings.add(name);
      }
      continue;
    }

    if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "TSEnumDeclaration" ||
      statement.type === "TSModuleDeclaration"
    ) {
      const name = getStaticIdentifierName(statement.id);
      if (name) runtimeBindings.add(name);
    }
  }

  return { runtimeBindings, typeOnlyBindings };
}

function collectStaticBindingNames(pattern: unknown): string[] {
  const node = asStaticAnalysisNode(pattern);
  if (!node) return [];

  if (node.type === "Identifier") {
    const name = getStaticIdentifierName(node);
    return name ? [name] : [];
  }
  if (node.type === "RestElement" || node.type === "AssignmentPattern") {
    return collectStaticBindingNames(node.argument ?? node.left);
  }
  if (node.type === "ArrayPattern") {
    return unknownArray(node.elements).flatMap(collectStaticBindingNames);
  }
  if (node.type === "ObjectPattern") {
    return nodeArray(node.properties).flatMap((property) => {
      if (property.type === "RestElement") return collectStaticBindingNames(property.argument);
      return collectStaticBindingNames(property.value);
    });
  }
  return [];
}

function getStaticIdentifierName(value: unknown): string | null {
  const node = asStaticAnalysisNode(value);
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    return typeof node.name === "string" ? node.name : null;
  }
  if (node.type === "Literal" || node.type === "StringLiteral") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
}

function asStaticAnalysisNode(value: unknown): StaticAnalysisNode | null {
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (value as StaticAnalysisNode) : null;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nodeArray(value: unknown): StaticAnalysisNode[] {
  return unknownArray(value).flatMap((entry) => {
    const node = asStaticAnalysisNode(entry);
    return node ? [node] : [];
  });
}

/**
 * Derive a capability's projection from its source, without executing it.
 *
 * This is the single implementation behind three consumers that must agree:
 * the Vite plugin builds the browser endpoint table from it, `pracht verify`
 * checks the contract against it, and `pracht typegen` cross-checks it against
 * the executed graph. If they disagreed, generated types could promise an
 * endpoint the client bundle never registered.
 *
 * `name` supplies the default HTTP path; `describe` wraps error messages so
 * each caller can phrase them its own way (the plugin fails the build, the CLI
 * fails a check).
 */
export function extractCapabilityProjection(
  name: string,
  source: string,
  describe: (detail: string) => string,
): CapabilityProjection {
  const args = extractDefineCapabilityArgs(source);
  if (!args) {
    throw new Error(
      describe("does not contain a defineCapability({ ... }) call the build can analyze."),
    );
  }

  const { properties, truncated } = scanTopLevelPropertyEntries(args);
  const exposeText = properties.get("expose");
  // A truncated scan cannot tell "no `expose`" from "`expose` sat after the
  // token we could not parse". Treating that as private would commit an
  // http+mcp-exposed capability to the graph as unreachable, so refuse instead
  // — which is also what the documented contract says a spread does.
  if (!exposeText && truncated) {
    throw new Error(
      describe(
        "contains a spread or computed key the build cannot analyze, so its `expose` could not be " +
          "read. Declare `expose`, `effect`, `agentPolicy`, and `middleware` as inline literals.",
      ),
    );
  }
  if (!exposeText) {
    // Private capability: server-only, nothing to project to the client.
    return {
      description: "",
      effect: null,
      httpPath: null,
      webmcp: false,
      inputSchema: null,
      mcp: false,
      ...readGuardProperties(properties, truncated),
    };
  }

  const expose = evaluateLiteral(exposeText);
  if (!isPlainObject(expose)) {
    throw new Error(
      describe(
        '"expose" must be an inline object literal so the client projection can be generated at build time.',
      ),
    );
  }

  const http = expose.http;
  let httpPath: string | null = null;
  if (http === true) {
    httpPath = capabilityHttpPath(name);
  } else if (isPlainObject(http)) {
    httpPath = typeof http.path === "string" ? http.path : capabilityHttpPath(name);
  }
  if (httpPath && !isValidCapabilityHttpPath(httpPath)) {
    throw new Error(
      describe('HTTP exposure "path" must be an exact same-origin pathname starting with "/".'),
    );
  }

  const webmcp = expose.webmcp === true;
  if (webmcp && !httpPath) {
    throw new Error(describe("expose.webmcp requires expose.http."));
  }

  let description = "";
  const descriptionText = properties.get("description");
  if (descriptionText) {
    const value = evaluateLiteral(descriptionText);
    if (typeof value === "string") description = value;
  }

  let effect: string | null = null;
  const effectText = properties.get("effect");
  if (effectText) {
    const value = evaluateLiteral(effectText);
    if (typeof value === "string") effect = value;
  }
  if (httpPath && effect !== "read" && effect !== "write" && effect !== "destructive") {
    throw new Error(
      describe(
        'is exposed via HTTP, but its "effect" could not be extracted at build time. ' +
          'HTTP-exposed capabilities must declare "effect" as an inline "read", "write", or ' +
          '"destructive" string literal.',
      ),
    );
  }

  let inputSchema: Record<string, unknown> | null = null;
  if (webmcp) {
    const inputText = properties.get("input");
    const value = inputText ? evaluateLiteral(inputText) : undefined;
    if (!isPlainObject(value)) {
      throw new Error(
        describe(
          'is exposed via WebMCP, but its "input" schema could not be extracted at build time. ' +
            "WebMCP-exposed capabilities must declare their input schema as an inline object literal.",
        ),
      );
    }
    inputSchema = value;
  }

  return {
    description,
    effect,
    httpPath,
    webmcp,
    inputSchema,
    mcp: expose.mcp === true,
    ...readGuardProperties(properties, truncated),
  };
}

/**
 * Recover the guard-shaped fields — the ones a reviewer reads to decide whether
 * a change widened what agents can reach.
 *
 * Each is `undefined` when it is declared but not as a literal this pass can
 * evaluate, so a caller can say "unverifiable" rather than "absent". `null`
 * `agentPolicy` and `[]` middleware are real answers meaning "not declared".
 */
function readGuardProperties(
  properties: Map<string, string>,
  truncated: boolean,
): Pick<CapabilityProjection, "agentPolicy" | "middleware"> {
  // After a truncated scan an absent key means "not seen", not "not declared".
  // Reporting `null` / `[]` there is the fail-open case: a capability whose
  // guards arrive via `...gated` would read as ungated, with everything else
  // correct, so the entry looks like a verified contract.
  if (truncated) return { agentPolicy: undefined, middleware: undefined };

  const policyText = properties.get("agentPolicy");
  let agentPolicy: string | null | undefined = null;
  if (policyText) {
    const value = evaluateLiteral(policyText);
    agentPolicy = typeof value === "string" ? value : undefined;
  }

  const middlewareText = properties.get("middleware");
  let middleware: string[] | undefined = [];
  if (middlewareText) {
    const value = evaluateLiteral(middlewareText);
    middleware =
      Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as string[])
        : undefined;
  }

  return { agentPolicy, middleware };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract the argument object text of the *default-exported*
 * `defineCapability({ ... })` call. The runtime resolves a capability module
 * by its default export, so analysis must agree: a helper `defineCapability()`
 * call earlier in the file must not be mistaken for the exported one. Matches
 * the call site (optionally with a type argument), not the import binding.
 */
export function extractDefineCapabilityArgs(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const parenIndex = findDefaultExportedCallParen(searchable);
  if (parenIndex === -1) return null;
  const braceStart = searchable.indexOf("{", parenIndex);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

const CALL_SITE = /defineCapability\s*(?:<[^(]*?>)?\s*\(/g;

/**
 * Index of the `(` of the default-exported `defineCapability()` call, or -1
 * when the module has no analyzable default-exported call. Handles
 * `export default defineCapability(...)`, `export default <id>` (with or
 * without a trailing `;`), and `export { <id> as default }`, resolving the
 * identifier to its `const/let/var <id> = defineCapability(...)` declaration.
 * A named-only call is deliberately not accepted: the runtime requires the
 * capability itself to be the module's default export.
 */
function findDefaultExportedCallParen(searchable: string): number {
  const direct = /export\s+default\s+defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  if (direct && direct.index != null) {
    return direct.index + direct[0].length - 1;
  }

  const localName = defaultExportLocalName(searchable);
  if (localName) {
    const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`, "g");
    // The default export refers to the MODULE-scope binding; a shadowed
    // declaration inside a function must not win. Prefer the match at brace
    // depth 0.
    for (const match of searchable.matchAll(decl)) {
      if (match.index != null && braceDepthAt(searchable, match.index) === 0) {
        const paren = findDefineCapabilityInitializer(searchable, match.index + match[0].length);
        if (paren !== -1) return paren;
      }
    }
  }

  return -1;
}

/**
 * Resolve the first assignment of a variable declaration and accept it only
 * when its initializer is immediately `defineCapability(...)`. This avoids
 * crossing an ASI boundary into a later declaration while still supporting
 * multiline and arrow-function type annotations.
 */
function findDefineCapabilityInitializer(searchable: string, start: number): number {
  return findCallInitializer(searchable, start, "defineCapability", CALL_SITE.source);
}

function findCallInitializer(
  searchable: string,
  start: number,
  callName: string,
  callPattern = `${callName}\\s*(?:<[^(]*?>)?\\s*\\(`,
): number {
  let depth = 0;
  for (let index = start; index < searchable.length; index += 1) {
    const char = searchable[index];
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return -1;
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (char === ";") return -1;
    if (char === "\n" || char === "\r") {
      const next = searchable.slice(skipWhitespace(searchable, index + 1));
      if (/^(?:(?:export|import)\b|(?:const|let|var|function|class)\b)/.test(next)) {
        return -1;
      }
      continue;
    }
    if (
      char === "=" &&
      searchable[index + 1] !== ">" &&
      searchable[index - 1] !== "=" &&
      searchable[index - 1] !== "!" &&
      searchable[index - 1] !== "<" &&
      searchable[index - 1] !== ">"
    ) {
      const initializerStart = skipWhitespace(searchable, index + 1);
      const call = new RegExp(`^${callPattern}`).exec(searchable.slice(initializerStart));
      return call ? initializerStart + call[0].length - 1 : -1;
    }
  }
  return -1;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

/**
 * Brace/paren/bracket nesting depth at `index` in an already comment- and
 * string-masked source. Depth 0 means module scope.
 */
function braceDepthAt(searchable: string, index: number): number {
  let depth = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const char = searchable[cursor];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
  }
  return depth;
}

/** Local binding name of a module's default export, or null. */
function defaultExportLocalName(searchable: string): string | null {
  const idMatch = /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(searchable);
  if (idMatch && idMatch[1] !== "defineCapability") {
    return idMatch[1];
  }
  const asDefault = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default\b/.exec(
    searchable,
  );
  return asDefault ? asDefault[1] : null;
}

/**
 * Scan an object literal body for its top-level properties, returning a map
 * of property name → raw value text. Depth-aware and quote/comment-aware so
 * nested schema annotations (e.g. a `description` inside `input`) are never
 * mistaken for capability fields.
 */
export interface TopLevelPropertyScan {
  properties: Map<string, string>;
  /**
   * True when the scan hit a token it could not parse as a key (a spread, a
   * computed key) and stopped. Everything from that point on is missing from
   * `properties`, so a caller must not read an absent key as "not declared" —
   * that is how a spread-in `agentPolicy` or `middleware` came back as "no
   * policy, no middleware" instead of "unreadable".
   */
  truncated: boolean;
}

export function scanTopLevelProperties(objectBody: string): Map<string, string> {
  return scanTopLevelPropertyEntries(objectBody).properties;
}

export function scanTopLevelPropertyEntries(objectBody: string): TopLevelPropertyScan {
  const properties = new Map<string, string>();
  let index = 0;
  let truncated = false;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    // Property key: identifier or quoted string.
    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) {
        truncated = true;
        break;
      }
      const decoded = evaluateLiteral(objectBody.slice(index, end + 1));
      if (typeof decoded !== "string") {
        truncated = true;
        break;
      }
      key = decoded;
      index = end + 1;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) {
        truncated = true;
        break;
      }
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      // Shorthand or method definitions — skip to the next top-level comma.
      index = skipToTopLevelComma(objectBody, index) + 1;
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return { properties, truncated };
}

/** Parse a module registry block from an app manifest source. */
export function extractManifestModuleRegistrations(
  manifestSource: string,
  key: string,
): { name: string; file: string }[] {
  const appBody = extractDefineAppObjectBody(manifestSource);
  if (!appBody) return [];
  let registryValue = scanModuleRegistryProperties(appBody).get(key);
  if (!registryValue) return [];
  const registryIdentifier = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(registryValue)?.[1];
  if (registryIdentifier) {
    const initializer = findTopLevelVariableInitializer(manifestSource, registryIdentifier);
    if (initializer) registryValue = initializer;
  }
  const braceStart = skipInsignificant(registryValue, 0);
  if (registryValue[braceStart] !== "{") return [];
  const braceEnd = findMatchingBrace(registryValue, braceStart, "{", "}");
  if (braceEnd === -1) return [];
  const block = registryValue.slice(braceStart + 1, braceEnd);
  const entries: { name: string; file: string }[] = [];
  for (const [name, expression] of scanModuleRegistryProperties(block)) {
    let file = extractModuleRefPath(expression);
    if (!file) {
      const identifier = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(expression)?.[1];
      const initializer = identifier
        ? findTopLevelVariableInitializer(manifestSource, identifier)
        : null;
      if (initializer) file = extractModuleRefPath(initializer);
    }
    if (file) entries.push({ name, file });
  }
  return entries;
}

function scanModuleRegistryProperties(block: string): Map<string, string> {
  const properties = new Map<string, string>();
  let index = 0;

  while (index < block.length) {
    const start = skipInsignificant(block, index);
    if (start >= block.length) break;
    const end = skipToTopLevelComma(block, start);
    const propertySource = block.slice(start, end);
    const parsedProperties = scanTopLevelPropertyEntries(propertySource).properties;
    for (const [name, expression] of parsedProperties) {
      properties.set(name, expression);
    }
    if (parsedProperties.size === 0) {
      // Object shorthand is a normal way to keep module refs readable:
      // `const pages = () => import("./pages/_middleware.ts");`
      // `middleware: { pages }`. Preserve the property name as its expression
      // so the same top-level binding resolver used for explicit values can
      // recover the module path.
      const shorthand = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(
        maskComments(propertySource),
      )?.[1];
      if (shorthand) properties.set(shorthand, shorthand);
    }
    if (end >= block.length) break;
    index = end + 1;
  }

  return properties;
}

function extractModuleRefPath(expression: string): string | null {
  const start = skipInsignificant(expression, 0);
  const quote = expression[start];
  if (quote === '"' || quote === "'") {
    const end = findStringEnd(expression, start);
    if (end === -1) return null;
    const value = evaluateLiteral(expression.slice(start, end + 1));
    return typeof value === "string" ? value : null;
  }

  const importMatch = /^\s*\(\s*\)\s*=>\s*import\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/s.exec(
    expression,
  );
  if (!importMatch) return null;
  const value = evaluateLiteral(`${importMatch[1]}${importMatch[2]}${importMatch[1]}`);
  return typeof value === "string" ? value : null;
}

function findTopLevelVariableInitializer(source: string, name: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${escapedName}\\b`, "g");

  for (const match of searchable.matchAll(declaration)) {
    if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
    const afterName = match.index + match[0].length;
    const assignment = /^(?:\s*:[^=;,\n]+)?\s*=\s*/.exec(searchable.slice(afterName));
    if (!assignment) continue;
    return source.slice(afterName + assignment[0].length);
  }

  return null;
}

/** Parse the `capabilities: { ... }` block of an app manifest source. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  return extractManifestModuleRegistrations(manifestSource, "capabilities");
}

/** Extract the inline object body passed to the exported app's `defineApp()`. */
export function extractDefineAppObjectBody(source: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const defaultExport = /export\s+default\s+defineApp\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  let parenIndex =
    defaultExport?.index != null ? defaultExport.index + defaultExport[0].length - 1 : -1;

  if (parenIndex === -1) {
    const declaration = /export\s+(?:const|let|var)\s+app\b/g;
    for (const match of searchable.matchAll(declaration)) {
      if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
      parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
      if (parenIndex !== -1) break;
    }
  }

  if (parenIndex === -1) {
    const localName = namedAppExportLocalName(searchable);
    if (localName) {
      const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`, "g");
      for (const match of searchable.matchAll(declaration)) {
        if (match.index == null || braceDepthAt(searchable, match.index) !== 0) continue;
        parenIndex = findCallInitializer(searchable, match.index + match[0].length, "defineApp");
        if (parenIndex !== -1) break;
      }
    }
  }

  if (parenIndex === -1) return null;
  const braceStart = skipInsignificant(source, parenIndex + 1);
  if (source[braceStart] !== "{") return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  return braceEnd === -1 ? null : source.slice(braceStart + 1, braceEnd);
}

function namedAppExportLocalName(searchable: string): string | null {
  const aliased = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+app\b/.exec(searchable);
  if (aliased) return aliased[1];
  return /export\s*\{[^}]*?\bapp\b(?:\s*,|\s*\})/.test(searchable) ? "app" : null;
}

/**
 * Find the raw text of a top-level-ish `key: { ... }` property anywhere in a
 * source file (used for the manifest's `capabilities` block).
 */
export function findTopLevelObjectProperty(source: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const codeOnly = maskCommentsAndStrings(source);
  const commentsRemoved = maskComments(source);
  const unquotedMatch = new RegExp(`\\b${escapedKey}\\s*:\\s*\\{`).exec(codeOnly);
  const quotedIndex = findQuotedObjectProperty(source, key);
  const matchIndex = [unquotedMatch?.index, quotedIndex]
    .filter((candidate): candidate is number => candidate !== undefined && candidate !== null)
    .sort((left, right) => left - right)[0];
  if (matchIndex === undefined) return null;
  const braceStart = commentsRemoved.indexOf("{", matchIndex);
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

/** Parse an extracted data literal without evaluating application code. */
export function evaluateLiteral(expression: string): unknown {
  const parsed = parseLiteralValue(expression, 0);
  if (!parsed) return undefined;
  const end = skipInsignificant(expression, parsed.index);
  return end === expression.length ? parsed.value : undefined;
}

function skipToTopLevelComma(source: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return source.length;
      index = end + 1;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index);
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd;
        continue;
      }
    }
    if (char === "{" || char === "[" || char === "(") depth += 1;
    if (char === "}" || char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) return index;
    index += 1;
  }
  return source.length;
}

function skipInsignificant(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const blockEnd = source.indexOf("*/", index + 2);
      index = blockEnd === -1 ? source.length : blockEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

/**
 * Replace comments, regex literals, and optionally strings with spaces while
 * preserving source offsets. Regex-based entry-point discovery can then only
 * match live code, while the real source remains available for brace-aware
 * extraction.
 */
function maskLexicalNoise(source: string, maskStrings: boolean): string {
  const chars = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return chars.slice(0, index).join("") + " ".repeat(source.length - index);
      if (maskStrings) {
        for (let cursor = index; cursor <= end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
      }
      index = end + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      const limit = end === -1 ? source.length : end;
      for (let cursor = index; cursor < limit; cursor += 1) chars[cursor] = " ";
      index = limit;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const limit = close === -1 ? source.length : close + 2;
      for (let cursor = index; cursor < limit; cursor += 1) {
        if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
      }
      index = limit;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        for (let cursor = index; cursor < end; cursor += 1) {
          if (chars[cursor] !== "\n" && chars[cursor] !== "\r") chars[cursor] = " ";
        }
        index = end;
        continue;
      }
    }
    index += 1;
  }
  return chars.join("");
}

function maskComments(source: string): string {
  return maskLexicalNoise(source, false);
}

export function maskCommentsAndStrings(source: string): string {
  return maskLexicalNoise(source, true);
}

/** Find an actual quoted property token, excluding lookalikes inside strings/comments. */
function findQuotedObjectProperty(source: string, key: string): number | null {
  let index = 0;
  while (index < source.length) {
    const next = skipInsignificant(source, index);
    if (next > index) {
      index = next;
      continue;
    }

    const char = source[index];
    if (char !== '"' && char !== "'" && char !== "`") {
      index += 1;
      continue;
    }

    const end = findStringEnd(source, index);
    if (end === -1) return null;
    if (char !== "`" && source.slice(index + 1, end) === key) {
      const colon = skipInsignificant(source, end + 1);
      const brace = source[colon] === ":" ? skipInsignificant(source, colon + 1) : -1;
      if (brace !== -1 && source[brace] === "{") return index;
    }
    index = end + 1;
  }
  return null;
}

/** Index of the closing quote of the string starting at `start`. */
function findStringEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote === "`") return findTemplateEnd(source, start);
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/**
 * Index of the closing backtick of the template literal starting at `start`.
 * Tracks `${ ... }` interpolations (including nested strings and templates
 * inside them) so an inner backtick or `}` does not end the template early.
 */
function findTemplateEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
    if (char === "$" && source[index + 1] === "{") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        const inner = source[index];
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === '"' || inner === "'" || inner === "`") {
          const end = findStringEnd(source, index);
          if (end === -1) return -1;
          index = end + 1;
          continue;
        }
        if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        index += 1;
      }
      if (depth > 0) return -1;
      index -= 1;
    }
  }
  return -1;
}

function findMatchingBrace(source: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return -1;
      index = end;
      continue;
    }
    if (char === "/" && (source[index + 1] === "/" || source[index + 1] === "*")) {
      index = skipInsignificant(source, index) - 1;
      continue;
    }
    if (char === "/") {
      const regexEnd = regexLiteralEnd(source, index);
      if (regexEnd !== -1) {
        index = regexEnd - 1;
        continue;
      }
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "<",
  ">",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
]);
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
  "case",
]);
const REGEX_STATEMENT_CONTROL_KEYWORDS = new Set(["if", "while", "for", "with"]);

interface LexicalToken {
  kind: "atom" | "punctuation" | "word";
  value: string;
}

/**
 * Whether `closeIndex` closes a control-flow condition whose body may begin
 * with a regex expression statement (`if (condition) /pattern/.test(value)`).
 *
 * A closing parenthesis normally makes the following slash division. Control
 * statements are the exception, so retain just enough token context while
 * matching parentheses to distinguish them from calls such as `fn() / 2`.
 */
function closesRegexStatementControlParen(source: string, closeIndex: number): boolean {
  const controlParens: boolean[] = [];
  const tokens: LexicalToken[] = [];

  const record = (token: LexicalToken): void => {
    tokens.push(token);
    if (tokens.length > 2) tokens.shift();
  };

  for (let index = 0; index <= closeIndex; index += 1) {
    const char = source[index];
    if (/\s/.test(char)) continue;

    if (char === '"' || char === "'" || char === "`") {
      const end = findStringEnd(source, index);
      if (end === -1) return false;
      record({ kind: "atom", value: "string" });
      index = end;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) return false;
      index = end + 1;
      continue;
    }
    if (char === "/") {
      const end = regexLiteralEnd(source, index);
      if (end !== -1) {
        record({ kind: "atom", value: "regex" });
        index = end - 1;
        continue;
      }
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      record({ kind: "word", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (/[0-9]/.test(char)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end += 1;
      record({ kind: "atom", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }
    if (char === "(") {
      const previous = tokens[tokens.length - 1];
      const beforePrevious = tokens[tokens.length - 2];
      const followsControlKeyword =
        previous?.kind === "word" &&
        (REGEX_STATEMENT_CONTROL_KEYWORDS.has(previous.value) ||
          (previous.value === "await" &&
            beforePrevious?.kind === "word" &&
            beforePrevious.value === "for")) &&
        beforePrevious?.value !== ".";
      controlParens.push(followsControlKeyword);
      record({ kind: "punctuation", value: char });
      continue;
    }
    if (char === ")") {
      const closesControl = controlParens.pop() ?? false;
      if (index === closeIndex) return closesControl;
      record({ kind: "punctuation", value: char });
      continue;
    }

    record({ kind: "punctuation", value: char });
  }

  return false;
}

/**
 * If the `/` at `slashIndex` begins a regex literal (decided from the previous
 * significant token, the standard divide-vs-regex heuristic), return the index
 * just after its closing `/` and flags; otherwise -1. Keeps the brace/comma
 * scanners from miscounting a `}`/`]`/`,` inside a regex such as `/\}/`.
 */
function regexLiteralEnd(source: string, slashIndex: number): number {
  let back = slashIndex - 1;
  while (back >= 0 && /\s/.test(source[back])) back -= 1;
  let isRegex: boolean;
  if (back < 0) {
    isRegex = true;
  } else {
    const prev = source[back];
    if (REGEX_PRECEDING_PUNCTUATION.has(prev)) {
      isRegex = true;
    } else if (prev === ")" && closesRegexStatementControlParen(source, back)) {
      isRegex = true;
    } else if (/[A-Za-z0-9_$]/.test(prev)) {
      let wordStart = back;
      while (wordStart >= 0 && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
      isRegex = REGEX_PRECEDING_KEYWORDS.has(source.slice(wordStart + 1, back + 1));
    } else {
      // Non-control `)`, `]`, `.`, numbers → division operator, not a regex.
      isRegex = false;
    }
  }
  if (!isRegex) return -1;

  let index = slashIndex + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "\n") return -1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return -1;
}

interface ParsedLiteral {
  value: unknown;
  index: number;
}

function parseLiteralValue(source: string, start: number): ParsedLiteral | null {
  const index = skipInsignificant(source, start);
  const char = source[index];
  if (char === "{") return parseObjectLiteral(source, index);
  if (char === "[") return parseArrayLiteral(source, index);
  if (char === '"' || char === "'" || char === "`") return parseStringLiteral(source, index);
  if (source.startsWith("true", index)) return parseKeyword(source, index, "true", true);
  if (source.startsWith("false", index)) return parseKeyword(source, index, "false", false);
  if (source.startsWith("null", index)) return parseKeyword(source, index, "null", null);
  return parseNumberLiteral(source, index);
}

function parseObjectLiteral(source: string, start: number): ParsedLiteral | null {
  const value: Record<string, unknown> = {};
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "}") return { value, index: index + 1 };

  while (index < source.length) {
    let key: string | null = null;
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const parsedKey = parseStringLiteral(source, index);
      if (!parsedKey || typeof parsedKey.value !== "string") return null;
      key = parsedKey.value;
      index = parsedKey.index;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index));
      if (!match) return null;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(source, index);
    if (source[index] !== ":") return null;

    const parsedValue = parseLiteralValue(source, index + 1);
    if (!parsedValue) return null;
    value[key] = parsedValue.value;

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "}") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "}") return { value, index: index + 1 };
  }

  return null;
}

function parseArrayLiteral(source: string, start: number): ParsedLiteral | null {
  const value: unknown[] = [];
  let index = skipInsignificant(source, start + 1);
  if (source[index] === "]") return { value, index: index + 1 };

  while (index < source.length) {
    const parsedValue = parseLiteralValue(source, index);
    if (!parsedValue) return null;
    value.push(parsedValue.value);

    index = skipInsignificant(source, parsedValue.index);
    if (source[index] === "]") return { value, index: index + 1 };
    if (source[index] !== ",") return null;
    index = skipInsignificant(source, index + 1);
    if (source[index] === "]") return { value, index: index + 1 };
  }

  return null;
}

function parseStringLiteral(source: string, start: number): ParsedLiteral | null {
  const quote = source[start];
  const end = findStringEnd(source, start);
  if (end === -1) return null;
  const body = source.slice(start + 1, end);
  if (quote === "`" && body.includes("${")) return null;

  let value = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= body.length) return null;
    const escaped = body[index];
    switch (escaped) {
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "v":
        value += "\v";
        break;
      case "0":
        value += "\0";
        break;
      case "x": {
        const hex = body.slice(index + 1, index + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
        break;
      }
      case "u": {
        if (body[index + 1] === "{") {
          const close = body.indexOf("}", index + 2);
          if (close === -1) return null;
          const hex = body.slice(index + 2, close);
          if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
          const codePoint = Number.parseInt(hex, 16);
          if (codePoint > 0x10ffff) return null;
          value += String.fromCodePoint(codePoint);
          index = close;
          break;
        }
        const hex = body.slice(index + 1, index + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escaped;
        break;
    }
  }

  return { value, index: end + 1 };
}

function parseKeyword(
  source: string,
  start: number,
  keyword: string,
  value: unknown,
): ParsedLiteral | null {
  const end = start + keyword.length;
  return /[A-Za-z0-9_$]/.test(source[end] ?? "") ? null : { value, index: end };
}

function parseNumberLiteral(source: string, start: number): ParsedLiteral | null {
  const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(start));
  if (!match) return null;
  const end = start + match[0].length;
  if (/[A-Za-z0-9_$]/.test(source[end] ?? "")) return null;
  return { value: Number(match[0]), index: end };
}
