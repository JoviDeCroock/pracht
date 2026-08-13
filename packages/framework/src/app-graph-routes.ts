import type { AppGraphRoute } from "./app-graph-types.ts";
import type { ResolvedRoute } from "./types.ts";

export function serializeAppRoutes(routes: readonly ResolvedRoute[]): AppGraphRoute[] {
  return routes.map((route) => ({
    file: route.file,
    hydration: route.hydration ?? null,
    id: route.id ?? "",
    loaderCache: route.loaderCache ?? null,
    loaderFile: route.loaderFile ?? null,
    ...(route.markdown === true ? { markdown: true as const } : {}),
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
