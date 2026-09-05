/**
 * Static analysis of capability sources — shared by the Vite plugin (client
 * projection codegen) and the CLI (`pracht verify`, `pracht typegen`). Every
 * consumer parses the same `defineCapability({ ... })` call sites without
 * executing application code, so keeping the parser here guarantees the build,
 * verification, and type generation can never disagree about what is
 * statically analyzable.
 *
 * Exposure and HTTP effect metadata must be inline because they decide which
 * browser endpoints exist. Other opaque values remain `undefined`/`null` for
 * callers to report or resolve from the server-only module; `evaluateLiteral()`
 * never executes them.
 */

import {
  capabilityFileStem,
  capabilityHttpPath,
  isValidCapabilityHttpPath,
  isValidCapabilityName,
} from "./protocol.ts";

/**
 * The parts of a capability contract that decide what gets projected to the
 * browser: whether it has an HTTP endpoint, its effect class, whether it
 * registers a WebMCP page tool, and the input schema that tool advertises.
 */
export interface CapabilityProjection {
  /** Empty when `title` is not an inline string literal — the WebMCP descriptor omits it then. */
  title: string;
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  /** The WebMCP tool's `untrustedContentHint` annotation. Always `false` when `webmcp` is `false`. */
  webmcpUntrustedContent: boolean;
  /** Inline input schema, or `null` when a server-module pass must derive it. */
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

function staticNode(value: unknown): StaticAnalysisNode | null {
  if (!value || typeof value !== "object") return null;
  return typeof (value as { type?: unknown }).type === "string"
    ? (value as StaticAnalysisNode)
    : null;
}

function staticName(value: unknown): string | null {
  const node = staticNode(value);
  if (node?.type === "Identifier" && typeof node.name === "string") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function bindsStaticName(value: unknown, name: string): boolean {
  const node = staticNode(value);
  if (!node) return false;
  if (node.type === "Identifier") return node.name === name;
  if (node.type === "RestElement" || node.type === "AssignmentPattern") {
    return bindsStaticName(node.argument ?? node.left, name);
  }
  if (node.type === "ArrayPattern") {
    return (
      Array.isArray(node.elements) && node.elements.some((item) => bindsStaticName(item, name))
    );
  }
  if (node.type === "ObjectPattern") {
    return (
      Array.isArray(node.properties) &&
      node.properties.some((property) => {
        const item = staticNode(property);
        return bindsStaticName(item?.type === "RestElement" ? item.argument : item?.value, name);
      })
    );
  }
  return false;
}

function collectStaticBindingNames(value: unknown, names: Set<string>): void {
  const node = staticNode(value);
  if (!node) return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    names.add(node.name);
    return;
  }
  if (node.type === "RestElement" || node.type === "AssignmentPattern") {
    collectStaticBindingNames(node.argument ?? node.left, names);
    return;
  }
  if (node.type === "ArrayPattern" && Array.isArray(node.elements)) {
    for (const element of node.elements) collectStaticBindingNames(element, names);
    return;
  }
  if (node.type === "ObjectPattern" && Array.isArray(node.properties)) {
    for (const property of node.properties) {
      const item = staticNode(property);
      collectStaticBindingNames(item?.type === "RestElement" ? item.argument : item?.value, names);
    }
  }
}

const STATIC_TYPE_ONLY_DECLARATIONS = new Set([
  "TSDeclareFunction",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
]);

function isStaticTypeOnlyDeclaration(declaration: StaticAnalysisNode): boolean {
  return (
    declaration.declare === true ||
    STATIC_TYPE_ONLY_DECLARATIONS.has(declaration.type) ||
    (declaration.type === "TSImportEqualsDeclaration" && declaration.importKind === "type")
  );
}

const STATIC_MODULE_SCOPE_BOUNDARIES = new Set([
  "ArrowFunctionExpression",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "StaticBlock",
  "TSModuleDeclaration",
]);

function collectNestedModuleVarBindings(value: unknown, names: Set<string>): void {
  const node = staticNode(value);
  if (!node || STATIC_MODULE_SCOPE_BOUNDARIES.has(node.type)) return;

  if (node.type === "VariableDeclaration" && node.kind === "var" && node.declare !== true) {
    const declarations = Array.isArray(node.declarations) ? node.declarations : [];
    for (const declaration of declarations) {
      collectStaticBindingNames(staticNode(declaration)?.id, names);
    }
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) collectNestedModuleVarBindings(item, names);
    } else {
      collectNestedModuleVarBindings(child, names);
    }
  }
}

