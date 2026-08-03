declare module "virtual:pracht/server" {
  const mod: { fetch: (request: Request, env: any, ctx: any) => Promise<Response> };
  export default mod;
}

declare module "virtual:pracht/client" {}

declare module "virtual:pracht/capabilities" {
  import type {
    CapabilityCallOptionsFor,
    CapabilityInputArgs,
    CapabilityOutputFor,
    HasRegisteredCapabilities,
    HttpCapabilityName,
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

  export interface CallCapabilityOptions {
    headers?: HeadersInit;
    signal?: AbortSignal;
    /**
     * Confirmation token for committing a destructive capability, taken from
     * the prior call's `confirmation_required` error envelope. Sets the
     * confirmation header for you. Required by the types on `destructive`
     * capabilities once `pracht typegen` has registered their effect class.
     */
    confirm?: string;
    /**
     * Successful non-`read` calls revalidate the active route's data
     * automatically; pass `false` to skip it for this call.
     */
    revalidate?: boolean;
  }

  /** Per-capability options: `confirm` is required for `destructive` effects. */
  type OptionsFor<TName extends string> = CapabilityCallOptionsFor<TName, CallCapabilityOptions>;

  /** HTTP endpoints of http-exposed capabilities, keyed by capability name. */
  export const capabilityEndpoints: Record<
    string,
    { method: string; path: string; effect: CapabilityEffect | null }
  >;

  /**
   * Invoke an http-exposed capability from the browser via its HTTP projection.
   * Once `pracht typegen` has registered the capability graph on
   * `Register["capabilities"]`, the name, input, output, and confirmation
   * requirement all come from the registration: a private capability, an
   * unknown name, a mismatched input, or a `destructive` call missing its
   * confirmation token are compile errors rather than runtime envelopes.
   *
   * The untyped form below stays available for apps that have not run typegen;
   * once anything is registered its `name` parameter resolves to `never` so
   * mistakes can no longer fall through to it.
   */
  export function callCapability<TName extends HttpCapabilityName>(
    name: TName,
    ...args: CapabilityInputArgs<TName, OptionsFor<TName>>
  ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
  export function callCapability<T = unknown>(
    name: HasRegisteredCapabilities extends true ? never : string,
    input?: unknown,
    opts?: CallCapabilityOptions,
  ): Promise<CapabilityEnvelope<T>>;

  /**
   * The same calls as `callCapability`, reached as a nested object built from
   * the dotted capability names — `capabilities.notes.search({ query })`.
   * Private capabilities are simply absent from it, and each method carries
   * the capability's title/description as JSDoc.
   *
   * Identical runtime path to `callCapability` (same endpoint table, same
   * settled event, same revalidation), so nothing forks between the two.
   */
  export const capabilities: PrachtCapabilityClient;

  /** Dotted names expanded into nested namespaces, http-exposed only. */
  export type PrachtCapabilityClient = CapabilityClientNode<HttpCapabilityName>;

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
