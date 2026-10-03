import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import { createServer, type ViteDevServer } from "vite";

import { collectAppGraph } from "../app-graph.js";
import { createDotEnvSync } from "../dotenv.js";
import { formatDevBanner, supportsColor } from "../dev-banner.js";
import { readProjectConfig, resolveProjectPath } from "../project.js";
import { isRouteSource, isWithinDirectory } from "../verification-helpers.js";
import { requirePositiveInteger } from "../utils.js";
import {
  DEFAULT_CAPABILITIES_OUT,
  DEFAULT_DECLARATION_OUT,
  DEFAULT_RUNTIME_OUT,
  runTypegen,
} from "./typegen.js";

/** The files `createDotEnvSync()` reads (Vite's `loadEnv` set). */
const DOT_ENV_FILE_NAMES = [".env", ".env.local", ".env.[mode]", ".env.[mode].local"];

export default defineCommand({
  meta: {
    name: "dev",
    description: "Start development server with HMR",
  },
  args: {
    cacheDir: {
      type: "string",
      description: "Vite cache directory (defaults to node_modules/.vite)",
    },
    port: {
      type: "string",
      description: "Port number (defaults to $PORT or 3000)",
    },
  },
  async run({ args }) {
    const root = process.cwd();
    // Server-side code reads `process.env`; Vite only surfaces `.env` through
    // `import.meta.env`. Without this a secret in `.env` is invisible to
    // loaders, middleware, API routes, and the capability confirmation gate.
    // Ahead of the port resolution below so a `PORT` in `.env` is honoured
    // rather than half-applied. Vite's dev server is always mode
    // `development`, whatever NODE_ENV says.
    const dotEnv = createDotEnvSync(root, "development");
    dotEnv.load();
    const dotEnvFiles = new Set(
      DOT_ENV_FILE_NAMES.map((name) => resolve(root, name.replace("[mode]", "development"))),
    );

    // `pracht dev 4000` (legacy positional) still works alongside `--port`.
    const positionalPort = args._?.[0] != null ? String(args._[0]) : undefined;
    const port = requirePositiveInteger(
      args.port ?? positionalPort ?? process.env.PORT,
      "port",
      3000,
    );

    const routeTypes = createGeneratedRouteTypesSync(root);
    const server = await createServer({
      cacheDir: args.cacheDir,
      // Vite re-creates the dev server (and its file watcher) on every
      // restart: a `routes.ts` edit, a config or `.env` change. Inline plugins
      // survive that, so the watcher is re-attached to each new server here
      // instead of being bound once to the first one.
      plugins: [
        {
          name: "pracht:cli-dev",
          configureServer(devServer) {
            routeTypes.attach(devServer);
            // Vite restarts the server when a `.env` file changes. Re-read the
            // files the moment the watcher reports it — synchronously, ahead
            // of that restart re-evaluating vite.config.ts — so `process.env`
            // and `serverEnv` follow the edit instead of keeping startup values.
            for (const event of ["add", "change", "unlink"] as const) {
              devServer.watcher.on(event, (file) => {
                if (dotEnvFiles.has(resolve(file))) dotEnv.load();
              });
            }
          },
        },
      ],
      root,
      server: { port },
    });

    await server.listen();
    // Vite closes the server on SIGTERM; do the same for Ctrl+C so work
    // registered with `waitUntil()` gets its bounded drain. A second Ctrl+C
    // falls through to the default and exits immediately.
    process.once("SIGINT", () => {
      void server.close().finally(() => process.exit(130));
    });
    const watchesGeneratedRouteTypes = routeTypes.isEnabled();
    routeTypes.start();

    try {
      const graph = await collectAppGraph(server, root, {
        appFile: readProjectConfig(root).appFile,
      });
      const urls = server.resolvedUrls ?? { local: [], network: [] };
      console.log(
        formatDevBanner({
          apiRoutes: graph.api,
          capabilities: graph.capabilities,
          color: supportsColor(),
          localUrls: urls.local,
          mcpAuthenticated: graph.mcpAuthenticated,
          mcpEndpoint: graph.mcpEndpoint ?? null,
          mcpDestructive: graph.mcpDestructive === true,
          mcpRuntimeStatus: graph.mcpRuntimeStatus,
          mcpUnavailableReasons: graph.mcpUnavailableReasons,
          networkUrls: urls.network,
          notFound: graph.notFound,
          routes: graph.routes,
        }),
      );
      if (!watchesGeneratedRouteTypes) {
        console.log(
          "\n  Tip: run `pracht typegen` once to enable typed routes and `apiFetch()`; `pracht dev` will keep them in sync.\n",
        );
      }
    } catch {
      // Not a resolvable pracht app graph (or it failed to load) — fall back
      // to Vite's own URL output so the dev server still starts cleanly.
      server.printUrls();
    }
  },
});

