/**
 * Shared resolved-app-graph serialization.
 *
 * Both `pracht inspect` (CLI) and the dev-only `/_pracht` devtools endpoint
 * (vite plugin) consume this module so they always report the same graph.
 * Module loading and file reading are injected by the caller to keep this
 * module platform-neutral.
 */

import {
  extractCapabilityProjection,
  type CapabilityProjection,
} from "@pracht/capabilities/static";

import { capabilityHttpPath } from "./runtime-capabilities.ts";
import { resolveMcpEndpoint } from "./runtime-mcp.ts";
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
  /**
   * Per-capability Web Bot Auth policy override, or `null` when the capability
   * inherits the app default. Part of the graph because a reviewer cannot
   * otherwise tell whether an exposed capability demands a verified agent.
   */
  agentPolicy: string | null;
  /** Prose contract description — feeds generated JSDoc and agent-facing inspection. */
  description: string | null;
  effect: string | null;
  /**
   * Why this capability's module could not be read, or `null` when it was read
   * successfully. A capability that fails to load (most often because
   * `@pracht/capabilities` is not installed) would otherwise serialize
   * identically to a private capability with no effect class, so every
   * inspection surface would quietly under-report what the app exposes.
   *
   * Optional so existing constructors of this shape stay valid; producers that
   * load modules (`serializeCapabilities`) always set it.
   */
  error?: string | null;
  /**
   * Set when the module could not be executed *and* static analysis could not
   * recover every guard-shaped field (`agentPolicy`, `middleware`). Those are
   * what `pracht plan` warns on, so silently reporting the fallback's blanks
   * would let deleting a capability's auth middleware produce no diff at all.
   */
  unverifiedContract?: true;
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
  /**
   * Path the remote MCP projection is served from, or `null` when the app does
   * not configure `agents.mcp` — in which case `expose.mcp` is recorded in the
   * graph but nothing serves it.
   */
  mcpEndpoint?: string | null;
  routes: AppGraphRoute[];
  /**
   * The app-level not-found page, serialized like a route. `null` when the app
   * declares none. It is reported separately from `routes` because it never
   * participates in matching.
   */
  notFound?: AppGraphRoute | null;
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
function readProjection(
  name: string,
  file: string,
  access: AppGraphModuleAccess,
): CapabilityProjection | null {
  try {
    return extractCapabilityProjection(name, access.readSource(file), (detail) => detail);
  } catch {
    return null;
  }
}

function projectionTransports(projection: CapabilityProjection | null): string[] {
  if (!projection) return [];
  const transports: string[] = [];
  if (projection.httpPath) transports.push("http");
  // Order matches the executed path so a fallback entry diffs against a
  // normally-read one without spurious churn.
  if (projection.mcp) transports.push("mcp");
  if (projection.webmcp) transports.push("webmcp");
  return transports;
}

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
          agentPolicy: capability.agentPolicy ?? null,
          description: capability.description,
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
      } catch (cause) {
        // Falling back to static analysis rather than reporting nothing.
        //
        // A capability module that cannot be *executed* here is often perfectly
        // healthy: a Cloudflare capability importing `cloudflare:workers` at
        // the top level deploys fine, it just cannot load in the CLI's Node
        // graph server. Reporting `effect: null, transports: []` for it would
        // claim the app exposes nothing — under-reporting the agent surface in
        // the dev banner, `inspect`, the committed snapshot, and generated
        // types alike. The same extractor the browser projection is built from
        // reads `expose` and `effect` straight out of the source, so use it and
        // keep `error` set for the diagnostic.
        const projection = readProjection(name, file, access);
        // `undefined` from the extractor means "declared, but not readable
        // statically". Recording it as `null` / `[]` would claim the
        // capability has no agent policy and no middleware — the two fields a
        // reviewer reads to decide whether a change weakened a guard, and the
        // ones `pracht plan` warns on. `unverifiedContract` says so instead.
        const unverified =
          !projection ||
          projection.agentPolicy === undefined ||
          projection.middleware === undefined;
        return {
          agentPolicy: projection?.agentPolicy ?? null,
          description: projection?.description ?? null,
          effect: projection?.effect ?? null,
          error: cause instanceof Error ? cause.message : String(cause),
          unverifiedContract: unverified ? (true as const) : undefined,
          hasUi: false as const,
          httpPath: projection?.httpPath ?? null,
          input: projection?.inputSchema ?? null,
          middleware: projection?.middleware ?? [],
          name,
          output: null,
          source: file,
          title: null,
          transports: projectionTransports(projection),
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
  const notFound = options.app.notFound;
  return {
    api: await serializeApiRoutes(options.apiRoutes ?? [], options),
    capabilities: await serializeCapabilities(options.app.capabilities, options),
    mcpEndpoint: resolveMcpEndpoint(options.app.agents),
    notFound: notFound ? serializeAppRoutes([notFound])[0] : null,
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
