/**
 * Standalone capability host — mount the capability suite in any server.
 *
 * `createCapabilityHost()` builds the same dispatch surface a pracht app gets
 * from `handlePrachtRequest()` — capability HTTP endpoints, the remote MCP
 * endpoint, and the RFC 9728 protected-resource metadata document — from
 * capability objects and middleware functions registered at runtime. No app
 * manifest, no Vite plugin, no static analysis: `host.fetch(request)` answers
 * capability traffic and resolves to `null` for everything else, so it drops
 * into an Express handler, a Hono route, a Next.js route handler, or a bare
 * Cloudflare Worker in front of the rest of the application.
 *
 * Every request runs the exact production pipeline (`handleCapabilityRequest`
 * / `handleMcpRequest`): input validation, named middleware, Web Bot Auth
 * policy, the destructive prepare/commit confirmation flow, output validation,
 * and audit events. Nothing here is a re-implementation — a capability served
 * standalone behaves byte-for-byte like one served by a pracht app.
 */

import type { CapabilityEnvelope } from "../capability.ts";
import { CAPABILITY_HTTP_PREFIX, normalizeCapabilityHttpPath } from "../protocol.ts";
import type { PrachtAgentIdentity } from "../protocol.ts";
import { bindAgentContext } from "./agent-context.ts";
import { verifyAgentSignature } from "./agent-auth.ts";
import { validateAgentsConfig } from "./agents-config.ts";
import {
  envelopeResponse,
  handleCapabilityRequest,
  invokeCapabilityOnHost,
  matchCapabilityRoute,
  resolveAppCapabilities,
  setActiveCapabilityHost,
  type CapabilityHost as ActiveCapabilityHost,
  type ResolvedCapability,
} from "./capabilities.ts";
import {
  isMcpResourceMetadataPath,
  OAUTH_PROTECTED_RESOURCE_WELL_KNOWN,
  resolveMcpEndpoint,
} from "./mcp-config.ts";
import { handleMcpMetadataRequest, handleMcpRequest, normalizeMcpRequestPath } from "./mcp.ts";
import { formatUnknownNameError } from "./names.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type {
  CapabilityAuditHook,
  CapabilityModuleRegistry,
  McpAuthConfig,
  McpProjectionConfig,
  McpTokenVerifier,
  MiddlewareFn,
  PrachtAgentsConfig,
  PrachtCapability,
  PrachtContextExtensions,
} from "./types.ts";

/**
 * `McpAuthConfig` with the token verifier registered directly as a function.
 * In a pracht app the verifier is a server-only module reference because the
 * app manifest is bundled into the client; a standalone host is server code
 * already, so the indirection would be pure ceremony.
 */
export interface CapabilityHostMcpAuthConfig extends Omit<McpAuthConfig, "verify"> {
  verify: McpTokenVerifier;
}

export interface CapabilityHostMcpConfig extends Omit<McpProjectionConfig, "auth"> {
  auth?: CapabilityHostMcpAuthConfig;
}

export interface CapabilityHostAgentsConfig extends Omit<PrachtAgentsConfig, "mcp"> {
  mcp?: CapabilityHostMcpConfig;
}

export interface CreateCapabilityHostOptions<TContext = Record<string, unknown>> {
  /** Capability name → the object `defineCapability()` returns. */
  capabilities: Record<string, PrachtCapability>;
  /** Middleware name → function, for capabilities declaring `middleware: [name]`. */
  middleware?: Record<string, MiddlewareFn>;
  /**
   * Agent trust config — Web Bot Auth verification, the destructive
   * confirmation flow, and the remote MCP endpoint. Same shape as
   * `defineApp({ agents })`, except `mcp.auth.verify` is the verifier
   * function itself.
   */
  agents?: CapabilityHostAgentsConfig;
  /**
   * Middleware names wrapped around every HTTP and MCP dispatch (the
   * `defineApp({ api: { middleware } })` equivalent). Direct `invoke()` calls
   * deliberately skip these, exactly like `invokeCapability()` does.
   */
  apiMiddleware?: string[];
  /**
   * Reject state-changing capability requests whose browser provenance is not
   * an exact same-origin fetch — the CSRF stance pracht applies to its API
   * surface. Default `true`; opt out only if the surrounding server owns CSRF
   * protection.
   */
  requireSameOrigin?: boolean;
  /**
   * Include internal error details (messages, validation issues for server
   * bugs) in HTTP responses. Default `false` — production-safe redaction.
   */
  exposeErrors?: boolean;
  /**
   * Build the request context middleware and `run()` receive. Called once per
   * `fetch()` when no explicit context is passed. Return a fresh object per
   * request — contexts must not be reused across requests.
   */
  createContext?: (request: Request) => TContext | Promise<TContext>;
  /** Request-local audit sink, in addition to any process-level hooks. */
  onAudit?: CapabilityAuditHook;
  /**
   * Apply pracht's default security headers (`x-content-type-options`,
   * `x-frame-options`, `referrer-policy`, `permissions-policy`) to responses
   * the host produces. Default `true`.
   */
  securityHeaders?: boolean;
}

