import type { Capability, CapabilityEffect, CapabilityEnvelope } from "@pracht/capabilities";

import type { Register } from "./registration.ts";

// Generated capability registration and client inference types live here so
// the framework's general route/runtime types do not own the typegen contract.

export type PrachtCapability<TContext = any> = Capability<any, unknown, TContext>;

export interface CapabilityModule<TContext = any> {
  default: PrachtCapability<TContext>;
}

/**
 * `pracht typegen` generates capability input/output types from the JSON
 * Schemas in the app's capability graph and registers them on
 * `Register["capabilities"]`, mirroring how route typegen registers
 * `Register["routes"]`. Once registered, `invokeCapability()` (and the
 * browser's `callCapability()`) infer input and output types from the
 * capability name — no per-call generics needed.
 */
type RegisteredCapabilityMap = Register extends { capabilities: infer TCapabilities }
  ? TCapabilities extends Record<string, unknown>
    ? TCapabilities
    : {}
  : {};

/**
 * Whether the app generated a capability registration. Test for the property,
 * not for entries: after the last capability is removed, typegen deliberately
 * emits an empty registration and stale calls must remain compile errors.
 * Every alias below degrades to `string`/`unknown` only when the property is
 * absent, so the APIs stay usable before the first `pracht typegen` run.
 */
export type HasRegisteredCapabilities = "capabilities" extends keyof Register ? true : false;

export type RegisteredCapabilityName = Extract<keyof RegisteredCapabilityMap, string>;

/**
 * Every registered capability name, including private ones: direct server
 * invocation reaches capabilities that are never exposed over the network.
 * Falls back to `string` before typegen has run.
 */
export type CapabilityName = HasRegisteredCapabilities extends true
  ? RegisteredCapabilityName
  : string;

type ExposedHttpCapabilityName = {
  [TName in keyof RegisteredCapabilityMap]: RegisteredCapabilityMap[TName] extends {
    exposed: { http: true };
  }
    ? TName
    : never;
}[keyof RegisteredCapabilityMap] &
  string;

/**
 * Whether every generated entry carries the exposure metadata introduced with
 * the typed browser client. Checking for the field — rather than checking
 * whether any capability is exposed — distinguishes a legacy declaration from
 * a current app whose capabilities are all deliberately private.
 */
type HasCapabilityExposureMetadata = HasRegisteredCapabilities extends true
  ? RegisteredCapabilityMap[RegisteredCapabilityName] extends {
      exposed: { http: boolean };
    }
    ? true
    : false
  : false;

/**
 * Capability names reachable from the browser — those with `expose.http`.
 * `callCapability()`, the generated `capabilities` client, and
 * `<Form capability>` use this so a private capability is a compile error
 * rather than a runtime `unknown_capability` envelope.
 *
 * A declaration generated before `exposed` existed falls back to every
 * registered name so upgrades remain source-compatible. Current declarations
 * are distinguishable by the presence of exposure metadata on every entry: an
 * app whose current registration is entirely private therefore resolves to
 * `never`, not to the legacy fallback.
 */
export type HttpCapabilityName = HasRegisteredCapabilities extends true
  ? HasCapabilityExposureMetadata extends true
    ? ExposedHttpCapabilityName
    : RegisteredCapabilityName
  : string;

/**
 * The registration entry for a name, or `never` when the name is unregistered
 * (which includes every name before typegen has run). Each alias below checks
 * for that case explicitly: indexing an empty map yields `never`, and `never`
 * satisfies every `extends` test, so an unguarded conditional would silently
 * resolve to `never` instead of the intended `unknown`.
 */
type RegisteredCapabilityEntry<TName extends string> = TName extends keyof RegisteredCapabilityMap
  ? RegisteredCapabilityMap[TName]
  : never;

type CapabilityInputForName<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? unknown
  : RegisteredCapabilityEntry<TName> extends { input: infer TInput }
    ? TInput
    : unknown;

/**
 * Input accepted safely for every possible capability name. The conditional
 * distributes over `TName`, then contravariant inference intersects the input
 * types from each member. A union name therefore has to be narrowed unless one
 * value satisfies every member's schema; accepting the union of inputs would
 * let an input for capability A reach capability B at runtime.
 *
 * A single capability whose schema itself produces a union remains a union —
 * only the outer capability-name alternatives are intersected.
 */
export type CapabilityInputFor<TName extends string> = (
  TName extends unknown ? (input: CapabilityInputForName<TName>) => void : never
) extends (input: infer TInput) => void
  ? TInput
  : unknown;

/** Input accepted safely at a capability call boundary. */
export type CapabilityCallInputFor<TName extends string> = CapabilityInputFor<TName>;

export type CapabilityOutputFor<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? unknown
  : RegisteredCapabilityEntry<TName> extends { output: infer TOutput }
    ? TOutput
    : unknown;

