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
  prefetch: string | null;
  render: string | null;
  revalidate: unknown;
  shell: string | null;
  shellFile: string | null;
  speculation: unknown;
}

export interface AppGraphApiRoute {
  file: string;
  hasDefaultHandler: boolean;
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
  prefetch?: string;
  render?: string;
  revalidate?: unknown;
  shell?: string;
  shellFile?: string;
  speculation?: unknown;
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
    prefetch: route.prefetch ?? null,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
    speculation: route.speculation ?? null,
  }));
}

export async function collectApiRoutes(
  server: ViteDevServer,
  root: string,
  apiRoutes: ApiRouteEntry[],
  options: { executeApiModules?: boolean } = {},
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      const { hasDefaultHandler, methods } = await detectApiExports(
        server,
        root,
        route.file,
        options,
      );
      return {
        file: route.file,
        hasDefaultHandler,
        methods,
        path: route.path,
      };
    }),
  );
}

async function detectApiExports(
  server: ViteDevServer,
  root: string,
  file: string,
  options: { executeApiModules?: boolean },
): Promise<{ hasDefaultHandler: boolean; methods: string[] }> {
  const resolvedFile = resolve(root, `.${file}`);
  const source = readFileSync(resolvedFile, "utf-8");

  if (options.executeApiModules) {
    try {
      const module = await server.ssrLoadModule(file);
      return {
        hasDefaultHandler: typeof module.default === "function",
        methods: METHOD_ORDER.filter((method) => typeof module[method] === "function"),
      };
    } catch {
      // Fall through to the static scan below.
    }
  }

  return {
    hasDefaultHandler: /export\s+default\b/.test(source),
    methods: METHOD_ORDER.filter((method) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`).test(source),
    ),
  };
}
