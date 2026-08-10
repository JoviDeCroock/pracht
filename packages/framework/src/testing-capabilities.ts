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

import type { Capability } from "@pracht/capabilities";

import { formatUnknownNameError } from "./name-suggestions.ts";
import { bindAgentContext } from "./runtime-agent-context.ts";
import {
  handleCapabilityRequest,
  invokeCapabilityOnHost,
  resolveAppCapabilities,
  type CapabilityHost,
} from "./runtime-capabilities.ts";
import type {
  CapabilityEnvelope,
  HasRegisteredCapabilities,
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

export interface CapabilityTestHostOptions<
  TCapabilities extends Record<string, PrachtCapability> = Record<string, PrachtCapability>,
> {
  /** Capability name → the object `defineCapability()` returns. */
  capabilities: TCapabilities;
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

type RegisteredCapabilityTestMap = HasRegisteredCapabilities extends true
  ? {
      [TName in RegisteredCapabilityName]: {
        input: CapabilityInputFor<TName>;
        output: CapabilityOutputFor<TName>;
      };
    }
  : Record<string, { input: unknown; output: unknown }>;

type CapabilityTestInput<TCapability> =
  TCapability extends Capability<infer TInput, any, any>
    ? TInput
    : TCapability extends { input: infer TInput }
      ? TInput
      : unknown;

type CapabilityTestInputFor<TCapabilities, TName extends Extract<keyof TCapabilities, string>> = (
  TName extends string ? (input: CapabilityTestInput<TCapabilities[TName]>) => void : never
) extends (input: infer TInput) => void
  ? TInput
  : never;

type CapabilityTestOutput<TCapability> =
  TCapability extends Capability<any, infer TOutput, any>
    ? TOutput
    : TCapability extends { output: infer TOutput }
      ? TOutput
      : unknown;

export interface CapabilityTestHost<
  TCapabilities extends Record<string, unknown> = RegisteredCapabilityTestMap,
> {
  /**
   * Direct server invocation — same pipeline and envelope as
   * `invokeCapability()`. Factory-created hosts read the input/output generics
   * retained by their own capability map, including test-only names that are
   * absent from the app manifest. Annotating a definition's `run()` argument
   * lets `defineCapability()` infer both generics; supplying only its first
   * generic leaves the defaulted output as `unknown`. The bare
   * `CapabilityTestHost` type keeps using the generated app registration for
   * callers that declare a host separately.
   */
  invoke<TName extends Extract<keyof TCapabilities, string>>(
    name: TName,
    input: CapabilityTestInputFor<TCapabilities, TName>,
    options?: CapabilityTestInvokeOptions,
  ): Promise<CapabilityEnvelope<CapabilityTestOutput<TCapabilities[TName]>>>;
  /** HTTP dispatch — same handler the generated `/api/capabilities/*` endpoints use. */
  request(name: string, input: unknown, options?: CapabilityTestRequestOptions): Promise<Response>;
}

export function createCapabilityTestHost<
  const TCapabilities extends Record<string, PrachtCapability>,
>(options: CapabilityTestHostOptions<TCapabilities>): CapabilityTestHost<TCapabilities> {
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
    invoke<TName extends Extract<keyof TCapabilities, string>>(
      name: TName,
      input: CapabilityTestInputFor<TCapabilities, TName>,
      invokeOptions: CapabilityTestInvokeOptions = {},
    ): Promise<CapabilityEnvelope<CapabilityTestOutput<TCapabilities[TName]>>> {
      return invokeCapabilityOnHost<CapabilityTestOutput<TCapabilities[TName]>>(host, name, input, {
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

      let agent = requestOptions.agent ?? null;
      let context: Record<string, unknown> = { ...requestOptions.context };
      // `handlePrachtRequest` surfaces the verified identity on the request
      // context before dispatch; simulated identities travel the same way.
      if (options.agents?.webBotAuth || requestOptions.agent !== undefined) {
        const boundContext = bindAgentContext(context, agent);
        context = boundContext;
        agent = boundContext.agent ?? null;
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
