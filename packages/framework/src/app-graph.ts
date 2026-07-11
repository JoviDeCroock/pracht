/**
 * Shared resolved-app-graph serialization.
 *
 * Both `pracht inspect` (CLI) and the dev-only `/_pracht` devtools endpoint
 * (vite plugin) consume this module so they always report the same graph.
 * Module loading and file reading are injected by the caller to keep this
 * module platform-neutral.
 */

import { capabilityHttpPath } from "./runtime-capabilities.ts";
import type {
  HttpMethod,
  PrachtCapability,
  ResolvedApiRoute,
  ResolvedPrachtApp,
  ResolvedRoute,
  SpeculationOption,
} from "./types.ts";

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
  speculation: SpeculationOption | null;
}

export interface AppGraphApiRoute {
  file: string;
  hasDefaultHandler: boolean;
  methods: string[];
  path: string;
}

export interface AppGraphCapability {
  effect: string | null;
  /** Reserved for the MCP Apps projection — always false for now. */
  hasUi: false;
  httpPath: string | null;
  /** Input JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  input: Record<string, unknown> | null;
  middleware: string[];
  name: string;
  /** Output JSON Schema — feeds `pracht typegen` and agent-facing inspection. */
  output: Record<string, unknown> | null;
  source: string;
  title: string | null;
  /** Exposure transports from the capability's `expose` config. */
  transports: string[];
}

export interface AppGraph {
  api: AppGraphApiRoute[];
  capabilities: AppGraphCapability[];
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
    hydration: route.hydration ?? null,
    id: route.id ?? "",
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

export function serializeApiRoutes(
  apiRoutes: readonly ResolvedApiRoute[],
  access: AppGraphModuleAccess,
): Promise<AppGraphApiRoute[]> {
  return Promise.all(
    apiRoutes.map(async (route) => {
      const { hasDefaultHandler, methods } = await detectApiExports(route.file, access);
      return {
        file: route.file,
        hasDefaultHandler,
        methods,
        path: route.path,
      };
    }),
  );
}

/**
 * Serialize registered capabilities by loading their modules. Modules that
 * fail to load (or don't export a capability) still appear in the graph with
 * null metadata so inspect/devtools can surface the broken registration.
 */
export function serializeCapabilities(
  capabilities: Record<string, string> | undefined,
  access: AppGraphModuleAccess,
): Promise<AppGraphCapability[]> {
  return Promise.all(
    Object.entries(capabilities ?? {}).map(async ([name, file]) => {
      try {
        const module = await access.loadModule(file);
        const capability = module.default as PrachtCapability | undefined;
        if (!capability || capability.kind !== "capability") {
          throw new Error("module does not default-export a capability");
        }

        const transports: string[] = [];
        if (capability.expose?.http) transports.push("http");
        if (capability.expose?.mcp) transports.push("mcp");
        if (capability.expose?.webmcp) transports.push("webmcp");

        return {
          effect: capability.effect,
          hasUi: false as const,
          httpPath: capability.expose?.http
            ? (capability.expose.http.path ?? capabilityHttpPath(name))
            : null,
          input: capability.input ?? null,
          middleware: capability.middleware ?? [],
          name,
          output: capability.output ?? null,
          source: file,
          title: capability.title,
          transports,
        };
      } catch {
        return {
          effect: null,
          hasUi: false as const,
          httpPath: null,
          input: null,
          middleware: [],
          name,
          output: null,
          source: file,
          title: null,
          transports: [],
        };
      }
    }),
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
    capabilities: await serializeCapabilities(options.app.capabilities, options),
    routes: serializeAppRoutes(options.app.routes),
  };
}

export interface ApiRouteExports {
  /** `true` when the module exports a default catch-all request handler. */
  hasDefaultHandler: boolean;
  methods: HttpMethod[];
}

export async function detectApiExports(
  file: string,
  access: AppGraphModuleAccess,
): Promise<ApiRouteExports> {
  try {
    const module = await access.loadModule(file);
    return {
      hasDefaultHandler: typeof module.default === "function",
      methods: API_METHOD_ORDER.filter((method) => typeof module[method] === "function"),
    };
  } catch {
    let source: string;
    try {
      source = access.readSource(file);
    } catch {
      return { hasDefaultHandler: false, methods: [] };
    }

    return {
      hasDefaultHandler: /export\s+default\b/.test(source),
      methods: API_METHOD_ORDER.filter((method) =>
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+${method}\\b`).test(
          source,
        ),
      ),
    };
  }
}

export async function detectApiMethods(
  file: string,
  access: AppGraphModuleAccess,
): Promise<HttpMethod[]> {
  return (await detectApiExports(file, access)).methods;
}