function collectStaticModuleBindings(root: StaticAnalysisNode): {
  runtime: Set<string>;
  typeOnly: Set<string>;
} {
  const runtime = new Set<string>();
  const typeOnly = new Set<string>();
  const statements = Array.isArray(root.body) ? root.body : [];

  for (const value of statements) {
    const statement = staticNode(value);
    if (!statement) continue;

    if (statement.type === "ImportDeclaration") {
      const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : [];
      for (const specifierValue of specifiers) {
        const specifier = staticNode(specifierValue);
        const localName = staticName(specifier?.local);
        if (localName === null) continue;
        if (statement.importKind === "type" || specifier?.importKind === "type") {
          typeOnly.add(localName);
        } else {
          runtime.add(localName);
        }
      }
      continue;
    }

    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? staticNode(statement.declaration)
        : statement;
    if (!declaration) continue;

    const target = isStaticTypeOnlyDeclaration(declaration) ? typeOnly : runtime;
    if (declaration.type === "VariableDeclaration") {
      const declarations = Array.isArray(declaration.declarations) ? declaration.declarations : [];
      for (const item of declarations) collectStaticBindingNames(staticNode(item)?.id, target);
    } else {
      const name = staticName(declaration.id);
      if (name !== null) target.add(name);
    }

    collectNestedModuleVarBindings(statement, runtime);
  }

  return { runtime, typeOnly };
}

/**
 * Whether a parsed JavaScript/TypeScript module explicitly exports a binding
 * named `middleware`. This intentionally answers only the static ESM question:
 * runtime validation owns whether the exported value is callable.
 *
 * A value `export *` is treated as unknown/allowed because its names cannot be
 * known without loading the referenced module. Explicit type-only exports do
 * not create runtime bindings and are ignored.
 */
export function hasNamedMiddlewareExport(program: unknown): boolean {
  return hasNamedValueExport(program, "middleware");
}

/**
 * Whether a parsed module explicitly exports a runtime binding named `name`,
 * under the rules `hasNamedMiddlewareExport()` documents: a value `export *`
 * counts because its names cannot be known without loading the referenced
 * module, and explicit type-only exports do not.
 */
