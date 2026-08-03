/**
 * Build-time capability projection for the browser.
 *
 * The client never loads capability modules (they are server-only), so the
 * `virtual:pracht/capabilities` and `virtual:pracht/webmcp` modules are
 * generated from static analysis of the app manifest and the registered
 * capability sources — the same approach the plugin already uses for
 * hydration-mode excludes. Only serializable metadata crosses the boundary:
 * capability names, HTTP endpoints, effects, and (for WebMCP tools)
 * description and input schema.
 *
 * The static analyzer itself lives in `@pracht/capabilities/static` and is
 * shared with `pracht verify`, so the build and verification can never
 * disagree about what is analyzable. Constraint it imposes: a capability's
 * `expose`, HTTP-projected `effect`, and WebMCP `input` values must be inline
 * literals (no imported constants or spreads) — the extractor parses the
 * literal text as data.
 * Extraction failures fail the build with a pointer to the offending file
 * rather than silently dropping an endpoint.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CAPABILITY_SETTLED_EVENT,
  CAPABILITY_TRANSPORT_HEADER,
  CONFIRMATION_HEADER,
} from "@pracht/capabilities";
import {
  extractCapabilityProjection,
  extractCapabilityRegistrations,
} from "@pracht/capabilities/static";
import { resolveOptions, type PrachtPluginOptions } from "./plugin-options.ts";

export { extractCapabilityRegistrations };

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
    // Root-relative refs (`/src/capabilities/x.ts`) resolve against the Vite
    // root, matching the runtime registry loader; everything else is relative
    // to the app manifest's directory.
    const capabilityFileAbs = file.startsWith("/")
      ? resolve(root, file.replace(/^\//, ""))
      : resolve(appDir, file);
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

/**
 * Absolute paths of the capability modules the manifest registers.
 *
 * The client-import guard uses this rather than a `capabilitiesDir` prefix
 * test: registration is what makes a module server-only, and the manifest may
 * point anywhere. A directory test both misses capabilities registered from
 * elsewhere and wrongly rejects ordinary co-located files (shared constants,
 * types) that happen to sit in the capability folder.
 *
 * Returns an empty list when the manifest cannot be read or parsed — the
 * virtual-module generation raises its own precise error for those, and
 * guessing here would turn one clear failure into two confusing ones.
 */
export function resolveCapabilityModulePaths(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): string[] {
  const resolved = resolveOptions(options);
  if (resolved.pagesDir) return [];

  const appFileAbs = resolve(root, resolved.appFile.replace(/^\//, ""));
  let manifestSource: string;
  try {
    manifestSource = readFileSync(appFileAbs, "utf-8");
  } catch {
    return [];
  }

  const appDir = dirname(appFileAbs);
  return extractCapabilityRegistrations(manifestSource).map(({ file }) =>
    file.startsWith("/") ? resolve(root, file.replace(/^\//, "")) : resolve(appDir, file),
  );
}

function extractCapabilityMetadata(
  name: string,
  file: string,
  source: string,
): ExtractedCapability {
  // The projection rules live in @pracht/capabilities so the build, `pracht
  // verify`, and `pracht typegen` cannot drift on what a capability exposes.
  const projection = extractCapabilityProjection(
    name,
    source,
    (detail) => `[pracht] Capability ${JSON.stringify(name)} (${file}) ${detail}`,
  );
  return { name, file, ...projection };
}

/**
 * Generate `virtual:pracht/capabilities` — the browser-side `callCapability`
 * helper plus the endpoint map for http-exposed capabilities. Side-effect
 * free, so it costs zero bytes unless application code imports it.
 *
 * After every call settles, the helper announces itself on
 * CAPABILITY_SETTLED_EVENT with the capability's effect class; the framework
 * runtime revalidates route data for successful non-`read` calls (opt out
 * per call via `{ revalidate: false }`).
 */
export function createPrachtCapabilitiesClientModuleSource(
  options: PrachtPluginOptions = {},
  buildOptions: { root?: string } = {},
): string {
  const capabilities = extractCapabilities(options, buildOptions.root);
  const endpoints: Record<string, { method: string; path: string; effect: string | null }> = {};
  for (const capability of capabilities) {
    if (capability.httpPath) {
      endpoints[capability.name] = {
        method: "POST",
        path: capability.httpPath,
        effect: capability.effect,
      };
    }
  }

  return [
    "// Generated by @pracht/vite-plugin from the app manifest capability registrations.",
    "// Contains only http-exposed capability names, endpoints, and effects —",
    "// capability modules themselves are server-only and never reach the client graph.",
    `const endpoints = ${JSON.stringify(endpoints)};`,
    "",
    "export const capabilityEndpoints = endpoints;",
    "",
    "async function dispatchCapability(endpoint, input, opts) {",
    "  let response;",
    "  try {",
    "    const headers = new Headers(opts && opts.headers);",
    '    headers.set("content-type", "application/json");',
    "    if (opts && opts.confirm) {",
    `      headers.set(${JSON.stringify(CONFIRMATION_HEADER)}, opts.confirm);`,
    "    }",
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
    "  const result = await dispatchCapability(endpoint, input, opts);",
    "  // Announce the settled call so the route runtime can revalidate after",
    "  // successful non-read effects. Best-effort — never breaks the call.",
    "  try {",
    '    if (typeof window !== "undefined") {',
    `      window.dispatchEvent(new CustomEvent(${JSON.stringify(CAPABILITY_SETTLED_EVENT)}, {`,
    "        detail: {",
    "          name,",
    "          effect: endpoint.effect,",
    "          ok: result && result.ok === true,",
    "          revalidate: opts && opts.revalidate === false ? false : undefined,",
    "        },",
    "      }));",
    "    }",
    "  } catch {}",
    "  return result;",
    "}",
    "",
    "// Nested client: dotted capability names become object paths, so",
    '// `capabilities.notes.search(input)` calls `callCapability("notes.search", input)`.',
    "// Built from the same endpoint table, so there is one dispatch path.",
    "function buildCapabilityClient(names) {",
    "  const root = {};",
    "  for (const name of names) {",
    '    const segments = name.split(".");',
    "    const leaf = segments.pop();",
    "    let node = root;",
    "    for (const segment of segments) {",
    "      // A name that is both a namespace and a leaf (`a` plus `a.b`) would",
    "      // collide; the namespace wins and the leaf stays reachable through",
    "      // callCapability(). `pracht verify` reports the shadowed name.",
    '      if (typeof node[segment] !== "object" || node[segment] === null) {',
    "        node[segment] = {};",
    "      }",
    "      node = node[segment];",
    "    }",
    '    if (typeof node[leaf] !== "object") {',
    "      node[leaf] = (input, opts) => callCapability(name, input, opts);",
    "    }",
    "  }",
    "  return root;",
    "}",
    "",
    // Annotated pure so bundlers drop the whole client (and the builder) when an
    // app imports only `callCapability`, keeping the module's zero-cost promise.
    "export const capabilities = /*@__PURE__*/ buildCapabilityClient(Object.keys(endpoints));",
    "",
  ].join("\n");
}

/**
 * Generate `virtual:pracht/webmcp` — the disposable WebMCP registration shim.
 * One page tool per `expose.webmcp` capability; `execute` dispatches through
 * `callCapability`, so the user's session authenticates the call and all
 * validation/middleware/policy stays server-side. Each dispatch carries the
 * transport marker header so audit events can attribute it to WebMCP.
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
    `const transportHeaders = { ${JSON.stringify(CAPABILITY_TRANSPORT_HEADER)}: "webmcp" };`,
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
    "          const result = await callCapability(tool.name, input, { headers: transportHeaders });",
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
