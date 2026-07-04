/**
 * Shared resolved-app-graph serialization.
 *
 * Both `pracht inspect` (CLI) and the dev-only `/_pracht` devtools endpoint
 * (vite plugin) consume this module so they always report the same graph.
 * Module loading and file reading are injected by the caller to keep this
 * module platform-neutral.
 */

import type { HttpMethod, ResolvedApiRoute, ResolvedPrachtApp, ResolvedRoute } from "./types.ts";

export const API_METHOD_ORDER: readonly HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export interface AppGraphRoute {
  file: string;
  id: string;
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

export interface AppGraphModuleAccess {
  /** Import an app module by its app-relative file path (e.g. Vite's `ssrLoadModule`). */
  loadModule: (file: string) => Promise<Record<string, unknown>>;
  /** Read an app module's source text — fallback method detection when importing fails. */
  readSource: (file: string) => string;
}

export function serializeAppRoutes(routes: readonly ResolvedRoute[]): AppGraphRoute[] {
  return routes.map((route) => ({
    file: route.file,
    id: route.id ?? "",
    loaderFile: route.loaderFile ?? null,
    middleware: route.middleware,
    path: route.path,
    render: route.render ?? null,
    revalidate: route.revalidate ?? null,
    shell: route.shell ?? null,
    shellFile: route.shellFile ?? null,
  }));
}

export function serializeApiRoutes(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphModuleAccess,
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => ({
      file: route.file,
      methods: await detectApiMethods(route.file, access),
      path: route.path,
    })),
  );
}

export async function buildAppGraph(
  options: {
    apiRoutes?: readonly ResolvedApiRoute[];
    app: ResolvedPrachtApp;
  } & AppGraphModuleAccess,
): Promise<AppGraph> {
  return {
    api: await serializeApiRoutes(options.apiRoutes ?? [], options),
    routes: serializeAppRoutes(options.app.routes),
  };
}

export async function detectApiMethods(
  file: string,
  access: AppGraphModuleAccess,
): Promise<HttpMethod[]> {
  try {
    const module = await access.loadModule(file);
    return API_METHOD_ORDER.filter((method) => typeof module[method] === "function");
  } catch {
    let source: string;
    try {
      source = access.readSource(file);
    } catch {
      return [];
    }

    return API_METHOD_ORDER.filter((method) =>
      new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`).test(source),
    );
  }
}