export interface CapabilityHostFetchInit<TContext> {
  /** Explicit request context; wins over `createContext`. */
  context?: TContext;
}

export interface CapabilityHostInvokeOptions<TContext> {
  request?: Request;
  context?: TContext;
  signal?: AbortSignal;
}

export interface StandaloneCapabilityHost<TContext = Record<string, unknown>> {
  /**
   * Serve one request. Resolves to `null` when the URL is not a capability
   * surface (no capability HTTP path, not the MCP endpoint, not the
   * well-known metadata document) so the caller can fall through to its own
   * routing; resolves to a `Response` for everything the host owns.
   */
  fetch(request: Request, init?: CapabilityHostFetchInit<TContext>): Promise<Response | null>;
  /**
   * Direct server invocation — same pipeline and typed envelope as
   * `invokeCapability()` inside a pracht app. Works for private
   * (non-exposed) capabilities too.
   */
  invoke<T = unknown>(
    name: string,
    input: unknown,
    options?: CapabilityHostInvokeOptions<TContext>,
  ): Promise<CapabilityEnvelope<T>>;
  /** The resolved capability graph, for introspection and tests. */
  capabilities(): Promise<readonly ResolvedCapability[]>;
  /** The MCP endpoint pathname this host serves, or `null` when MCP is off. */
  mcpPath: string | null;
}

const HOST_INVOKE_ORIGIN = "http://capability-host.local";

