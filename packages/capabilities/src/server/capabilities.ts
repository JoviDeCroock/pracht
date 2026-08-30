/**
 * Capability registry and execution pipeline.
 *
 * Capabilities are registered in the app manifest (like shells/middleware)
 * and executed through one pipeline regardless of how they are invoked:
 *
 *   input validation → named middleware chain → run() → output validation
 *
 * Both the generated HTTP projection (`handlePrachtRequest`) and direct
 * server-side use (`invokeCapability`) call the same pipeline, so business
 * rules can never diverge between transports. Capabilities are private by
 * default — only `expose.http` makes one reachable over the network.
 */

import { MCP_SCHEMA_ROOT_ERROR } from "../capability.ts";
import { coerceFormInput } from "../form.ts";
import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_HTTP_PREFIX,
  CAPABILITY_TRANSPORT_HEADER,
  capabilityHttpPath,
  DEFAULT_MCP_ENDPOINT,
  isValidCapabilityHttpPath,
  isValidMcpToolName,
  isValidWebmcpToolName,
  MCP_CONFIRMATION_META_KEY,
  MCP_TOOL_NAME_ERROR,
  mcpToolName,
  normalizeCapabilityHttpPath,
  WEBMCP_TOOL_NAME_ERROR,
} from "../protocol.ts";
import { globalSlot } from "./global-state.ts";
import { formatUnknownNameError } from "./names.ts";
import {
  capabilityApprovalId,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
} from "./approval.ts";
import { bindAgentContext, rebindMcpTokenContext, snapshotAgentIdentity } from "./agent-context.ts";
import {
  canonicalJson,
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  consumeConfirmationToken,
  createConfirmationToken,
  DEFAULT_CONFIRMATION_TTL_SECONDS,
  resolveConfirmationSecret,
  sha256Base64Url,
  verifyConfirmationToken,
} from "./confirmation.ts";
import { resolveRegistryModule } from "./registry.ts";
import { runMiddlewareChain } from "./middleware.ts";
import type { CapabilityEnvelope, CapabilityErrorPayload } from "../capability.ts";
import type { CapabilityErrorCode, PrachtAgentIdentity } from "../protocol.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityModule,
  CapabilityModuleRegistry,
  CapabilityRouteDescriptor,
  McpTokenPrincipal,
  PrachtAgentsConfig,
  PrachtCapability,
  PrachtContextExtensions,
} from "./types.ts";

export { CAPABILITY_HTTP_PREFIX, capabilityHttpPath };

/** Longest a capability may run before its signal aborts, matching API routes. */
const CAPABILITY_TIMEOUT_MS = 30_000;

/** Names must be URL-safe: dot-separated segments of [a-z0-9_-]. */
const CAPABILITY_NAME_RE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i;

export interface ResolvedCapability {
  name: string;
  file: string;
  capability: PrachtCapability;
  /** Dispatch path when `expose.http` is set, `null` for private capabilities. */
  httpPath: string | null;
  middlewareFiles: string[];
}

/**
 * The slice of an app a capability host needs: registered capability and
 * middleware names (mapped to registry file keys) plus the agent trust
 * config. `@pracht/core` passes its resolved `PrachtApp`, which is
 * structurally assignable; `createCapabilityHost()` and the test host build
 * it synthetically.
 */
export interface CapabilityHostApp {
  agents?: PrachtAgentsConfig;
  capabilities?: Record<string, string>;
  middleware?: Record<string, string>;
}

// Resolution loads every registered capability module once per app manifest +
// registry instance. Resolution also depends on app-level middleware and MCP
// configuration, so keying only by the capabilities record could leak a result
// between distinct app manifests that happen to share that record. Dev HMR can
// keep the same app manifest object while replacing the generated registry
// after a capability edit, so both identities participate in the cache key.
const resolvedCapabilitiesCache = new WeakMap<
  object,
  WeakMap<object, Promise<ResolvedCapability[]>>
>();
const EMPTY_CAPABILITY_MODULES = {};

export function resolveAppCapabilities(
  app: CapabilityHostApp,
  registry: CapabilityModuleRegistry,
): Promise<ResolvedCapability[]> {
  const capabilityModules = registry.capabilityModules ?? EMPTY_CAPABILITY_MODULES;
  let registryCache = resolvedCapabilitiesCache.get(app);
  if (!registryCache) {
    registryCache = new WeakMap();
    resolvedCapabilitiesCache.set(app, registryCache);
  }
  let resolved = registryCache.get(capabilityModules);
  if (!resolved) {
    resolved = resolveAppCapabilitiesUncached(app, registry);
    registryCache.set(capabilityModules, resolved);
  }
  return resolved;
}

