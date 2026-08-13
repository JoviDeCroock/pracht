/**
 * Shared resolved-app-graph serialization.
 *
 * Both `pracht inspect` (CLI) and the dev-only `/_pracht` devtools endpoint
 * (vite plugin) consume this module so they always report the same graph.
 * Module loading and file reading are injected by the caller to keep this
 * module platform-neutral.
 */

import { capabilityHttpPath } from "@pracht/capabilities";
import {
  extractCapabilityProjection,
  type CapabilityProjection,
} from "@pracht/capabilities/static";

import { resolveMcpEndpoint } from "./mcp-config.ts";
import type {
  HttpMethod,
  PrachtCapability,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  SpeculationOption,
} from "./types.ts";

export const API_METHOD_ORDER: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export interface AppGraphRoute {
  file: string;
  hydration: string | null;
  id: string;
  loaderCache: number | false | null;
  loaderFile: string | null;
  /** Present only when middleware-owned Markdown negotiation is declared. */
  markdown?: true;
  middleware: string[];
  path: string;
  prefetch: string | null;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
  speculation: SpeculationOption | null;
}

export interface AppGraphApiRoute {
  file: string;
  hasDefaultHandler: boolean;
  methods: string[];
  path: string;
}

export interface AppGraphCapability {
  /**
   * Per-capability Web Bot Auth policy override, or `null` when the capability
   * inherits the app default. Part of the graph because a reviewer cannot
   * otherwise tell whether an exposed capability demands a verified agent.
   */
  agentPolicy: string | null;
  /** Prose contract description — feeds generated JSDoc and agent-facing inspection. */
  description: string | null;
  effect: string | null;
  /**
   * Why this capability's module could not be read, or `null` when it was read
   * successfully. A capability that fails to load (most often because
   * `@pracht/capabilities` is not installed) would otherwise serialize
   * identically to a private capability with no effect class, so every
   * inspection surface would quietly under-report what the app exposes.
   *
   * Optional so existing constructors of this shape stay valid; producers that
   * load modules (`serializeCapabilities`) always set it.
   */
  error?: string | null;
  /**
   * Set when the module could not be executed *and* static analysis could not
   * recover every guard-shaped field (`agentPolicy`, `middleware`). Those are
   * what `pracht plan` warns on, so silently reporting the fallback's blanks
   * would let deleting a capability's auth middleware produce no diff at all.
   */
  unverifiedContract?: true;
  /** Reserved for the MCP Apps projection — always false for now. */
  hasUi: false;
  httpPath: string | null;
  /** Input JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  input: Record<string, unknown> | null;
  middleware: string[];
  name: string;
  /** Output JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  output: Record<string, unknown> | null;
  source: string;
  title: string | null;
  /** Exposure transports from the capability's `expose` config. */
  transports: string[];
}

export interface AppGraph {
  api: AppGraphApiRoute[];
  capabilities: AppGraphCapability[];
  /**
   * Path the remote MCP projection is served from, or `null` when the app does
   * not configure `agents.mcp` — in which case `expose.mcp` is recorded in the
   * graph but nothing serves it.
   */
  mcpEndpoint?: string | null;
  routes: AppGraphRoute[];
  /**
   * The app-level not-found page, serialized like a route. `null` when the app
   * declares none. It is reported separately from `routes` because it never
   * participates in matching.
   */
  notFound?: AppGraphRoute | null;
}

export interface AppGraphModuleAccess {
  /** Import an app module by its app-relative file path (e.g. Vite's `ssrLoadModule`). */
  loadModule: (file: string) => Promise<Record<string, unknown>>;
  /** Read an app module's source text — fallback method detection when importing fails. */
  readSource: (file: string) => string;
}

export interface SerializeCapabilitiesOptions {
  /** Fail the graph read when a registered capability module cannot load. */
  strict?: boolean;
}

export interface SerializeApiRoutesOptions {
  /** Fail the graph read instead of inferring exports when an API module cannot load. */
  strict?: boolean;
}

export interface AppGraphStaticModuleAccess {
  /** Read an app module by its app-relative file path. */
  readSource: (file: string) => string;
  /** Resolve a star re-export to another app-relative module. */
  resolveModule?: (specifier: string, importer: string) => string | null | Promise<string | null>;
}

