import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./types.ts";

const agentIdentitySnapshots = new WeakSet<object>();

/**
 * Bind framework-verified agent identity onto an application request context.
 * The framework-owned field and its value are immutable snapshots, so
 * application middleware cannot rewrite the identity used by later policy or
 * audit checks. Frozen and sealed contexts get an extensible overlay so the
 * binding does not turn a valid request into a runtime exception while class
 * and built-in instances keep their internal slots. Writes to existing
 * application fields keep using the original receiver; fields added by
 * middleware live on the overlay.
 */
export function bindAgentContext<TContext>(
  supplied: TContext | undefined,
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  const context = supplied ?? ({} as TContext);
  const boundAgent = snapshotAgentIdentity(agent);

  if ((typeof context === "object" && context !== null) || typeof context === "function") {
    try {
      Object.defineProperty(context, "agent", {
        configurable: false,
        enumerable: true,
        value: boundAgent,
        writable: false,
      });
      return context as TContext & PrachtContextExtensions;
    } catch {
      // Frozen/sealed contexts cannot accept framework-owned fields. Fall
      // through to an overlay without weakening the trusted identity.
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(context, "agent");
    if (
      descriptor &&
      descriptor.configurable === false &&
      "value" in descriptor &&
      descriptor.writable === false &&
      ((descriptor.value === null && boundAgent === null) ||
        (isAgentIdentitySnapshot(descriptor.value) &&
          isAgentIdentitySnapshot(boundAgent) &&
          sameAgentIdentity(descriptor.value, boundAgent)))
    ) {
      return context as TContext & PrachtContextExtensions;
    }

    return immutableAgentContext(context, boundAgent);
  }

  return Object.freeze({ agent: boundAgent }) as TContext & PrachtContextExtensions;
}

type ContextMethod = (...args: unknown[]) => unknown;

/**
 * Add framework-owned fields without manufacturing a fake class instance.
 * Copying descriptors onto `Object.create(instancePrototype)` loses private
 * fields and built-in internal slots. This overlay keeps application writes
 * local while forwarding reads to the original receiver; prototype methods
 * are bound for the same reason.
 */
function immutableAgentContext<TContext>(
  context: TContext & (object | ContextMethod),
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  const prototype = Object.getPrototypeOf(context);
  const target =
    typeof context === "function"
      ? function (this: unknown, ...args: unknown[]) {
          return Reflect.apply(context, this, args);
        }
      : Object.create(prototype);
  Object.setPrototypeOf(target, prototype);
  Object.defineProperty(target, "agent", {
    configurable: false,
    enumerable: true,
    value: agent,
    writable: false,
  });

  const boundMethods = new WeakMap<ContextMethod, ContextMethod>();
  const bindContextMethod = (method: ContextMethod): ContextMethod => {
    let bound = boundMethods.get(method);
    if (!bound) {
      bound = method.bind(context);
      boundMethods.set(method, bound);
    }
    return bound;
  };
  const materializedContextKeys = new Set<PropertyKey>();
  return new Proxy(target, {
    apply(_target, thisArg, args) {
      return Reflect.apply(context as ContextMethod, thisArg, args);
    },
    get(target, property, receiver) {
      if (
        Object.prototype.hasOwnProperty.call(target, property) &&
        !materializedContextKeys.has(property)
      ) {
        return Reflect.get(target, property, receiver);
      }

      const value = Reflect.get(context, property, context);
      if (typeof value !== "function" || property === "constructor") return value;

      const targetDescriptor = materializedContextKeys.has(property)
        ? Reflect.getOwnPropertyDescriptor(target, property)
        : undefined;
      if (
        targetDescriptor &&
        "value" in targetDescriptor &&
        targetDescriptor.configurable === false &&
        targetDescriptor.writable === false
      ) {
        // A Proxy must return the exact value of a non-configurable,
        // non-writable data property on its target. Object.freeze() reaches
        // this state after preventExtensions() materializes source fields.
        return targetDescriptor.value;
      }

      return bindContextMethod(value as ContextMethod);
    },
    set(target, property, value) {
      if (materializedContextKeys.has(property)) {
        const contextUpdated = Reflect.set(context, property, value, context);
        if (!contextUpdated) return false;

        const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
        if (descriptor && "value" in descriptor) {
          return Reflect.set(target, property, Reflect.get(context, property, context), target);
        }
        return true;
      }

      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.set(target, property, value, target);
      }

      if (
        Object.prototype.hasOwnProperty.call(context, property) ||
        hasPrototypeSetter(context, property)
      ) {
        return Reflect.set(context, property, value, context);
      }

      return Reflect.set(target, property, value, target);
    },
    defineProperty(target, property, descriptor) {
      if (materializedContextKeys.has(property)) {
        if (!Reflect.defineProperty(context, property, descriptor)) return false;
        return Reflect.defineProperty(target, property, descriptor);
      }

      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.defineProperty(target, property, descriptor);
      }
      if (Object.prototype.hasOwnProperty.call(context, property)) {
        return Reflect.defineProperty(context, property, descriptor);
      }
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (materializedContextKeys.has(property)) {
        if (!Reflect.deleteProperty(context, property)) return false;
        materializedContextKeys.delete(property);
        return Reflect.deleteProperty(target, property);
      }

      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.deleteProperty(target, property);
      }
      if (Object.prototype.hasOwnProperty.call(context, property)) {
        return Reflect.deleteProperty(context, property);
      }
      return true;
    },
    getOwnPropertyDescriptor(target, property) {
      const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (ownDescriptor) return ownDescriptor;

      const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
    has(target, property) {
      return Reflect.has(target, property) || Reflect.has(context, property);
    },
    ownKeys(target) {
      return [...new Set([...Reflect.ownKeys(context), ...Reflect.ownKeys(target)])];
    },
    preventExtensions(target) {
      for (const property of Reflect.ownKeys(context)) {
        if (Object.prototype.hasOwnProperty.call(target, property)) continue;
        let descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
          context,
          property,
        );
        if (
          descriptor &&
          "value" in descriptor &&
          typeof descriptor.value === "function" &&
          property !== "constructor"
        ) {
          descriptor = {
            ...descriptor,
            value: bindContextMethod(descriptor.value as ContextMethod),
          };
        }
        if (!descriptor || !Reflect.defineProperty(target, property, descriptor)) return false;
        materializedContextKeys.add(property);
      }

      if (!Reflect.preventExtensions(context)) return false;
      return Reflect.preventExtensions(target);
    },
  }) as TContext & PrachtContextExtensions;
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
  const snapshot = Object.freeze({
    verified: true as const,
    agentDomain,
    keyId,
  });
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

/** Prototype accessors must keep the original class instance as `this`. */
function hasPrototypeSetter(context: object | ContextMethod, property: PropertyKey): boolean {
  let prototype = Object.getPrototypeOf(context);
  while (prototype !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property);
    if (descriptor) return typeof descriptor.set === "function";
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}
