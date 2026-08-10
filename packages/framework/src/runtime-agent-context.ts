import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./types.ts";

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
  const boundAgent = immutableAgentIdentity(agent);

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
      (descriptor.value === null || Object.isFrozen(descriptor.value)) &&
      sameAgentIdentity(descriptor.value, boundAgent)
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

      const method = value as ContextMethod;
      let bound = boundMethods.get(method);
      if (!bound) {
        bound = method.bind(context);
        boundMethods.set(method, bound);
      }
      return bound;
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
      if (!materializedContextKeys.has(property)) {
        return Reflect.defineProperty(target, property, descriptor);
      }

      if (!Reflect.defineProperty(context, property, descriptor)) return false;
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      if (!materializedContextKeys.has(property)) {
        return Reflect.deleteProperty(target, property);
      }

      if (!Reflect.deleteProperty(context, property)) return false;
      materializedContextKeys.delete(property);
      return Reflect.deleteProperty(target, property);
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
        const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (!descriptor || !Reflect.defineProperty(target, property, descriptor)) return false;
        materializedContextKeys.add(property);
      }

      if (!Reflect.preventExtensions(context)) return false;
      return Reflect.preventExtensions(target);
    },
  }) as TContext & PrachtContextExtensions;
}

function immutableAgentIdentity(
  agent: PrachtAgentIdentity | null,
): Readonly<PrachtAgentIdentity> | null {
  return agent ? Object.freeze({ ...agent }) : null;
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