async function resolveAppCapabilitiesUncached(
  app: CapabilityHostApp,
  registry: CapabilityModuleRegistry,
): Promise<ResolvedCapability[]> {
  const resolved: ResolvedCapability[] = [];
  const seenHttpPaths = new Map<string, string>();
  const mcpEndpoint = app.agents?.mcp
    ? normalizeCapabilityHttpPath(app.agents.mcp.path ?? DEFAULT_MCP_ENDPOINT)
    : null;

  for (const [name, file] of Object.entries(app.capabilities ?? {})) {
    if (!CAPABILITY_NAME_RE.test(name)) {
      throw new Error(
        `Invalid capability name "${name}". Names must be dot-separated segments of ` +
          'letters, numbers, hyphens, and underscores (e.g. "notes.search").',
      );
    }

    const module = await resolveRegistryModule<CapabilityModule>(registry.capabilityModules, file);
    const capability = module?.default;
    if (!capability || capability.kind !== "capability") {
      throw new Error(
        `Capability "${name}" (${file}) must default-export the result of ` +
          "defineCapability() from @pracht/capabilities.",
      );
    }

    // `defineCapability()` already refuses this; re-check here so a
    // hand-rolled capability object fails closed before it can be served.
    // Destructive + HTTP and destructive + MCP are both allowed — the
    // prepare/commit confirmation flow gates every dispatch on either, and the
    // MCP projection additionally requires the `agents.mcp.destructive`
    // opt-in before it serves one. WebMCP stays disallowed: a browser host's
    // approval UX is not a security boundary.
    if (capability.effect === "destructive" && capability.expose?.webmcp) {
      throw new Error(
        `Capability "${name}": destructive capabilities cannot be exposed as WebMCP page ` +
          "tools — use expose.http, or expose.mcp with agents.mcp.destructive.",
      );
    }
    if (capability.expose?.webmcp && !capability.expose.http) {
      throw new Error(`Capability "${name}": expose.webmcp requires expose.http.`);
    }
    // The registered capability name is projected verbatim as the WebMCP tool
    // name, and the browser rejects names outside the spec grammar — fail here
    // rather than letting registration fail silently in the page.
    if (capability.expose?.webmcp && !isValidWebmcpToolName(name)) {
      throw new Error(`Capability "${name}": ${WEBMCP_TOOL_NAME_ERROR}.`);
    }
    if (
      capability.expose?.mcp &&
      (capability.input?.type !== "object" || capability.output?.type !== "object")
    ) {
      throw new Error(`Capability "${name}": ${MCP_SCHEMA_ROOT_ERROR}.`);
    }
    if (capability.expose?.mcp && !isValidMcpToolName(mcpToolName(name))) {
      throw new Error(`Capability "${name}": ${MCP_TOOL_NAME_ERROR}.`);
    }
    if (
      capability.expose &&
      (typeof capability.validateInput !== "function" ||
        typeof capability.validateOutput !== "function" ||
        typeof capability.description !== "string" ||
        !capability.input ||
        !capability.output ||
        !capability.effect)
    ) {
      throw new Error(
        `Capability "${name}" is exposed but is missing its contract ` +
          "(description, input schema, output schema, effect, validators).",
      );
    }

    const middlewareFiles = (capability.middleware ?? []).map((middlewareName) => {
      const middlewareFile = app.middleware?.[middlewareName];
      if (!middlewareFile) {
        throw new Error(
          formatUnknownNameError({
            kind: "middleware",
            kindPlural: "middleware",
            name: middlewareName,
            registered: Object.keys(app.middleware ?? {}),
            context: `capability "${name}"`,
          }),
        );
      }
      return middlewareFile;
    });

    let httpPath: string | null = null;
    if (capability.expose?.http) {
      const configuredPath = capability.expose.http.path ?? capabilityHttpPath(name);
      if (!isValidCapabilityHttpPath(configuredPath)) {
        throw new Error(
          `Capability "${name}": HTTP exposure path must be an exact same-origin pathname ` +
            'starting with "/".',
        );
      }
      httpPath = normalizeCapabilityHttpPath(configuredPath);
      if (httpPath === mcpEndpoint) {
        throw new Error(
          `Capability "${name}" exposes HTTP path "${httpPath}", which is also the configured ` +
            "MCP endpoint. Choose a distinct agents.mcp.path or capability HTTP path.",
        );
      }
      const existing = seenHttpPaths.get(httpPath);
      if (existing) {
        throw new Error(
          `Capabilities "${existing}" and "${name}" both expose HTTP path "${httpPath}".`,
        );
      }
      seenHttpPaths.set(httpPath, name);
    }

    resolved.push({ name, file, capability, httpPath, middlewareFiles });
  }

  return resolved;
}

export function matchCapabilityRoute(
  capabilities: readonly ResolvedCapability[],
  pathname: string,
): ResolvedCapability | undefined {
  const normalized = normalizeCapabilityHttpPath(pathname);
  return capabilities.find((entry) => entry.httpPath === normalized);
}

/**
 * Best-effort path discovery used only after full registry resolution fails.
 * It recognizes valid capability modules independently so custom HTTP paths
 * still fail closed instead of falling through to an unrelated page route.
 */
export async function isRegisteredCapabilityHttpPath(
  app: CapabilityHostApp,
  registry: CapabilityModuleRegistry,
  pathname: string,
): Promise<boolean> {
  const normalized = normalizeCapabilityHttpPath(pathname);
  for (const [name, file] of Object.entries(app.capabilities ?? {})) {
    try {
      const module = await resolveRegistryModule<CapabilityModule>(
        registry.capabilityModules,
        file,
      );
      const capability = module?.default;
      if (capability?.kind !== "capability" || !capability.expose?.http) continue;
      const httpPath = normalizeCapabilityHttpPath(
        capability.expose.http.path ?? capabilityHttpPath(name),
      );
      if (httpPath === normalized) return true;
    } catch {
      // The full resolver reports the original error; this scan only identifies paths.
    }
  }
  return false;
}

interface CapabilityPipelineOptions<TContext> {
  resolved: ResolvedCapability;
  input: unknown;
  context: TContext;
  registry: CapabilityModuleRegistry;
  request: Request;
  signal: AbortSignal;
  url: URL;
  /** Matched HTTP pathname without the configured deployment base. */
  pathname?: string;
  /** Include internal error details (dev / direct server use). HTTP redacts in production. */
  exposeErrors: boolean;
  /**
   * Runs inside the middleware chain — after every named middleware, just
   * before the capability body — so gating (e.g. the destructive prepare/commit
   * confirmation flow) is subject to rate-limiting middleware. Returning an
   * envelope short-circuits `run()`; `null`/absent proceeds.
   */
  beforeRun?: (validatedInput: unknown) => Promise<{
    status: number;
    envelope: CapabilityEnvelope;
  } | null>;
}