export function createCapabilityHost<TContext = Record<string, unknown>>(
  options: CreateCapabilityHostOptions<TContext>,
): StandaloneCapabilityHost<TContext> {
  const capabilityFiles: Record<string, string> = {};
  const capabilityModules: NonNullable<CapabilityModuleRegistry["capabilityModules"]> = {};
  for (const [name, capability] of Object.entries(options.capabilities)) {
    const file = `host:capability:${name}`;
    capabilityFiles[name] = file;
    capabilityModules[file] = async () => ({ default: capability });
  }

  const middlewareFilesByName: Record<string, string> = {};
  const middlewareModules: NonNullable<CapabilityModuleRegistry["middlewareModules"]> = {};
  for (const [name, middleware] of Object.entries(options.middleware ?? {})) {
    const file = `host:middleware:${name}`;
    middlewareFilesByName[name] = file;
    middlewareModules[file] = async () => ({ middleware });
  }

  const apiMiddlewareFiles = (options.apiMiddleware ?? []).map((name) => {
    const file = middlewareFilesByName[name];
    if (!file) {
      throw new Error(
        formatUnknownNameError({
          kind: "middleware",
          kindPlural: "middleware",
          name,
          registered: Object.keys(middlewareFilesByName),
          context: "apiMiddleware",
        }),
      );
    }
    return file;
  });

  const registry: CapabilityModuleRegistry = { capabilityModules, middlewareModules };

  // Reject exactly the agent-trust misconfigurations `defineApp()` rejects —
  // a relative OAuth resource, a resource that does not address the MCP
  // endpoint, the reserved well-known path, malformed scopes — before a
  // request can hit them. A standalone host has no deploy base, so the
  // resource must address the configured endpoint path as-is.
  validateAgentsConfig(options.agents as PrachtAgentsConfig | undefined, {
    label: (path) => `createCapabilityHost({ ${path} })`,
    verifyMode: "function",
  });

  // The verifier function is registered like any other server-only module so
  // `loadMcpTokenVerifier()` — the code path a pracht app exercises — resolves
  // it identically.
  const agents = resolveHostAgents(options.agents, registry);

  const app = {
    agents,
    capabilities: capabilityFiles,
    middleware: middlewareFilesByName,
  };

  const exposeErrors = options.exposeErrors ?? false;
  const requireSameOrigin = options.requireSameOrigin ?? true;
  const securityHeaders = options.securityHeaders ?? true;
  const mcpPath = resolveMcpEndpoint(agents);

  const finalize = (response: Response): Response =>
    securityHeaders ? withHostSecurityHeaders(response) : response;

  const resolveContext = async (
    request: Request,
    explicit: TContext | undefined,
  ): Promise<TContext> => {
    if (explicit !== undefined) return explicit;
    if (options.createContext) return options.createContext(request);
    return {} as TContext;
  };

  return {
    mcpPath,

    capabilities() {
      return resolveAppCapabilities(app, registry);
    },

    async fetch(request, init = {}) {
      const url = new URL(request.url);

      // OAuth 2.0 protected-resource metadata (RFC 9728), served only when the
      // app opted into `agents.mcp.auth`. Ahead of everything else: §3.1 puts
      // the document at the origin root, and discovery happens before a host
      // has any token.
      const metadataAuth = agents?.mcp?.auth;
      if (metadataAuth && url.pathname.includes(OAUTH_PROTECTED_RESOURCE_WELL_KNOWN)) {
        if (isMcpResourceMetadataPath(url.pathname, metadataAuth)) {
          return finalize(await handleMcpMetadataRequest(request, metadataAuth));
        }
      }

      const pathname = normalizeMcpRequestPath(url.pathname);
      const isMcpRequest = mcpPath !== null && pathname === mcpPath;

      let requestContext: unknown = await resolveContext(request, init.context);
      let agent: PrachtAgentIdentity | null = null;

      // Web Bot Auth: verify the agent signature once per request when
      // configured. The result (identity or null) lands on the request
      // context before middleware or capabilities run.
      if (agents?.webBotAuth) {
        if (request.headers.has("signature-input")) {
          agent = await verifyAgentSignature(request, agents.webBotAuth);
        }
        try {
          const bound = bindAgentContext(requestContext, agent);
          requestContext = bound;
          agent = (bound as PrachtContextExtensions).agent ?? null;
        } catch (error: unknown) {
          return finalize(
            new Response(
              exposeErrors
                ? `Request context could not carry verified agent identity: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                : "Internal Server Error",
              { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
            ),
          );
        }
      }

      // Register the request so `invokeCapability()`-style composition works
      // from capability middleware and run() bodies.
      setActiveCapabilityHost(
        request,
        app,
        registry,
        isMcpRequest ? "mcp" : "http",
        options.onAudit,
        agent,
      );

      if (isMcpRequest && agents?.mcp) {
        const mcpResponse = await handleMcpRequest({
          app,
          capabilities: [],
          loadCapabilities: () => resolveAppCapabilities(app, registry),
          context: requestContext,
          registry,
          request,
          url,
          exposeErrors,
          mcp: agents.mcp,
          apiMiddlewareFiles,
          agents,
          agent,
          onAudit: options.onAudit,
        });
        return finalize(mcpResponse);
      }

      let capabilities: ResolvedCapability[];
      try {
        capabilities = await resolveAppCapabilities(app, registry);
      } catch (error: unknown) {
        // A broken capability definition fails closed on capability paths and
        // stays out of the way everywhere else.
        if (couldBeCapabilityPath(options.capabilities, url.pathname)) {
          return finalize(
            envelopeResponse(500, {
              ok: false,
              error: {
                code: "internal_error",
                message: exposeErrors
                  ? `Capability registry failed to resolve: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  : "Capability registry failed to resolve.",
              },
            }),
          );
        }
        return null;
      }

      const match = matchCapabilityRoute(capabilities, url.pathname);
      if (match) {
        // Same CSRF stance as pracht's API surface: capability calls may be
        // session-authenticated POSTs, so cross-origin browser requests are
        // rejected unless the embedder opted out.
        if (
          requireSameOrigin &&
          request.method.toUpperCase() !== "GET" &&
          request.method.toUpperCase() !== "HEAD" &&
          !isSameOriginRequest(request, url)
        ) {
          return finalize(
            envelopeResponse(403, {
              ok: false,
              error: { code: "cross_origin_blocked", message: "Cross-origin request blocked" },
            }),
          );
        }

        return finalize(
          await handleCapabilityRequest({
            match,
            context: requestContext,
            registry,
            request,
            url,
            pathname: match.httpPath ?? url.pathname,
            exposeErrors,
            apiMiddlewareFiles,
            agents,
            agent,
            onAudit: options.onAudit,
          }),
        );
      }

      // Unmatched requests under the capability prefix get the typed 404
      // instead of falling through to the embedding application.
      if (normalizeCapabilityHttpPath(url.pathname).startsWith(CAPABILITY_HTTP_PREFIX)) {
        // Same terse message as the framework runtime: the 404 is reachable by
        // anonymous callers, so it must not enumerate the registered graph.
        return finalize(
          envelopeResponse(404, {
            ok: false,
            error: {
              code: "unknown_capability",
              message: "No capability is exposed at this path.",
            },
          }),
        );
      }

      return null;
    },

    async invoke<T = unknown>(
      name: string,
      input: unknown,
      invokeOptions: CapabilityHostInvokeOptions<TContext> = {},
    ): Promise<CapabilityEnvelope<T>> {
      const host: ActiveCapabilityHost = { app, registry, onAudit: options.onAudit };
      const request = invokeOptions.request ?? new Request(`${HOST_INVOKE_ORIGIN}/`);
      const context =
        invokeOptions.context ??
        (options.createContext ? await options.createContext(request) : {});
      return invokeCapabilityOnHost<T>(host, name, input, {
        request,
        context,
        signal: invokeOptions.signal,
      });
    },
  };
}

