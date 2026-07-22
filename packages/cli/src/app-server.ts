import { existsSync } from "node:fs";

import { createServer, type ViteDevServer } from "vite";

import { readProjectConfig, resolveProjectPath, type ProjectConfig } from "./project.js";

export interface AppServerContext {
  project: ProjectConfig;
  server: ViteDevServer;
  serverModule: Record<string, any>;
}

/**
 * Boot a silent middleware-mode Vite server for the app at `root`, load the
 * `virtual:pracht/server` module, run `fn`, and always close the server.
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

  const server = await createServer({
    root,
    logLevel: "silent",
    server: {
      middlewareMode: true,
    },
  });

  try {
    const serverModule = await server.ssrLoadModule("virtual:pracht/server");
    return await fn({ project, server, serverModule });
  } finally {
    await server.close();
  }
}
