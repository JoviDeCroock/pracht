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
import { resolveRegistryModule } from "./runtime-manifest.ts";
import { runMiddlewareChain } from "./runtime-middleware.ts";
import type {
  CapabilityEnvelope,
  CapabilityErrorPayload,
  CapabilityModule,
  ModuleRegistry,
  PrachtApp,
  PrachtCapability,
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

// Resolution loads every registered capability module once per process (or
// per dev-server module graph — the cache key is the manifest's capability
// record, which gets a new identity whenever the server module re-evaluates).
const resolvedCapabilitiesCache = new WeakMap<object, Promise<ResolvedCapability[]>>();

export function resolveAppCapabilities(
  app: CapabilityHostApp,
  registry: ModuleRegistry,
): Promise<ResolvedCapability[]> {
  const capabilities = app.capabilities ?? {};
  let resolved = resolvedCapabilitiesCache.get(capabilities);
  if (!resolved) {
    resolved = resolveAppCapabilitiesUncached(app, registry);
    resolvedCapabilitiesCache.set(capabilities, resolved);
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
    if (capability.effect === "destructive" && capability.expose) {
      throw new Error(
        `Capability "${name}": destructive capabilities cannot be exposed yet; ` +
          "the trust layer ships separately.",
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
      httpPath = capability.expose.http.path ?? capabilityHttpPath(name);
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
  const normalized =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return capabilities.find((entry) => entry.httpPath === normalized);
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

/**
 * Handle a matched capability HTTP request. Method/CSRF checks already ran in
 * `handlePrachtRequest`. Always answers with the typed envelope, except for
 * middleware redirects (3xx pass through untouched).
 */
export async function handleCapabilityRequest<TContext>(options: {
  match: ResolvedCapability;
  context: TContext;
  registry: ModuleRegistry;
  request: Request;
  url: URL;
  exposeErrors: boolean;
}): Promise<Response> {
  if (options.request.method.toUpperCase() !== "POST") {
    return envelopeResponse(
      405,
      errorEnvelope({
        code: "method_not_allowed",
        message: `Capability "${options.match.name}" only accepts POST.`,
      }),
    );
  }

  let input: unknown = {};
  try {
    const body = await options.request.text();
    if (body.trim() !== "") {
      input = JSON.parse(body);
    }
  } catch {
    return envelopeResponse(
      400,
      errorEnvelope({ code: "invalid_json", message: "Request body must be valid JSON." }),
    );
  }

  try {
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
      return outcome.response;
    }
    return normalizeMiddlewareShortCircuit(outcome.response);
  } catch (error: unknown) {
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

interface CapabilityHost {
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
 */
export async function invokeCapability<T = unknown>(
  name: string,
  input: unknown,
  ctx: InvokeCapabilityContext,
): Promise<CapabilityEnvelope<T>> {
  const host = activeCapabilityHost;
  if (!host) {
    throw new Error(
      "invokeCapability() has no capability host yet. It is only available while " +
        "handlePrachtRequest() is serving requests (loaders, API routes, middleware).",
    );
  }

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

  const outcome = await runCapabilityPipeline({
    resolved,
    input,
    context: ctx.context ?? {},
    registry: host.registry,
    request: ctx.request,
    signal: ctx.signal ?? AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
    url: new URL(ctx.request.url),
    // Direct invocation stays server-side, so real error messages are safe.
    exposeErrors: true,
  });

  if (outcome.kind === "envelope") {
    return outcome.envelope as CapabilityEnvelope<T>;
  }

  const status = outcome.response.status;
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
