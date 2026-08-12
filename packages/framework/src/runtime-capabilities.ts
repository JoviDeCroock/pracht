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

import {
  CAPABILITY_EFFECT_HEADER,
  CAPABILITY_HTTP_PREFIX,
  CAPABILITY_TRANSPORT_HEADER,
  capabilityHttpPath,
  coerceFormInput,
} from "@pracht/capabilities";
import { formatUnknownNameError } from "./name-suggestions.ts";
import {
  resolveAppCapabilities,
  type CapabilityHostApp,
  type ResolvedCapability,
} from "./runtime-capability-registry.ts";
import {
  capabilityApprovalId,
  resolveCapabilityApprovalPrincipal,
  resolveCapabilityApprovalStore,
} from "./runtime-approval.ts";
import { bindAgentContext, snapshotAgentIdentity } from "./runtime-agent-context.ts";
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
} from "./runtime-confirmation.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import type {
  CapabilityAuditEvent,
  CapabilityAuditHook,
  CapabilityEnvelope,
  CapabilityErrorCode,
  CapabilityErrorPayload,
  CapabilityCallInputFor,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
  PrachtContextExtensions,
  ResolvedApiRoute,
} from "./types.ts";

export { CAPABILITY_HTTP_PREFIX, capabilityHttpPath };
export {
  isRegisteredCapabilityHttpPath,
  matchCapabilityRoute,
  resolveAppCapabilities,
} from "./runtime-capability-registry.ts";
export type { CapabilityHostApp, ResolvedCapability } from "./runtime-capability-registry.ts";

/** Longest a capability may run before its signal aborts, matching API routes. */
const CAPABILITY_TIMEOUT_MS = 30_000;

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
let capabilityAuditHook: CapabilityAuditHook | null = null;

export function setCapabilityAuditHook(hook: CapabilityAuditHook | null): void {
  capabilityAuditHook = hook;
}

/** Audit hooks observe; they must never break a request. */
function emitCapabilityAudit(event: CapabilityAuditEvent, extra?: CapabilityAuditHook): void {
  const snapshot = Object.freeze({
    ...event,
    agent: snapshotAgentIdentity(event.agent),
  });
  for (const hook of [capabilityAuditHook, extra]) {
    if (!hook) continue;
    try {
      hook(snapshot);
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

function capabilityMiddlewareRoute(resolved: ResolvedCapability): ResolvedApiRoute {
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
        ? (validatedInput: unknown) => enforceDestructiveConfirmation(options, validatedInput)
        : undefined;

    const outcome = await runCapabilityPipeline({
      resolved: options.match,
      input,
      context: options.context,
      registry: options.registry,
      request: options.request,
      signal: AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
      url: options.url,
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
        const reason = created.value.state === "consumed" ? "already_used" : "rejected";
        return {
          status: 403,
          envelope: errorEnvelope({
            code: "confirmation_invalid",
            message: `Confirmation request rejected (${reason}).`,
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
    return {
      status: 409,
      envelope: errorEnvelope({
        code: "confirmation_required",
        message:
          mode === "human"
            ? `Capability "${name}" is destructive and needs human approval. Repeat the call ` +
              `with identical input and the "${CONFIRMATION_HEADER}" header once the proposal ` +
              "is approved."
            : `Capability "${name}" is destructive. Repeat the call with identical input and ` +
              `the "${CONFIRMATION_HEADER}" header set to the confirmation token.`,
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

function errorEnvelope(error: CapabilityErrorPayload): CapabilityEnvelope<never> {
  return { ok: false, error };
}

export function envelopeResponse(status: number, envelope: CapabilityEnvelope): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
