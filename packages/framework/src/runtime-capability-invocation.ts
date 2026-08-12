/**
 * Request-scoped capability hosts and direct server-side invocation.
 *
 * Loaders, middleware, API routes, remote MCP tools, and the capability test
 * host all compose registered capabilities through the same execution pipeline
 * without inheriting HTTP-only API middleware.
 */

import { formatUnknownNameError } from "./name-suggestions.ts";
import { capabilityEnvelopeOutcome, emitCapabilityAudit } from "./runtime-capability-audit.ts";
import {
  CAPABILITY_TIMEOUT_MS,
  envelopeResponse,
  errorEnvelope,
  middlewareErrorCode,
  runCapabilityPipeline,
  type CapabilityPipelineOutcome,
} from "./runtime-capability-pipeline.ts";
import {
  resolveAppCapabilities,
  type CapabilityHostApp,
  type ResolvedCapability,
} from "./runtime-capability-registry.ts";
import { bindAgentContext, snapshotAgentIdentity } from "./runtime-agent-context.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityCallInputFor,
  CapabilityEnvelope,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtContextExtensions,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Direct server-side invocation
// ---------------------------------------------------------------------------

export interface CapabilityHost {
  app: CapabilityHostApp;
  registry: ModuleRegistry;
  /** Request-local audit hook supplied by a custom server entry. */
  onAudit?: CapabilityAuditHook;
  /** Verified identity bound by a trusted transport, never caller-supplied context. */
  agent?: PrachtAgentIdentity | null;
  /**
   * Transport of the request this host was installed for. Carried onto the
   * audit event of every capability composed through `invokeCapability()`
   * while that request is being served. Absent on synthetic hosts (test
   * hosts), which serve no request.
   */
  via?: CapabilityAuditEvent["via"];
}

// Bind each host to the incoming Request rather than a process-global slot.
// Custom servers may serve multiple Pracht apps from one process, and dev HMR
// can replace a registry while an older request is still awaiting its loader.
// A WeakMap keeps those overlapping invocations isolated on every Web runtime
// without retaining completed requests.
const activeCapabilityHosts = new WeakMap<Request, CapabilityHost>();

export function setActiveCapabilityHost(
  request: Request,
  app: CapabilityHostApp,
  registry: ModuleRegistry,
  /** Transport of the request being served; audits nested composition. */
  via: NonNullable<CapabilityAuditEvent["via"]> = "http",
  onAudit?: CapabilityAuditHook,
  agent?: PrachtAgentIdentity | null,
): void {
  activeCapabilityHosts.set(request, {
    app,
    registry,
    via,
    onAudit,
    agent: snapshotAgentIdentity(agent ?? null),
  });
}

export interface InvokeCapabilityContext<TContext = unknown> {
  /** The incoming request — middleware and `run()` receive it. */
  request: Request;
  context?: TContext;
  signal?: AbortSignal;
}

/**
 * Invoke a registered capability directly from server code (loaders, API
 * routes, middleware). Runs the exact same pipeline as the HTTP projection —
 * input validation, the capability's named middleware, `run()`, output
 * validation — and resolves to the same typed envelope. Works for private
 * (non-exposed) capabilities too.
 *
 * This is trusted first-party composition, so app-level `api.middleware` is
 * deliberately not re-applied and private capabilities remain callable as
 * building blocks. Remote MCP is the exception: a call composed under an MCP
 * tool re-applies the callee's `agentPolicy` and refuses destructive effects,
 * because otherwise a non-destructive tool could lend remote agents authority
 * that the callee's MCP projection would deny. Composed dispatches are audited
 * with `transport: "server"` and `via` set to the transport of the request being
 * served, so a remote-agent-caused effect stays attributable.
 *
 * When `pracht typegen` has registered the capability graph on
 * `Register["capabilities"]`, the name, input, and output types all come from
 * the registration: an unknown name or a mismatched input is a compile error,
 * not a runtime envelope.
 *
 * The untyped `invokeCapability<Output>(name, ...)` form remains for apps that
 * have not run typegen. Once anything is registered its `name` parameter
 * resolves to `never`, so a mistake can no longer fall through to it — which
 * is the whole point, but it does mean an explicit type argument is a compile
 * error in a registered app. Drop the type argument and let it infer.
 */
