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
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  CAPABILITY_SETTLED_EVENT,
  CAPABILITY_TRANSPORT_HEADER,
  CONFIRMATION_HEADER,
} from "@pracht/capabilities";
import {
  extractDefineAppObjectBody,
  extractCapabilityProjection,
  extractCapabilityRegistrations,
  scanTopLevelProperties,
} from "@pracht/capabilities/static";
import { generatePagesManifestSource, scanPagesDirectory } from "./pages-router.ts";
import {
  resolveOptions,
  type PrachtPluginOptions,
  type ResolvedPrachtPluginOptions,
} from "./plugin-options.ts";

export { extractCapabilityRegistrations };

/**
 * The app manifest source these analyzers read.
 *
 * In pages mode there is no manifest file, so the generated one is
 * synthesized here — the exact source the virtual module serves. Analyzing the
 * generated text rather than re-deriving the registry from the file system is
 * what keeps pages mode and manifest mode from ever disagreeing about which
 * capabilities exist and how they are exposed.
 *
 * Throws when the manifest cannot be read or the pages tree is invalid; each
 * caller decides whether that means "assume the worst" or "report nothing".
 */
function readAppManifestSource(resolved: ResolvedPrachtPluginOptions, root: string): string {
  if (!resolved.pagesDir) {
    return readFileSync(resolve(root, resolved.appFile.replace(/^\//, "")), "utf-8");
  }

  const pagesDir = resolve(root, resolved.pagesDir.replace(/^\//, ""));
  const source = generatePagesManifestSource(
    scanPagesDirectory(pagesDir, [...resolved.additionalExtensions]),
    {
      additionalExtensions: resolved.additionalExtensions,
      capabilitiesDir: resolve(root, resolved.capabilitiesDir.replace(/^\//, "")),
      capabilitiesDirPrefix: resolved.capabilitiesDir,
      pagesDir,
      pagesDefaultRender: resolved.pagesDefaultRender,
      pagesDirPrefix: resolved.pagesDir,
    },
  );
  // `extractDefineAppObjectBody()` looks for an exported `app`, which the
  // virtual module deliberately does not have (it re-exports through the
  // registry instead).
  return source.replace("const app = defineApp(", "export const app = defineApp(");
}

/** The directory manifest-relative module refs resolve against. */
function appManifestDir(resolved: ResolvedPrachtPluginOptions, root: string): string {
  return resolved.pagesDir
    ? resolve(root, resolved.pagesDir.replace(/^\//, ""), "..")
    : dirname(resolve(root, resolved.appFile.replace(/^\//, "")));
}

export interface ExtractedCapability {
  name: string;
  /** Manifest-relative module path, e.g. "./capabilities/notes-search.ts". */
  file: string;
  title: string;
  description: string;
  effect: string | null;
  httpPath: string | null;
  webmcp: boolean;
  webmcpUntrustedContent: boolean;
  inputSchema: Record<string, unknown> | null;
}

/**
 * Whether the app can reach the agent surface at all — registered capabilities
 * or a `defineApp({ agents })` config. Drives the `__PRACHT_AGENT_SURFACE__`
 * define, which lets the bundler drop the capability and Web Bot Auth runtimes
 * from the server bundle of apps that use neither.
 *
 * Deliberately one-sided: it only answers `false` when the manifest is readable
 * and provably free of both. An unreadable manifest, a parse failure, or any
 * spread inside the manifest file (which could carry registrations this
 * analyzer cannot see) answers `true`, so the runtime keeps deciding for
 * itself. Being wrong the other way would 404 a capability in production that
 * works in dev.
 */
export function hasAgentSurface(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): boolean {
  const resolved = resolveOptions(options);

  let manifestSource: string;
  try {
    manifestSource = readAppManifestSource(resolved, root);
  } catch {
    return true;
  }

  const appBody = extractDefineAppObjectBody(manifestSource);
  // A non-literal defineApp(config) call is opaque to static analysis. It may
  // carry capabilities or agents, so keep the runtime rather than silently
  // changing production behavior.
  if (appBody === null) return true;

  // Decode quoted property keys before deciding. The regex also covers
  // ordinary identifier and shorthand properties without requiring a value.
  const properties = scanTopLevelProperties(appBody);
  if (properties.has("agents") || properties.has("capabilities")) return true;
  if (/\b(?:agents|capabilities)\b/.test(appBody)) return true;
  // Spreads, computed keys, and escaped identifier keys can hide either name
  // behind syntax this lightweight analyzer does not fully evaluate.
  if (appBody.includes("...") || hasOpaqueTopLevelProperty(appBody)) return true;

  try {
    return extractCapabilityRegistrations(manifestSource).length > 0;
  } catch {
    return true;
  }
}

/** Whether an object literal body contains an opaque key at its top level. */
function hasOpaqueTopLevelProperty(objectBody: string): boolean {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let expectingKey = true;

  for (let index = 0; index < objectBody.length; index += 1) {
    const char = objectBody[index];
    const next = objectBody[index + 1];

    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      for (index += 1; index < objectBody.length; index += 1) {
        if (objectBody[index] === "\\") {
          index += 1;
        } else if (objectBody[index] === quote) {
          break;
        }
      }
      continue;
    }

    if (char === "/" && next === "/") {
      index = objectBody.indexOf("\n", index + 2);
      if (index === -1) break;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = objectBody.indexOf("*/", index + 2);
      if (end === -1) return true;
      index = end + 1;
      continue;
    }
    // Distinguishing division from a regular-expression literal requires a
    // full lexer. Treat either as opaque: counting delimiters inside a regex
    // could otherwise hide a later computed agent-surface key and make this
    // production-only optimization incorrectly answer false.
    if (char === "/") return true;

    const atTopLevel = braces === 0 && brackets === 0 && parentheses === 0;
    if (atTopLevel && expectingKey && char === "[") return true;
    if (atTopLevel && expectingKey && char === "\\") return true;
    if (atTopLevel && char === ":") expectingKey = false;
    if (atTopLevel && char === ",") expectingKey = true;

    if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "(") parentheses += 1;
    else if (char === ")") parentheses -= 1;
  }

  return false;
}

/**
 * Extract capability registrations (name → module path) from a manifest app
 * or the pages router's generated manifest, then read exposure metadata from
 * each capability source.
 */
export function extractCapabilities(
  options: PrachtPluginOptions = {},
  root: string = process.cwd(),
): ExtractedCapability[] {
  const resolved = resolveOptions(options);

  let manifestSource: string;
  try {
    manifestSource = readAppManifestSource(resolved, root);
  } catch {
    return [];
  }

  const registrations = extractCapabilityRegistrations(manifestSource);
  if (registrations.length === 0) return [];

  const appDir = appManifestDir(resolved, root);
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

  let manifestSource: string;
  try {
    manifestSource = readAppManifestSource(resolved, root);
  } catch {
    return [];
  }

  const appDir = appManifestDir(resolved, root);
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
  const endpoints: Record<string, { method: string; path: string; effect: string | null }> =
    Object.create(null);
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
    'import { createUseCapability, ensureCapabilityRevalidation, withBase } from "@pracht/core";',
    "",
    // A null prototype makes unknown names such as "toString" miss normally;
    // JSON.parse preserves an own "__proto__" key instead of invoking the
    // object-literal prototype setter.
    `const endpoints = Object.assign(Object.create(null), JSON.parse(${JSON.stringify(
      JSON.stringify(endpoints),
    )}));`,
    "",
    "export const capabilityEndpoints = endpoints;",
    "",
    "async function dispatchCapability(endpoint, input, opts) {",
    "  let response;",
    "  try {",
    "    const headers = new Headers(opts && opts.headers);",
    '    headers.set("content-type", "application/json");',
    "    if (opts && opts.prepare) {",
    // `prepare` is a safety promise, not only a type marker. A wrapper may
    // forward caller headers that already contain a token; remove it so this
    // request can only receive a fresh token and can never commit.
    `      headers.delete(${JSON.stringify(CONFIRMATION_HEADER)});`,
    "    } else if (opts && opts.confirm) {",
    `      headers.set(${JSON.stringify(CONFIRMATION_HEADER)}, opts.confirm);`,
    "    }",
    // Capability paths are declared without the deploy base; the request
    // carries it.
    "    response = await fetch(withBase(endpoint.path), {",
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
    "  let result;",
    "  try {",
    "    result = await response.json();",
    "  } catch {",
    "    return {",
    "      ok: false,",
    "      error: {",
    '        code: "invalid_response",',
    "        message: `Capability endpoint returned a non-JSON response (status ${response.status}).`,",
    "      },",
    "    };",
    "  }",
    "  if (",
    '    !result || typeof result !== "object" ||',
    "    (result.ok !== true && result.ok !== false) ||",
    '    (result.ok === true && !("data" in result)) ||',
    "    (result.ok === false &&",
    '      (!result.error || typeof result.error !== "object" ||',
    '        typeof result.error.code !== "string" || typeof result.error.message !== "string"))',
    "  ) {",
    "    return {",
    "      ok: false,",
    "      error: {",
    '        code: "invalid_response",',
    "        message: `Capability endpoint returned an invalid envelope (status ${response.status}).`,",
    "      },",
    "    };",
    "  }",
    "  return result;",
    "}",
    "",
    "export async function callCapability(name, input, opts) {",
    // This module owns one of the two CAPABILITY_SETTLED_EVENT dispatch paths
    // (`<Form capability>` owns the other), so it installs the listener that
    // revalidates route data. Apps with no capabilities never load this module
    // and so never pay for the revalidation runtime.
    "  ensureCapabilityRevalidation();",
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
    "  const root = Object.create(null);",
    "  for (const name of names) {",
    '    const segments = name.split(".");',
    "    const leaf = segments.pop();",
    "    let node = root;",
    "    for (const segment of segments) {",
    "      // A name that is both a namespace and a leaf (`a` plus `a.b`) would",
    "      // collide; the namespace wins and the leaf stays reachable through",
    "      // callCapability(). `pracht verify` reports the shadowed name.",
    '      if (typeof node[segment] !== "object" || node[segment] === null) {',
    "        node[segment] = Object.create(null);",
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
    "// The hook's implementation lives in @pracht/core (typed and unit-tested);",
    "// only the app-specific dispatch is bound here, so every projection shares",
    "// one call path. Pure-annotated: apps that never call it pay nothing.",
    "export const useCapability = /*@__PURE__*/ createUseCapability(callCapability);",
    "",
  ].join("\n");
}

/**
 * Generate `virtual:pracht/webmcp` — the WebMCP registration shim.
 * One page tool per `expose.webmcp` capability; dispatch goes through
 * `callCapability`, so the user's session authenticates the call and all
 * validation/middleware/policy stays server-side. Each dispatch carries the
 * transport marker header so audit events can attribute it to WebMCP.
 *
 * The registration runtime — feature detection, `registerTool()` calls, and
 * the WebMCP annotation policy — lives in
 * `@pracht/capabilities/webmcp` (published, so non-pracht sites register tools
 * with identical semantics); this module only
 * contributes the statically extracted tool metadata and the app-specific
 * dispatch. The registrar import is resolved from *this plugin's* copy of
 * `@pracht/capabilities` at codegen time: the virtual module has no importer
 * on disk, so a bare specifier would resolve against the app root — where an
 * older installed copy may predate the `./webmcp` entry point. The registrar
 * is stateless, so using the plugin's copy cannot split state.
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
    // The spec's optional `title` feeds host UI (e.g. ChatGPT's "Site tools"
    // list). Omitted when not statically extractable rather than guessed.
    ...(capability.title ? { title: capability.title } : {}),
    description: capability.description,
    inputSchema: capability.inputSchema,
    // The registrar derives WebMCP's supported annotation hints from the
    // effect class. (destructive never reaches WebMCP.)
    ...(capability.effect ? { effect: capability.effect } : {}),
    ...(capability.webmcpUntrustedContent ? { untrustedContent: true } : {}),
  }));

  return [
    "// Generated by @pracht/vite-plugin — WebMCP page-tool registration shim.",
    `import { registerWebmcpTools } from ${JSON.stringify(resolveWebmcpRegistrarSpecifier())};`,
    'import { callCapability } from "virtual:pracht/capabilities";',
    "",
    `const tools = ${JSON.stringify(tools)};`,
    "const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));",
    `const transportHeaders = { ${JSON.stringify(CAPABILITY_TRANSPORT_HEADER)}: "webmcp" };`,
    "let registrationController;",
    "let activeNames = import.meta.hot?.data.activeNames ?? [];",
    "",
    "export function registerPrachtWebmcpTools(names) {",
    "  activeNames = [...new Set(names)];",
    "  registrationController?.abort();",
    "  registrationController = new AbortController();",
    "  return registerWebmcpTools(activeNames.flatMap((name) => {",
    "    const tool = toolsByName.get(name);",
    "    return tool ? [tool] : [];",
    "  }), (name, input, { signal } = {}) =>",
    "    callCapability(name, input, { headers: transportHeaders, signal }),",
    "    { signal: registrationController.signal },",
    "  );",
    "}",
    "",
    "if (import.meta.hot) {",
    "  import.meta.hot.dispose((data) => {",
    "    data.activeNames = activeNames;",
    "    registrationController?.abort();",
    "  });",
    "}",
    "",
    "if (activeNames.length > 0) registerPrachtWebmcpTools(activeNames);",
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
    "// WebMCP page tools — the active route owns the registration lifetime.",
    "let webmcpRouteGeneration = 0;",
    "let webmcpModulePromise;",
    "function syncPrachtWebmcpTools(capabilities) {",
    "  const generation = ++webmcpRouteGeneration;",
    '  if (typeof document === "undefined" || !document.modelContext) return;',
    "  if (capabilities.length === 0 && !webmcpModulePromise) return;",
    '  webmcpModulePromise ??= import("virtual:pracht/webmcp");',
    "  webmcpModulePromise.then((module) => {",
    "    if (generation === webmcpRouteGeneration) {",
    "      module.registerPrachtWebmcpTools(capabilities);",
    "    }",
    "  }).catch(() => {});",
    "}",
    "",
  ];
}

/**
 * Absolute module specifier for `@pracht/capabilities/webmcp`, resolved from
 * this plugin so the generated shim never depends on the app root carrying a
 * new-enough copy. Falls back to the bare specifier if resolution fails
 * (tests with unusual layouts); Vite then resolves it from the app root.
 */
function resolveWebmcpRegistrarSpecifier(): string {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@pracht/capabilities/webmcp").split("\\").join("/");
  } catch {
    return "@pracht/capabilities/webmcp";
  }
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