type CapabilityPipelineOutcome =
  | { kind: "envelope"; status: number; envelope: CapabilityEnvelope; response: Response }
  | { kind: "short-circuit"; response: Response };

/**
 * Run one capability through validation, middleware, and execution. The
 * middleware chain wraps the terminal exactly like page/API middleware does
 * (same `runMiddlewareChain`), so `next()`, context mutation, and
 * short-circuit semantics are identical everywhere.
 */
async function runCapabilityPipeline<TContext>(
  options: CapabilityPipelineOptions<TContext>,
): Promise<CapabilityPipelineOutcome> {
  const { capability, name, middlewareFiles } = options.resolved;

  const validatedInput = capability.validateInput(options.input);
  if (!validatedInput.ok) {
    const envelope = errorEnvelope({
      code: "invalid_input",
      message: `Invalid input for capability "${name}".`,
      issues: validatedInput.issues,
    });
    return { kind: "envelope", status: 400, envelope, response: envelopeResponse(400, envelope) };
  }

  // Synthetic route descriptor handed to middleware, mirroring API dispatch.
  const syntheticRoute = capabilityMiddlewareRoute(options.resolved);

  // Holder object rather than a plain `let`: the value is assigned inside
  // the terminal closure, which TypeScript's control-flow analysis cannot see.
  const holder: { settled: { status: number; envelope: CapabilityEnvelope } | null } = {
    settled: null,
  };
  let terminalResponse: Response | null = null;

  const terminal = async (): Promise<Response> => {
    if (options.beforeRun) {
      const gate = await options.beforeRun(validatedInput.value);
      if (gate) {
        holder.settled = { status: gate.status, envelope: gate.envelope };
        terminalResponse = envelopeResponse(gate.status, gate.envelope);
        return terminalResponse;
      }
    }
    let output: unknown;
    try {
      output = await capability.run({
        input: validatedInput.value,
        context: options.context,
        request: options.request,
        signal: options.signal,
      });
    } catch (error: unknown) {
      holder.settled = {
        status: 500,
        envelope: errorEnvelope({
          code: "internal_error",
          message: options.exposeErrors
            ? `Capability "${name}" failed: ${error instanceof Error ? error.message : String(error)}`
            : "Capability failed.",
        }),
      };
      terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
      return terminalResponse;
    }

    const validatedOutput = capability.validateOutput(output);
    if (!validatedOutput.ok) {
      // Invalid output is a server bug — never return the raw value.
      holder.settled = {
        status: 500,
        envelope: errorEnvelope({
          code: "invalid_output",
          message: options.exposeErrors
            ? `Capability "${name}" produced output that does not match its output schema.`
            : "Capability failed.",
          issues: options.exposeErrors ? validatedOutput.issues : undefined,
        }),
      };
      terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
      return terminalResponse;
    }

    holder.settled = { status: 200, envelope: { ok: true, data: validatedOutput.value } };
    terminalResponse = envelopeResponse(holder.settled.status, holder.settled.envelope);
    return terminalResponse;
  };

  const response = await runMiddlewareChain({
    context: options.context,
    middlewareFiles,
    params: {},
    pathname: options.pathname,
    registry: options.registry,
    request: options.request,
    route: syntheticRoute,
    signal: options.signal,
    url: options.url,
    terminal,
  });

  if (
    holder.settled &&
    (response === terminalResponse || (await responseMatchesEnvelope(response, holder.settled)))
  ) {
    return { kind: "envelope", ...holder.settled, response };
  }
  return { kind: "short-circuit", response };
}

async function responseMatchesEnvelope(
  response: Response,
  settled: { status: number; envelope: CapabilityEnvelope },
): Promise<boolean> {
  if (response.status !== settled.status) return false;
  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  try {
    return canonicalJson(await response.clone().json()) === canonicalJson(settled.envelope);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

// Module-level hook so server-only application code (middleware modules,
// capability modules, custom server entries) can subscribe without a way to
// pass functions through the serializable app manifest. Same registration
// style as `setActiveCapabilityHost`/`setIslandsClientEntryUrl`.
const auditHookState = /* @__PURE__ */ globalSlot<{ hook: CapabilityAuditHook | null }>(
  "auditHook",
  () => ({
    hook: null,
  }),
);

// The single-slot setter below is the original API and stays single-slot:
// calling it twice replaces the hook. Real apps ship more than one sink
// (structured logs *and* metrics), and silently dropping one of them is the
// wrong default, so additive subscribers get their own registry.
//
// Keyed by name rather than by function identity, because the common
// registration site is a server-only module's top level. In dev, `@pracht/core`
// is inlined into Vite's SSR graph and Vite re-executes importers on every
// save, so such a module registers again — with a *fresh closure* every time.
// An identity-keyed Set would accumulate one live sink per keystroke, each
// holding a stale closure for the life of the dev server, and every dispatch
// would be delivered N times (inflating counters and duplicating log lines).
// A name-keyed Map makes re-registration a replacement, which is what the
// author meant, and is why `setCapabilityAuditHook` never had this problem.
interface CapabilityAuditListenerRegistration {
  hook: CapabilityAuditHook;
}

const capabilityAuditListeners = /* @__PURE__ */ globalSlot(
  "auditListeners",
  () => new Map<string, CapabilityAuditListenerRegistration>(),
);

export function setCapabilityAuditHook(hook: CapabilityAuditHook | null): void {
  auditHookState.hook = hook;
}

/**
 * Register an additional audit sink under a stable name, without displacing
 * the single-slot hook or any differently-named sink. Registering the same
 * name again replaces that sink — which is what makes the API safe to call
 * from module scope under dev HMR.
 *
 * Returns an unsubscribe function. It is idempotent, and it deliberately only
 * removes *its own* registration: after a reload replaced the name, a stale
 * closure's unsubscribe must not delete the live sink.
 */
export function addCapabilityAuditListener(name: string, hook: CapabilityAuditHook): () => void {
  const registration = { hook };
  capabilityAuditListeners.set(name, registration);
  return () => {
    if (capabilityAuditListeners.get(name) === registration) {
      capabilityAuditListeners.delete(name);
    }
  };
}

/** Test/teardown helper — drops every additive sink. */
export function clearCapabilityAuditListeners(): void {
  capabilityAuditListeners.clear();
}

// Tracked per sink, not globally: a working log sink alongside a broken metrics
// sink is the whole point of supporting more than one, and a single global flag
// would let the first failure silence every other sink's report forever. Named
// listeners use their registration object as the key, so differently-named
// sinks warn independently even when they deliberately reuse one callback, and
// replacing a name creates a fresh sink that can report its own failure.
const warnedAuditSinks = new WeakSet<object>();

/**
 * Deliver one event to one sink. Exceptions are swallowed — an observer must
 * never fail a capability call — but the first failure *from that sink* is
 * reported so a broken sink is not invisible. Later failures from the same
 * sink stay quiet rather than emitting a line per capability call.
 */
function deliverCapabilityAudit(
  label: string,
  hook: CapabilityAuditHook | null | undefined,
  snapshot: CapabilityAuditEvent,
  warningKey?: object,
): void {
  if (!hook) return;
  const sinkKey = warningKey ?? hook;
  try {
    hook(snapshot);
  } catch (error: unknown) {
    if (warnedAuditSinks.has(sinkKey)) return;
    warnedAuditSinks.add(sinkKey);
    try {
      console.warn(
        `[pracht] Capability audit sink ${JSON.stringify(label)} threw and was ignored: ${describeCapabilityAuditError(
          error,
        )}. Audit sinks must never throw; further failures from this sink are not reported.`,
      );
    } catch {
      // Diagnostics are best-effort too: a hostile thrown value or patched
      // console must not let an observer break the capability request.
    }
  }
}

function describeCapabilityAuditError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "<unprintable error>";
  }
}

