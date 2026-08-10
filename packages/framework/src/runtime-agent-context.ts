import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./types.ts";

/**
 * Bind framework-verified agent identity onto an application request context.
 * Mutable contexts keep their shared identity. Frozen and sealed contexts get
 * an extensible, descriptor-preserving copy so framework fields do not turn a
 * valid request into a runtime exception.
 */
export function bindAgentContext<TContext>(
  supplied: TContext | undefined,
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  const context = supplied ?? ({} as TContext);

  if ((typeof context === "object" && context !== null) || typeof context === "function") {
    try {
      (context as PrachtContextExtensions).agent = agent;
      if ((context as PrachtContextExtensions).agent === agent) {
        return context as TContext & PrachtContextExtensions;
      }
    } catch {
      // Frozen/sealed contexts cannot accept framework-owned fields. Fall
      // through to a copy without weakening the trusted identity.
    }

    const descriptors = Object.getOwnPropertyDescriptors(context);
    delete descriptors.agent;
    const copy = Object.create(Object.getPrototypeOf(context)) as TContext &
      PrachtContextExtensions;
    Object.defineProperties(copy, descriptors);
    Object.defineProperty(copy, "agent", {
      configurable: true,
      enumerable: true,
      value: agent,
      writable: false,
    });
    return copy;
  }

  return { agent } as TContext & PrachtContextExtensions;
}
