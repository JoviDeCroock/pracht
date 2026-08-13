/**
 * MCP and capability HTTP projection routing.
 *
 * Explicit API routes run before this module. Once reached, it selects MCP or
 * capability HTTP transport, resolves the shared capability graph, preserves
 * trusted request provenance, and keeps registry failures scoped to agent
 * endpoints instead of taking down page rendering.
 */

import type { CapabilityRuntime, McpRuntime } from "./runtime-agent-surface.ts";
import { SAFE_METHODS } from "./runtime-constants.ts";
import { withEnhancedCapabilityFormRedirect } from "./runtime-capability-form-redirect.ts";
import { withDefaultSecurityHeaders } from "./runtime-response-security.ts";
import { isSameOriginRequest } from "./runtime-request-provenance.ts";
import type {
  CapabilityAuditHook,
  McpProjectionConfig,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtApp,
} from "./types.ts";

export interface DispatchAgentProjectionOptions<TContext> {
  agent: PrachtAgentIdentity | null;
  apiMiddlewareFiles: string[];
  app: PrachtApp;
  capabilityRuntime: CapabilityRuntime;
  context: TContext;
  exposeErrors: boolean;
  hasCapabilities: boolean;
  mcpConfig: McpProjectionConfig | undefined;
  mcpRuntime: McpRuntime | null;
  onAudit?: CapabilityAuditHook;
  registry: ModuleRegistry;
  request: Request;
  requireSameOrigin: boolean;
  url: URL;
}

/** Return the agent projection response, or `null` to continue to pages. */
export async function dispatchAgentProjection<TContext>(
  options: DispatchAgentProjectionOptions<TContext>,
): Promise<Response | null> {
  const isMcpRequest =
    !!options.mcpConfig &&
    !!options.mcpRuntime &&
    options.mcpRuntime.normalizeMcpRequestPath(options.url.pathname) ===
      options.mcpRuntime.resolveMcpEndpoint(options.app.agents);
  if (!options.hasCapabilities && !isMcpRequest) return null;

  if (isMcpRequest) {
    // Adapter contexts may retain the incoming transport request. Bind the
    // same trusted provenance as synthesized capability requests so either
    // request preserves the MCP composition guard.
    options.capabilityRuntime.setActiveCapabilityHost(
      options.request,
      options.app,
      options.registry,
      "mcp",
      options.onAudit,
      options.agent,
    );
  }

  const {
    CAPABILITY_HTTP_PREFIX,
    envelopeResponse,
    handleCapabilityRequest,
    isRegisteredCapabilityHttpPath,
    matchCapabilityRoute,
    resolveAppCapabilities,
  } = options.capabilityRuntime;
  let capabilities: Awaited<ReturnType<typeof resolveAppCapabilities>> | null =
    options.hasCapabilities ? null : [];
  let resolutionError: unknown;
  try {
    if (options.hasCapabilities) {
      capabilities = await resolveAppCapabilities(options.app, options.registry);
    }
  } catch (error: unknown) {
    resolutionError = error;
    warnCapabilityResolutionFailure(error);
    // Broken capability definitions do not take down pages, while requests to
    // capability paths still fail closed.
    if (
      !isMcpRequest &&
      (options.url.pathname.startsWith(CAPABILITY_HTTP_PREFIX) ||
        (await isRegisteredCapabilityHttpPath(options.app, options.registry, options.url.pathname)))
    ) {
      return withDefaultSecurityHeaders(
        envelopeResponse(500, {
          ok: false,
          error: {
            code: "internal_error",
            message: options.exposeErrors
              ? `Capability registry failed to resolve: ${error instanceof Error ? error.message : String(error)}`
              : "Capability registry failed to resolve.",
          },
        }),
      );
    }
  }

  if (isMcpRequest && options.mcpConfig && options.mcpRuntime) {
    return withDefaultSecurityHeaders(
      await options.mcpRuntime.handleMcpRequest({
        app: options.app,
        capabilities: capabilities ?? [],
        context: options.context,
        registry: options.registry,
        request: options.request,
        url: options.url,
        exposeErrors: options.exposeErrors,
        mcp: options.mcpConfig,
        apiMiddlewareFiles: options.apiMiddlewareFiles,
        agents: options.app.agents,
        agent: options.agent,
        onAudit: options.onAudit,
        resolutionError,
      }),
    );
  }

  if (!capabilities) return null;
  const match = matchCapabilityRoute(capabilities, options.url.pathname);
  if (match) {
    if (
      options.requireSameOrigin &&
      !SAFE_METHODS.has(options.request.method) &&
      !isSameOriginRequest(options.request, options.url)
    ) {
      return withDefaultSecurityHeaders(
        envelopeResponse(403, {
          ok: false,
          error: { code: "cross_origin_blocked", message: "Cross-origin request blocked" },
        }),
      );
    }

    const response = await handleCapabilityRequest({
      match,
      context: options.context,
      registry: options.registry,
      request: options.request,
      url: options.url,
      exposeErrors: options.exposeErrors,
      apiMiddlewareFiles: options.apiMiddlewareFiles,
      agents: options.app.agents,
      agent: options.agent,
      onAudit: options.onAudit,
    });
    return withDefaultSecurityHeaders(
      withEnhancedCapabilityFormRedirect(response, options.request),
    );
  }

  // Capability namespace misses stay on the typed agent protocol surface.
  if (options.url.pathname.startsWith(CAPABILITY_HTTP_PREFIX)) {
    return withDefaultSecurityHeaders(
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
}

let warnedCapabilityResolutionFailure = false;

function warnCapabilityResolutionFailure(error: unknown): void {
  if (warnedCapabilityResolutionFailure) return;
  warnedCapabilityResolutionFailure = true;
  console.error(
    "[pracht] Capability registry failed to resolve; capability requests will fail closed:",
    error,
  );
}