/** Audit hooks observe; they must never break a request. */
function emitCapabilityAudit(event: CapabilityAuditEvent, extra?: CapabilityAuditHook): void {
  const snapshot = Object.freeze({
    ...event,
    agent: snapshotAgentIdentity(event.agent),
  });
  // Snapshot every process-wide registration before invoking user code. The
  // single-slot hook can add, replace, or remove an additive sink too; those
  // changes must follow the same next-event rule as changes made by an
  // additive sink itself.
  const singleSlotHook = auditHookState.hook;
  const listeners = Array.from(capabilityAuditListeners);
  deliverCapabilityAudit("setCapabilityAuditHook", singleSlotHook, snapshot);
  for (const [name, registration] of listeners) {
    deliverCapabilityAudit(name, registration.hook, snapshot, registration);
  }
  deliverCapabilityAudit("onCapabilityAudit", extra, snapshot);
}

export interface HandleCapabilityRequestOptions<TContext> {
  match: ResolvedCapability;
  context: TContext;
  registry: CapabilityModuleRegistry;
  request: Request;
  url: URL;
  /** Matched HTTP pathname without the configured deployment base. */
  pathname?: string;
  exposeErrors: boolean;
  /** App-level `api.middleware`, wrapped around the HTTP projection only. */
  apiMiddlewareFiles?: string[];
  /** App-level agent trust config (`defineApp({ agents })`). */
  agents?: PrachtAgentsConfig;
  /** Verified agent identity for this request, `null` when unsigned/unverified. */
  agent?: PrachtAgentIdentity | null;
  /** Trusted transport selected by an internal framework projection. */
  transport?: "mcp";
  onAudit?: CapabilityAuditHook;
}

/**
 * Handle a matched capability HTTP request. Method/CSRF checks already ran in
 * `handlePrachtRequest`. Always answers with the typed envelope, except for
 * middleware redirects (3xx pass through untouched). Emits one audit event
 * per dispatch (principal, capability, effect, outcome, duration).
 */
export async function handleCapabilityRequest<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<Response> {
  const started = performance.now();
  let dispatched = await dispatchCapabilityHttpWithApiMiddleware(options);
  if (options.transport === "mcp") {
    dispatched = await revalidateMcpSuccessEnvelope(options, dispatched);
  }
  const { response, outcome } = dispatched;
  const responseWithEffect = withCapabilityEffect(response, options.match.capability.effect);
  emitCapabilityAudit(
    {
      capability: options.match.name,
      effect: options.match.capability.effect,
      // MCP is trusted internal dispatch state. WebMCP remains a
      // client-declared marker and is therefore informational only.
      transport: capabilityTransport(
        options.request.headers.get(CAPABILITY_TRANSPORT_HEADER),
        options.transport,
      ),
      // A dispatch that arrived on a transport is not composed under one.
      via: null,
      outcome,
      status: responseWithEffect.status,
      durationMs: performance.now() - started,
      agent: options.agent ?? null,
    },
    options.onAudit,
  );
  return responseWithEffect;
}

/**
 * MCP advertises the capability's output schema in `tools/list`. Middleware
 * can short-circuit with its own success envelope before the capability
 * pipeline validates output, so validate that envelope before the audit event
 * and status are finalized. The MCP adapter can then translate the same
 * settled response without making its audit trail disagree with the client.
 */
