import type { Plugin } from "vite";

import {
  isPrachtClientModuleId,
  stripServerOnlyExportsForClient,
} from "./client-module-transform.ts";
import { resolveCapabilityModulePaths } from "./plugin-capabilities.ts";
import { canonicalFilePath, resolveConfigPath, toPosixPath } from "./plugin-paths.ts";
import type { ResolvedPrachtPluginOptions } from "./plugin-options.ts";

const ROUTE_FILE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".mdx", ".tsrx"]);

/**
 * Own the client/server module boundary for route and capability modules.
 * Resolved file identity stays local to this plugin so its guards cannot drift
 * from the Vite root that produced the module ids they inspect.
 */
export function createClientModuleSafetyPlugin(
  resolved: ResolvedPrachtPluginOptions,
  getRoot: () => string = () => process.cwd(),
): Plugin {
  let configuredRoot = "";
  let routeFileDirs: string[] = [];
  let capabilityModulePaths = new Set<string>();

  function configureRoot(root: string): void {
    if (root === configuredRoot) return;
    configuredRoot = root;
    routeFileDirs = computeRouteFileDirs(root, resolved);
    capabilityModulePaths = new Set(
      resolveCapabilityModulePaths(resolved, root).map(canonicalFilePath),
    );
  }

  return {
    name: "pracht:client-module-transform",
    enforce: "post",

    configResolved(config) {
      configureRoot(config.root);
    },

    transform(code, id, transformOptions) {
      // The main plugin owns the root for legacy direct-hook consumers, while
      // Vite calls this plugin's configResolved hook in normal operation.
      configureRoot(getRoot());

      // Capability modules are server-only: they hold `run()` and everything it
      // imports (database clients, secrets, internal stores). Nothing strips
      // them the way route loaders are stripped, so a component importing one
      // directly would ship the whole contract and its dependencies to every
      // visitor. The generated browser projection exists precisely so that
      // never has to happen — fail the build and point at it.
      if (!transformOptions?.ssr && isCapabilityModule(id, capabilityModulePaths)) {
        throw new Error(
          `[pracht] Capability module ${JSON.stringify(toPosixPath(id))} was imported by client ` +
            "code. Capability modules are server-only — their run() implementation and its " +
            "imports would be bundled for every visitor. Call the capability instead: " +
            '`callCapability`/`capabilities` from "virtual:pracht/capabilities" in the browser, ' +
            'or `invokeCapability` from "@pracht/core/server" in loaders, middleware, and API routes.',
        );
      }

      const shouldStrip =
        isPrachtClientModuleId(id) ||
        (!transformOptions?.ssr && isRouteOrShellFile(id, routeFileDirs));
      if (!shouldStrip) return null;

      const transformed = stripServerOnlyExportsForClient(code, id);
      if (transformed === code) return null;
      return { code: transformed, map: null };
    },
  };
}

function computeRouteFileDirs(root: string, resolved: ResolvedPrachtPluginOptions): string[] {
  const dirs = resolved.pagesDir ? [resolved.pagesDir] : [resolved.routesDir, resolved.shellsDir];
  return dirs.map((dir) => canonicalFilePath(resolveConfigPath(root, dir))).map(withTrailingSep);
}

/** Match registered modules, not directory membership, after Vite canonicalization. */
function isCapabilityModule(id: string, capabilityModulePaths: Set<string>): boolean {
  if (capabilityModulePaths.size === 0) return false;
  const queryStart = id.indexOf("?");
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  if (path.startsWith("\0") || path.startsWith("virtual:")) return false;
  return capabilityModulePaths.has(canonicalFilePath(path));
}

function isRouteOrShellFile(id: string, dirs: string[]): boolean {
  if (dirs.length === 0) return false;
  const queryStart = id.indexOf("?");
  const path = queryStart === -1 ? id : id.slice(0, queryStart);
  if (path.startsWith("\0") || path.startsWith("virtual:")) return false;
  const extIndex = path.lastIndexOf(".");
  if (extIndex === -1 || !ROUTE_FILE_EXTENSIONS.has(path.slice(extIndex))) return false;
  const normalized = canonicalFilePath(path);
  return dirs.some((dir) => normalized.startsWith(dir));
}

function withTrailingSep(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}
