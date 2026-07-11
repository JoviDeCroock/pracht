/**
 * Build-time capability projection for the browser.
 *
 * The client never loads capability modules (they are server-only), so the
 * `virtual:pracht/capabilities` and `virtual:pracht/webmcp` modules are
 * generated from static analysis of the app manifest and the registered
 * capability sources — the same approach the plugin already uses for
 * hydration-mode excludes. Only serializable metadata crosses the boundary:
 * capability names, HTTP endpoints, and (for WebMCP tools) description,
 * effect, and input schema.
 *
 * Constraint this imposes: a capability's `expose` and `input` values must be
 * inline object literals (no imported constants or spreads of identifiers) —
 * the extractor evaluates the literal text as data. Extraction failures fail
 * the build with a pointer to the offending file rather than silently
 * dropping an endpoint.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export interface ExtractedCapability {
  name: string;
  /** Manifest-relative module path, e.g. "./capabilities/notes-search.ts". */
  file: string;
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  inputSchema: Record<string, unknown> | null;
}

/** Default HTTP path for a capability name — mirrors `@pracht/core`. */
function capabilityHttpPath(name: string): string {
  return `/api/capabilities/${name.split(".").join("/")}`;
}

/**
 * Extract capability registrations (name → module path) from the app
 * manifest source and their exposure metadata from each capability source.
 * Pages-router apps have no manifest, so capabilities are manifest-mode only.
 */
