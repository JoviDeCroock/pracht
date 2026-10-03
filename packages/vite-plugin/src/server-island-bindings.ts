import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

import { parse as parseModule } from "@babel/parser";

import { escapeForStringLiteral } from "./plugin-server-css.ts";

/**
 * Route↔server island binding.
 *
 * The server island endpoint (`/__pracht/server-island`) is asked to render server island R for
 * page path P. It only does so when the route P matches renders R: when R is
 * reachable through static imports from that route's own module or from its
 * shell module. The middleware that then runs, and the params the loader
 * sees, are exactly the ones that page runs and sees itself, so a server island is
 * never more reachable than the page that hosts it. See docs/SERVER_ISLANDS.md,
 * "Route binding".
 *
 * The map is `{ [route or shell registry key]: serverIsland files }`, both in the
 * form `import.meta.glob` keys take ("/src/routes/admin.tsx",
 * "/src/server-islands/AdminStats.tsx"), so the runtime can look a matched route's
 * modules up exactly as it loads them.
 *
 * - **Build:** computed once the server bundle is complete, resolving imports
 *   with the build's resolver, and spliced into a token in the generated
 *   server module.
 * - **Dev:** computed per server island request, resolving imports with the
 *   Vite server environment's resolver, and handed to the runtime in a
 *   request header this middleware owns.
 *
 * Both read each module's links from its source file and walk the same edges:
 * static `import` and `export … from`, never dynamic `import()`, never into
 * dependencies, virtual modules, or files outside the project root. A
 * re-export is followed only for the names its importer uses, so importing
 * `{ Button }` from a barrel does not bind the server islands that barrel
 * also re-exports.
 */

/** Spliced with the bindings JSON after the server bundle is written. */
export const SERVER_ISLAND_BINDINGS_TOKEN = "__PRACHT_SERVER_ISLAND_BINDINGS__";

// Mirrors @pracht/core server-islands-shared.ts; the plugin never imports runtime
// source directly.
const DEV_SERVER_ISLAND_BINDINGS_HEADER = "x-pracht-dev-server-island-bindings";
const SERVER_ISLAND_ENDPOINT = "/__pracht/server-island";

const SERVER_ISLAND_MODULE_RE = /\.(?:tsx?|jsx?)$/;

export type ServerIslandBindingsMap = Record<string, string[]>;

/**
 * What one module statically links to, by name.
 *
 * The walk only follows a re-export edge for the names its importer asks for,
 * so a route importing `{ Button }` from a barrel that also re-exports a
 * server island does not bind that server island.
 */
export interface ServerIslandModuleLinks {
  /**
   * `import` declarations: the bindings this module's own code may use.
   * `names` is the imported names, or `"*"` for a namespace import.
   */
  imports: Array<{ id: string; names: "*" | readonly string[] }>;
  /** `export { a as b } from` (`imported: "*"` for `export * as b from`). */
  reexports: Array<{ exported: string; id: string; imported: string }>;
  /** `export * from` targets. */
  starExports: string[];
  /** Names this module's own code exports (`default` included). */
  localExports: string[];
  /**
   * The module could not be read by name (not JavaScript, or it did not
   * parse): every link is in `imports` with `names: "*"`, and the walk treats
   * all of them as used.
   */
  opaque?: boolean;
}

/** How the walk sees one module graph. */
export interface ServerIslandGraph {
  /**
   * The glob-style key of a module the walk may enter ("/src/nav.tsx"), or
   * null to stop there: dependencies, virtual modules, and files outside the
   * project root cannot import app server islands, and entering them could only
   * widen a binding.
   */
  keyOf(id: string): string | null;
  /** The module's static links: `import`, `export … from`, never `import()`. */
  links(id: string): ServerIslandModuleLinks | Promise<ServerIslandModuleLinks>;
}

export interface ServerIslandBindingDirs {
  serverIslandsDir: string;
  routesDir: string;
  shellsDir: string;
  pagesDir: string;
}

