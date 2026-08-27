import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer, resolveConfig, type InlineConfig, type ViteDevServer } from "vite";
import { PRACHT_GRAPH_ONLY_ENV } from "@pracht/core/server";

import { loadAppMetadataModule } from "./app-graph.js";
import { readProjectConfig, resolveProjectPath, type ProjectConfig } from "./project.js";

export interface AppServerContext {
  project: ProjectConfig;
  server: ViteDevServer;
  serverModule: Record<string, any>;
}

interface PrachtPluginWithMetadata {
  name?: string;
  api?: {
    llmsTxtEnabled?: unknown;
  };
}

/** Read the version-compatible metadata exposed by the resolved pracht plugin. */
export function readBuildLlmsTxtEnabled(
  plugins: readonly PrachtPluginWithMetadata[],
): boolean | null {
  const enabled = plugins.find((plugin) => plugin.name === "pracht")?.api?.llmsTxtEnabled;
  return typeof enabled === "boolean" ? enabled : null;
}

/**
 * Resolve the same production SSR configuration that emits `generateLlmsTxt`.
 * A normal graph server uses Vite's `serve` command and development mode, so
 * reading its options would misreport build- or production-only configuration.
 */
export async function resolveBuildLlmsTxtEnabled(root: string): Promise<boolean | null> {
  const releaseStartup = await acquireGraphStartup();
  try {
    enterGraphOnlyMode();
    try {
      const config = await resolveConfig(
        {
          root,
          logLevel: "silent",
          build: {
            copyPublicDir: false,
            rollupOptions: { input: "virtual:pracht/server" },
            ssr: true,
          },
        },
        "build",
        "production",
      );
      return readBuildLlmsTxtEnabled(config.plugins);
    } finally {
      exitGraphOnlyMode();
    }
  } finally {
    releaseStartup();
  }
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
  // Vite's optimizer writes through a temporary directory and then renames it
  // into place. Giving every graph reader its own cache prevents concurrent
  // inspect/plan/verify processes from racing over node_modules/.vite.
  const cacheDir = mkdtempSync(join(tmpdir(), "pracht-graph-"));
  let server: ViteDevServer | undefined;
  let releaseOperation: (() => void) | undefined;

  try {
    const viteConfig: InlineConfig = {
      cacheDir,
      root,
      logLevel: "silent",
      // This server exists to evaluate one SSR module and is closed immediately;
      // it never answers a browser request. Dependency pre-bundling is therefore
      // pure cost, even though plugins may still contribute explicit entries.
      optimizeDeps: {
        noDiscovery: true,
      },
      server: {
        middlewareMode: true,
      },
    };
    const releaseStartup = await acquireGraphStartup();
    try {
      enterGraphOnlyMode();
      try {
        server = await createServer(viteConfig);
      } finally {
        exitGraphOnlyMode();
      }
    } finally {
      releaseStartup();
    }

    // A later startup must not set the process-wide flag while this server is
    // evaluating app metadata, API routes, or capabilities. Shared operation
    // leases keep those phases concurrent across already-created servers while
    // making graph-only startup the sole exclusive section.
    releaseOperation = await acquireGraphOperation();
    const serverModule = await loadAppMetadataModule(server);
    return await fn({ project, server, serverModule });
  } finally {
    try {
      await server?.close();
    } finally {
      // The cache is disposable. A cleanup failure must not hide the app or
      // Vite error the graph command was trying to report.
      try {
        rmSync(cacheDir, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 50,
        });
      } catch {
        // Best-effort cleanup of an OS-temporary directory.
      }
      releaseOperation?.();
    }
  }
}

interface GraphGateWaiter {
  kind: "operation" | "startup";
  resolve: (release: () => void) => void;
}

let graphOperationCount = 0;
let graphStartupActive = false;
const graphGateQueue: GraphGateWaiter[] = [];

function releaseOnce(release: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

function releaseGraphOperation(): void {
  graphOperationCount -= 1;
  if (graphOperationCount === 0) drainGraphGate();
}

function releaseGraphStartup(): void {
  graphStartupActive = false;
  drainGraphGate();
}

function drainGraphGate(): void {
  if (graphStartupActive || graphOperationCount > 0 || graphGateQueue.length === 0) return;

  if (graphGateQueue[0].kind === "startup") {
    graphStartupActive = true;
    graphGateQueue.shift()!.resolve(releaseOnce(releaseGraphStartup));
    return;
  }

  while (graphGateQueue[0]?.kind === "operation") {
    graphOperationCount += 1;
    graphGateQueue.shift()!.resolve(releaseOnce(releaseGraphOperation));
  }
}

function acquireGraphGate(kind: GraphGateWaiter["kind"]): Promise<() => void> {
  if (
    graphGateQueue.length === 0 &&
    !graphStartupActive &&
    (kind === "operation" || graphOperationCount === 0)
  ) {
    if (kind === "startup") {
      graphStartupActive = true;
      return Promise.resolve(releaseOnce(releaseGraphStartup));
    }
    graphOperationCount += 1;
    return Promise.resolve(releaseOnce(releaseGraphOperation));
  }

  return new Promise((resolve) => {
    graphGateQueue.push({ kind, resolve });
  });
}

function acquireGraphStartup(): Promise<() => void> {
  return acquireGraphGate("startup");
}

function acquireGraphOperation(): Promise<() => void> {
  return acquireGraphGate("operation");
}

/**
 * Startup is exclusive because the flag has to outlive the complete
 * `createServer()` call without becoming visible to app module evaluation.
 *
 * The pracht plugin reads it while Vite bundles and evaluates the app's
 * config, which is asynchronous. Restoring as soon as one `createServer()`
 * resolved therefore let a second, overlapping call load the adapter's Vite
 * plugins after all — booting workerd in a "graph-only" server and hanging the
 * process, which is precisely what this mode exists to avoid. The MCP server
 * is the realistic trigger: it serves inspect/verify/plan/typegen from one
 * long-lived process.
 *
 * The original value is restored before the server receives its shared
 * operation lease, so app modules and child processes never inherit `"1"`.
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
