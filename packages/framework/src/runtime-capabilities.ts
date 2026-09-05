/**
 * Capability registry and execution pipeline.
 *
 * The implementation lives in `@pracht/capabilities/server/internal` — the
 * protocol-owning leaf package — so the exact same pipeline serves pracht
 * apps and standalone hosts (`createCapabilityHost()`). This module
 * re-exports it for the framework runtime and layers the typegen-aware
 * `invokeCapability()` signature on top: when `pracht typegen` has registered
 * the capability graph on `Register["capabilities"]`, names, inputs, and
 * outputs are all checked at compile time.
 */

import { invokeCapability as invokeCapabilityUntyped } from "@pracht/capabilities/server/internal";
import type {
  CapabilityCallInputFor,
  CapabilityEnvelope,
  CapabilityName,
  CapabilityOutputFor,
  HasRegisteredCapabilities,
} from "./types.ts";

export {
  addCapabilityAuditListener,
  CAPABILITY_HTTP_PREFIX,
  capabilityHttpPath,
  clearCapabilityAuditListeners,
  clearDestructiveConfirmed,
  envelopeResponse,
  handleCapabilityRequest,
  invokeCapabilityOnHost,
  isRegisteredCapabilityHttpPath,
  matchCapabilityRoute,
  resolveAppCapabilities,
  setActiveCapabilityHost,
  setCapabilityAuditHook,
  type CapabilityHost,
  type CapabilityHostApp,
  type HandleCapabilityRequestOptions,
  type InvokeCapabilityContext,
  type ResolvedCapability,
} from "@pracht/capabilities/server/internal";

import type { InvokeCapabilityContext } from "@pracht/capabilities/server/internal";

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
 * agents an effect no one confirmed.
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
export const invokeCapability = invokeCapabilityUntyped as {
  <TName extends CapabilityName>(
    name: TName,
    input: CapabilityCallInputFor<TName>,
    ctx: InvokeCapabilityContext,
  ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
  <T = unknown>(
    name: HasRegisteredCapabilities extends true ? never : string,
    input: unknown,
    ctx: InvokeCapabilityContext,
  ): Promise<CapabilityEnvelope<T>>;
};