/** Declared effect class, or the full union when typegen has not run. */
export type CapabilityEffectFor<TName extends string> = [RegisteredCapabilityEntry<TName>] extends [
  never,
]
  ? CapabilityEffect
  : RegisteredCapabilityEntry<TName> extends { effect: infer TEffect }
    ? TEffect
    : CapabilityEffect;

/**
 * The effect a registration actually states, or `never` when it states none.
 *
 * The confirmation gate has to tell apart two cases `CapabilityEffectFor`
 * collapses into one. A `pracht-capabilities.d.ts` generated before `effect`
 * was emitted declares nothing, and must keep behaving as it did — demanding a
 * token on every call would break every upgrading app. A registration that
 * declares the *full union* does so because the build could not read a broken
 * capability's effect, and that one must fail closed.
 */
type DeclaredCapabilityEffect<TName extends string> =
  RegisteredCapabilityEntry<TName> extends { effect: infer TEffect } ? TEffect : never;

/**
 * Http-exposed names that cannot be `destructive`, so their call takes its
 * options optionally. Splitting the name space this way is what keeps the
 * confirmation gate from swallowing every other diagnostic: a signature whose
 * *arity* depends on the name reports every name mistake as an argument-count
 * error, because TypeScript checks arity before it checks the constraint. With
 * the two effect classes in separate signatures, an unresolvable name always
 * has one signature it satisfies on arity, and that signature is the one that
 * gets to say what is actually wrong with the name.
 *
 * A legacy declaration that records no `effect` lands here for every name, so
 * it keeps its pre-gate behaviour.
 */
export type NonDestructiveCapabilityName = HttpCapabilityName extends infer TName
  ? TName extends string
    ? [Extract<DeclaredCapabilityEffect<TName>, "destructive">] extends [never]
      ? TName
      : never
    : never
  : never;

/**
 * Argument list for a browser capability call — `callCapability()` and the
 * generated `capabilities` client. A capability whose input schema requires
 * nothing is callable with no argument at all; every other capability must
 * pass one. When the name is a union, omission is allowed only if every member
 * accepts empty input. `TOptions` stays generic so the virtual module can
 * supply its own option type without `@pracht/core` importing it.
 *
 * Server-side `invokeCapability()` does not use this: its request context is
 * always required, so it takes a plain `(name, input, ctx)` signature.
 */
type CapabilityInputRequirement<TName extends string> = TName extends string
  ? {} extends CapabilityInputFor<TName>
    ? "optional"
    : "required"
  : never;

export type CapabilityInputArgs<TName extends string, TOptions> = {} extends TOptions
  ? "required" extends CapabilityInputRequirement<TName>
    ? [input: CapabilityInputFor<TName>, options?: TOptions]
    : {} extends CapabilityInputFor<TName>
      ? [input?: CapabilityInputFor<TName>, options?: TOptions]
      : [input: CapabilityInputFor<TName>, options?: TOptions]
  : // Options carry a required member (a `destructive` capability's prepare
    // marker or confirmation token), so neither argument may be omitted — an
    // optional parameter cannot precede a required one.
    [input: CapabilityInputFor<TName>, options: TOptions];

/**
 * Browser call options, narrowed per capability: a `destructive` capability is
 * gated by the server-verified prepare/commit flow. Mark the first call with
 * `{ prepare: true }`; committing instead requires the confirmation token from
 * that call's `confirmation_required` envelope. See AGENT_TRUST.md.
 *
 * `prepare` is not sent over the wire. The browser dispatcher uses it only to
 * strip any confirmation token inherited through caller-supplied headers, so
 * a prepare call cannot accidentally commit. Refusing to run the resulting
 * unconfirmed call remains the server's job, and it fails closed.
 *
 * The gate closes whenever `destructive` is *possible*, not only when it is
 * certain: a name typed as a union (`"notes.search" | "notes.purge"`) and a
 * capability whose effect could not be read at build time both demand an
 * explicit prepare or commit option. Erring toward requiring a flow marker
 * costs a caller one argument; erring the other way silently drops the only
 * compile-time half of the confirmation flow.
 */
export type CapabilityCallOptionsFor<
  TName extends string,
  TOptions extends { confirm?: string; prepare?: true },
> = [Extract<DeclaredCapabilityEffect<TName>, "destructive">] extends [never]
  ? TOptions
  :
      | (Omit<TOptions, "confirm"> & { confirm?: never; prepare: true })
      | (TOptions & { confirm: string; prepare?: never });

/** Browser options shared by `callCapability()` and the nested client. */
export interface CapabilityBrowserCallOptions {
  headers?: HeadersInit;
  signal?: AbortSignal;
  /** Confirmation token for committing a prepared destructive capability. */
  confirm?: string;
  /** Begin a destructive call without allowing it to commit. */
  prepare?: true;
  /** Skip automatic route-data revalidation after a successful mutation. */
  revalidate?: boolean;
}

/** One generated nested-client method, including its effect-specific options. */
export type CapabilityClientMethod<TName extends string> = (
  ...args: CapabilityInputArgs<TName, CapabilityCallOptionsFor<TName, CapabilityBrowserCallOptions>>
) => Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