export function serializeAppRoutes(routes: readonly ResolvedRoute[]): AppGraphRoute[] {
  return routes.map((route) => ({
    file: route.file,
    hydration: route.hydration ?? null,
    id: route.id ?? "",
    loaderCache: route.loaderCache ?? null,
    loaderFile: route.loaderFile ?? null,
    ...(route.markdown === true ? { markdown: true as const } : {}),
    middleware: route.middleware,
    path: route.path,
    prefetch: route.prefetch ?? null,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
    speculation: route.speculation ?? null,
  }));
}

export function serializeApiRoutes(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphModuleAccess,
  options: SerializeApiRoutesOptions = {},
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      try {
        const { hasDefaultHandler, methods } = options.strict
          ? apiExportsFromModule(await access.loadModule(route.file))
          : await detectApiExports(route.file, access);
        return {
          file: route.file,
          hasDefaultHandler,
          methods,
          path: route.path,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to load API route ${JSON.stringify(route.path)} from ${JSON.stringify(route.file)} while resolving the app graph: ${detail}`,
          { cause: error },
        );
      }
    }),
  );
}

/**
 * Serialize API method metadata without executing application modules.
 *
 * Used by the dev banner, where importing every API route at startup would run
 * unrelated top-level application work. Named re-exports expose their names
 * directly; star re-exports are followed through the caller's resolver.
 */
export function serializeApiRoutesStatic(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphStaticModuleAccess,
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      const { hasDefaultHandler, methods } = await detectApiExportsStatic(route.file, access);
      return {
        file: route.file,
        hasDefaultHandler,
        methods,
        path: route.path,
      };
    }),
  );
}

/**
 * Serialize registered capabilities by loading their modules. Modules that
 * fail to load (or don't export a capability) still appear in the graph with
 * null metadata so inspect/devtools can surface the broken registration.
 */
function readProjection(
  name: string,
  file: string,
  access: AppGraphModuleAccess,
): CapabilityProjection | null {
  try {
    return extractCapabilityProjection(name, access.readSource(file), (detail) => detail);
  } catch {
    return null;
  }
}

function projectionTransports(projection: CapabilityProjection | null): string[] {
  if (!projection) return [];
  const transports: string[] = [];
  if (projection.httpPath) transports.push("http");
  // Order matches the executed path so a fallback entry diffs against a
  // normally-read one without spurious churn.
  if (projection.mcp) transports.push("mcp");
  if (projection.webmcp) transports.push("webmcp");
  return transports;
}

export function serializeCapabilities(
  capabilities: Record<string, string> | undefined,
  access: AppGraphModuleAccess,
  options: SerializeCapabilitiesOptions = {},
): Promise<AppGraphCapability[]> {
  return Promise.all(
    Object.entries(capabilities ?? {}).map(async ([name, file]) => {
      try {
        const module = await access.loadModule(file);
        const capability = module.default as PrachtCapability | undefined;
        if (!capability || capability.kind !== "capability") {
          throw new Error("module does not default-export a capability");
        }

        const transports: string[] = [];
        if (capability.expose?.http) transports.push("http");
        if (capability.expose?.mcp) transports.push("mcp");
        if (capability.expose?.webmcp) transports.push("webmcp");

        return {
          agentPolicy: capability.agentPolicy ?? null,
          description: capability.description,
          effect: capability.effect,
          hasUi: false as const,
          httpPath: capability.expose?.http
            ? (capability.expose.http.path ?? capabilityHttpPath(name))
            : null,
          input: capability.input ?? null,
          middleware: capability.middleware ?? [],
          name,
          output: capability.output ?? null,
          source: file,
          title: capability.title,
          transports,
        };
      } catch (cause) {
        if (options.strict) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `Failed to load capability ${JSON.stringify(name)} from ${JSON.stringify(file)} while resolving the app graph: ${detail}`,
            { cause },
          );
        }
        // Falling back to static analysis rather than reporting nothing.
        //
        // A capability module that cannot be *executed* here is often perfectly
        // healthy: a Cloudflare capability importing `cloudflare:workers` at
        // the top level deploys fine, it just cannot load in the CLI's Node
        // graph server. Reporting `effect: null, transports: []` for it would
        // claim the app exposes nothing — under-reporting the agent surface in
        // the dev banner, `inspect`, the committed snapshot, and generated
        // types alike. The same extractor the browser projection is built from
        // reads `expose` and `effect` straight out of the source, so use it and
        // keep `error` set for the diagnostic.
        const projection = readProjection(name, file, access);
        // `undefined` from the extractor means "declared, but not readable
        // statically". Recording it as `null` / `[]` would claim the
        // capability has no agent policy and no middleware — the two fields a
        // reviewer reads to decide whether a change weakened a guard, and the
        // ones `pracht plan` warns on. `unverifiedContract` says so instead.
        const unverified =
          !projection ||
          projection.agentPolicy === undefined ||
          projection.middleware === undefined;
        return {
          agentPolicy: projection?.agentPolicy ?? null,
          description: projection?.description ?? null,
          effect: projection?.effect ?? null,
          error: cause instanceof Error ? cause.message : String(cause),
          unverifiedContract: unverified ? (true as const) : undefined,
          hasUi: false as const,
          httpPath: projection?.httpPath ?? null,
          input: projection?.inputSchema ?? null,
          middleware: projection?.middleware ?? [],
          name,
          output: null,
          source: file,
          title: null,
          transports: projectionTransports(projection),
        };
      }
    }),
  );
}

export async function buildAppGraph(
  options: {
    apiRoutes?: readonly ResolvedApiRoute[];
    app: ResolvedPrachtApp;
  } & AppGraphModuleAccess,
): Promise<AppGraph> {
  const notFound = options.app.notFound;
  return {
    api: await serializeApiRoutes(options.apiRoutes ?? [], options),
    capabilities: await serializeCapabilities(options.app.capabilities, options),
    mcpEndpoint: resolveMcpEndpoint(options.app.agents),
    notFound: notFound ? serializeAppRoutes([notFound])[0] : null,
    routes: serializeAppRoutes(options.app.routes),
  };
}

export interface ApiRouteExports {
  /** `true` when the module exports a default catch-all request handler. */
  hasDefaultHandler: boolean;
  methods: HttpMethod[];
}

export async function detectApiExports(
  file: string,
  access: AppGraphModuleAccess,
): Promise<ApiRouteExports> {
  try {
    return apiExportsFromModule(await access.loadModule(file));
  } catch {
    let source: string;
    try {
      source = access.readSource(file);
    } catch {
      return { hasDefaultHandler: false, methods: [] };
    }

    const maskedSource = maskJavaScriptCommentsAndStrings(source);
    const topLevelOffsets = findTopLevelOffsets(maskedSource);
    return {
      hasDefaultHandler: hasStaticallyCallableDefaultExport(maskedSource, topLevelOffsets),
      methods: API_METHOD_ORDER.filter((method) =>
        hasTopLevelMatch(
          maskedSource,
          new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
          topLevelOffsets,
        ),
      ),
    };
  }
}

function apiExportsFromModule(module: Record<string, unknown>): ApiRouteExports {
  return {
    hasDefaultHandler: typeof module.default === "function",
    methods: API_METHOD_ORDER.filter((method) => typeof module[method] === "function"),
  };
}

/** Detect API exports from source text only, following relative star re-exports. */
export async function detectApiExportsStatic(
  file: string,
  access: AppGraphStaticModuleAccess,
  seen: Set<string> = new Set(),
): Promise<ApiRouteExports> {
  if (seen.has(file)) {
    return { hasDefaultHandler: false, methods: [] };
  }
  seen.add(file);

  let rawSource: string;
  try {
    rawSource = access.readSource(file);
  } catch {
    return { hasDefaultHandler: false, methods: [] };
  }
  const source = maskJavaScriptCommentsAndStrings(rawSource);
  const topLevelOffsets = findTopLevelOffsets(source);

  const exportedNames = new Set<string>();
  const hasDefaultHandler = hasStaticallyCallableDefaultExport(source, topLevelOffsets);

  for (const method of API_METHOD_ORDER) {
    if (
      hasTopLevelMatch(
        source,
        new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`, "g"),
        topLevelOffsets,
      )
    ) {
      exportedNames.add(method);
    }
  }

  const namedExportPattern = /\bexport\s*\{([\s\S]*?)\}(?:\s*from\s*["'][^"']+["'])?/g;
  for (const match of source.matchAll(namedExportPattern)) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    for (const entry of match[1].split(",")) {
      const normalized = entry.trim();
      if (!normalized) continue;
      // Inline type-only specifiers (`export { type GET }`) are erased by
      // TypeScript and therefore cannot be API handlers at runtime.
      if (/^type\s+/.test(normalized)) continue;
      const parts = normalized.split(/\s+as\s+/);
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (exportedName !== "default") exportedNames.add(exportedName);
    }
  }

  if (access.resolveModule) {
    const starExportPattern = /\bexport\s*\*\s*from\s*(["'])/g;
    for (const match of source.matchAll(starExportPattern)) {
      if (!topLevelOffsets[match.index ?? 0]) continue;
      const quoteIndex = (match.index ?? 0) + match[0].lastIndexOf(match[1]);
      const specifier = readStringLiteral(rawSource, quoteIndex);
      if (!specifier) continue;
      const resolved = await access.resolveModule(specifier, file);
      if (!resolved) continue;
      const nested = await detectApiExportsStatic(resolved, access, seen);
      for (const method of nested.methods) exportedNames.add(method);
      // `export *` deliberately does not forward a default export.
    }
  }

  return {
    hasDefaultHandler,
    methods: API_METHOD_ORDER.filter((method) => exportedNames.has(method)),
  };
}

/** Recognize default handlers whose callable value is evident from local syntax. */
function hasStaticallyCallableDefaultExport(
  source: string,
  topLevelOffsets: Uint8Array = findTopLevelOffsets(source),
): boolean {
  const directDefaultPatterns = [
    /\bexport\s+default\s+(?:async\s+)?function(?:\s*\*)?(?:\s+[A-Za-z_$][\w$]*)?\s*\(/g,
    /\bexport\s+default\s+(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^;{}]*\))\s*=>/g,
  ];
  for (const pattern of directDefaultPatterns) {
    if (hasTopLevelMatch(source, pattern, topLevelOffsets)) return true;
  }

  const callableBindings = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:async\s+)?function(?:\s*\*)?\s+([A-Za-z_$][\w$]*)\s*\(/g,
  )) {
    if (
      !isModuleFunctionDeclaration(source, match.index ?? 0, topLevelOffsets) ||
      previousWord(source, match.index ?? 0) === "declare"
    ) {
      continue;
    }
    callableBindings.add(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*(?:async\s+)?function\b/g,
  )) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    callableBindings.add(match[1]);
  }
  for (const match of source.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=;]+)?\s*=\s*(?:async\s+)?(?:[A-Za-z_$][\w$]*|\([^;{}]*\))\s*=>/g,
  )) {
    if (!topLevelOffsets[match.index ?? 0]) continue;
    callableBindings.add(match[1]);
  }

  const defaultIdentifierPattern =
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)(?=[ \t]*(?:;|\r?\n|$))/g;
  for (const match of source.matchAll(defaultIdentifierPattern)) {
    if (topLevelOffsets[match.index ?? 0] && callableBindings.has(match[1])) return true;
  }

  const namedExportPattern = /\bexport\s*\{([\s\S]*?)\}(\s*from\s*["'][^"']*["'])?/g;
  for (const match of source.matchAll(namedExportPattern)) {
    if (!topLevelOffsets[match.index ?? 0] || match[2]) continue;
    for (const entry of match[1].split(",")) {
      const normalized = entry.trim();
      if (!normalized || /^type\s+/.test(normalized)) continue;
      const parts = normalized.split(/\s+as\s+/);
      const localName = parts[0].trim();
      const exportedName = (parts[1] ?? parts[0]).trim();
      if (exportedName === "default" && callableBindings.has(localName)) return true;
    }
  }

  return false;
}