export async function invokeCapability<TName extends CapabilityName>(
  name: TName,
  input: CapabilityCallInputFor<TName>,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
export async function invokeCapability<T = unknown>(
  name: HasRegisteredCapabilities extends true ? never : string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>>;
export async function invokeCapability<T = unknown>(
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>> {
  const host = activeCapabilityHosts.get(ctx.request);
  if (!host) {
    throw new Error(
      "invokeCapability() has no capability host for this request. It is only available while " +
        "handlePrachtRequest() is serving requests (loaders, API routes, middleware). " +
        "In tests, build a standalone host with createCapabilityTestHost() instead.",
    );
  }
  return invokeCapabilityOnHost(host, name, input, ctx);
}

/**
 * Run one capability through the full dispatch pipeline against an explicit
 * host. Shared by `invokeCapability()` (the request-bound host installed by
 * `handlePrachtRequest`) and `createCapabilityTestHost()` (a synthetic host
 * for tests).
 */
export async function invokeCapabilityOnHost<T = unknown>(
  host: CapabilityHost,
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>> {
  const capabilities = await resolveAppCapabilities(host.app, host.registry);
  const resolved = capabilities.find((entry) => entry.name === name);
  if (!resolved) {
    return errorEnvelope({
      code: "unknown_capability",
      message: formatUnknownNameError({
        kind: "capability",
        kindPlural: "capabilities",
        name,
        registered: capabilities.map((entry) => entry.name),
      }),
    }) as CapabilityEnvelope<T>;
  }

  const started = performance.now();
  let context: unknown = ctx.context ?? {};
  let outcome: CapabilityPipelineOutcome;
  try {
    context = capabilityPipelineContext(host, ctx.context);
    outcome =
      mcpCompositionGuard(host, resolved) ??
      (await runCapabilityPipeline({
        resolved,
        input,
        context,
        registry: host.registry,
        request: ctx.request,
        signal: ctx.signal ?? AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
        url: new URL(ctx.request.url),
        // Direct invocation stays server-side, so real error messages are safe.
        exposeErrors: true,
      }));
  } catch (error: unknown) {
    // Middleware resolution/execution can throw (bad module, a middleware that
    // does not return a Response). HTTP dispatch turns these into an
    // internal_error envelope; direct invocation must honor the same
    // envelope-returning contract rather than rejecting.
    const envelope = errorEnvelope({
      code: "internal_error",
      message: `Capability "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    emitCapabilityAudit(
      {
        capability: name,
        effect: resolved.capability.effect,
        transport: "server",
        via: host.via ?? null,
        outcome: "internal_error",
        status: 500,
        durationMs: performance.now() - started,
        agent: capabilityHostAgent(host, context),
      },
      host.onAudit,
    );
    return envelope as CapabilityEnvelope<T>;
  }

  // Direct invocation audits like HTTP dispatch does, marked as the "server"
  // transport and attributed to the transport of the request it was composed
  // under (`via`). The agent identity travels on the request context when Web
  // Bot Auth is enabled.
  const agent = capabilityHostAgent(host, context);
  const status = outcome.kind === "envelope" ? outcome.status : outcome.response.status;
  const auditOutcome =
    outcome.kind === "envelope"
      ? capabilityEnvelopeOutcome(outcome.envelope)
      : `middleware_${status}`;
  emitCapabilityAudit(
    {
      capability: name,
      effect: resolved.capability.effect,
      transport: "server",
      via: host.via ?? null,
      outcome: auditOutcome,
      status,
      durationMs: performance.now() - started,
      agent,
    },
    host.onAudit,
  );

  if (outcome.kind === "envelope") {
    return outcome.envelope as CapabilityEnvelope<T>;
  }

  const code = middlewareErrorCode(status);
  return errorEnvelope({
    code,
    message: `Capability middleware short-circuited with status ${status}.`,
  }) as CapabilityEnvelope<T>;
}

/**
 * Remote MCP tools may compose private capabilities, but they must not turn
 * that server-only reachability into a bypass around agent identity or the
 * transport's destructive-effect prohibition. These checks run before the
 * callee's pipeline, matching the placement of `agentPolicy` in HTTP dispatch
 * and ensuring denied calls cannot trigger middleware side effects.
 */
function mcpCompositionGuard(
  host: CapabilityHost,
  resolved: ResolvedCapability,
): CapabilityPipelineOutcome | null {
  if (host.via !== "mcp") return null;

  const policy =
    resolved.capability.agentPolicy ?? host.app.agents?.webBotAuth?.policy ?? "observe";
  if (policy === "require" && !host.agent) {
    const envelope = errorEnvelope({
      code: "agent_required",
      message: `Capability "${resolved.name}" requires a verified agent signature (Web Bot Auth).`,
    });
    return { kind: "envelope", status: 401, envelope, response: envelopeResponse(401, envelope) };
  }

  if (resolved.capability.effect === "destructive") {
    const envelope = errorEnvelope({
      code: "forbidden",
      message: `Capability "${resolved.name}" cannot be composed from remote MCP because it is destructive.`,
    });
    return { kind: "envelope", status: 403, envelope, response: envelopeResponse(403, envelope) };
  }

  return null;
}

/**
 * Keep the context seen by nested MCP middleware and capability bodies on the
 * same trusted identity used by the policy guard and audit trail. The
 * framework-owned field is rebound to an immutable snapshot without changing
 * other shared request-context fields. Immutable contexts receive an
 * extensible receiver-preserving overlay, so binding identity never turns a
 * valid nested call into a rejected promise.
 */
function capabilityPipelineContext<TContext>(
  host: CapabilityHost,
  supplied: TContext | undefined,
): TContext | PrachtContextExtensions {
  const context = supplied ?? {};
  const carriesTransportIdentity =
    !!host.app.agents?.webBotAuth && (host.via === "http" || host.via === "mcp");
  if (!carriesTransportIdentity) return context;
  return bindAgentContext(context, host.agent ?? null);
}

function capabilityHostAgent<TContext>(
  host: CapabilityHost,
  context: TContext,
): PrachtAgentIdentity | null {
  return host.via === "http" || host.via === "mcp"
    ? (host.agent ?? null)
    : ((context as { agent?: PrachtAgentIdentity | null }).agent ?? null);
}