/** "/src/server-islands", however the option was spelled. */
function dirKey(dir: string): string {
  return `/${dir
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")}`;
}

/** True for a key the generated server module registers as a server island. */
export function isServerIslandKey(key: string, serverIslandsDir: string): boolean {
  return (
    key.startsWith(`${dirKey(serverIslandsDir)}/`) &&
    SERVER_ISLAND_MODULE_RE.test(key) &&
    !key.endsWith(".d.ts") &&
    !key.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/** True for a key the runtime can load as a route or shell module. */
export function isRouteOrShellKey(key: string, dirs: ServerIslandBindingDirs): boolean {
  const roots = dirs.pagesDir ? [dirs.pagesDir] : [dirs.routesDir, dirs.shellsDir];
  return roots.some((dir) => key.startsWith(`${dirKey(dir)}/`));
}

type Demand = "*" | ReadonlySet<string>;

/**
 * Every server island reachable from `start` through static imports. A server island
 * imported with a query (`?raw`, `?url`) is a string, not a rendered
 * component, and does not count.
 *
 * The walk tracks which exported names each module is asked for. A module's
 * `import` declarations are followed once any of its own exports is used (its
 * code may use any of them); an `export … from` edge is followed only for the
 * names asked for, and `export *` only for names the module does not declare
 * itself. `start` is asked for everything.
 */
export async function collectBoundServerIslands(
  start: string,
  graph: ServerIslandGraph,
  serverIslandsDir: string,
): Promise<string[]> {
  const serverIslands = new Set<string>();
  const asked = new Map<string, { all: boolean; names: Set<string>; ownCode: boolean }>();
  const pending: Array<[string, Demand]> = [[start, "*"]];
  while (pending.length > 0) {
    const [id, demand] = pending.pop()!;
    const key = graph.keyOf(id);
    if (key === null) continue;

    let state = asked.get(id);
    const firstVisit = !state;
    if (!state) {
      state = { all: false, names: new Set(), ownCode: false };
      asked.set(id, state);
      if (!id.includes("?") && isServerIslandKey(key, serverIslandsDir)) serverIslands.add(key);
    }
    if (state.all) continue;
    let fresh: "*" | string[];
    if (demand === "*") {
      fresh = "*";
      state.all = true;
    } else {
      fresh = [...demand].filter((name) => !state.names.has(name));
      for (const name of fresh) state.names.add(name);
      if (fresh.length === 0 && !firstVisit) continue;
    }
    // A query import (`?raw`) is the file's text, not its code.
    if (id.includes("?")) continue;

    const links = await graph.links(id);
    const local = new Set(links.localExports);
    const forwarded = new Map<string, { id: string; imported: string }[]>();
    for (const reexport of links.reexports) {
      const list = forwarded.get(reexport.exported) ?? [];
      list.push(reexport);
      forwarded.set(reexport.exported, list);
    }

    const usesOwnCode = links.opaque || fresh === "*" || fresh.some((name) => local.has(name));
    if (usesOwnCode && !state.ownCode) {
      state.ownCode = true;
      for (const edge of links.imports) {
        pending.push([edge.id, edge.names === "*" ? "*" : new Set(edge.names)]);
      }
    }

    const names = fresh === "*" ? [...forwarded.keys()] : fresh;
    const throughStar: string[] = [];
    for (const name of names) {
      const targets = forwarded.get(name);
      if (targets) {
        for (const target of targets) {
          pending.push([target.id, target.imported === "*" ? "*" : new Set([target.imported])]);
        }
      } else if (!local.has(name) && name !== "default") {
        throughStar.push(name);
      }
    }
    if (fresh === "*" || throughStar.length > 0) {
      for (const target of links.starExports) {
        pending.push([target, fresh === "*" ? "*" : new Set(throughStar)]);
      }
    }
  }
  return [...serverIslands].sort();
}

/** Bindings for every start module that reaches at least one server island. */
export async function computeServerIslandBindings(
  starts: Iterable<string>,
  graph: ServerIslandGraph,
  serverIslandsDir: string,
): Promise<ServerIslandBindingsMap> {
  const bindings: ServerIslandBindingsMap = {};
  for (const start of starts) {
    const key = graph.keyOf(start);
    if (key === null) continue;
    const serverIslands = await collectBoundServerIslands(start, graph, serverIslandsDir);
    if (serverIslands.length > 0) bindings[key] = serverIslands;
  }
  return bindings;
}

// ---------------------------------------------------------------------------
// Module links from source
// ---------------------------------------------------------------------------

/** A module's links with their specifiers as written, before resolution. */
export interface ServerIslandSourceLinks {
  imports: Array<{ source: string; names: "*" | string[] }>;
  reexports: Array<{ exported: string; source: string; imported: string }>;
  starExports: string[];
  localExports: string[];
}

const SOURCE_MODULE_RE = /\.[cm]?[jt]sx?$/;

interface Node {
  [key: string]: any;
  type: string;
}

function nameOf(node: Node): string {
  return node.type === "StringLiteral" ? (node.value as string) : (node.name as string);
}

/** Identifiers a declaration pattern binds (`const { a, b: [c] } = …`). */
function patternNames(pattern: Node | null | undefined, into: string[]): void {
  if (!pattern) return;
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        patternNames(property.type === "RestElement" ? property.argument : property.value, into);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) patternNames(element, into);
      break;
    case "RestElement":
      patternNames(pattern.argument, into);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, into);
      break;
  }
}

