declare module "virtual:pracht/server" {
  const mod: { fetch: (request: Request, env: any, ctx: any) => Promise<Response> };
  export default mod;
}

declare module "virtual:pracht/client" {}

declare module "virtual:pracht/capabilities" {
  import type {
    CapabilityBrowserCallOptions,
    CapabilityCallOptionsFor,
    CapabilityInputArgs,
    CapabilityInputFor,
    CapabilityOutputFor,
    HasRegisteredCapabilities,
    HttpCapabilityName,
    NonDestructiveCapabilityName,
  } from "@pracht/core";
  import type {
    CapabilityEffect,
    CapabilityEnvelope,
    CapabilityErrorPayload,
    CapabilityIssue,
  } from "@pracht/capabilities";

  // The envelope types are the protocol package's — re-exported so existing
  // `import type { ... } from "virtual:pracht/capabilities"` keeps working.
  export type { CapabilityEnvelope, CapabilityErrorPayload, CapabilityIssue };

  export interface CallCapabilityOptions extends CapabilityBrowserCallOptions {
    /**
     * Confirmation token for committing a destructive capability, taken from
     * the prior call's `confirmation_required` error envelope. Sets the
     * confirmation header for you. A destructive call must either prepare with
     * `{ prepare: true }` or commit with this token once `pracht typegen` has
     * registered its effect class.
     */
    confirm?: string;
    /**
     * Start the prepare half of a destructive call. The server returns a
     * `confirmation_required` envelope containing the token; repeat the call
     * with `confirm` to commit. Typed destructive calls require exactly one of
     * `prepare: true` or `confirm`.
     */
    prepare?: true;
    /**
     * Successful non-`read` calls revalidate the active route's data
     * automatically; pass `false` to skip it for this call.
     */
    revalidate?: boolean;
  }

  /**
   * Destructive calls require exactly one of `{ prepare: true }` or
   * `{ confirm }`. `prepare` is a compile-time marker only — nothing is sent
   * for it; a prepare call is a call without a confirmation header, and the
   * server is what refuses to run it.
   */
  type OptionsFor<TName extends string> = CapabilityCallOptionsFor<TName, CallCapabilityOptions>;

  /**
   * HTTP endpoints of http-exposed capabilities, keyed by capability name.
   *
   * Has a **null prototype**, so a capability named `toString` cannot shadow an
   * inherited member during lookup. Index it and enumerate it as usual, but
   * reach for `Object.hasOwn(capabilityEndpoints, name)` rather than
   * `capabilityEndpoints.hasOwnProperty(name)` — there is no `Object.prototype`
   * to inherit that from. TypeScript cannot express the missing prototype, so
   * the `Record` type below overstates what is available.
   */
  export const capabilityEndpoints: Record<
    string,
    { method: string; path: string; effect: CapabilityEffect | null }
  >;

