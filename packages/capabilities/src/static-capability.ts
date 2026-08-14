import { capabilityHttpPath, isValidCapabilityHttpPath } from "./protocol.ts";
import { braceDepthAt, findCallInitializer } from "./static-module-binding.ts";
import { scanTopLevelPropertyEntries } from "./static-object.ts";
import { maskCommentsAndStrings } from "./static-source/mask.ts";
import { findMatchingBrace } from "./static-source/scan.ts";
import { evaluateLiteral } from "./static-literal.ts";

/** The statically readable portion of a capability's projected contract. */
export interface CapabilityProjection {
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  inputSchema: Record<string, unknown> | null;
  /**
   * Remote MCP exposure. Not part of the browser projection, but required by
   * graph fallbacks when a capability module cannot execute under Node.
   */
  mcp: boolean;
  /**
   * Per-capability Web Bot Auth policy, or `null` when it inherits the app
   * default. `undefined` means declared but not statically readable.
   */
  agentPolicy: string | null | undefined;
  /**
   * Named middleware, or `undefined` when declared as something other than an
   * inline array of string literals.
   */
  middleware: string[] | undefined;
}

/**
 * Derive a capability's projection from source without executing it.
 *
 * This is shared by Vite browser projection, CLI verification/typegen, and
 * graph fallback analysis. Unreadable exposure or guard state fails closed.
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
  // token we could not parse". Treating that as private could remove an
  // exposed capability from every generated projection.
  if (!exposeText && truncated) {
    throw new Error(
      describe(
        "contains a spread or computed key the build cannot analyze, so its `expose` could not be " +
          "read. Declare `expose`, `effect`, `agentPolicy`, and `middleware` as inline literals.",
      ),
    );
  }
  if (!exposeText) {
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
 * Extract the argument body of the default-exported `defineCapability()` call.
 * Analysis follows runtime identity: named-only helper calls are rejected.
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

function findDefaultExportedCallParen(searchable: string): number {
  const direct = /export\s+default\s+defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(searchable);
  if (direct && direct.index != null) {
    return direct.index + direct[0].length - 1;
  }

  const localName = defaultExportLocalName(searchable);
  if (localName) {
    const id = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaration = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b`, "g");
    for (const match of searchable.matchAll(declaration)) {
      if (match.index != null && braceDepthAt(searchable, match.index) === 0) {
        const paren = findCallInitializer(
          searchable,
          match.index + match[0].length,
          "defineCapability",
          CALL_SITE.source,
        );
        if (paren !== -1) return paren;
      }
    }
  }

  return -1;
}

/** Local binding name of a module's default export, or null. */
function defaultExportLocalName(searchable: string): string | null {
  const identifier = /export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(searchable);
  if (identifier && identifier[1] !== "defineCapability") return identifier[1];

  const aliased = /export\s*\{[^}]*?\b([A-Za-z_$][A-Za-z0-9_$]*)\s+as\s+default\b/.exec(searchable);
  return aliased ? aliased[1] : null;
}

/** Recover the guard fields a reviewer uses to detect widened agent access. */
function readGuardProperties(
  properties: Map<string, string>,
  truncated: boolean,
): Pick<CapabilityProjection, "agentPolicy" | "middleware"> {
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