/** Value names an `export <declaration>` binds; type-only declarations bind none. */
function declarationNames(declaration: Node): string[] {
  const names: string[] = [];
  if (declaration.declare) return names;
  switch (declaration.type) {
    case "VariableDeclaration":
      for (const declarator of declaration.declarations) patternNames(declarator.id, names);
      break;
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
      if (declaration.id?.type === "Identifier") names.push(declaration.id.name);
      break;
  }
  return names;
}

/**
 * Read a JavaScript or TypeScript module's static links by name, or null when
 * it does not parse. Type-only imports and exports are left out: they are
 * erased before the module runs.
 */
export function parseServerIslandSourceLinks(
  code: string,
  file: string,
): ServerIslandSourceLinks | null {
  const plugins: ("typescript" | "jsx")[] = [];
  if (/\.[cm]?tsx?$/.test(file)) plugins.push("typescript");
  if (!/\.[cm]?ts$/.test(file)) plugins.push("jsx");
  let body: Node[];
  try {
    body = (parseModule(code, { sourceType: "module", plugins }) as unknown as Node).program.body;
  } catch {
    return null;
  }

  const links: ServerIslandSourceLinks = {
    imports: [],
    reexports: [],
    starExports: [],
    localExports: [],
  };
  // Local names bound by `import`, so `import X from …; export { X }` is
  // read as the re-export it is.
  const importedBindings = new Map<string, { source: string; imported: string }>();
  for (const node of body) {
    if (node.type === "TSImportEqualsDeclaration") {
      if (node.importKind !== "type" && node.moduleReference.type === "TSExternalModuleReference") {
        links.imports.push({ source: node.moduleReference.expression.value, names: "*" });
      }
      continue;
    }
    if (node.type !== "ImportDeclaration" || node.importKind === "type") continue;
    const source = node.source.value as string;
    const specifiers = (node.specifiers as Node[]).filter((spec) => spec.importKind !== "type");
    if (node.specifiers.length > 0 && specifiers.length === 0) continue;
    let names: "*" | string[] = [];
    for (const spec of specifiers) {
      if (spec.type === "ImportNamespaceSpecifier") {
        names = "*";
        continue;
      }
      const imported = spec.type === "ImportDefaultSpecifier" ? "default" : nameOf(spec.imported);
      importedBindings.set(spec.local.name, { source, imported });
      if (names !== "*") names.push(imported);
    }
    links.imports.push({ source, names });
  }

  for (const node of body) {
    switch (node.type) {
      case "ExportNamedDeclaration": {
        if (node.exportKind === "type") break;
        if (node.declaration) {
          links.localExports.push(...declarationNames(node.declaration));
          break;
        }
        for (const spec of node.specifiers as Node[]) {
          if (spec.exportKind === "type") continue;
          const exported = nameOf(spec.exported);
          if (node.source) {
            links.reexports.push({
              exported,
              source: node.source.value,
              imported: spec.type === "ExportNamespaceSpecifier" ? "*" : nameOf(spec.local),
            });
          } else {
            const binding = importedBindings.get(nameOf(spec.local));
            if (binding) links.reexports.push({ exported, ...binding });
            else links.localExports.push(exported);
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const declaration = node.declaration as Node;
        if (declaration.type === "TSInterfaceDeclaration" || declaration.declare) break;
        const binding =
          declaration.type === "Identifier" ? importedBindings.get(declaration.name) : undefined;
        if (binding) links.reexports.push({ exported: "default", ...binding });
        else links.localExports.push("default");
        break;
      }
      case "ExportAllDeclaration":
        if (node.exportKind === "type") break;
        if (node.exported) {
          links.reexports.push({
            exported: nameOf(node.exported),
            source: node.source.value,
            imported: "*",
          });
        } else {
          links.starExports.push(node.source.value);
        }
        break;
    }
  }
  return links;
}

/** What a graph built from source needs from its host (the build or the dev server). */
export interface ServerIslandSourceHost {
  keyOf(id: string): string | null;
  /** The file a module id is read from. */
  readFile(id: string): Promise<string>;
  /** Resolve `specifier` imported from `importer` to a module id, or null. */
  resolve(specifier: string, importer: string): Promise<string | null>;
  /**
   * The ids a module imports, for a module that is not JavaScript or
   * TypeScript source (e.g. Markdown compiled by a plugin).
   */
  importedIds(id: string): Iterable<string> | Promise<Iterable<string>>;
}

/**
 * A graph that reads each module's links from its source file and resolves
 * them with the host's resolver. The build and the dev server share it, so
 * both bind by the same rules, and the dev server never has to transform a
 * module (or cache that transform) to answer.
 */
/** Parsed source links by module id, reused while the file's text is unchanged. */
export type ServerIslandParseCache = Map<
  string,
  { code: string; links: ServerIslandSourceLinks | null }
>;

export function createSourceServerIslandGraph(
  host: ServerIslandSourceHost,
  parseCache: ServerIslandParseCache = new Map(),
): ServerIslandGraph {
  const linksById = new Map<string, Promise<ServerIslandModuleLinks>>();
  const parse = (code: string, id: string) => {
    const cached = parseCache.get(id);
    if (cached?.code === code) return cached.links;
    const links = parseServerIslandSourceLinks(code, id);
    parseCache.set(id, { code, links });
    return links;
  };
  const opaque = async (id: string): Promise<ServerIslandModuleLinks> => ({
    imports: [...(await host.importedIds(id))].map((imported) => ({ id: imported, names: "*" })),
    reexports: [],
    starExports: [],
    localExports: [],
    opaque: true,
  });
  return {
    keyOf: host.keyOf,
    links(id) {
      let links = linksById.get(id);
      if (!links) {
        links = readLinks(id);
        linksById.set(id, links);
      }
      return links;
    },
  };

  async function readLinks(id: string): Promise<ServerIslandModuleLinks> {
    if (!SOURCE_MODULE_RE.test(id)) return opaque(id);
    let source: ServerIslandSourceLinks | null = null;
    try {
      source = parse(await host.readFile(id), id);
    } catch {
      // Unreadable: fall back to the host's own view of the module.
    }
    if (!source) return opaque(id);

    const resolved = new Map<string, Promise<string | null>>();
    const resolve = (specifier: string) => {
      let result = resolved.get(specifier);
      if (!result) {
        result = host.resolve(specifier, id).catch(() => null);
        resolved.set(specifier, result);
      }
      return result;
    };
    const links: ServerIslandModuleLinks = {
      imports: [],
      reexports: [],
      starExports: [],
      localExports: source.localExports,
    };
    for (const edge of source.imports) {
      const target = await resolve(edge.source);
      if (target) links.imports.push({ id: target, names: edge.names });
    }
    for (const edge of source.reexports) {
      const target = await resolve(edge.source);
      if (target)
        links.reexports.push({ exported: edge.exported, id: target, imported: edge.imported });
    }
    for (const specifier of source.starExports) {
      const target = await resolve(specifier);
      if (target) links.starExports.push(target);
    }
    return links;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * A Rollup module id as a glob-style key under one of `roots` (the configured
 * root and its real path, since Rollup ids are real paths), or null.
 */
export function buildModuleKey(id: string, roots: readonly string[]): string | null {
  if (id.startsWith("\0")) return null;
  const file = id.split("?")[0]!;
  if (!isAbsolute(file) || file.replace(/\\/g, "/").includes("/node_modules/")) return null;
  for (const root of roots) {
    const path = relative(root, file).replace(/\\/g, "/");
    if (path && !path.startsWith("..") && !isAbsolute(path)) return `/${path}`;
  }
  return null;
}

/**
 * Compute the bindings from the finished server bundle and splice them into
 * the generated server module. A server bundle whose token is never replaced
 * parses to no bindings, and the endpoint refuses every server island: fail closed.
 */
export function createServerIslandBindingsPlugin(dirs: ServerIslandBindingDirs): Plugin {
  let isServerBundle = false;
  let roots: string[] = [process.cwd()];

  return {
    name: "pracht:server-island-bindings",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      isServerBundle = !!config.build.ssr;
      roots = rootSpellings(config.root ?? process.cwd());
    },

    async generateBundle(_outputOptions, bundle) {
      const consumer = this.environment?.config?.consumer;
      if (!(consumer ? consumer === "server" : isServerBundle)) return;
      const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk" && output.code.includes(SERVER_ISLAND_BINDINGS_TOKEN),
      );
      if (chunks.length === 0) return;

      const graph = createSourceServerIslandGraph({
        keyOf: (id) => buildModuleKey(id, roots),
        readFile: (id) => readFile(id, "utf-8"),
        resolve: async (specifier, importer) => {
          const resolved = await this.resolve(specifier, importer);
          return resolved && !resolved.external ? resolved.id : null;
        },
        importedIds: (id) => this.getModuleInfo(id)?.importedIds ?? [],
      });
      const starts = [...this.getModuleIds()].filter((id) => {
        if (id.includes("?")) return false;
        const key = graph.keyOf(id);
        return key !== null && isRouteOrShellKey(key, dirs);
      });
      const bindings = await computeServerIslandBindings(starts, graph, dirs.serverIslandsDir);

      for (const output of chunks) {
        if (output.type !== "chunk") continue;
        output.code = output.code.replace(
          SERVER_ISLAND_BINDINGS_TOKEN,
          escapeForStringLiteral(JSON.stringify(bindings)),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Development
// ---------------------------------------------------------------------------

/** The configured root and its real path: resolved ids use either spelling. */
function rootSpellings(root: string): string[] {
  const configured = resolve(root);
  let real = configured;
  try {
    real = realpathSync(configured);
  } catch {
    // A root that cannot be resolved keeps its configured spelling.
  }
  return real === configured ? [configured] : [configured, real];
}

/**
 * The dev server's view of the graph: each module's links are read from its
 * file and resolved with the server environment's resolver, exactly as the
 * build does. Nothing is transformed, so the answer reflects the files as they
 * are now — never a transform cached before an edit — and does not depend on
 * what has been rendered so far. Module ids are absolute file paths.
 */
export function createDevServerIslandGraph(
  environment: {
    config: { root: string };
    pluginContainer: {
      resolveId(id: string, importer?: string): Promise<{ id: string; external?: unknown } | null>;
    };
    transformRequest(url: string): Promise<{ deps?: string[] } | null>;
  },
  parseCache?: ServerIslandParseCache,
): ServerIslandGraph {
  const root = resolve(environment.config.root);
  const roots = rootSpellings(root);
  const keyOf = (id: string) => buildModuleKey(id, roots);
  return createSourceServerIslandGraph(
    {
      keyOf,
      readFile: (id) => readFile(id, "utf-8"),
      async resolve(specifier, importer) {
        const resolved = await environment.pluginContainer.resolveId(specifier, importer);
        return resolved && !resolved.external ? resolved.id : null;
      },
      // Only modules that are not JavaScript source get here; their imports
      // exist only after a plugin compiled them.
      async importedIds(id) {
        const key = keyOf(id);
        if (key === null) return [];
        const query = id.includes("?") ? id.slice(id.indexOf("?")) : "";
        const result = await environment.transformRequest(`${key}${query}`);
        return (result?.deps ?? []).flatMap((url) => {
          if (url.startsWith("/@fs/")) return [url.slice("/@fs".length)];
          return devModuleKey(url) === null ? [] : [join(root, url)];
        });
      },
    },
    parseCache,
  );
}

/** A dev module URL as a glob-style key, or null outside the app's own files. */
export function devModuleKey(url: string): string | null {
  // Bare specifiers are externalized dependencies; `/@fs/` is outside the
  // project root, `/@id/` a virtual module.
  if (!url.startsWith("/") || url.startsWith("/@") || url.includes("/node_modules/")) return null;
  return url.split("?")[0]!;
}

interface DevFramework {
  matchAppRoute(
    app: unknown,
    pathname: string,
  ): { route: { file: string; shellFile?: string } } | undefined;
  stripBase(pathname: string): string | null;
}

interface DevMetadata {
  resolvedApp: unknown;
  registry: {
    routeModules?: Record<string, unknown>;
    shellModules?: Record<string, unknown>;
  };
}

/** The registry key the runtime would load `file` from (exact, then by suffix). */
function devRegistryKey(
  modules: Record<string, unknown> | undefined,
  file: string | undefined,
): string | undefined {
  if (!modules || !file) return undefined;
  if (Object.hasOwn(modules, file)) return file;
  const suffix = file.replace(/\\/g, "/").replace(/^\.?\//, "");
  return Object.keys(modules).find((key) => {
    const normalized = key.replace(/^\.?\//, "");
    return normalized === suffix || normalized.endsWith(`/${suffix}`);
  });
}

/** Remove every copy of the dev bindings header a client may have sent. */
function stripDevBindingsHeader(req: IncomingMessage): void {
  delete req.headers[DEV_SERVER_ISLAND_BINDINGS_HEADER];
  const raw = req.rawHeaders;
  if (!raw.some((value, index) => index % 2 === 0 && isBindingsHeader(value))) return;
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    if (!isBindingsHeader(raw[index]!)) kept.push(raw[index]!, raw[index + 1]!);
  }
  req.rawHeaders = kept;
}

function isBindingsHeader(name: string): boolean {
  return name.toLowerCase() === DEV_SERVER_ISLAND_BINDINGS_HEADER;
}

function setDevBindingsHeader(req: IncomingMessage, value: string): void {
  req.headers[DEV_SERVER_ISLAND_BINDINGS_HEADER] = value;
  req.rawHeaders.push(DEV_SERVER_ISLAND_BINDINGS_HEADER, value);
}

/**
 * The development half of the binding. For a server island request, compute which
 * server islands the matched route's own module and shell import, and pass that
 * to the runtime in a header.
 * Every request loses any client-sent copy of that header first, whatever its
 * path, so the runtime only ever reads what this middleware wrote; a request
 * it did not handle carries none, and the endpoint then refuses the server island.
 *
 * Modules are read from disk, never transformed, so the answer neither depends
 * on the page having been rendered first nor caches a transform before the
 * next edit.
 */
export function createDevServerIslandBindingsMiddleware(
  server: ViteDevServer,
  options: { serverIslandsDir: string; basePathRetained: boolean },
): Connect.NextHandleFunction {
  let warned = false;
  const explained = new Set<string>();
  const parseCache: ServerIslandParseCache = new Map();
  return (req: IncomingMessage, _res: ServerResponse, next: Connect.NextFunction) => {
    stripDevBindingsHeader(req);
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      next();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    // Adapter-owned dev servers see the public path, base included; Vite's
    // own SSR middleware sees it with the base already stripped.
    const endpoint = options.basePathRetained
      ? `${(server.config.base || "/").replace(/\/$/, "")}${SERVER_ISLAND_ENDPOINT}`
      : SERVER_ISLAND_ENDPOINT;
    if (url.pathname !== endpoint) {
      next();
      return;
    }

    const pagePath = url.searchParams.get("path");
    resolveDevServerIslandBindings(server, pagePath, options.serverIslandsDir, parseCache).then(
      ({ matched, bindings }) => {
        setDevBindingsHeader(req, JSON.stringify(bindings));
        // The endpoint answers an unbound server island with a bare 404 — in
        // development, say why, once per page and server island.
        const serverIsland = url.searchParams.get("island") ?? "";
        const bound = Object.values(bindings).some((files) => files.includes(serverIsland));
        const note = `${pagePath}\0${serverIsland}`;
        if (
          matched &&
          !bound &&
          !explained.has(note) &&
          isServerIslandKey(serverIsland, options.serverIslandsDir) &&
          existsSync(join(server.config.root, serverIsland))
        ) {
          explained.add(note);
          server.config.logger.warn(
            `[pracht] The server island endpoint refused ${serverIsland} for ${pagePath}: neither the route ` +
              "module nor the shell that page renders imports it statically, so it does not run " +
              "under that route. Import the server island with a static import (not import()) from the " +
              "route, its shell, or a component they import.",
          );
        }
        next();
      },
      (error: unknown) => {
        if (!warned) {
          warned = true;
          server.config.logger.warn(
            `[pracht] Could not resolve which routes render which server islands: ${
              error instanceof Error ? error.message : String(error)
            }. Server island requests are refused until this is fixed.`,
          );
        }
        next();
      },
    );
  };
}

async function resolveDevServerIslandBindings(
  server: ViteDevServer,
  pagePath: string | null,
  serverIslandsDir: string,
  parseCache: ServerIslandParseCache,
): Promise<{ matched: boolean; bindings: ServerIslandBindingsMap }> {
  const none = { matched: false, bindings: {} };
  if (!pagePath || !pagePath.startsWith("/") || pagePath.startsWith("//")) return none;
  const [framework, devMetadata] = (await Promise.all([
    server.ssrLoadModule("@pracht/core/server"),
    server.ssrLoadModule("virtual:pracht/dev-metadata"),
  ])) as [DevFramework, DevMetadata];
  const pathname = framework.stripBase(new URL(pagePath, "http://localhost").pathname);
  if (pathname === null) return none;
  const route = framework.matchAppRoute(devMetadata.resolvedApp, pathname)?.route;
  if (!route) return none;

  const graph = createDevServerIslandGraph(server.environments.ssr, parseCache);
  const starts = [
    devRegistryKey(devMetadata.registry.routeModules, route.file),
    devRegistryKey(devMetadata.registry.shellModules, route.shellFile),
  ]
    .filter((key): key is string => key !== undefined)
    .map((key) => join(server.config.root, key));
  return {
    matched: true,
    bindings: await computeServerIslandBindings(starts, graph, serverIslandsDir),
  };
}