export function extractCapabilities(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): ExtractedCapability[] {
  const resolved = resolveOptions(options);
  if (resolved.pagesDir) return [];

  const appFileAbs = resolve(root, resolved.appFile.replace(/^\//, ""));
  let manifestSource: string;
  try {
    manifestSource = readFileSync(appFileAbs, "utf-8");
  } catch {
    return [];
  }

  const registrations = extractCapabilityRegistrations(manifestSource);
  if (registrations.length === 0) return [];

  const appDir = dirname(appFileAbs);
  return registrations.map(({ name, file }) => {
    const capabilityFileAbs = resolve(appDir, file);
    let source: string;
    try {
      source = readFileSync(capabilityFileAbs, "utf-8");
    } catch {
      throw new Error(
        `[pracht] Capability "${name}" references missing file ${JSON.stringify(file)}.`,
      );
    }
    return extractCapabilityMetadata(name, file, source);
  });
}

/** Parse the `capabilities: { ... }` block of the app manifest. */
export function extractCapabilityRegistrations(
  manifestSource: string,
): { name: string; file: string }[] {
  const block = findTopLevelObjectProperty(manifestSource, "capabilities");
  if (!block) return [];

  const entries: { name: string; file: string }[] = [];
  // Keys are usually quoted ("notes.search"); values are either lazy import
  // functions or plain string paths (post-transform form).
  const pattern =
    /(?:(["'])((?:\\.|(?!\1).)+)\1|([A-Za-z0-9_$]+))\s*:\s*(?:\(\)\s*=>\s*import\(\s*(["'])([^"']+)\4\s*\)|(["'])([^"']+)\6)/g;
  for (const match of block.matchAll(pattern)) {
    entries.push({ name: match[2] ?? match[3], file: match[5] ?? match[7] });
  }
  return entries;
}

function extractCapabilityMetadata(
  name: string,
  file: string,
  source: string,
): ExtractedCapability {
  const args = extractDefineCapabilityArgs(source);
  if (!args) {
    throw new Error(
      `[pracht] Capability "${name}" (${file}) does not contain a ` +
        "defineCapability({ ... }) call the build can analyze.",
    );
  }

  const properties = scanTopLevelProperties(args);
  const exposeText = properties.get("expose");
  if (!exposeText) {
    // Private capability: server-only, nothing to project to the client.
    return {
      name,
      file,
      description: "",
      effect: null,
      httpPath: null,
      webmcp: false,
      inputSchema: null,
    };
  }

  const expose = evaluateLiteral(exposeText);
  if (!isPlainObject(expose)) {
    throw new Error(
      `[pracht] Capability "${name}" (${file}): "expose" must be an inline object ` +
        "literal so the client projection can be generated at build time.",
    );
  }

  const http = expose.http;
  let httpPath: string | null = null;
  if (http === true) {
    httpPath = capabilityHttpPath(name);
  } else if (isPlainObject(http)) {
    httpPath = typeof http.path === "string" ? http.path : capabilityHttpPath(name);
  }

  const webmcp = expose.webmcp === true;
  if (webmcp && !httpPath) {
    throw new Error(`[pracht] Capability "${name}" (${file}): expose.webmcp requires expose.http.`);
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

  let inputSchema: Record<string, unknown> | null = null;
  if (webmcp) {
    const inputText = properties.get("input");
    const value = inputText ? evaluateLiteral(inputText) : undefined;
    if (!isPlainObject(value)) {
      throw new Error(
        `[pracht] Capability "${name}" (${file}) is exposed via WebMCP, but its "input" ` +
          "schema could not be extracted at build time. WebMCP-exposed capabilities must " +
          "declare their input schema as an inline object literal.",
      );
    }
    inputSchema = value;
  }

  return { name, file, description, effect, httpPath, webmcp, inputSchema };
}

/**
 * Generate `virtual:pracht/capabilities` — the browser-side `callCapability`
 * helper plus the endpoint map for http-exposed capabilities. Side-effect
 * free, so it costs zero bytes unless application code imports it.
 */
export function createPrachtCapabilitiesClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const capabilities = extractCapabilities(options, buildOptions.root);
  const endpoints: Record<string, { method: string; path: string }> = {};
  for (const capability of capabilities) {
    if (capability.httpPath) {
      endpoints[capability.name] = { method: "POST", path: capability.httpPath };
    }
  }

  return [
    "// Generated by @pracht/vite-plugin from the app manifest capability registrations.",
    "// Contains only http-exposed capability names and endpoints — capability",
    "// modules themselves are server-only and never reach the client graph.",
    `const endpoints = ${JSON.stringify(endpoints)};`,
    "",
    "export const capabilityEndpoints = endpoints;",
    "",
    "export async function callCapability(name, input, opts) {",
    "  const endpoint = endpoints[name];",
    "  if (!endpoint) {",
    "    return {",
    "      ok: false,",
    "      error: {",
    '        code: "unknown_capability",',
    '        message: `No HTTP-exposed capability named "${name}" is registered.`,',
    "      },",
    "    };",
    "  }",
    "  let response;",
    "  try {",
    "    const headers = new Headers(opts && opts.headers);",
    '    headers.set("content-type", "application/json");',
    "    response = await fetch(endpoint.path, {",
    "      method: endpoint.method,",
    "      headers,",
    "      body: JSON.stringify(input === undefined ? {} : input),",
    '      credentials: "same-origin",',
    "      signal: opts && opts.signal,",
    "    });",
    "  } catch (error) {",
    "    return {",
    "      ok: false,",
    '      error: { code: "network_error", message: String((error && error.message) || error) },',
    "    };",
    "  }",
    "  try {",
    "    return await response.json();",
    "  } catch {",
    "    return {",
    "      ok: false,",
    "      error: {",
    '        code: "invalid_response",',
    "        message: `Capability endpoint returned a non-JSON response (status ${response.status}).`,",
    "      },",
    "    };",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Generate `virtual:pracht/webmcp` — the disposable WebMCP registration shim.
 * One page tool per `expose.webmcp` capability; `execute` dispatches through
 * `callCapability`, so the user's session authenticates the call and all
 * validation/middleware/policy stays server-side.
 *
 * Targets the Chrome origin-trial API: `document.modelContext.registerTool()`
 * (Chrome 150+; `navigator.modelContext` is the deprecated pre-150 location
 * and is kept as a fallback). No-ops silently when the API is absent.
 */
export function createPrachtWebmcpModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const capabilities = extractCapabilities(options, buildOptions.root).filter(
    (capability) => capability.webmcp,
  );

  const tools = capabilities.map((capability) => ({
    name: capability.name,
    description: capability.description,
    effect: capability.effect,
    inputSchema: capability.inputSchema,
  }));

  return [
    "// Generated by @pracht/vite-plugin — WebMCP page-tool registration shim.",
    'import { callCapability } from "virtual:pracht/capabilities";',
    "",
    `const tools = ${JSON.stringify(tools)};`,
    "",
    "export function registerPrachtWebmcpTools() {",
    "  const modelContext =",
    '    (typeof document !== "undefined" && document.modelContext) ||',
    '    (typeof navigator !== "undefined" && navigator.modelContext) ||',
    "    null;",
    '  if (!modelContext || typeof modelContext.registerTool !== "function") {',
    "    return false;",
    "  }",
    "  for (const tool of tools) {",
    "    try {",
    "      const registration = modelContext.registerTool({",
    "        name: tool.name,",
    "        description: tool.description,",
    "        inputSchema: tool.inputSchema,",
    '        annotations: { readOnlyHint: tool.effect === "read" },',
    "        async execute(input) {",
    "          const result = await callCapability(tool.name, input);",
    '          return { content: [{ type: "text", text: JSON.stringify(result) }] };',
    "        },",
    "      });",
    '      if (registration && typeof registration.catch === "function") {',
    "        registration.catch(() => {});",
    "      }",
    "    } catch {",
    "      // Origin-trial API surface may shift; a failed registration must",
    "      // never break the page.",
    "    }",
    "  }",
    "  return true;",
    "}",
    "",
    "registerPrachtWebmcpTools();",
    "",
  ].join("\n");
}

/**
 * Snippet appended to the client entry / islands bootstrap when at least one
 * capability opts into WebMCP. Feature-detects before importing so browsers
 * without the origin trial never pay for the shim chunk.
 */
export function createWebmcpBootstrapSource(): string[] {
  return [
    "// WebMCP page tools — loaded only when the browser exposes the API.",
    "if (",
    '  typeof document !== "undefined" &&',
    '  (document.modelContext || (typeof navigator !== "undefined" && navigator.modelContext))',
    ") {",
    '  import("virtual:pracht/webmcp").catch(() => {});',
    "}",
    "",
  ];
}

export function hasWebmcpCapabilities(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): boolean {
  try {
    return extractCapabilities(options, root).some((capability) => capability.webmcp);
  } catch {
    // Extraction errors surface when the virtual modules are generated.
    return true;
  }
}

// ---------------------------------------------------------------------------
// Static analysis helpers
// ---------------------------------------------------------------------------

/**
 * Extract the argument object text of the first `defineCapability({ ... })`
 * call. Matches the call site (optionally with a type argument), not the
 * import statement's `defineCapability` binding.
 */
function extractDefineCapabilityArgs(source: string): string | null {
  const callMatch = /defineCapability\s*(?:<[^(]*?>)?\s*\(/.exec(source);
  if (!callMatch || callMatch.index == null) return null;
  const braceStart = source.indexOf("{", callMatch.index + callMatch[0].length - 1);
  if (braceStart === -1) return null;
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}

/**
 * Scan an object literal body for its top-level properties, returning a map
 * of property name → raw value text. Depth-aware and quote/comment-aware so
 * nested schema annotations (e.g. a `description` inside `input`) are never
 * mistaken for capability fields.
 */
export function scanTopLevelProperties(objectBody: string): Map<string, string> {
  const properties = new Map<string, string>();
  let index = 0;

  while (index < objectBody.length) {
    index = skipInsignificant(objectBody, index);
    if (index >= objectBody.length) break;

    // Property key: identifier or quoted string.
    let key: string | null = null;
    const char = objectBody[index];
    if (char === '"' || char === "'") {
      const end = findStringEnd(objectBody, index);
      if (end === -1) break;
      key = objectBody.slice(index + 1, end);
      index = end + 1;
    } else {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(objectBody.slice(index));
      if (!match) break;
      key = match[0];
      index += match[0].length;
    }

    index = skipInsignificant(objectBody, index);
    if (objectBody[index] !== ":") {
      // Shorthand or method definitions — skip to the next top-level comma.
      index = skipToTopLevelComma(objectBody, index);
      continue;
    }
    index += 1;

    const valueStart = skipInsignificant(objectBody, index);
    const valueEnd = skipToTopLevelComma(objectBody, valueStart);
    properties.set(key, objectBody.slice(valueStart, valueEnd).trim());
    index = valueEnd + 1;
  }

  return properties;
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

/** Index of the closing quote of the string starting at `start`. */
function findStringEnd(source: string, start: number): number {
  const quote = source[start];
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
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * Evaluate an extracted literal expression as plain data. This runs at build
 * time on the application's own source (exactly like Vite evaluating the
 * app's config); expressions referencing imports simply fail and return
 * undefined so callers can produce a targeted error.
 */
function evaluateLiteral(expression: string): unknown {
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return (${expression});`)();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Find the raw text of a top-level-ish `key: { ... }` property anywhere in a
 * source file (used for the manifest's `capabilities` block).
 */
function findTopLevelObjectProperty(source: string, key: string): string | null {
  const pattern = new RegExp(`\\b${key}\\s*:\\s*\\{`);
  const match = pattern.exec(source);
  if (!match || match.index == null) return null;
  const braceStart = source.indexOf("{", match.index);
  const braceEnd = findMatchingBrace(source, braceStart, "{", "}");
  if (braceEnd === -1) return null;
  return source.slice(braceStart + 1, braceEnd);
}
