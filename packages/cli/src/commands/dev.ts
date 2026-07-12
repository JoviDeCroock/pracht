import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import { createServer, type ViteDevServer } from "vite";

import { collectAppGraph } from "../app-graph.js";
import { formatDevBanner, supportsColor } from "../dev-banner.js";
import { readProjectConfig, resolveProjectPath } from "../project.js";
import { DEFAULT_DECLARATION_OUT, DEFAULT_RUNTIME_OUT, runTypegen } from "./typegen.js";

export default defineCommand({
  meta: {
    name: "dev",
    description: "Start development server with HMR",
  },
  args: {
    port: {
      type: "positional",
      description: "Port number",
      required: false,
    },
  },
  async run({ args }) {
    const port = parseInt(process.env.PORT || args.port || "3000", 10);
    const root = process.cwd();

    const server = await createServer({
      root,
      server: { port },
    });

    await server.listen();
    watchGeneratedRouteTypes(server, root);

    try {
      const graph = await collectAppGraph(server, root);
      const urls = server.resolvedUrls ?? { local: [], network: [] };
      console.log(
        formatDevBanner({
          apiRoutes: graph.api,
          color: supportsColor(),
          localUrls: urls.local,
          networkUrls: urls.network,
          routes: graph.routes,
        }),
      );
    } catch {
      // Not a resolvable pracht app graph (or it failed to load) — fall back
      // to Vite's own URL output so the dev server still starts cleanly.
      server.printUrls();
    }
  },
});

// Extensions that can introduce or remove a route (see the typegen module
// resolution and markdown route support).
const ROUTE_MODULE_PATTERN = /\.(?:ts|tsx|tsrx|js|jsx|md|mdx)$/;

/**
 * Keep generated route types in sync while the dev server runs. Opt-in by
 * having run `pracht typegen` once: when the generated declaration exists at
 * its default location it is refreshed on startup, whenever files that can
 * define routes are added or removed (renames arrive as an unlink + add pair),
 * and whenever the app manifest changes. Handler signature changes need no
 * regeneration — the declaration references route modules with
 * `typeof import(...)`, so those types update live. Projects that never ran
 * typegen are left untouched.
 */
function watchGeneratedRouteTypes(server: ViteDevServer, root: string): void {
  const declarationPath = resolve(root, DEFAULT_DECLARATION_OUT);
  if (!existsSync(declarationPath)) {
    return;
  }

  const generatedPaths = new Set([declarationPath, resolve(root, DEFAULT_RUNTIME_OUT)]);
  const appFilePath = resolveProjectPath(root, readProjectConfig(root).appFile);
  let queued: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let rerunQueued = false;

  const regenerate = async (): Promise<void> => {
    if (running) {
      rerunQueued = true;
      return;
    }
    running = true;
    try {
      await runTypegen({
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

  const queueRegenerate = (file: string) => {
    if (!file.startsWith(root) || !ROUTE_MODULE_PATTERN.test(file) || generatedPaths.has(file)) {
      return;
    }
    if (queued) {
      clearTimeout(queued);
    }
    queued = setTimeout(() => {
      queued = null;
      void regenerate();
    }, 300);
  };

  server.watcher.on("add", queueRegenerate);
  server.watcher.on("unlink", queueRegenerate);
  server.watcher.on("change", (file) => {
    if (file === appFilePath) {
      queueRegenerate(file);
    }
  });
  void regenerate();
}