/**
 * Whether a URL could address one of the registered capabilities even though
 * full resolution failed — the generated-prefix form plus any custom
 * `expose.http` path is unknowable without loading the modules, so only the
 * prefix is checked here. Custom-path capabilities that fail resolution
 * therefore fall through; the embedding router will 404 them.
 */
function couldBeCapabilityPath(
  capabilities: Record<string, PrachtCapability>,
  pathname: string,
): boolean {
  if (normalizeCapabilityHttpPath(pathname).startsWith(CAPABILITY_HTTP_PREFIX)) return true;
  const normalized = normalizeCapabilityHttpPath(pathname);
  for (const capability of Object.values(capabilities)) {
    const path = capability?.expose?.http?.path;
    if (typeof path === "string" && normalizeCapabilityHttpPath(path) === normalized) return true;
  }
  return false;
}

function resolveHostAgents(
  agents: CapabilityHostAgentsConfig | undefined,
  registry: CapabilityModuleRegistry,
): PrachtAgentsConfig | undefined {
  if (!agents) return undefined;
  if (!agents.mcp?.auth) return agents as PrachtAgentsConfig;

  const { verify, ...auth } = agents.mcp.auth;
  if (typeof verify !== "function") {
    throw new Error("createCapabilityHost(): agents.mcp.auth.verify must be a verifier function.");
  }
  const verifyFile = "host:mcp-token-verify";
  registry.dataModules = {
    ...registry.dataModules,
    [verifyFile]: async () => ({ default: verify }),
  };
  return {
    ...agents,
    mcp: { ...agents.mcp, auth: { ...auth, verify: verifyFile } },
  };
}

/** The same four defaults pracht sets on every response path. */
function withHostSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("permissions-policy")) {
    headers.set(
      "permissions-policy",
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
    );
  }
  if (!headers.has("referrer-policy")) {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (!headers.has("x-content-type-options")) {
    headers.set("x-content-type-options", "nosniff");
  }
  if (!headers.has("x-frame-options")) {
    headers.set("x-frame-options", "SAMEORIGIN");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