async function revalidateMcpSuccessEnvelope<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  dispatched: { response: Response; outcome: string },
): Promise<{ response: Response; outcome: string }> {
  if (!dispatched.outcome.startsWith("middleware_")) return dispatched;

  let parsed: unknown;
  try {
    parsed = await dispatched.response.clone().json();
  } catch {
    return dispatched;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { ok?: unknown }).ok !== true ||
    !("data" in parsed)
  ) {
    return dispatched;
  }

  const validatedOutput = options.match.capability.validateOutput(
    (parsed as { data: unknown }).data,
  );
  const headers = new Headers(dispatched.response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  if (validatedOutput.ok) {
    return {
      response: new Response(JSON.stringify({ ok: true, data: validatedOutput.value }), {
        status: dispatched.response.status,
        headers,
      }),
      outcome: dispatched.outcome,
    };
  }

  return audited(
    new Response(
      JSON.stringify(
        errorEnvelope({
          code: "invalid_output",
          message: options.exposeErrors
            ? `Capability "${options.match.name}" produced output that does not match its output schema.`
            : "Capability failed.",
          issues: options.exposeErrors ? validatedOutput.issues : undefined,
        }),
      ),
      { status: 500, headers },
    ),
    "invalid_output",
  );
}

/**
 * Capability endpoints are part of the application's HTTP API surface, so the
 * app-level API middleware chain wraps the complete dispatch. This deliberately
 * stays outside `runCapabilityPipeline`: direct server invocation should run
 * capability middleware, but must not inherit HTTP-only API policy.
 */
async function dispatchCapabilityHttpWithApiMiddleware<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<{ response: Response; outcome: string }> {
  const middlewareFiles = options.apiMiddlewareFiles ?? [];
  if (middlewareFiles.length === 0) {
    return dispatchCapabilityHttp(options);
  }

  // Holder object because the value is assigned inside the terminal closure;
  // TypeScript does not carry that assignment into the outer control flow.
  const holder: { dispatched: { response: Response; outcome: string } | null } = {
    dispatched: null,
  };
  try {
    const response = await runMiddlewareChain({
      context: options.context,
      middlewareFiles,
      params: {},
      pathname: options.pathname,
      registry: options.registry,
      request: options.request,
      route: capabilityMiddlewareRoute(options.match),
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
      terminal: async () => {
        holder.dispatched = await dispatchCapabilityHttp(options);
        return holder.dispatched.response;
      },
    });

    const dispatched = holder.dispatched;
    if (dispatched && response === dispatched.response) {
      return dispatched;
    }

    const normalized = normalizeMiddlewareShortCircuit(response);
    return audited(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return audited(capabilityInternalErrorResponse(options, error), "internal_error");
  }
}

function capabilityTransport(
  marker: string | null,
  trustedTransport: HandleCapabilityRequestOptions<unknown>["transport"],
): CapabilityAuditEvent["transport"] {
  if (trustedTransport === "mcp") return "mcp";
  if (marker === "webmcp") return "webmcp";
  return "http";
}

function capabilityMiddlewareRoute(resolved: ResolvedCapability): CapabilityRouteDescriptor {
  return {
    path: resolved.httpPath ?? `capability:${resolved.name}`,
    file: resolved.file,
    segments: [],
  };
}

function withCapabilityEffect(response: Response, effect: string): Response {
  const headers = new Headers(response.headers);
  headers.set(CAPABILITY_EFFECT_HEADER, effect);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function dispatchCapabilityHttp<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
): Promise<{ response: Response; outcome: string }> {
  const { capability, name } = options.match;

  if (options.request.method.toUpperCase() !== "POST") {
    return audited(
      envelopeResponse(
        405,
        errorEnvelope({
          code: "method_not_allowed",
          message: `Capability "${name}" only accepts POST.`,
        }),
      ),
      "method_not_allowed",
    );
  }

  // Web Bot Auth policy: per-capability override, then the app default.
  // "require" without a verified agent fails closed with the 401 envelope —
  // including when webBotAuth is not configured at all.
  const policy = capability.agentPolicy ?? options.agents?.webBotAuth?.policy ?? "observe";
  if (policy === "require" && !options.agent) {
    return audited(
      envelopeResponse(
        401,
        errorEnvelope({
          code: "agent_required",
          message: `Capability "${name}" requires a verified agent signature (Web Bot Auth).`,
        }),
      ),
      "agent_required",
    );
  }

  // JSON is the native encoding. Form posts — the no-JS fallback of
  // `<Form capability>` — are accepted too and coerced onto the input schema,
  // so progressive enhancement hits the exact same contract as agents do.
  let input: unknown = {};
  const contentType = options.request.headers.get("content-type") ?? "";
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");
  if (isFormPost) {
    try {
      const form = await options.request.formData();
      input = coerceFormInput(capability.input, form.entries());
    } catch {
      return audited(
        envelopeResponse(
          400,
          errorEnvelope({
            code: "invalid_json",
            message: "Request form body could not be parsed.",
          }),
        ),
        "invalid_json",
      );
    }
  } else {
    try {
      const body = await options.request.text();
      if (body.trim() !== "") {
        input = JSON.parse(body);
      }
    } catch {
      return audited(
        envelopeResponse(
          400,
          errorEnvelope({ code: "invalid_json", message: "Request body must be valid JSON." }),
        ),
        "invalid_json",
      );
    }
  }

  try {
    // Destructive capabilities never run on the first call: the prepare/commit
    // confirmation gate answers unless a valid token for this exact principal +
    // input is presented. It runs as the pipeline's `beforeRun` hook — after
    // named middleware — so rate-limiting middleware sees prepare and
    // invalid-token attempts too. Invalid input still yields the usual 400 with
    // issues because the pipeline validates before reaching the hook.
    const beforeRun =
      capability.effect === "destructive"
        ? async (validatedInput: unknown) => {
            const gate = await enforceDestructiveConfirmation(options, validatedInput);
            // Passing the gate is what puts destructive work in scope for this
            // request, including anything the capability composes.
            if (gate === null) markDestructiveConfirmed(options.request);
            return gate;
          }
        : undefined;

    const outcome = await runCapabilityPipeline({
      resolved: options.match,
      input,
      context: options.context,
      registry: options.registry,
      request: options.request,
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
      pathname: options.pathname,
      exposeErrors: options.exposeErrors,
      beforeRun,
    });

    if (outcome.kind === "envelope") {
      // Progressive enhancement: a successful form post from a document (the
      // no-JS `<Form capability>` fallback) navigates back to the page it
      // was posted from instead of rendering the JSON envelope.
      if (
        isFormPost &&
        outcome.envelope.ok &&
        (options.request.headers.get("accept") ?? "").includes("text/html")
      ) {
        const back = sameOriginReferer(options.request, options.url);
        if (back) {
          return audited(Response.redirect(back, 303), "ok");
        }
      }
      return audited(outcome.response, envelopeOutcome(outcome.envelope));
    }
    const normalized = normalizeMiddlewareShortCircuit(outcome.response);
    return audited(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return audited(capabilityInternalErrorResponse(options, error), "internal_error");
  }
}

function capabilityInternalErrorResponse<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  error: unknown,
): Response {
  return envelopeResponse(
    500,
    errorEnvelope({
      code: "internal_error",
      message: options.exposeErrors
        ? `Capability "${options.match.name}" failed: ${error instanceof Error ? error.message : String(error)}`
        : "Capability failed.",
    }),
  );
}

function audited(response: Response, outcome: string): { response: Response; outcome: string } {
  return { response, outcome };
}

/** Referer of a document form post, only when it stays on this origin. */
function sameOriginReferer(request: Request, url: URL): string | null {
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    return parsed.origin === url.origin ? parsed.href : null;
  } catch {
    return null;
  }
}

