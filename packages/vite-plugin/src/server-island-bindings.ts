import { existsSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

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
 * - **Build:** computed from Rollup's module graph once the server bundle is
 *   complete and spliced into a token in the generated server module.
 * - **Dev:** computed per server island request from the Vite server environment's
 *   module graph and handed to the runtime in a request header this
 *   middleware owns.
 *
 * Both walk the same edges: static `import` and `export … from`, never
 * dynamic `import()`, never into dependencies, virtual modules, or files
 * outside the project root.
 */

/** Spliced with the bindings JSON after the server bundle is written. */
export const SERVER_ISLAND_BINDINGS_TOKEN = "__PRACHT_SERVER_ISLAND_BINDINGS__";

// Mirrors @pracht/core server-islands-shared.ts; the plugin never imports runtime
// source directly.
const DEV_SERVER_ISLAND_BINDINGS_HEADER = "x-pracht-dev-server-island-bindings";
const SERVER_ISLAND_ENDPOINT = "/__pracht/server-island";

const SERVER_ISLAND_MODULE_RE = /\.(?:tsx?|jsx?)$/;

export type ServerIslandBindingsMap = Record<string, string[]>;

/** How the walk sees one module graph. */
export interface ServerIslandGraph {
  /**
   * The glob-style key of a module the walk may enter ("/src/nav.tsx"), or
   * null to stop there: dependencies, virtual modules, and files outside the
   * project root cannot import app server islands, and entering them could only
   * widen a binding.
   */
  keyOf(id: string): string | null;
  /** The ids a module imports statically, including `export … from`. */
  staticImports(id: string): Iterable<string> | Promise<Iterable<string>>;
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

/**
 * Every server island reachable from `start` through static imports. A server island
 * imported with a query (`?raw`, `?url`) is a string, not a rendered
 * component, and does not count.
 */
export async function collectBoundServerIslands(
  start: string,
  graph: ServerIslandGraph,
  serverIslandsDir: string,
): Promise<string[]> {
  const serverIslands = new Set<string>();
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = graph.keyOf(id);
    if (key === null) continue;
    if (!id.includes("?") && isServerIslandKey(key, serverIslandsDir)) serverIslands.add(key);
    for (const imported of await graph.staticImports(id)) pending.push(imported);
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
      const root = resolve(config.root ?? process.cwd());
      let realRoot = root;
      try {
        realRoot = realpathSync(root);
      } catch {
        // A root that cannot be resolved keeps its configured spelling.
      }
      roots = realRoot === root ? [root] : [root, realRoot];
    },

    async generateBundle(_outputOptions, bundle) {
      const consumer = this.environment?.config?.consumer;
      if (!(consumer ? consumer === "server" : isServerBundle)) return;
      const chunks = Object.values(bundle).filter(
        (output) => output.type === "chunk" && output.code.includes(SERVER_ISLAND_BINDINGS_TOKEN),
      );
      if (chunks.length === 0) return;

      const graph: ServerIslandGraph = {
        keyOf: (id) => buildModuleKey(id, roots),
        staticImports: (id) => this.getModuleInfo(id)?.importedIds ?? [],
      };
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

/** A dev module URL as a glob-style key, or null outside the app's own files. */
export function devModuleKey(url: string): string | null {
  // Bare specifiers are externalized dependencies; `/@fs/` is outside the
  // project root, `/@id/` a virtual module.
  if (!url.startsWith("/") || url.startsWith("/@") || url.includes("/node_modules/")) return null;
  return url.split("?")[0]!;
}

/**
 * The dev server's view of the graph: Vite's server environment, whose SSR
 * transform lists a module's static imports as `deps` (its `import()`s are
 * `dynamicDeps`, which the walk does not follow). Transforming on demand makes
 * the answer independent of what has been rendered so far.
 */
export function createDevServerIslandGraph(environment: {
  transformRequest(url: string): Promise<{ deps?: string[] } | null>;
}): ServerIslandGraph {
  return {
    keyOf: devModuleKey,
    async staticImports(url) {
      const result = await environment.transformRequest(url);
      return result?.deps ?? [];
    },
  };
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
 * server islands the matched route's own module and shell import, from the Vite
 * server environment's module graph, and pass that to the runtime in a header.
 * Every request loses any client-sent copy of that header first, whatever its
 * path, so the runtime only ever reads what this middleware wrote; a request
 * it did not handle carries none, and the endpoint then refuses the server island.
 *
 * Modules are transformed on demand, so the answer does not depend on the page
 * having been rendered first.
 */
export function createDevServerIslandBindingsMiddleware(
  server: ViteDevServer,
  options: { serverIslandsDir: string; basePathRetained: boolean },
): Connect.NextHandleFunction {
  let warned = false;
  const explained = new Set<string>();
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
    resolveDevServerIslandBindings(server, pagePath, options.serverIslandsDir).then(
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

  const graph = createDevServerIslandGraph(server.environments.ssr);
  const starts = [
    devRegistryKey(devMetadata.registry.routeModules, route.file),
    devRegistryKey(devMetadata.registry.shellModules, route.shellFile),
  ].filter((key): key is string => key !== undefined);
  return {
    matched: true,
    bindings: await computeServerIslandBindings(starts, graph, serverIslandsDir),
  };
}