/**
 * Keep generated route types in sync while the dev server runs. Opt-in by
 * having run `pracht typegen` once, before or during the session: while the
 * generated declaration exists at its default location it is refreshed on
 * startup, after each dev-server restart, whenever files that can define
 * routes are added or removed (renames arrive as an unlink + add pair), and
 * whenever the app manifest or one of its imported definition modules changes.
 * Handler signature changes need no regeneration — the declaration references
 * route modules with `typeof import(...)`, so those types update live.
 * Projects that never ran typegen are left untouched and receive a setup tip
 * in the dev banner.
 *
 * `attach()` binds the listeners to one dev server's watcher. It runs for the
 * first server and again for every server Vite creates on restart, because a
 * restart closes the old watcher along with everything listening to it.
 */
function createGeneratedRouteTypesSync(root: string): {
  attach(server: ViteDevServer): void;
  isEnabled(): boolean;
  /** Refresh once the first server listens; restarts refresh on their own. */
  start(): void;
} {
  const declarationPath = resolve(root, DEFAULT_DECLARATION_OUT);
  const isEnabled = () => existsSync(declarationPath);
  const generatedPaths = new Set([
    declarationPath,
    resolve(root, DEFAULT_RUNTIME_OUT),
    resolve(root, DEFAULT_CAPABILITIES_OUT),
  ]);
  const project = readProjectConfig(root);
  const appFilePath = resolveProjectPath(root, project.appFile);
  const routeSourceDirs = (
    project.mode === "pages" ? [project.pagesDir] : [project.routesDir, project.shellsDir]
  ).map((directory) => resolveProjectPath(root, directory));
  let queued: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunQueued = false;

  const regenerate = async (): Promise<void> => {
    if (!isEnabled()) return;
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    try {
      await runTypegen({
        capabilitiesOut: DEFAULT_CAPABILITIES_OUT,
        check: false,
        declarationOut: DEFAULT_DECLARATION_OUT,
        root,
        runtimeOut: DEFAULT_RUNTIME_OUT,
      });
    } catch (error) {
      console.warn(
        `pracht typegen failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        void regenerate();
      }
    }
  };

  const scheduleRegenerate = () => {
    if (queued) {
      clearTimeout(queued);
    }
    queued = setTimeout(() => {
      queued = null;
      void regenerate();
    }, 300);
  };

  const queueRegenerate = (file: string, requireRouteExtension = true) => {
    const couldUseUnresolvedExtension =
      !project.additionalExtensionsIsStatic &&
      routeSourceDirs.some((directory) => isWithinDirectory(file, directory));
    if (
      !file.startsWith(root) ||
      (requireRouteExtension &&
        !isRouteSource(file, project.additionalExtensions) &&
        !couldUseUnresolvedExtension) ||
      generatedPaths.has(file)
    ) {
      return;
    }
    scheduleRegenerate();
  };

  let started = false;
  return {
    attach(server) {
      server.watcher.on("add", (file) => queueRegenerate(file));
      server.watcher.on("unlink", (file) => queueRegenerate(file));
      server.watcher.on("change", (file) => {
        if (isAppManifestDependency(server, file, appFilePath)) {
          queueRegenerate(file, false);
        }
      });
      // A restart can follow a change the old watcher never reported (a
      // vite.config.ts edit moving the routes directory, for example).
      if (started) scheduleRegenerate();
    },
    isEnabled,
    start() {
      started = true;
      void regenerate();
    },
  };
}

/** Whether `file` is the app manifest or one of its local imported modules. */
function isAppManifestDependency(
  server: ViteDevServer,
  file: string,
  appFilePath: string,
): boolean {
  if (file === appFilePath) {
    return true;
  }

  const modules = server.environments.ssr.moduleGraph.getModulesByFile(file);
  if (!modules) {
    return false;
  }

  const pending = [...modules];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const module = pending.pop()!;
    for (const importer of module.importers) {
      if (importer.file === appFilePath) {
        return true;
      }
      if (!visited.has(importer)) {
        visited.add(importer);
        pending.push(importer);
      }
    }
  }

  return false;
}