/** Mark offsets whose token starts in module scope rather than inside nested syntax. */
function findTopLevelOffsets(source: string): Uint8Array {
  const offsets = new Uint8Array(source.length + 1);
  let nestingDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    offsets[index] = nestingDepth === 0 ? 1 : 0;
    if (source[index] === "{" || source[index] === "(" || source[index] === "[") {
      nestingDepth += 1;
    } else if (source[index] === "}" || source[index] === ")" || source[index] === "]") {
      nestingDepth = Math.max(0, nestingDepth - 1);
    }
  }
  offsets[source.length] = nestingDepth === 0 ? 1 : 0;
  return offsets;
}

function hasTopLevelMatch(source: string, pattern: RegExp, topLevelOffsets: Uint8Array): boolean {
  for (const match of source.matchAll(pattern)) {
    if (topLevelOffsets[match.index ?? 0]) return true;
  }
  return false;
}

function previousWord(source: string, offset: number): string | null {
  return /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, offset))?.[1] ?? null;
}

const MODULE_EXPRESSION_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/** Distinguish a module declaration from a same-depth named function expression. */
function isModuleFunctionDeclaration(
  source: string,
  offset: number,
  topLevelOffsets: Uint8Array,
): boolean {
  if (!topLevelOffsets[offset]) return false;

  const prefix = source.slice(0, offset);
  const trimmed = prefix.trimEnd();
  if (!trimmed || /[;}]$/.test(trimmed)) return true;

  const word = previousWord(source, offset);
  if (word === "export" || word === "default" || word === "declare") return true;

  const whitespace = prefix.slice(trimmed.length);
  if (!/[\r\n]/.test(whitespace)) return false;
  if (/[([{=,:!?&|+\-*%^~<>.]$/.test(trimmed) || /=>\s*$/.test(trimmed)) return false;

  return !MODULE_EXPRESSION_PREFIX_KEYWORDS.has(word ?? "");
}

/** Mask comments and string contents while preserving offsets and syntax punctuation. */
function maskJavaScriptCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      if (char === "\\") {
        result += " ";
        result += next === "\n" ? "\n" : next ? " " : "";
        index += 2;
        continue;
      }
      if (char === quote) {
        result += char;
        quote = null;
      } else {
        result += char === "\n" ? "\n" : " ";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      result += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < source.length) {
        result += "  ";
        index += 2;
      }
      continue;
    }

    if (char === "/" && canStartRegexLiteral(result)) {
      const regexEnd = findRegexLiteralEnd(source, index);
      if (regexEnd !== null) {
        while (index < regexEnd) {
          result += source[index] === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "case",
  "delete",
  "default",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const REGEX_CONTROL_KEYWORDS = new Set(["for", "if", "while", "with"]);

/** Decide whether `/` starts an expression rather than dividing one. */
function canStartRegexLiteral(maskedPrefix: string): boolean {
  const prefix = maskedPrefix.trimEnd();
  if (!prefix) return true;
  if (prefix.endsWith("++") || prefix.endsWith("--")) return false;

  const previous = prefix.at(-1) ?? "";
  if ("([{=,:;!?&|+-*%^~<>}".includes(previous)) return true;
  if (previous === ")" && followsControlCondition(prefix)) return true;

  const previousWord = /([A-Za-z_$][\w$]*)$/.exec(prefix)?.[1];
  return previousWord ? REGEX_PREFIX_KEYWORDS.has(previousWord) : false;
}

/** A regex may be the single statement following `if (...)`, `for (...)`, etc. */
function followsControlCondition(prefix: string): boolean {
  let depth = 0;
  for (let index = prefix.length - 1; index >= 0; index -= 1) {
    const char = prefix[index];
    if (char === ")") {
      depth += 1;
      continue;
    }
    if (char !== "(") continue;
    depth -= 1;
    if (depth !== 0) continue;

    const controlPrefix = prefix.slice(0, index).trimEnd();
    const keyword = /([A-Za-z_$][\w$]*)$/.exec(controlPrefix)?.[1];
    return keyword ? REGEX_CONTROL_KEYWORDS.has(keyword) : false;
  }
  return false;
}

/** Return the offset after a complete regex literal and its flags. */
function findRegexLiteralEnd(source: string, start: number): number | null {
  let inCharacterClass = false;

  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n" || char === "\r") return null;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      continue;
    }
    if (char !== "/" || inCharacterClass) continue;

    let end = index + 1;
    while (/[A-Za-z]/.test(source[end] ?? "")) end += 1;
    return end;
  }

  return null;
}

function readStringLiteral(source: string, quoteIndex: number): string | null {
  const quote = source[quoteIndex];
  if (quote !== '"' && quote !== "'") return null;

  let value = "";
  for (let index = quoteIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === quote) return value;
    if (char === "\\") {
      const escaped = source[index + 1];
      if (escaped === undefined) return null;
      value += escaped;
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\r") return null;
    value += char;
  }
  return null;
}

export async function detectApiMethods(
  file: string,
  access: AppGraphModuleAccess,
): Promise<HttpMethod[]> {
  return (await detectApiExports(file, access)).methods;
}
