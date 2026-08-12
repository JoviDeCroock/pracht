import type { PrachtAgentIdentity } from "@pracht/capabilities";

import { createImmutableContextOverlay } from "./runtime-context-overlay.ts";
import type { PrachtContextExtensions } from "./types.ts";

const agentIdentitySnapshots = new WeakSet<object>();

interface BoundAgentContext {
  agent: Readonly<PrachtAgentIdentity> | null;
  context: object;
}

const boundAgentContexts = new WeakMap<object, BoundAgentContext>();

/** Bind one immutable framework-verified identity to a request-local context. */
export function bindAgentContext<TContext>(
  supplied: TContext | undefined,
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  const context = supplied ?? ({} as TContext);
  const boundAgent = snapshotAgentIdentity(agent);

  if ((typeof context === "object" && context !== null) || typeof context === "function") {
    const previous = boundAgentContexts.get(context);
    if (previous) {
      if (sameAgentIdentity(previous.agent, boundAgent)) {
        return previous.context as TContext & PrachtContextExtensions;
      }
      throw new TypeError(
        "Pracht request contexts cannot be reused across different verified agent identities. " +
          "Create a fresh context for each request.",
      );
    }

    try {
      Object.defineProperty(context, "agent", {
        configurable: false,
        enumerable: true,
        value: boundAgent,
        writable: false,
      });
      boundAgentContexts.set(context, { agent: boundAgent, context });
      return context as TContext & PrachtContextExtensions;
    } catch {
      // Frozen/sealed contexts require the invariant-preserving overlay.
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(context, "agent");
    if (
      descriptor?.configurable === false &&
      "value" in descriptor &&
      descriptor.writable === false &&
      ((descriptor.value === null && boundAgent === null) ||
        (isAgentIdentitySnapshot(descriptor.value) &&
          isAgentIdentitySnapshot(boundAgent) &&
          sameAgentIdentity(descriptor.value, boundAgent)))
    ) {
      boundAgentContexts.set(context, { agent: boundAgent, context });
      return context as TContext & PrachtContextExtensions;
    }

    if (descriptor && (!("value" in descriptor) || descriptor.value !== null)) {
      throw new TypeError(
        "Pracht cannot safely replace an immutable application-owned agent field on the " +
          "supplied request context. Create a fresh context without an application-owned " +
          "agent field.",
      );
    }
    if (!descriptor && Reflect.has(context, "agent")) {
      throw new TypeError(
        "Pracht cannot safely replace an inherited application-owned agent field on the supplied " +
          "request context. Create a fresh context without an application-owned agent field.",
      );
    }

    const overlay = createImmutableContextOverlay(context, boundAgent);
    const binding = { agent: boundAgent, context: overlay };
    boundAgentContexts.set(context, binding);
    boundAgentContexts.set(overlay, binding);
    return overlay;
  }

  return Object.freeze({ agent: boundAgent }) as TContext & PrachtContextExtensions;
}

export function snapshotAgentIdentity(
  agent: PrachtAgentIdentity | null,
): Readonly<PrachtAgentIdentity> | null {
  if (!agent) return null;
  if (isAgentIdentitySnapshot(agent)) return agent;
  const { verified, agentDomain, keyId } = agent;
  if (
    verified !== true ||
    typeof keyId !== "string" ||
    (agentDomain !== null && typeof agentDomain !== "string")
  ) {
    return null;
  }
  const snapshot = Object.freeze({ verified: true as const, agentDomain, keyId });
  agentIdentitySnapshots.add(snapshot);
  return snapshot;
}

function isAgentIdentitySnapshot(value: unknown): value is Readonly<PrachtAgentIdentity> {
  return typeof value === "object" && value !== null && agentIdentitySnapshots.has(value);
}

function sameAgentIdentity(left: unknown, right: Readonly<PrachtAgentIdentity> | null): boolean {
  if (left === right) return true;
  if (!left || typeof left !== "object" || !right) return false;
  const candidate = left as Partial<PrachtAgentIdentity>;
  return (
    candidate.verified === true &&
    candidate.agentDomain === right.agentDomain &&
    candidate.keyId === right.keyId
  );
}
