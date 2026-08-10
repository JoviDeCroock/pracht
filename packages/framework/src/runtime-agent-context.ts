import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./types.ts";

/**
 * Bind framework-verified agent identity onto an application request context.
 * Mutable contexts keep their shared identity. Frozen and sealed contexts get
 * an extensible overlay so framework fields do not turn a valid request into a
 * runtime exception while class and built-in instances keep their internal
 * slots.
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
      // through to an overlay without weakening the trusted identity.
    }

    return immutableAgentContext(context, agent);
  }

  return { agent } as TContext & PrachtContextExtensions;
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
    configurable: true,
    enumerable: true,
    value: agent,
    writable: false,
  });

  const boundMethods = new WeakMap<ContextMethod, ContextMethod>();
  return new Proxy(target, {
    apply(_target, thisArg, args) {
      return Reflect.apply(context as ContextMethod, thisArg, args);
    },
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.get(target, property, receiver);
      }

      const value = Reflect.get(context, property, context);
      if (typeof value !== "function") return value;

      const method = value as ContextMethod;
      let bound = boundMethods.get(method);
      if (!bound) {
        bound = method.bind(context);
        boundMethods.set(method, bound);
      }
      return bound;
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
  }) as TContext & PrachtContextExtensions;
}
