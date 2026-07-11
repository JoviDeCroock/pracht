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

import { formatUnknownNameError } from "./name-suggestions.ts";
import {
  canonicalJson,
  CONFIRMATION_HEADER,
  CONFIRMATION_SECRET_ENV,
  consumeConfirmationToken,
  createConfirmationToken,
  DEFAULT_CONFIRMATION_TTL_SECONDS,
  resolveConfirmationSecret,
  verifyConfirmationToken,
} from "./runtime-confirmation.ts";
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityEnvelope,
  CapabilityErrorPayload,
  CapabilityInputFor,
  CapabilityModule,
  CapabilityOutputFor,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
  PrachtApp,
  PrachtCapability,
  RegisteredCapabilityName,
  ResolvedApiRoute,
} from "./types.ts";

export const CAPABILITY_HTTP_PREFIX = "/api/capabilities/";

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

export type CapabilityHostApp = Pick<PrachtApp, "capabilities" | "middleware">;

/** Default HTTP path for a capability name: dots become slashes. */
export function capabilityHttpPath(name: string): string {
  return `${CAPABILITY_HTTP_PREFIX}${name.split(".").join("/")}`;
}

function normalizeCapabilityHttpPath(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

// Resolution loads every registered capability module once per manifest +
// registry instance. Dev HMR can keep the same app manifest object while
// replacing the generated registry after a capability edit, so both identities
// participate in the cache key.
const resolvedCapabilitiesCache = new WeakMap<
  object,
  WeakMap<object, Promise<ResolvedCapability[]>>
>();
const EMPTY_CAPABILITY_MODULES = {};

export function resolveAppCapabilities(
  app: CapabilityHostApp,
  registry: ModuleRegistry,
): Promise<ResolvedCapability[]> {
  const capabilities = app.capabilities ?? {};
  const capabilityModules = registry.capabilityModules ?? EMPTY_CAPABILITY_MODULES;
  let registryCache = resolvedCapabilitiesCache.get(capabilities);
  if (!registryCache) {
    registryCache = new WeakMap();
    resolvedCapabilitiesCache.set(capabilities, registryCache);
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
  registry: ModuleRegistry,
): Promise<ResolvedCapability[]> {
  const resolved: ResolvedCapability[] = [];
  const seenHttpPaths = new Map<string, string>();

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

    // `defineCapability()` already refuses these; re-check here so a
    // hand-rolled capability object fails closed before it can be served.
    // Destructive + HTTP is allowed (the prepare/commit confirmation flow
    // gates every dispatch); agent-initiated projections stay disallowed in v1.
    if (
      capability.effect === "destructive" &&
      (capability.expose?.webmcp || capability.expose?.mcp)
    ) {
      throw new Error(
        `Capability "${name}": destructive capabilities cannot be exposed to agent ` +
          "projections (webmcp/mcp) yet — only expose.http with the confirmation flow.",
      );
    }
    if (capability.expose?.webmcp && !capability.expose.http) {
      throw new Error(`Capability "${name}": expose.webmcp requires expose.http.`);
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
      httpPath = normalizeCapabilityHttpPath(
        capability.expose.http.path ?? capabilityHttpPath(name),
      );
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
  registry: ModuleRegistry,
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
  registry: ModuleRegistry;
  request: Request;
  signal: AbortSignal;
  url: URL;
  /** Include internal error details (dev / direct server use). HTTP redacts in production. */
  exposeErrors: boolean;
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
  const { capability, name, file, httpPath, middlewareFiles } = options.resolved;

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
  const syntheticRoute: ResolvedApiRoute = {
    path: httpPath ?? `capability:${name}`,
    file,
    segments: [],
  };

  // Holder object rather than a plain `let`: the value is assigned inside
  // the terminal closure, which TypeScript's control-flow analysis cannot see.
  const holder: { settled: { status: number; envelope: CapabilityEnvelope } | null } = {
    settled: null,
  };

  const terminal = async (): Promise<Response> => {
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
      return envelopeResponse(holder.settled.status, holder.settled.envelope);
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
      return envelopeResponse(holder.settled.status, holder.settled.envelope);
    }

    holder.settled = { status: 200, envelope: { ok: true, data: validatedOutput.value } };
    return envelopeResponse(holder.settled.status, holder.settled.envelope);
  };

  const response = await runMiddlewareChain({
    context: options.context,
    middlewareFiles,
    params: {},
    registry: options.registry,
    request: options.request,
    route: syntheticRoute,
    signal: options.signal,
    url: options.url,
    terminal,
  });

  if (holder.settled) {
    return { kind: "envelope", ...holder.settled, response };
  }
  return { kind: "short-circuit", response };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

// Module-level hook so server-only application code (middleware modules,
// capability modules, custom server entries) can subscribe without a way to
// pass functions through the serializable app manifest. Same registration
// style as `setActiveCapabilityHost`/`setIslandsClientEntryUrl`.
let capabilityAuditHook: CapabilityAuditHook | null = null;

export function setCapabilityAuditHook(hook: CapabilityAuditHook | null): void {
  capabilityAuditHook = hook;
}

/** Audit hooks observe; they must never break a request. */
function emitCapabilityAudit(event: CapabilityAuditEvent, extra?: CapabilityAuditHook): void {
  for (const hook of [capabilityAuditHook, extra]) {
    if (!hook) continue;
    try {
      hook(event);
    } catch {
      // Deliberately swallowed.
    }
  }
}

export interface HandleCapabilityRequestOptions<TContext> {
  match: ResolvedCapability;
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  url: URL;
  exposeErrors: boolean;
  /** App-level agent trust config (`defineApp({ agents })`). */
  agents?: PrachtAgentsConfig;
  /** Verified agent identity for this request, `null` when unsigned/unverified. */
  agent?: PrachtAgentIdentity | null;
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
  const { response, outcome } = await dispatchCapabilityHttp(options);
  emitCapabilityAudit(
    {
      capability: options.match.name,
      effect: options.match.capability.effect,
      transport: "http",
      outcome,
      status: response.status,
      durationMs: performance.now() - started,
      agent: options.agent ?? null,
    },
    options.onAudit,
  );
  return response;
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

  let input: unknown = {};
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

  try {
    // Destructive capabilities never run on the first call: the prepare/commit
    // confirmation gate answers before the pipeline unless a valid token for
    // this exact principal + input is presented. Invalid input skips the gate
    // so the pipeline can produce its usual 400 with issues.
    if (capability.effect === "destructive") {
      const validated = capability.validateInput(input);
      if (validated.ok) {
        const gate = await enforceDestructiveConfirmation(options, validated.value);
        if (gate) return gate;
      }
    }

    const outcome = await runCapabilityPipeline({
      resolved: options.match,
      input,
      context: options.context,
      registry: options.registry,
      request: options.request,
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
      exposeErrors: options.exposeErrors,
    });

    if (outcome.kind === "envelope") {
      return audited(outcome.response, envelopeOutcome(outcome.envelope));
    }
    const normalized = normalizeMiddlewareShortCircuit(outcome.response);
    return audited(normalized, `middleware_${normalized.status}`);
  } catch (error: unknown) {
    return audited(
      envelopeResponse(
        500,
        errorEnvelope({
          code: "internal_error",
          message: options.exposeErrors
            ? `Capability "${name}" failed: ${error instanceof Error ? error.message : String(error)}`
            : "Capability failed.",
        }),
      ),
      "internal_error",
    );
  }
}

function audited(response: Response, outcome: string): { response: Response; outcome: string } {
  return { response, outcome };
}

function envelopeOutcome(envelope: CapabilityEnvelope): string {
  return envelope.ok ? "ok" : envelope.error.code;
}

/**
 * Prepare/commit gate for destructive capability HTTP calls. Returns the
 * response ending the request, or `null` when a valid confirmation token was
 * presented and the capability may run. See runtime-confirmation.ts for the
 * token construction and its documented replay limitations.
 */
async function enforceDestructiveConfirmation<TContext>(
  options: HandleCapabilityRequestOptions<TContext>,
  validatedInput: unknown,
): Promise<{ response: Response; outcome: string } | null> {
  const secret = resolveConfirmationSecret();
  if (!secret) {
    // Exposed destructive capability without a configured secret: fail closed.
    // `pracht verify` reports this at build time too.
    return audited(
      envelopeResponse(
        403,
        errorEnvelope({
          code: "confirmation_unavailable",
          message:
            `Destructive capability "${options.match.name}" cannot run: no confirmation ` +
            `secret is configured (set ${CONFIRMATION_SECRET_ENV}).`,
        }),
      ),
      "confirmation_unavailable",
    );
  }

  const binding = {
    secret,
    principal: options.agent ? `agent:${options.agent.keyId}` : "anonymous",
    capability: options.match.name,
    canonicalInput: canonicalJson(validatedInput),
  };
  const presented = options.request.headers.get(CONFIRMATION_HEADER);

  if (!presented) {
    const ttlSeconds = options.agents?.confirmation?.ttlSeconds ?? DEFAULT_CONFIRMATION_TTL_SECONDS;
    const { token, expiresAt } = await createConfirmationToken({ ...binding, ttlSeconds });
    return audited(
      envelopeResponse(
        409,
        errorEnvelope({
          code: "confirmation_required",
          message:
            `Capability "${options.match.name}" is destructive. Repeat the call with ` +
            `identical input and the "${CONFIRMATION_HEADER}" header set to the confirmation token.`,
          confirmationToken: token,
          expiresAt,
        }),
      ),
      "confirmation_required",
    );
  }

  const verification = await verifyConfirmationToken(presented, binding);
  if (!verification.ok) {
    return audited(
      envelopeResponse(
        403,
        errorEnvelope({
          code: "confirmation_invalid",
          message: `Confirmation token rejected (${verification.reason}).`,
        }),
      ),
      "confirmation_invalid",
    );
  }

  if (
    options.agents?.confirmation?.singleUse &&
    !consumeConfirmationToken(verification.signature, verification.expiresAt)
  ) {
    return audited(
      envelopeResponse(
        403,
        errorEnvelope({
          code: "confirmation_invalid",
          message: "Confirmation token rejected (already_used).",
        }),
      ),
      "confirmation_invalid",
    );
  }

  return null;
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

  const code =
    response.status === 401
      ? "unauthorized"
      : response.status === 403
        ? "forbidden"
        : "middleware_rejected";
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

// ---------------------------------------------------------------------------
// Direct server-side invocation
// ---------------------------------------------------------------------------

export interface CapabilityHost {
  app: CapabilityHostApp;
  registry: ModuleRegistry;
}

// The app manifest and module registry are process-level constants, so a
// single slot is safe under concurrent requests. `handlePrachtRequest`
// refreshes it on every request (dev re-evaluates the server module).
let activeCapabilityHost: CapabilityHost | null = null;

export function setActiveCapabilityHost(app: CapabilityHostApp, registry: ModuleRegistry): void {
  activeCapabilityHost = { app, registry };
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
 * When `pracht typegen` has registered the capability graph on
 * `Register["capabilities"]`, the input and output types are inferred from
 * the capability name; the explicit `invokeCapability<Output>(...)` form
 * keeps working for unregistered names.
 */
export async function invokeCapability<TName extends RegisteredCapabilityName>(
  name: TName,
  input: CapabilityInputFor<TName>,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
export async function invokeCapability<T = unknown>(
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>>;
export async function invokeCapability<T = unknown>(
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>> {
  const host = activeCapabilityHost;
  if (!host) {
    throw new Error(
      "invokeCapability() has no capability host yet. It is only available while " +
        "handlePrachtRequest() is serving requests (loaders, API routes, middleware). " +
        "In tests, build a standalone host with createCapabilityTestHost() instead.",
    );
  }
  return invokeCapabilityOnHost(host, name, input, ctx);
}

/**
 * Run one capability through the full dispatch pipeline against an explicit
 * host. Shared by `invokeCapability()` (the process-level host installed by
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
  const context = ctx.context ?? {};
  const outcome = await runCapabilityPipeline({
    resolved,
    input,
    context,
    registry: host.registry,
    request: ctx.request,
    signal: ctx.signal ?? AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    url: new URL(ctx.request.url),
    // Direct invocation stays server-side, so real error messages are safe.
    exposeErrors: true,
  });

  // Direct invocation audits like HTTP dispatch does, marked as the "server"
  // transport. The agent identity travels on the request context when Web
  // Bot Auth is enabled.
  const agent = (context as { agent?: PrachtAgentIdentity | null }).agent ?? null;
  const status = outcome.kind === "envelope" ? outcome.status : outcome.response.status;
  const auditOutcome =
    outcome.kind === "envelope" ? envelopeOutcome(outcome.envelope) : `middleware_${status}`;
  emitCapabilityAudit({
    capability: name,
    effect: resolved.capability.effect,
    transport: "server",
    outcome: auditOutcome,
    status,
    durationMs: performance.now() - started,
    agent,
  });

  if (outcome.kind === "envelope") {
    return outcome.envelope as CapabilityEnvelope<T>;
  }

  const code =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status >= 300 && status < 400
          ? "redirect"
          : "middleware_rejected";
  return errorEnvelope({
    code,
    message: `Capability middleware short-circuited with status ${status}.`,
  }) as CapabilityEnvelope<T>;
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