export function hasNamedValueExport(program: unknown, name: string): boolean {
  const root = staticNode(program);
  if (!root || !Array.isArray(root.body)) return false;
  const bindings = collectStaticModuleBindings(root);

  for (const value of root.body) {
    const statement = staticNode(value);
    if (!statement) continue;

    if (statement.type === "ExportAllDeclaration") {
      if (statement.exportKind === "type") continue;
      if (!statement.exported || staticName(statement.exported) === name) return true;
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue;

    const declaration = staticNode(statement.declaration);
    if (declaration && !isStaticTypeOnlyDeclaration(declaration)) {
      if (
        declaration?.type === "VariableDeclaration" &&
        Array.isArray(declaration.declarations) &&
        declaration.declarations.some((item) => bindsStaticName(staticNode(item)?.id, name))
      ) {
        return true;
      }
      if (staticName(declaration.id) === name) {
        return true;
      }
    }

    if (
      Array.isArray(statement.specifiers) &&
      statement.specifiers.some((value) => {
        const specifier = staticNode(value);
        const localName = staticName(specifier?.local);
        return (
          specifier?.type === "ExportSpecifier" &&
          specifier.exportKind !== "type" &&
          staticName(specifier.exported) === name &&
          (statement.source ||
            localName === null ||
            !bindings.typeOnly.has(localName) ||
            bindings.runtime.has(localName))
        );
      })
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Whether a parsed module has an unnamed value `export * from "..."`.
 *
 * Callers that need the exact export set — rather than whether one particular
 * name is present — use this to refuse instead of guessing: the star's names
 * cannot be known without loading the referenced module.
 */
export function hasValueStarExport(program: unknown): boolean {
  const root = staticNode(program);
  if (!root || !Array.isArray(root.body)) return false;
  return root.body.some((value) => {
    const statement = staticNode(value);
    return (
      statement?.type === "ExportAllDeclaration" &&
      statement.exportKind !== "type" &&
      !statement.exported
    );
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
/**
 * Resolve the name a pages-router capability module registers under.
 *
 * The pages router has no `capabilities` registry to key modules by, so the
 * module either declares `defineCapability({ name })` or takes the file stem.
 * A declared name must still map back to its file (`notes.search` ↔
 * `notes-search.ts`) so the file a name resolves to is readable from the name
 * alone — the same mapping `pracht generate capability` writes.
 *
 * Returns the resolved name, or an `error` string for the caller to report as
 * a build/doctor/verify failure. Never guesses: a `name` the analyzer cannot
 * read statically falls back to the file stem rather than to nothing.
 */
export function resolvePagesCapabilityName(
  fileStem: string,
  source: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const declared = readDeclaredCapabilityName(source);
  if (declared === null) {
    if (!isValidCapabilityName(fileStem)) {
      return {
        ok: false,
        error:
          `file name ${JSON.stringify(fileStem)} is not a usable capability name. Rename the ` +
          "file to dot-separated segments of letters, numbers, hyphens, and underscores written " +
          'with hyphens (for example `notes-search.ts`), or declare `name: "notes.search"` in ' +
          "its `defineCapability({ ... })` call.",
      };
    }
    return { ok: true, name: fileStem };
  }

  if (!isValidCapabilityName(declared)) {
    return {
      ok: false,
      error:
        `declares name ${JSON.stringify(declared)}, which is not a valid capability name. Use ` +
        'dot-separated segments of letters, numbers, hyphens, and underscores (for example "notes.search").',
    };
  }

  const expectedStem = capabilityFileStem(declared);
  if (expectedStem !== fileStem) {
    return {
      ok: false,
      error:
        `declares name ${JSON.stringify(declared)} but lives in ${JSON.stringify(`${fileStem}.*`)}. ` +
        `A pages-router capability is discovered by file, so its name must map back to it: rename ` +
        `the file to ${JSON.stringify(`${expectedStem}.*`)}, or change the declared name to ` +
        `${JSON.stringify(fileStem.replaceAll("-", "."))}.`,
    };
  }

  return { ok: true, name: declared };
}

/**
 * The source text of a module's top-level `export const <name> = <literal>`
 * initializer, or `null` when there is no single unambiguous *literal* one.
 *
 * Returns the expression *text*, not a value: callers hand it to the same
 * object-body scanners they use on a `defineApp({ ... })` literal, so a config
 * file that lives outside the manifest is analyzed by exactly the same rules.
 *
 * That is also why anything other than an object or array literal answers
 * `null`. `export const agents = buildAgents()` has no body those scanners can
 * read; returning its text would let a caller inline an opaque expression and
 * then conclude, from a scan that found no `mcp` key, that the app configures
 * no MCP endpoint — reporting an open surface as absent. A `satisfies` or `as`
 * suffix and wrapping parentheses are unwrapped, since they do not change the
 * literal underneath.
 */
export function readNamedExportInitializer(source: string, name: string): string | null {
  const searchable = maskCommentsAndStrings(source);
  const declarations = [
    ...searchable.matchAll(new RegExp(`export\\s+const\\s+${name}\\b`, "g")),
  ].filter((match) => match.index != null && braceDepthAt(searchable, match.index) === 0);
  if (declarations.length !== 1) return null;

  // Skip an optional `: Type` annotation, then require the `=`.
  const afterName = (declarations[0].index ?? 0) + declarations[0][0].length;
  const assignment = /^\s*(?::[^=]*)?=/.exec(searchable.slice(afterName));
  if (!assignment) return null;

  const start = skipInsignificant(source, afterName + assignment[0].length);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = searchable[index];
    if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && (char === ";" || char === "\n")) {
      const text = source.slice(start, index).trim();
      // A newline at depth 0 only ends the declaration once something was read
      // (`export const agents =\n  { … }` continues onto the next line).
      if (text !== "") return asLiteralInitializer(text);
    }
    if (depth < 0) return null;
  }

  const trailing = source.slice(start).trim();
  return trailing === "" ? null : asLiteralInitializer(trailing);
}

/** An object or array literal, unwrapped from parentheses and a `satisfies`/`as` suffix. */
function asLiteralInitializer(text: string): string | null {
  let value = text.trim();

  // Bounded: each iteration strips one wrapping layer, and real config files
  // nest a handful at most.
  for (let guard = 0; guard < 8; guard += 1) {
    const open = value[0];
    if (open === "(") {
      const end = findMatchingBrace(value, 0, "(", ")");
      if (end === -1 || value.slice(end + 1).trim() !== "") return null;
      value = value.slice(1, end).trim();
      continue;
    }
    if (open !== "{" && open !== "[") return null;

    const end = findMatchingBrace(value, 0, open, open === "{" ? "}" : "]");
    if (end === -1) return null;
    const rest = value.slice(end + 1).trim();
    if (rest === "") return value;
    // `{ … } satisfies PrachtAgentsConfig` and `{ … } as const` still describe
    // the literal; `{ … }.foo` and `{ … } ?? fallback` do not.
    return /^(?:satisfies|as)\s+\S/.test(rest) ? value.slice(0, end + 1) : null;
  }

  return null;
}

/**
 * The string literal passed as `defineCapability({ name })`, or `null` when
 * the property is absent or not a statically readable literal.
 */
export function readDeclaredCapabilityName(source: string): string | null {
  const args = extractDefineCapabilityArgs(source);
  if (!args) return null;
  const value = scanTopLevelProperties(args).get("name");
  if (value === undefined) return null;
  const literal = evaluateLiteral(value);
  return typeof literal === "string" ? literal : null;
}

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
      title: "",
      description: "",
      effect: null,
      httpPath: null,
      webmcp: false,
      webmcpUntrustedContent: false,
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

  let webmcp = false;
  let webmcpUntrustedContent = false;
  if (expose.webmcp === true) {
    webmcp = true;
  } else if (isPlainObject(expose.webmcp)) {
    webmcp = true;
    webmcpUntrustedContent = expose.webmcp.untrustedContent === true;
  } else if (expose.webmcp !== undefined && expose.webmcp !== false && expose.webmcp !== null) {
    throw new Error(describe('"expose.webmcp" must be a boolean or an options object.'));
  }
  if (webmcp && !httpPath) {
    throw new Error(describe("expose.webmcp requires expose.http."));
  }

  let title = "";
  const titleText = properties.get("title");
  if (titleText) {
    const value = evaluateLiteral(titleText);
    if (typeof value === "string") title = value;
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
    // Imported and builder-produced schemas are resolved by the Vite plugin
    // from the server-only capability module. Keep this pass non-executing:
    // callers that cannot load the module receive null and can report the
    // same conservative unknown state they use for other opaque metadata.
    if (isPlainObject(value)) inputSchema = value;
  }

  return {
    title,
    description,
    effect,
    httpPath,
    webmcp,
    webmcpUntrustedContent,
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

/** Parse the `capabilities: { ... }` block of an app manifest source. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  const appBody = extractDefineAppObjectBody(manifestSource);
  if (!appBody) return [];
  const capabilitiesValue = scanTopLevelProperties(appBody).get("capabilities");
  if (!capabilitiesValue) return [];
  const braceStart = skipInsignificant(capabilitiesValue, 0);
  if (capabilitiesValue[braceStart] !== "{") return [];
  const braceEnd = findMatchingBrace(capabilitiesValue, braceStart, "{", "}");
  if (braceEnd === -1) return [];
  const block = capabilitiesValue.slice(braceStart + 1, braceEnd);
  const searchableBlock = maskComments(block);

  const entries: { name: string; file: string }[] = [];
  // Keys are usually quoted ("notes.search"); values are either lazy import
  // functions or plain string paths (post-transform form).
  const pattern =
    /(?:(["'])((?:\\.|(?!\1).)+)\1|([A-Za-z0-9_$]+))\s*:\s*(?:\(\)\s*=>\s*import\(\s*(["'])([^"']+)\4\s*\)|(["'])([^"']+)\6)/g;
  for (const match of searchableBlock.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], file: match[5] ?? match[7] });
  }
  return entries;
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

/** Read a pages boolean policy without evaluating application code. */
export function readPageStreaming(source: string): boolean | "invalid" | undefined {
  const declarations = [
    ...maskCommentsAndStrings(source).matchAll(/export\s+const\s+STREAMING\s*=/g),
  ];
  if (declarations.length === 0) return undefined;
  if (declarations.length !== 1) return "invalid";
  const match = declarations[0]!;
  const value = source
    .slice(match.index! + match[0].length)
    .match(/^\s*(true|false)\s*(?:;|\r?\n|$)/);
  return value ? value[1] === "true" : "invalid";
}

export {
  PUBLIC_ENV_PREFIX,
  VITE_BUILTIN_ENV_VARS,
  WHOLE_ENV_READ,
  scanCodeForEnvLeaks,
  getCodePositionMask,
} from "./source-analysis.ts";
export type { EnvLeakReference } from "./source-analysis.ts";
export {
  PAGES_APP_CONFIG_EXPORTS,
  pagesShellName,
  findOwningPagesShell,
  maskMarkdownFences,
} from "./pages-analysis.ts";

/** Inspect one pages-router string declaration without executing its module. */
export function readPageStringExport(
  source: string,
  name: string,
): { count: number; value?: string } {
  const declarations = [
    ...maskCommentsAndStrings(source).matchAll(new RegExp(`export\\s+const\\s+${name}\\s*=`, "g")),
  ];
  const declaration = declarations[0];
  const value =
    declarations.length === 1
      ? source
          .slice((declaration.index ?? 0) + declaration[0].length)
          .trimStart()
          .match(/^["'](\w+)["']/)?.[1]
      : undefined;
  return { count: declarations.length, value };
}

export type PageRevalidation =
  | { kind: "missing" }
  | { kind: "time"; seconds: number }
  | { kind: "invalid"; expression: string; reason: "duplicate" | "expression" | "range" };

export function readPageRevalidation(source: string): PageRevalidation {
  const matches = [
    ...maskCommentsAndStrings(source).matchAll(/export\s+const\s+REVALIDATE\s*=\s*([^;\n]+)/g),
  ];
  if (!matches.length) return { kind: "missing" };
  if (matches.length > 1)
    return { kind: "invalid", expression: "duplicate exports", reason: "duplicate" };
  const expression = matches[0][1].trim().replace(/\s+as\s+const$/, "");
  if (!/^\d(?:_?\d)*$/.test(expression))
    return { kind: "invalid", expression, reason: "expression" };
  const seconds = Number(expression.replaceAll("_", ""));
  return Number.isSafeInteger(seconds) && seconds > 0
    ? { kind: "time", seconds }
    : { kind: "invalid", expression, reason: "range" };
}