function envelopeOutcome(envelope: CapabilityEnvelope): string {
  return envelope.ok ? "ok" : envelope.error.code;
}

/**
 * Prepare/commit gate for destructive capability HTTP calls. Returns the
 * envelope ending the request, or `null` when a valid confirmation token was
 * presented and the capability may run. Runs as the pipeline's `beforeRun`
 * hook — i.e. after named middleware — so rate limiting sees prepare and
 * invalid-token attempts too. See runtime-confirmation.ts for the token
 * construction and its documented replay limitations, and runtime-approval.ts
 * for the durable store that removes them.
 */
async function enforceDestructiveConfirmation<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  validatedInput: unknown,
): Promise<{ status: number; envelope: CapabilityEnvelope } | null> {
  const secret = resolveConfirmationSecret();
  if (!secret) {
    // Exposed destructive capability without a configured secret: fail closed.
    // `pracht verify` reports this at build time too.
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${options.match.name}" cannot run: no confirmation ` +
          `secret is configured (set ${CONFIRMATION_SECRET_ENV}).`,
      }),
    };
  }

  const name = options.match.name;
  const store = resolveCapabilityApprovalStore();
  const mode = options.agents?.confirmation?.mode ?? "token";

  // Remote MCP hands the confirmation token to the very agent that will commit
  // with it, over a transport with no browser session to bind it to. A
  // stateless HMAC token replays until it expires, so the exactly-once store is
  // what makes destructive tools safe to serve at all — never degrade to
  // token-only replay protection here.
  if (options.transport === "mcp" && !store) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run over remote MCP: no approval store is ` +
          "registered, so commits could not be made exactly-once (call " +
          "setCapabilityApprovalStore() from a server-only module).",
      }),
    };
  }

  // A manifest asking for human approval without a store to hold proposals in
  // would silently degrade to self-approval. Fail closed and say why.
  if (mode === "human" && !store) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run: agents.confirmation.mode is ` +
          '"human" but no approval store is registered (call ' +
          "setCapabilityApprovalStore() from a server-only module).",
      }),
    };
  }

  let principal: string;
  let confirmationPrincipal: string;
  try {
    const resolvedPrincipal = await resolveCapabilityApprovalPrincipal({
      context: options.context,
      request: options.request,
      capability: name,
      agent: options.agent ?? null,
      confirmationSecret: secret,
    });
    principal = resolvedPrincipal?.record ?? "anonymous";
    confirmationPrincipal = resolvedPrincipal?.tokenBinding ?? "anonymous";
  } catch (error: unknown) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run: the approval principal resolver failed` +
          (options.exposeErrors
            ? ` (${error instanceof Error ? error.message : String(error)}).`
            : "."),
      }),
    };
  }
  if (mode === "human" && principal === "anonymous") {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_unavailable",
        message:
          `Destructive capability "${name}" cannot run in human approval mode without an ` +
          "authenticated principal (use Web Bot Auth or call " +
          "setCapabilityApprovalPrincipalResolver() from a server-only module).",
      }),
    };
  }
  const canonicalInput = canonicalJson(validatedInput);
  const binding = {
    secret,
    principal: confirmationPrincipal,
    capability: name,
    canonicalInput,
    ...(store ? { approvalMode: mode } : {}),
  };
  const presented = options.request.headers.get(CONFIRMATION_HEADER);
  const ttlSeconds = options.agents?.confirmation?.ttlSeconds ?? DEFAULT_CONFIRMATION_TTL_SECONDS;

  // Proposal identity is derived from what the operation *is*, so repeated
  // prepares address one proposal instead of accumulating one per token.
  const inputHash = store ? await sha256Base64Url(canonicalInput) : null;
  const approvalId = inputHash
    ? await capabilityApprovalId(secret, principal, name, inputHash, mode)
    : null;

  if (!presented) {
    let expiresAtLimit = 0;
    if (store && approvalId && inputHash) {
      const now = Math.floor(Date.now() / 1000);
      const created = await withApprovalStore(name, options.exposeErrors, () =>
        store.create({
          id: approvalId,
          principal,
          capability: name,
          inputHash,
          input: validatedInput,
          requiresApproval: mode === "human",
          createdAt: now,
          expiresAt: now + ttlSeconds,
          state: "pending",
          decidedBy: null,
          decidedAt: null,
        }),
      );
      if (!created.ok) return created.failure;
      if (created.value.state === "consumed" || created.value.state === "rejected") {
        // A decided proposal stays closed until it expires, so the identical
        // operation cannot be re-proposed yet. That is the safety property —
        // it is what stops a still-valid old token becoming reusable — but to
        // an agent it looks like a broken token unless we say when to come
        // back. Name the window instead of leaving it to guess and retry.
        const retryAfterSeconds = Math.max(1, created.value.expiresAt - now);
        const reason = created.value.state === "consumed" ? "already_used" : "rejected";
        return {
          status: 403,
          envelope: errorEnvelope({
            code: "confirmation_invalid",
            message:
              `Confirmation request rejected (${reason}): this exact operation was already ` +
              `decided and stays closed until its approval expires. Retry the same input in ` +
              `${retryAfterSeconds}s, or call with different input.`,
            retryAfterSeconds,
          }),
        };
      }
      // Re-preparing an existing proposal must not extend its life, so the
      // token expires with the proposal rather than `now + ttlSeconds`.
      expiresAtLimit = created.value.expiresAt - now;
    }

    const { token, expiresAt } = await createConfirmationToken({
      ...binding,
      ttlSeconds: store ? Math.max(1, expiresAtLimit) : ttlSeconds,
    });
    // The channel the caller has to use is transport-specific: remote MCP has
    // no per-call header, so telling an agent to set one would send it looking
    // for something that does not exist on its transport.
    const echo =
      options.transport === "mcp"
        ? `repeat the tools/call with identical arguments and the token in ` +
          `_meta["${MCP_CONFIRMATION_META_KEY}"]`
        : `repeat the call with identical input and the "${CONFIRMATION_HEADER}" header set to ` +
          "the confirmation token";
    return {
      status: 409,
      envelope: errorEnvelope({
        code: "confirmation_required",
        message:
          mode === "human"
            ? `Capability "${name}" is destructive and needs human approval. Once the proposal ` +
              `is approved, ${echo}.`
            : `Capability "${name}" is destructive. To commit, ${echo}.`,
        confirmationToken: token,
        expiresAt,
        ...(approvalId ? { approvalId } : {}),
      }),
    };
  }

  // Signature first, always: a forged or tampered token must never be able to
  // consume — and thereby destroy — a legitimate proposal.
  const verification = await verifyConfirmationToken(presented, binding);
  if (!verification.ok) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_invalid",
        message: `Confirmation token rejected (${verification.reason}).`,
      }),
    };
  }

  if (store && approvalId) {
    const consumed = await withApprovalStore(name, options.exposeErrors, () =>
      store.consume(approvalId),
    );
    if (!consumed.ok) return consumed.failure;

    if (!consumed.value.ok) {
      if (consumed.value.reason === "awaiting_approval") {
        return {
          status: 409,
          envelope: errorEnvelope({
            code: "confirmation_pending",
            message: `Capability "${name}" is awaiting human approval.`,
            approvalId,
          }),
        };
      }
      return {
        status: 403,
        envelope: errorEnvelope({
          code: "confirmation_invalid",
          message: `Confirmation token rejected (${consumed.value.reason}).`,
        }),
      };
    }
    return null;
  }

  if (
    options.agents?.confirmation?.singleUse &&
    !consumeConfirmationToken(verification.signature, verification.expiresAt)
  ) {
    return {
      status: 403,
      envelope: errorEnvelope({
        code: "confirmation_invalid",
        message: "Confirmation token rejected (already_used).",
      }),
    };
  }

  return null;
}

/**
 * Approval stores talk to a database, so they can fail. A store that is down
 * must never wave a destructive call through: any rejection becomes a closed
 * gate.
 */
async function withApprovalStore<T>(
  capability: string,
  exposeErrors: boolean,
  operation: () => Promise<T>,
): Promise<
  { ok: true; value: T } | { ok: false; failure: { status: number; envelope: CapabilityEnvelope } }
> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    return {
      ok: false,
      failure: {
        status: 403,
        envelope: errorEnvelope({
          code: "confirmation_unavailable",
          message:
            `Destructive capability "${capability}" cannot run: the approval store failed` +
            (exposeErrors ? ` (${error instanceof Error ? error.message : String(error)}).` : "."),
        }),
      },
    };
  }
}

/**
 * Middleware that returns without calling `next()` decides the response.
 * Redirects and 2xx responses pass through untouched; error statuses are
 * normalized into the envelope (status and headers preserved) so HTTP
 * callers always receive the typed shape.
 */
function normalizeMiddlewareShortCircuit(response: Response): Response {
  if (response.status < 400) {
    return response;
  }

  const code = middlewareErrorCode(response.status);
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.delete("content-length");
  return new Response(
    JSON.stringify(
      errorEnvelope({
        code,
        message: `Request rejected by middleware (status ${response.status}).`,
      }),
    ),
    { status: response.status, headers },
  );
}

function middlewareErrorCode(status: number): CapabilityErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 300 && status < 400) return "redirect";
  return "middleware_rejected";
}

// ---------------------------------------------------------------------------
// Direct server-side invocation
// ---------------------------------------------------------------------------

export interface CapabilityHost {
  app: CapabilityHostApp;
  registry: CapabilityModuleRegistry;
  /** Request-local audit hook supplied by a custom server entry. */
  onAudit?: CapabilityAuditHook;
  /** Verified identity bound by a trusted transport, never caller-supplied context. */
  agent?: PrachtAgentIdentity | null;
  /** OAuth identity verified by the MCP transport, never caller-supplied context. */
  tokenAuth?: McpTokenPrincipal;
  /**
   * Transport of the request this host was installed for. Carried onto the
   * audit event of every capability composed through `invokeCapability()`
   * while that request is being served. Absent on synthetic hosts (test
   * hosts), which serve no request.
   */
  via?: CapabilityAuditEvent["via"];
  /**
   * Set once the destructive capability being served on this request has
   * passed its prepare/commit gate. Remote MCP composition uses it as a
   * request-scoped grant: after it is set, this request's server code may
   * compose any destructive capability. Never set by callers — the gate sets
   * it, from the server side.
   */
  destructiveConfirmed?: boolean;
}

// Bind each host to the incoming Request rather than a process-global slot.
// Custom servers may serve multiple Pracht apps from one process, and dev HMR
// can replace a registry while an older request is still awaiting its loader.
// A WeakMap keeps those overlapping invocations isolated on every Web runtime
// without retaining completed requests.
const activeCapabilityHosts = /* @__PURE__ */ globalSlot(
  "activeHosts",
  () => new WeakMap<Request, CapabilityHost>(),
);

/**
 * Record that the destructive dispatch on this request cleared prepare/commit,
 * so capabilities it composes may perform destructive work too. Called only
 * from the confirmation gate; there is no caller-reachable path to it.
 */
function markDestructiveConfirmed(request: Request): void {
  const host = activeCapabilityHosts.get(request);
  if (host) host.destructiveConfirmed = true;
}

/** End the destructive-composition grant when the confirmed dispatch settles. */
export function clearDestructiveConfirmed(request: Request): void {
  const host = activeCapabilityHosts.get(request);
  if (host) host.destructiveConfirmed = false;
}

export function setActiveCapabilityHost(
  request: Request,
  app: CapabilityHostApp,
  registry: CapabilityModuleRegistry,
  /** Transport of the request being served; audits nested composition. */
  via: NonNullable<CapabilityAuditEvent["via"]> = "http",
  onAudit?: CapabilityAuditHook,
  agent?: PrachtAgentIdentity | null,
  tokenAuth?: McpTokenPrincipal,
  /** Another request identity that must share this request-scoped host. */
  sharedRequest?: Request,
): void {
  const sharedHost = sharedRequest ? activeCapabilityHosts.get(sharedRequest) : undefined;
  activeCapabilityHosts.set(
    request,
    sharedHost ?? {
      app,
      registry,
      via,
      onAudit,
      agent: snapshotAgentIdentity(agent ?? null),
      tokenAuth,
    },
  );
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
 * tool re-applies the callee's `agentPolicy`, and refuses destructive effects
 * unless the tool being served is itself a destructive capability that already
 * cleared prepare/commit — otherwise a non-destructive tool could lend remote
 * agents an effect no one confirmed. That clearance is a request-scoped grant
 * covering every destructive callee, like a confirmed HTTP endpoint, not a
 * per-callee check. Composed dispatches are audited
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
  // Bind the host to the request when nothing served it yet, so a capability
  // invoked directly (standalone `host.invoke()`, test hosts) can itself
  // compose others via `invokeCapability()`. A host installed by a live
  // request keeps precedence — its transport provenance must not be replaced —
  // and a binding installed here is removed on settle, so two hosts invoked
  // with one Request cannot silently dispatch against each other's graph.
  const installedHostBinding = !activeCapabilityHosts.has(ctx.request);
  if (installedHostBinding) {
    activeCapabilityHosts.set(ctx.request, host);
  }
  try {
    return await invokeCapabilityOnBoundHost<T>(host, name, input, ctx);
  } finally {
    if (installedHostBinding) {
      activeCapabilityHosts.delete(ctx.request);
    }
  }
}

async function invokeCapabilityOnBoundHost<T = unknown>(
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
    outcome.kind === "envelope" ? envelopeOutcome(outcome.envelope) : `middleware_${status}`;
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
 * confirmation flow destructive effects require. These checks run before the
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

  // Destructive work is in scope only when the tool being served is itself a
  // destructive capability that already cleared prepare/commit — which the
  // projection only serves at all when `agents.mcp.destructive` is on. A
  // `read`/`write` tool therefore cannot lend a remote agent a destructive
  // effect nobody confirmed.
  //
  // This is a request-scoped grant, not a per-callee check: once the gate is
  // cleared, the tool's own `run()` may compose any destructive capability,
  // private ones included, as often as it likes — exactly as a confirmed HTTP
  // endpoint can. First-party code picks those callees; the agent only picks
  // the entry point it confirmed by name and input.
  if (resolved.capability.effect === "destructive" && !host.destructiveConfirmed) {
    const envelope = errorEnvelope({
      code: "forbidden",
      message:
        `Capability "${resolved.name}" cannot be composed from remote MCP because it is ` +
        "destructive and no confirmed destructive dispatch is in scope for this request.",
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
  let context: TContext | PrachtContextExtensions = supplied ?? ({} as TContext);
  const carriesTransportIdentity =
    !!host.app.agents?.webBotAuth && (host.via === "http" || host.via === "mcp");
  if (carriesTransportIdentity) {
    context = bindAgentContext(context, host.agent ?? null);
  }
  if (host.via === "mcp" && host.tokenAuth !== undefined) {
    context = rebindMcpTokenContext(context, host.tokenAuth);
  }
  return context;
}

function capabilityHostAgent<TContext>(
  host: CapabilityHost,
  context: TContext,
): PrachtAgentIdentity | null {
  return host.via === "http" || host.via === "mcp"
    ? (host.agent ?? null)
    : ((context as { agent?: PrachtAgentIdentity | null }).agent ?? null);
}

function errorEnvelope(error: CapabilityErrorPayload): CapabilityEnvelope<never> {
  return { ok: false, error };
}

export function envelopeResponse(status: number, envelope: CapabilityEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
