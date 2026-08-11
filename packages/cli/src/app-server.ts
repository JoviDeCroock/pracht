import { existsSync } from "node:fs";

import { createServer, type ViteDevServer } from "vite";
import { PRACHT_GRAPH_ONLY_ENV } from "@pracht/core/server";

import { loadAppMetadataModule } from "./app-graph.js";
import { readProjectConfig, resolveProjectPath, type ProjectConfig } from "./project.js";

export interface AppServerContext {
  project: ProjectConfig;
  server: ViteDevServer;
  serverModule: Record<string, any>;
}

/**
 * Boot a silent middleware-mode Vite server for the app at `root`, load the
 * app's resolved graph metadata, run `fn`, and always close the server.
 * Shared by `pracht inspect`, `pracht plan`, and graph-aware verification so
 * they all observe the exact same resolved app graph.
 */
export async function withAppServer<T>(
  root: string,
  fn: (context: AppServerContext) => Promise<T>,
): Promise<T> {
  const project = readProjectConfig(root);

  if (!project.configFile) {
    throw new Error("Missing vite config. This command requires a project with pracht configured.");
  }

  if (!project.hasPrachtPlugin) {
    throw new Error("vite.config does not appear to register the pracht plugin.");
  }

  if (project.mode === "manifest") {
    const manifestPath = resolveProjectPath(project.root, project.appFile);
    if (!existsSync(manifestPath)) {
      throw new Error(`App manifest is missing at ${project.appFile}.`);
    }
  }

  // Tell the pracht plugin to skip adapter-contributed Vite plugins. This
  // server only evaluates `virtual:pracht/dev-metadata`, which is
  // adapter-neutral by design, and adapter plugins can own resources that
  // outlive `server.close()` — `@cloudflare/vite-plugin` boots workerd and a
  // debugger socket, which used to keep every graph command running forever.
  enterGraphOnlyMode();

  let server: ViteDevServer;
  try {
    server = await createServer({
      root,
      logLevel: "silent",
      // This server exists to evaluate one SSR module and is closed
      // immediately; it never answers a browser request. Dependency
      // pre-bundling is therefore pure cost — and it outlives
      // `server.close()`, so the scan keeps writing
      // `node_modules/.vite/deps_temp_*` after the command has moved on.
      optimizeDeps: {
        noDiscovery: true,
      },
      server: {
        middlewareMode: true,
      },
    });
  } finally {
    exitGraphOnlyMode();
  }

  try {
    const serverModule = await loadAppMetadataModule(server);
    return await fn({ project, server, serverModule });
  } finally {
    await server.close();
  }
}

/**
 * Ref-counted, because the flag has to outlive *every* concurrent
 * `createServer()` call, not just the first one to finish.
 *
 * The pracht plugin reads it while Vite bundles and evaluates the app's
 * config, which is asynchronous. Restoring as soon as one `createServer()`
 * resolved therefore let a second, overlapping call load the adapter's Vite
 * plugins after all — booting workerd in a "graph-only" server and hanging the
 * process, which is precisely what this mode exists to avoid. The MCP server
 * is the realistic trigger: it serves inspect/verify/plan/typegen from one
 * long-lived process.
 *
 * The original value is captured once, on the 0 → 1 transition, so nested or
 * overlapping calls cannot leak `"1"` into the rest of the process (and from
 * there into any child process it spawns).
 */
let graphOnlyDepth = 0;
let graphOnlyPrevious: string | undefined;

function enterGraphOnlyMode(): void {
  if (graphOnlyDepth === 0) {
    graphOnlyPrevious = process.env[PRACHT_GRAPH_ONLY_ENV];
    process.env[PRACHT_GRAPH_ONLY_ENV] = "1";
  }
  graphOnlyDepth += 1;
}

function exitGraphOnlyMode(): void {
  graphOnlyDepth -= 1;
  if (graphOnlyDepth > 0) return;

  graphOnlyDepth = 0;
  if (graphOnlyPrevious === undefined) {
    delete process.env[PRACHT_GRAPH_ONLY_ENV];
  } else {
    process.env[PRACHT_GRAPH_ONLY_ENV] = graphOnlyPrevious;
  }
  graphOnlyPrevious = undefined;
}
