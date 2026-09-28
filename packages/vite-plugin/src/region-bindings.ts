import { existsSync, realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Connect, Plugin, ViteDevServer } from "vite";

import { escapeForStringLiteral } from "./plugin-server-css.ts";

/**
 * Route↔region binding.
 *
 * The region endpoint (`/__pracht/region`) is asked to render region R for
 * page path P. It only does so when the route P matches renders R: when R is
 * reachable through static imports from that route's own module or from its
 * shell module. The middleware that then runs, and the params the loader
 * sees, are exactly the ones that page runs and sees itself, so a region is
 * never more reachable than the page that hosts it. See docs/REGIONS.md,
 * "Route binding".
 *
 * The map is `{ [route or shell registry key]: region files }`, both in the
 * form `import.meta.glob` keys take ("/src/routes/admin.tsx",
 * "/src/regions/AdminStats.tsx"), so the runtime can look a matched route's
 * modules up exactly as it loads them.
 *
 * - **Build:** computed from Rollup's module graph once the server bundle is
 *   complete and spliced into a token in the generated server module.
 * - **Dev:** computed per region request from the Vite server environment's
 *   module graph and handed to the runtime in a request header this
 *   middleware owns.
 *
 * Both walk the same edges: static `import` and `export … from`, never
 * dynamic `import()`, never into dependencies, virtual modules, or files
 * outside the project root.
 */

/** Spliced with the bindings JSON after the server bundle is written. */
export const REGION_BINDINGS_TOKEN = "__PRACHT_REGION_BINDINGS__";

// Mirrors @pracht/core regions-shared.ts; the plugin never imports runtime
// source directly.
const DEV_REGION_BINDINGS_HEADER = "x-pracht-dev-region-bindings";
const REGION_ENDPOINT = "/__pracht/region";

const REGION_MODULE_RE = /\.(?:tsx?|jsx?)$/;

export type RegionBindingsMap = Record<string, string[]>;

/** How the walk sees one module graph. */
export interface RegionGraph {
  /**
   * The glob-style key of a module the walk may enter ("/src/nav.tsx"), or
   * null to stop there: dependencies, virtual modules, and files outside the
   * project root cannot import app regions, and entering them could only
   * widen a binding.
   */
  keyOf(id: string): string | null;
  /** The ids a module imports statically, including `export … from`. */
  staticImports(id: string): Iterable<string> | Promise<Iterable<string>>;
}

export interface RegionBindingDirs {
  regionsDir: string;
  routesDir: string;
  shellsDir: string;
  pagesDir: string;
}

/** "/src/regions", however the option was spelled. */
function dirKey(dir: string): string {
  return `/${dir
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "")}`;
}

