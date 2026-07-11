declare module "virtual:pracht/server" {
  const mod: { fetch: (request: Request, env: any, ctx: any) => Promise<Response> };
  export default mod;
}

declare module "virtual:pracht/client" {}

declare module "virtual:pracht/capabilities" {
  import type {
    CapabilityInputFor,
    CapabilityOutputFor,
    RegisteredCapabilityName,
  } from "@pracht/core";

  export interface CapabilityIssue {
    path: string;
    message: string;
  }
  export interface CapabilityErrorPayload {
    code: string;
    message: string;
    issues?: CapabilityIssue[];
  }
  export type CapabilityEnvelope<T = unknown> =
    | { ok: true; data: T }
    | { ok: false; error: CapabilityErrorPayload };
  /** HTTP endpoints of http-exposed capabilities, keyed by capability name. */
  export const capabilityEndpoints: Record<string, { method: string; path: string }>;
  /**
   * Invoke an http-exposed capability from the browser via its HTTP projection.
   * When `pracht typegen` has registered the capability graph on
   * `Register["capabilities"]`, input and output types are inferred from the
   * capability name.
   */
  export function callCapability<TName extends RegisteredCapabilityName>(
    name: TName,
    input: CapabilityInputFor<TName>,
    opts?: { headers?: HeadersInit; signal?: AbortSignal },
  ): Promise<CapabilityEnvelope<CapabilityOutputFor<TName>>>;
  export function callCapability<T = unknown>(
    name: string,
    input?: unknown,
    opts?: { headers?: HeadersInit; signal?: AbortSignal },
  ): Promise<CapabilityEnvelope<T>>;
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
