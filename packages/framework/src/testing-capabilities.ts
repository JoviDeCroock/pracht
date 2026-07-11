/**
 * Standalone capability test host.
 *
 * `invokeCapability()` needs the process-level host that `handlePrachtRequest`
 * installs, so the full dispatch pipeline is normally only reachable through a
 * running server. `createCapabilityTestHost()` builds that host synthetically —
 * from capability objects and middleware functions, no manifest files or Vite —
 * so unit tests can exercise the exact production code paths:
 *
 *   - `invoke()` — the direct server projection (`invokeCapability`): input
 *     validation → middleware chain → run() → output validation, resolving to
 *     the typed envelope and emitting the same audit events.
 *   - `request()` — the HTTP projection (`handleCapabilityRequest`): everything
 *     above plus exposure/404 semantics, Web Bot Auth policy, and the
 *     destructive prepare/commit confirmation flow. A simulated verified agent
 *     identity can be injected via the `agent` option — no RFC 9421 signing
 *     required.
 *
 * The confirmation flow reads its secret from `PRACHT_CONFIRMATION_SECRET` or
 * `setCapabilityConfirmationSecret()` — set one of them in test setup before
 * exercising destructive capabilities.
 */

import { formatUnknownNameError } from "./name-suggestions.ts";
import {
  handleCapabilityRequest,
  invokeCapabilityOnHost,
  resolveAppCapabilities,
  type CapabilityHost,
} from "./runtime-capabilities.ts";
import type {
  CapabilityEnvelope,
  CapabilityInputFor,
  CapabilityOutputFor,
  MiddlewareFn,
  ModuleRegistry,
  PrachtAgentIdentity,
  PrachtAgentsConfig,
  PrachtCapability,
  RegisteredCapabilityName,
} from "./types.ts";

const TEST_ORIGIN = "http://capability-test.local";

export interface CapabilityTestHostOptions {
  /** Capability name → the object `defineCapability()` returns. */
  capabilities: Record<string, PrachtCapability>;
  /** Middleware name → function, for capabilities declaring `middleware: [name]`. */
  middleware?: Record<string, MiddlewareFn>;
  /** App-level agent trust config — the `defineApp({ agents })` equivalent. */
  agents?: PrachtAgentsConfig;
}

export interface CapabilityTestInvokeOptions {
  request?: Request;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CapabilityTestRequestOptions {
  /** Extra request headers, e.g. `{ "x-pracht-confirm": token }`. */
  headers?: HeadersInit;
  context?: Record<string, unknown>;
  /**
   * Simulated verified Web Bot Auth identity. Drives `agentPolicy` checks,
   * the confirmation-token principal, audit events, and `context.agent` —
   * exactly as if the request carried a valid signature.
   */
  agent?: PrachtAgentIdentity | null;
}

export interface CapabilityTestHost {
  /** Direct server invocation — same pipeline and envelope as `invokeCapability()`. */
  invoke<TName extends RegisteredCapabilityName>(
    name: TName,
    input: CapabilityInputFor<TName>,
    options?: CapabilityTestInvokeOptions,
  ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
  invoke<T = unknown>(
    name: string,
    input: unknown,
    options?: CapabilityTestInvokeOptions,
  ): Promise<CapabilityEnvelope<T>>;
  /** HTTP dispatch — same handler the generated `/api/capabilities/*` endpoints use. */
  request(name: string, input: unknown, options?: CapabilityTestRequestOptions): Promise<Response>;
}

export function createCapabilityTestHost(options: CapabilityTestHostOptions): CapabilityTestHost {
  const capabilityFiles: Record<string, string> = {};
  const capabilityModules: NonNullable<ModuleRegistry["capabilityModules"]> = {};
  for (const [name, capability] of Object.entries(options.capabilities)) {
    const file = `test:capability:${name}`;
    capabilityFiles[name] = file;
    capabilityModules[file] = async () => ({ default: capability });
  }

  const middlewareFiles: Record<string, string> = {};
  const middlewareModules: NonNullable<ModuleRegistry["middlewareModules"]> = {};
  for (const [name, middleware] of Object.entries(options.middleware ?? {})) {
    const file = `test:middleware:${name}`;
    middlewareFiles[name] = file;
    middlewareModules[file] = async () => ({ middleware });
  }

  const host: CapabilityHost = {
    app: { capabilities: capabilityFiles, middleware: middlewareFiles },
    registry: { capabilityModules, middlewareModules },
  };

  return {
    invoke<T = unknown>(
      name: string,
      input: unknown,
      invokeOptions: CapabilityTestInvokeOptions = {},
    ): Promise<CapabilityEnvelope<T>> {
      return invokeCapabilityOnHost<T>(host, name, input, {
        request: invokeOptions.request ?? new Request(`${TEST_ORIGIN}/`),
        context: invokeOptions.context ?? {},
        signal: invokeOptions.signal,
      });
    },

    async request(
      name: string,
      input: unknown,
      requestOptions: CapabilityTestRequestOptions = {},
    ): Promise<Response> {
      const capabilities = await resolveAppCapabilities(host.app, host.registry);
      const match = capabilities.find((entry) => entry.name === name);

      // Mirror the wire: names that are not registered — or registered without
      // `expose.http`, so no dispatch path exists — answer with the typed 404.
      if (!match?.httpPath) {
        return Response.json(
          {
            ok: false,
            error: {
              code: "unknown_capability",
              message: formatUnknownNameError({
                kind: "capability",
                kindPlural: "capabilities",
                name,
                registered: capabilities
                  .filter((entry) => entry.httpPath)
                  .map((entry) => entry.name),
              }),
            },
          },
          { status: 404 },
        );
      }

      const agent = requestOptions.agent ?? null;
      const context: Record<string, unknown> = { ...requestOptions.context };
      // `handlePrachtRequest` surfaces the verified identity on the request
      // context before dispatch; simulated identities travel the same way.
      if (!("agent" in context)) {
        context.agent = agent;
      }

      const headers = new Headers(requestOptions.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const request = new Request(`${TEST_ORIGIN}${match.httpPath}`, {
        method: "POST",
        headers,
        body: JSON.stringify(input === undefined ? {} : input),
      });

      return handleCapabilityRequest({
        match,
        context,
        registry: host.registry,
        request,
        url: new URL(request.url),
        exposeErrors: true,
        agents: options.agents,
        agent,
      });
    },
  };
}
