/**
 * Static analysis of capability sources — shared by the Vite plugin (client
 * projection codegen) and the CLI (`pracht verify`, `pracht typegen`). Every
 * consumer parses the same `defineCapability({ ... })` call sites without
 * executing application code. Domain extraction stays here; offset-preserving
 * lexing and inline-literal parsing live in `static-source-parser.ts`.
 *
 * Constraint this imposes on capability authors: values the tools need
 * (`expose`, `effect`, `input`, string fields) must be inline literals — no
 * imported constants or spreads. `evaluateLiteral()` parses the literal text
 * as data and returns `undefined` for anything else.
 */

import { capabilityHttpPath, isValidCapabilityHttpPath } from "./protocol.ts";
import {
  evaluateLiteral,
  findMatchingBrace,
  findQuotedObjectProperty,
  findStringEnd,
  maskComments,
  maskCommentsAndStrings,
  skipInsignificant,
  skipToTopLevelComma,
} from "./static-source-parser.ts";

export { evaluateLiteral, maskCommentsAndStrings };

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
