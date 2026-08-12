import type { PrachtAgentIdentity } from "@pracht/capabilities";

/**
 * Augment this interface to register your app's generated routes,
 * capabilities, API routes, and request context globally.
 *
 * ```ts
 * declare module "@pracht/core" {
 *   interface Register {
 *     context: { env: Env; executionContext: ExecutionContext };
 *   }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by users and typegen
export interface Register {}

/** Framework-owned fields merged into the app-registered request context. */
export interface PrachtContextExtensions {
  /**
   * Verified agent identity (Web Bot Auth); `null` when the request is
   * unsigned or fails verification, absent when agent trust is not configured.
   */
  readonly agent?: PrachtAgentIdentity | null;
}

export type RegisteredContext = (Register extends { context: infer TContext }
  ? TContext
  : unknown) &
  PrachtContextExtensions;

/** The request context application loaders, middleware, APIs, and capabilities receive. */
export type PrachtRequestContext = RegisteredContext;
