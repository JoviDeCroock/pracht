/**
 * Stable facade for request-scoped capability hosts and direct server-side
 * invocation. Host binding, nested transport policy, and pipeline/audit
 * dispatch live in focused sibling modules.
 */

import { getActiveCapabilityHost } from "./runtime-capability-host.ts";
import { invokeCapabilityOnHost } from "./runtime-capability-invocation-dispatch.ts";
import type { InvokeCapabilityContext } from "./runtime-capability-invocation-types.ts";
import type {
  CapabilityCallInputFor,
  CapabilityEnvelope,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
} from "./types.ts";

export { setActiveCapabilityHost } from "./runtime-capability-host.ts";
export { invokeCapabilityOnHost } from "./runtime-capability-invocation-dispatch.ts";
export type {
  CapabilityHost,
  InvokeCapabilityContext,
} from "./runtime-capability-invocation-types.ts";

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
 * resolves to `never`, so a mistake can no longer fall through to it. Drop the
 * explicit type argument in a registered app and let the output infer.
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
  const host = getActiveCapabilityHost(ctx.request);
  if (!host) {
    throw new Error(
      "invokeCapability() has no capability host for this request. It is only available while " +
        "handlePrachtRequest() is serving requests (loaders, API routes, middleware). " +
        "In tests, build a standalone host with createCapabilityTestHost() instead.",
    );
  }
  return invokeCapabilityOnHost(host, name, input, ctx);
}
