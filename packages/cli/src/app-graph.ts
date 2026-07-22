import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ViteDevServer } from "vite";

import { HTTP_METHODS, type HttpMethod } from "./constants.js";

const METHOD_ORDER: HttpMethod[] = [...HTTP_METHODS];

export interface AppGraphRoute {
  file: string;
  hydration: string | null;
  id: string;
  loaderCache: number | false | null;
  loaderFile: string | null;
  middleware: string[];
  path: string;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
}

export interface AppGraphApiRoute {
  file: string;
  methods: string[];
  path: string;
}

export interface AppGraph {
  api: AppGraphApiRoute[];
  routes: AppGraphRoute[];
}

interface ResolvedRouteEntry {
  file: string;
  hydration?: string;
  id: string;
  loaderCache?: number | false;
  loaderFile?: string;
  middleware: string[];
  path: string;
  render?: string;
  revalidate?: unknown;
  shell?: string;
  shellFile?: string;
}

interface ApiRouteEntry {
  file: string;
  path: string;
}

/**
 * Load the resolved app graph (page routes + API routes) from a running Vite
 * dev server. Shared by `pracht inspect` and the `pracht dev` startup banner.
 */
export async function collectAppGraph(
  server: ViteDevServer,
  root: string,
  options: { executeApiModules?: boolean } = {},
): Promise<AppGraph> {
  const serverModule = await server.ssrLoadModule("virtual:pracht/server");
  return {
    api: await collectApiRoutes(server, root, serverModule.apiRoutes, options),
    routes: serializeResolvedRoutes(serverModule.resolvedApp.routes),
  };
}

export function serializeResolvedRoutes(routes: ResolvedRouteEntry[]): AppGraphRoute[] {
  return routes.map((route) => ({
    file: route.file,
    hydration: route.hydration ?? null,
    id: route.id,
    loaderCache: route.loaderCache ?? null,
    loaderFile: route.loaderFile ?? null,
    middleware: route.middleware,
    path: route.path,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
  }));
}

export async function collectApiRoutes(
  server: ViteDevServer,
  root: string,
  apiRoutes: ApiRouteEntry[],
  options: { executeApiModules?: boolean } = {},
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => ({
      file: route.file,
      methods: await detectApiMethods(server, root, route.file, options),
      path: route.path,
    })),
  );
}

async function detectApiMethods(
  server: ViteDevServer,
  root: string,
  file: string,
  options: { executeApiModules?: boolean },
): Promise<string[]> {
  const resolvedFile = resolve(root, `.${file}`);
  const source = readFileSync(resolvedFile, "utf-8");

  if (options.executeApiModules) {
    try {
      const module = await server.ssrLoadModule(file);
      return METHOD_ORDER.filter((method) => typeof module[method] === "function");
    } catch {
      // Fall through to the static scan below.
    }
  }

  return METHOD_ORDER.filter((method) =>
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`).test(source),
  );
}
