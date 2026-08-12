/**
 * Request-scoped agent-surface initialization.
 *
 * This boundary owns lazy capability/MCP loading, optional Web Bot Auth
 * verification, immutable request-context binding, and HTTP invocation-host
 * registration. Builds that prove an app has no agent surface can eliminate
 * the dynamic runtimes below in one place.
 */

import { withDefaultSecurityHeaders } from "./runtime-headers.ts";
import type {
  CapabilityAuditHook,
  McpProjectionConfig,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtApp,
  PrachtContextExtensions,
} from "./types.ts";

/**
 * Build-time proof that the app has no registered capabilities or `agents`
 * config. The Vite plugin only defines this as false when static manifest
 * analysis proves both are absent; uncertain manifests keep runtime checks.
 */
declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

export const AGENT_SURFACE_ENABLED =
  typeof __PRACHT_AGENT_SURFACE__ === "undefined" || __PRACHT_AGENT_SURFACE__;

export type CapabilityRuntime = typeof import("./runtime-capabilities.ts");
export type McpRuntime = typeof import("./runtime-mcp.ts");

export type AgentSurfaceInitialization<TContext> =
  | {
      ok: true;
      agent: PrachtAgentIdentity | null;
      capabilityRuntime: CapabilityRuntime | null;
      context: TContext & PrachtContextExtensions;
      hasCapabilities: boolean;
      mcpConfig: McpProjectionConfig | undefined;
      mcpRuntime: McpRuntime | null;
    }
  | { ok: false; response: Response };

export async function initializeAgentSurface<TContext>(options: {
  app: PrachtApp;
  context?: TContext;
  exposeDiagnostics: boolean;
  onAudit?: CapabilityAuditHook;
  registry: ModuleRegistry;
  request: Request;
}): Promise<AgentSurfaceInitialization<TContext>> {
  let context = (options.context ?? {}) as TContext & PrachtContextExtensions;
  const hasCapabilities = Object.keys(options.app.capabilities ?? {}).length > 0;
  const mcpConfig = options.app.agents?.mcp;
  let capabilityRuntime: CapabilityRuntime | null = null;
  let mcpRuntime: McpRuntime | null = null;
  let agent: PrachtAgentIdentity | null = null;

  // Apps with neither capabilities nor agents never load either runtime. A
  // build-time false define makes this whole branch unreachable to bundlers.
  if (AGENT_SURFACE_ENABLED) {
    if (hasCapabilities || mcpConfig) {
      [capabilityRuntime, mcpRuntime] = await Promise.all([
        import("./runtime-capabilities.ts"),
        mcpConfig ? import("./runtime-mcp.ts") : Promise.resolve(null),
      ]);
    }

    const webBotAuth = options.app.agents?.webBotAuth;
    if (webBotAuth) {
      const { bindAgentContext } = await import("./runtime-agent-context.ts");
      if (options.request.headers.has("signature-input")) {
        const { verifyAgentSignature } = await import("./runtime-agent-auth.ts");
        agent = await verifyAgentSignature(options.request, webBotAuth);
      }
      try {
        context = bindAgentContext(context, agent);
      } catch (error: unknown) {
        // An unbindable context fails closed. Return a response instead of
        // rejecting, which would otherwise escape the adapter as an unhandled
        // request failure.
        warnAgentContextBindingFailure(error);
        return {
          ok: false,
          response: withDefaultSecurityHeaders(
            new Response(
              options.exposeDiagnostics
                ? `Request context could not carry verified agent identity: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                : "Internal Server Error",
              { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
            ),
          ),
        };
      }
      agent = context.agent ?? null;
    }

    // Register HTTP provenance before middleware, loaders, or API routes can
    // call invokeCapability(). MCP dispatch replaces it after API precedence.
    if (capabilityRuntime && (hasCapabilities || mcpConfig)) {
      capabilityRuntime.setActiveCapabilityHost(
        options.request,
        options.app,
        options.registry,
        "http",
        options.onAudit,
        agent,
      );
    }
  } else if (hasCapabilities || options.app.agents) {
    // Only reachable when runtime registrations disagree with the manifest
    // shape proven at build time.
    warnAgentSurfaceElided();
  }

  return {
    ok: true,
    agent,
    capabilityRuntime,
    context,
    hasCapabilities,
    mcpConfig,
    mcpRuntime,
  };
}

let warnedAgentSurfaceElided = false;

function warnAgentSurfaceElided(): void {
  if (warnedAgentSurfaceElided) return;
  warnedAgentSurfaceElided = true;
  console.error(
    "[pracht] This build dropped the capability and agent-trust runtime because the app " +
      "manifest registered neither, but the running app has capabilities or an `agents` " +
      "config. Capability requests will 404 and agent signatures will not be verified. " +
      "Register capabilities as literal entries in `defineApp({ capabilities })` so the " +
      "build can see them, then rebuild.",
  );
}

let warnedAgentContextBindingFailure = false;

function warnAgentContextBindingFailure(error: unknown): void {
  if (warnedAgentContextBindingFailure) return;
  warnedAgentContextBindingFailure = true;
  console.error(
    "[pracht] Verified agent identity could not be bound to the request context; " +
      "requests fail closed with a 500:",
    error,
  );
}