/** True for a key the generated server module registers as a region. */
export function isRegionKey(key: string, regionsDir: string): boolean {
  return (
    key.startsWith(`${dirKey(regionsDir)}/`) &&
    REGION_MODULE_RE.test(key) &&
    !key.endsWith(".d.ts") &&
    !key.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

/** True for a key the runtime can load as a route or shell module. */
export function isRouteOrShellKey(key: string, dirs: RegionBindingDirs): boolean {
  const roots = dirs.pagesDir ? [dirs.pagesDir] : [dirs.routesDir, dirs.shellsDir];
  return roots.some((dir) => key.startsWith(`${dirKey(dir)}/`));
}

/**
 * Every region reachable from `start` through static imports. A region
 * imported with a query (`?raw`, `?url`) is a string, not a rendered
 * component, and does not count.
 */
export async function collectBoundRegions(
  start: string,
  graph: RegionGraph,
  regionsDir: string,
): Promise<string[]> {
  const regions = new Set<string>();
  const seen = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const key = graph.keyOf(id);
    if (key === null) continue;
    if (!id.includes("?") && isRegionKey(key, regionsDir)) regions.add(key);
    for (const imported of await graph.staticImports(id)) pending.push(imported);
  }
  return [...regions].sort();
}

/** Bindings for every start module that reaches at least one region. */
export async function computeRegionBindings(
  starts: Iterable<string>,
  graph: RegionGraph,
  regionsDir: string,
): Promise<RegionBindingsMap> {
  const bindings: RegionBindingsMap = {};
  for (const start of starts) {
    const key = graph.keyOf(start);
    if (key === null) continue;
    const regions = await collectBoundRegions(start, graph, regionsDir);
    if (regions.length > 0) bindings[key] = regions;
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
 * parses to no bindings, and the endpoint refuses every region: fail closed.
 */
export function createRegionBindingsPlugin(dirs: RegionBindingDirs): Plugin {
  let isServerBundle = false;
  let roots: string[] = [process.cwd()];

  return {
    name: "pracht:region-bindings",
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
        (output) => output.type === "chunk" && output.code.includes(REGION_BINDINGS_TOKEN),
      );
      if (chunks.length === 0) return;

      const graph: RegionGraph = {
        keyOf: (id) => buildModuleKey(id, roots),
        staticImports: (id) => this.getModuleInfo(id)?.importedIds ?? [],
      };
      const starts = [...this.getModuleIds()].filter((id) => {
        if (id.includes("?")) return false;
        const key = graph.keyOf(id);
        return key !== null && isRouteOrShellKey(key, dirs);
      });
      const bindings = await computeRegionBindings(starts, graph, dirs.regionsDir);

      for (const output of chunks) {
        if (output.type !== "chunk") continue;
        output.code = output.code.replace(
          REGION_BINDINGS_TOKEN,
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
export function createDevRegionGraph(environment: {
  transformRequest(url: string): Promise<{ deps?: string[] } | null>;
}): RegionGraph {
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
  delete req.headers[DEV_REGION_BINDINGS_HEADER];
  const raw = req.rawHeaders;
  if (!raw.some((value, index) => index % 2 === 0 && isBindingsHeader(value))) return;
  const kept: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    if (!isBindingsHeader(raw[index]!)) kept.push(raw[index]!, raw[index + 1]!);
  }
  req.rawHeaders = kept;
}

function isBindingsHeader(name: string): boolean {
  return name.toLowerCase() === DEV_REGION_BINDINGS_HEADER;
}

function setDevBindingsHeader(req: IncomingMessage, value: string): void {
  req.headers[DEV_REGION_BINDINGS_HEADER] = value;
  req.rawHeaders.push(DEV_REGION_BINDINGS_HEADER, value);
}

/**
 * The development half of the binding. For a region request, compute which
 * regions the matched route's own module and shell import, from the Vite
 * server environment's module graph, and pass that to the runtime in a header.
 * Every request loses any client-sent copy of that header first, whatever its
 * path, so the runtime only ever reads what this middleware wrote; a request
 * it did not handle carries none, and the endpoint then refuses the region.
 *
 * Modules are transformed on demand, so the answer does not depend on the page
 * having been rendered first.
 */
export function createDevRegionBindingsMiddleware(
  server: ViteDevServer,
  options: { regionsDir: string; basePathRetained: boolean },
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
      ? `${(server.config.base || "/").replace(/\/$/, "")}${REGION_ENDPOINT}`
      : REGION_ENDPOINT;
    if (url.pathname !== endpoint) {
      next();
      return;
    }

    const pagePath = url.searchParams.get("path");
    resolveDevRegionBindings(server, pagePath, options.regionsDir).then(
      ({ matched, bindings }) => {
        setDevBindingsHeader(req, JSON.stringify(bindings));
        // The endpoint answers an unbound region with a bare 404 — in
        // development, say why, once per page and region.
        const region = url.searchParams.get("region") ?? "";
        const bound = Object.values(bindings).some((files) => files.includes(region));
        const note = `${pagePath}\0${region}`;
        if (
          matched &&
          !bound &&
          !explained.has(note) &&
          isRegionKey(region, options.regionsDir) &&
          existsSync(join(server.config.root, region))
        ) {
          explained.add(note);
          server.config.logger.warn(
            `[pracht] The region endpoint refused ${region} for ${pagePath}: neither the route ` +
              "module nor the shell that page renders imports it statically, so it does not run " +
              "under that route. Import the region with a static import (not import()) from the " +
              "route, its shell, or a component they import.",
          );
        }
        next();
      },
      (error: unknown) => {
        if (!warned) {
          warned = true;
          server.config.logger.warn(
            `[pracht] Could not resolve which routes render which regions: ${
              error instanceof Error ? error.message : String(error)
            }. Region requests are refused until this is fixed.`,
          );
        }
        next();
      },
    );
  };
}

async function resolveDevRegionBindings(
  server: ViteDevServer,
  pagePath: string | null,
  regionsDir: string,
): Promise<{ matched: boolean; bindings: RegionBindingsMap }> {
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

  const graph = createDevRegionGraph(server.environments.ssr);
  const starts = [
    devRegistryKey(devMetadata.registry.routeModules, route.file),
    devRegistryKey(devMetadata.registry.shellModules, route.shellFile),
  ].filter((key): key is string => key !== undefined);
  return { matched: true, bindings: await computeRegionBindings(starts, graph, regionsDir) };
}