  interface TypedCallCapability {
    /**
     * Names that cannot be `destructive`. Listed first and with an optional
     * options argument, so it is always arity-compatible with a one- or
     * two-argument call — which makes it the signature that reports what is
     * wrong with an unresolvable name, instead of an argument count.
     */
    <TName extends NonDestructiveCapabilityName>(
      name: TName,
      ...args: CapabilityInputArgs<TName, CallCapabilityOptions>
    ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
    /** Possibly `destructive`: the prepare marker or the token is required. */
    <TName extends HttpCapabilityName>(
      name: TName,
      input: CapabilityInputFor<TName>,
      options: OptionsFor<TName>,
    ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
  }

  interface UntypedCallCapability {
    <T = unknown>(
      name: string,
      input?: unknown,
      opts?: CallCapabilityOptions,
    ): Promise<CapabilityEnvelope<T>>;
  }

  /**
   * Invoke an http-exposed capability from the browser via its HTTP projection.
   * Once `pracht typegen` has registered the capability graph on
   * `Register["capabilities"]`, the name, input, output, and confirmation
   * requirement all come from the registration: a private capability, an
   * unknown name, a mismatched input, or a `destructive` call without an
   * explicit prepare/commit choice are compile errors rather than runtime
   * envelopes.
   *
   * Declared as a conditionally-typed value rather than as an overload pair
   * whose fallback `name` resolves to `never`. That fallback survived overload
   * resolution and absorbed anything arity filtering rejected, so every
   * mistake — including a `destructive` call that merely forgot its options —
   * came back as `'"notes.purge"' is not assignable to 'never'`: blaming the
   * name, never naming the cause. Here the untyped form is simply absent for a
   * registered app, and the two typed signatures split by effect class so that
   * an unresolvable name is always arity-compatible with the first one and gets
   * reported as a name.
   *
   * A dynamic name is no longer accepted once typegen has run; assert it with
   * `name as HttpCapabilityName` when the name genuinely comes from data, and
   * keep in mind the runtime still answers an unknown one with
   * `unknown_capability`.
   */
  export const callCapability: HasRegisteredCapabilities extends true
    ? TypedCallCapability
    : UntypedCallCapability;

  /**
   * The same calls as `callCapability`, reached as a nested object built from
   * the dotted capability names — `capabilities.notes.search({ query })`.
   * Private capabilities are simply absent from it. Because the members are
   * real property accesses, a typo here reports as "Property 'serach' does not
   * exist … Did you mean 'search'?" — which `callCapability("notes.serach")`
   * cannot do, since a string literal argument has no such suggestion.
   *
   * The nodes are built by parsing the dotted names into a mapped type, so
   * they are *not* homomorphic over the registration and carry none of its
   * JSDoc; hovering a method shows its signature, not the capability's prose.
   *
   * Identical runtime path to `callCapability` (same endpoint table, same
   * settled event, same revalidation), so nothing forks between the two.
   */
  export const capabilities: PrachtCapabilityClient;

  /**
   * Dotted names expanded into nested namespaces, http-exposed only. Before
   * typegen has run, every segment stays callable with unknown input/output —
   * the nested counterpart of `callCapability`'s untyped fallback.
   */
  export type PrachtCapabilityClient = HasRegisteredCapabilities extends true
    ? CapabilityClientNode<HttpCapabilityName>
    : Record<string, UntypedCapabilityClientNode>;

  interface UntypedCapabilityClientNode {
    <T = unknown>(input?: unknown, opts?: CallCapabilityOptions): Promise<CapabilityEnvelope<T>>;
    [segment: string]: UntypedCapabilityClientNode;
  }

  type CapabilityMethod<TName extends string> = (
    ...args: CapabilityInputArgs<TName, OptionsFor<TName>>
  ) => Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;

  /**
   * `Prefix` carries the already-consumed path so a leaf can look its own full
   * dotted name back up in the flat registration map.
   */
  type CapabilitySegment<
    TAll extends string,
    TPrefix extends string,
  > = TAll extends `${TPrefix}${infer TRest}`
    ? TRest extends `${infer THead}.${string}`
      ? THead
      : TRest
    : never;

  /**
   * A name that is also a prefix of another (`notes` alongside `notes.search`)
   * cannot be both a function and a namespace. The runtime builder resolves
   * that by letting the namespace win, so the type must too — otherwise
   * `capabilities.notes(...)` would typecheck and throw at runtime. The
   * shadowed name stays callable through `callCapability()`, and
   * `pracht verify` warns about it.
   */
  type CapabilityClientNode<TAll extends string, TPrefix extends string = ""> = {
    [TSeg in CapabilitySegment<TAll, TPrefix>]: [
      Extract<TAll, `${TPrefix}${TSeg}.${string}`>,
    ] extends [never]
      ? CapabilityMethod<`${TPrefix}${TSeg}`>
      : CapabilityClientNode<TAll, `${TPrefix}${TSeg}.`>;
  };

  /**
   * Call state for a user-triggered capability call — a button, a search box, a
   * picker. `call()` takes the same arguments as `callCapability` minus the
   * name, and resolves to the same envelope.
   *
   * This is a mutation-shaped hook, not a fetch-on-render one: it dispatches
   * when you call it, never during render. For data a page needs on load, run
   * the capability in a `loader` with `invokeCapability()` — that result is
   * server-rendered into the HTML and revalidates automatically after
   * non-`read` calls, which a render-time fetch cannot do.
   *
   * ```tsx
   * const search = useCapability("notes.search");
   * await search.call({ query });
   * // search.data / search.error / search.pending / search.reset()
   * ```
   *
   * Concurrent calls are last-one-wins: an earlier response that arrives after
   * a later one is discarded, so typing into a search box cannot show a stale
   * result. `data` stays visible while a follow-up call is `pending`.
   * It also remains the most recent successful result when that follow-up fails;
   * only `reset()` or changing the capability name clears it.
   */
  export function useCapability<TName extends HttpCapabilityName>(
    name: TName,
  ): PrachtCapabilityHook<TName>;

  export interface PrachtCapabilityHook<TName extends HttpCapabilityName> {
    call: (
      ...args: CapabilityInputArgs<TName, OptionsFor<TName>>
    ) => Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
    /** Data from the most recent successful call, until `reset()`. */
    data: CapabilityOutputFor<TName> | undefined;
    /** Error payload from the most recent failed call, until `reset()`. */
    error: CapabilityErrorPayload | undefined;
    /** Whether a call is in flight. */
    pending: boolean;
    /** Clear `data`/`error`/`pending` and abandon any in-flight result. */
    reset: () => void;
  }
}

declare module "virtual:pracht/webmcp" {
  /** Registers WebMCP page tools; returns false when the API is unavailable. */
  export function registerPrachtWebmcpTools(): boolean;
}

// `.tsrx` modules are compiled by `@tsrx/vite-plugin-preact`. Declare an
// ambient module so apps can `import` them without a typed source — TypeScript
// has no built-in support for the `.tsrx` extension.
declare module "*.tsrx" {
  const mod: Record<string, unknown>;
  export = mod;
}
