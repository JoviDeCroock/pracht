import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./types.ts";

const agentIdentitySnapshots = new WeakSet<object>();
interface BoundAgentContext {
  agent: Readonly<PrachtAgentIdentity> | null;
  context: object;
}

const boundAgentContexts = new WeakMap<object, BoundAgentContext>();

/**
 * Bind framework-verified agent identity onto an application request context.
 * The framework-owned field and its value are immutable snapshots, so
 * application middleware cannot rewrite the identity used by later policy or
 * audit checks. Frozen and sealed ordinary contexts get an extensible overlay
 * so the binding does not turn a valid request into a runtime exception while
 * class instances keep their private-field receivers and arrays keep their
 * brand. Native built-ins that require internal slots cannot be represented by
 * an overlay and fail closed with guidance to wrap them in a mutable context.
 * Writes to existing application fields keep using the original receiver;
 * fields added by middleware live on the overlay.
 */
export function bindAgentContext<TContext>(
  supplied: TContext | undefined,
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  const context = supplied ?? ({} as TContext);
  const boundAgent = snapshotAgentIdentity(agent);

  if ((typeof context === "object" && context !== null) || typeof context === "function") {
    if (boundAgentContexts.has(context)) {
      const previous = boundAgentContexts.get(context)!;
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

    assertOverlayableContext(context);
    const overlay = immutableFrameworkContext(context, { agent: boundAgent });
    const binding = { agent: boundAgent, context: overlay };
    boundAgentContexts.set(context, binding);
    boundAgentContexts.set(overlay, binding);
    return overlay;
  }

  return Object.freeze({ agent: boundAgent }) as TContext & PrachtContextExtensions;
}

type ContextMethod = (...args: unknown[]) => unknown;

const requestContextOverlays = new WeakSet<object>();

/**
 * Create a fresh request-local view over an adapter-supplied context.
 *
 * Reads and receiver-sensitive methods still reach the supplied object, while
 * framework-owned fields and otherwise-new writes stay on this request's
 * overlay. This lets adapters reuse a base context without carrying identity
 * from one request into the next.
 */
export function isolateRequestContext<TContext>(context: TContext): TContext {
  if ((typeof context !== "object" || context === null) && typeof context !== "function") {
    return context;
  }

  assertOverlayableContext(context as object | ContextMethod);
  const overlay = immutableFrameworkContext(context as TContext & (object | ContextMethod), {});
  requestContextOverlays.add(overlay as object);
  return overlay as TContext;
}

/** @internal Whether this context is already a request-local overlay. */
export function isRequestContextOverlay(context: unknown): boolean {
  return (
    ((typeof context === "object" && context !== null) || typeof context === "function") &&
    requestContextOverlays.has(context as object)
  );
}

/**
 * Add framework-owned fields without manufacturing a fake class instance.
 * Copying descriptors onto `Object.create(instancePrototype)` loses private
 * fields. This overlay keeps application writes local while forwarding reads
 * to the original receiver; prototype methods are bound for the same reason.
 */
function immutableFrameworkContext<TContext>(
  context: TContext & (object | ContextMethod),
  frameworkFields: Readonly<Record<string, unknown>>,
): TContext & PrachtContextExtensions {
  const prototype = Object.getPrototypeOf(context);
  const materializedContextKeys = new Set<PropertyKey>();
  const isArrayContext = Array.isArray(context);
  const target =
    typeof context === "function"
      ? isConstructableContext(context)
        ? function (this: unknown, ...args: unknown[]) {
            return Reflect.apply(context, this, args);
          }.bind(undefined)
        : (...args: unknown[]) => Reflect.apply(context, undefined, args)
      : isArrayContext
        ? []
        : Object.create(prototype);
  if (typeof context === "function") {
    for (const property of ["name", "length", "prototype"] as const) {
      const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
      if (descriptor && Reflect.defineProperty(target, property, descriptor)) {
        materializedContextKeys.add(property);
      }
    }
  } else if (isArrayContext) {
    const descriptor = Reflect.getOwnPropertyDescriptor(context, "length");
    if (descriptor && Reflect.defineProperty(target, "length", descriptor)) {
      materializedContextKeys.add("length");
    }
  }
  Object.setPrototypeOf(target, prototype);
  const reservedFields = new Set(Reflect.ownKeys(frameworkFields));
  for (const property of reservedFields) {
    Object.defineProperty(target, property, {
      configurable: false,
      enumerable: true,
      value: frameworkFields[property as string],
      writable: false,
    });
  }

  const boundMethods = new WeakMap<ContextMethod, ContextMethod>();
  const contextBoundMethods = new WeakSet<ContextMethod>();
  const boundAccessors = new WeakMap<ContextMethod, ContextMethod>();
  const contextBoundAccessors = new WeakSet<ContextMethod>();
  const bindContextMethod = (method: ContextMethod): ContextMethod => {
    if (contextBoundMethods.has(method)) return method;
    let bound = boundMethods.get(method);
    if (!bound) {
      let guarded: ContextMethod;
      guarded = new Proxy(method, {
        apply(target, _thisArg, args) {
          assertNoInheritedFrameworkField();
          return Reflect.apply(target, context, args);
        },
        construct(_target, args, newTarget) {
          assertNoInheritedFrameworkField();
          return Reflect.construct(method, args, newTarget === guarded ? method : newTarget);
        },
      });
      bound = guarded;
      boundMethods.set(method, bound);
      contextBoundMethods.add(bound);
    }
    return bound;
  };
  const bindContextAccessor = (accessor: ContextMethod): ContextMethod => {
    if (contextBoundAccessors.has(accessor)) return accessor;
    let bound = boundAccessors.get(accessor);
    if (!bound) {
      const receiverBound = accessor.bind(context);
      bound = (...args: unknown[]) => {
        assertNoInheritedFrameworkField();
        return Reflect.apply(receiverBound, undefined, args);
      };
      boundAccessors.set(accessor, bound);
      contextBoundAccessors.add(bound);
    }
    return bound;
  };
  const targetContextDescriptor = (
    property: PropertyKey,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    if (
      "value" in descriptor &&
      typeof descriptor.value === "function" &&
      property !== "constructor"
    ) {
      return { ...descriptor, value: bindContextMethod(descriptor.value as ContextMethod) };
    }

    const targetDescriptor = { ...descriptor };
    if (typeof descriptor.get === "function") {
      targetDescriptor.get = bindContextAccessor(descriptor.get as ContextMethod);
    }
    if (typeof descriptor.set === "function") {
      targetDescriptor.set = bindContextAccessor(descriptor.set as ContextMethod);
    }
    return targetDescriptor;
  };
  const locksRawContextMethod = (
    property: PropertyKey,
    currentDescriptor: PropertyDescriptor,
    descriptor: PropertyDescriptor,
  ): boolean => {
    const resultingValue = Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : "value" in currentDescriptor
        ? currentDescriptor.value
        : undefined;
    const resultingConfigurable = descriptor.configurable ?? currentDescriptor.configurable;
    const resultingWritable =
      descriptor.writable ?? ("writable" in currentDescriptor && currentDescriptor.writable);
    return (
      property !== "constructor" &&
      Object.prototype.hasOwnProperty.call(descriptor, "value") &&
      typeof resultingValue === "function" &&
      resultingConfigurable === false &&
      resultingWritable === false &&
      !contextBoundMethods.has(resultingValue as ContextMethod)
    );
  };
  const isCompatibleBoundMethodDefinition = (
    property: PropertyKey,
    currentDescriptor: PropertyDescriptor,
    descriptor: PropertyDescriptor,
  ): boolean =>
    property !== "constructor" &&
    "value" in currentDescriptor &&
    typeof currentDescriptor.value === "function" &&
    Object.prototype.hasOwnProperty.call(descriptor, "value") &&
    descriptor.value === bindContextMethod(currentDescriptor.value as ContextMethod) &&
    (descriptor.enumerable === undefined ||
      descriptor.enumerable === currentDescriptor.enumerable) &&
    !(descriptor.writable === true && currentDescriptor.writable === false);
  const isCompatibleBoundAccessorDefinition = (
    currentDescriptor: PropertyDescriptor,
    descriptor: PropertyDescriptor,
  ): boolean => {
    if (
      "value" in currentDescriptor ||
      Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      Object.prototype.hasOwnProperty.call(descriptor, "writable")
    ) {
      return false;
    }
    if (
      descriptor.enumerable !== undefined &&
      descriptor.enumerable !== currentDescriptor.enumerable
    ) {
      return false;
    }
    if (descriptor.configurable === true && currentDescriptor.configurable === false) return false;

    for (const property of ["get", "set"] as const) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, property)) continue;
      const currentAccessor = currentDescriptor[property];
      const expected =
        typeof currentAccessor === "function"
          ? bindContextAccessor(currentAccessor as ContextMethod)
          : currentAccessor;
      if (descriptor[property] !== expected) return false;
    }
    return true;
  };
  const synchronizeMaterializedContextDescriptor = (property: PropertyKey): void => {
    if (!materializedContextKeys.has(property)) return;

    const contextDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
    if (!contextDescriptor) {
      if (Reflect.deleteProperty(target, property)) materializedContextKeys.delete(property);
      return;
    }

    Reflect.defineProperty(target, property, targetContextDescriptor(property, contextDescriptor));
  };
  const synchronizeContextPrototype = (): boolean => {
    const contextPrototype = Reflect.getPrototypeOf(context);
    return (
      Reflect.getPrototypeOf(target) === contextPrototype ||
      Reflect.setPrototypeOf(target, contextPrototype)
    );
  };
  function assertNoInheritedFrameworkField(): void {
    for (const property of reservedFields) {
      if (
        !Object.prototype.hasOwnProperty.call(context, property) &&
        Reflect.has(context, property)
      ) {
        throw new TypeError(
          `Pracht detected an inherited application-owned ${String(property)} field after binding the request ` +
            `context. The ${String(property)} field is reserved for the framework.`,
        );
      }
    }
  }
  let proxy: TContext & PrachtContextExtensions;
  proxy = new Proxy(target, {
    apply(_target, thisArg, args) {
      return Reflect.apply(context as ContextMethod, thisArg, args);
    },
    construct(_target, args, newTarget) {
      return Reflect.construct(
        context as ContextMethod,
        args,
        newTarget === (proxy as unknown) ? (context as ContextMethod) : newTarget,
      );
    },
    setPrototypeOf(target, newPrototype) {
      if (!Reflect.setPrototypeOf(context, newPrototype)) return false;
      return Reflect.setPrototypeOf(target, newPrototype);
    },
    getPrototypeOf(target) {
      synchronizeContextPrototype();
      return Reflect.getPrototypeOf(target);
    },
    get(target, property, receiver) {
      if (
        Object.prototype.hasOwnProperty.call(target, property) &&
        !materializedContextKeys.has(property)
      ) {
        return Reflect.get(target, property, receiver);
      }

      if (!reservedFields.has(property)) assertNoInheritedFrameworkField();

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
          const contextDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
          return (
            !!contextDescriptor &&
            Reflect.defineProperty(
              target,
              property,
              targetContextDescriptor(property, contextDescriptor),
            )
          );
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
        const currentDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (!currentDescriptor || locksRawContextMethod(property, currentDescriptor, descriptor)) {
          return false;
        }
        if (!Reflect.defineProperty(context, property, descriptor)) {
          return (
            (isCompatibleBoundMethodDefinition(property, currentDescriptor, descriptor) ||
              isCompatibleBoundAccessorDefinition(currentDescriptor, descriptor)) &&
            Reflect.defineProperty(target, property, descriptor)
          );
        }
        const contextDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        return (
          !!contextDescriptor &&
          Reflect.defineProperty(
            target,
            property,
            targetContextDescriptor(property, contextDescriptor),
          )
        );
      }

      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.defineProperty(target, property, descriptor);
      }
      if (Object.prototype.hasOwnProperty.call(context, property)) {
        const currentDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (!currentDescriptor || locksRawContextMethod(property, currentDescriptor, descriptor)) {
          // A locked data property forces a Proxy to return the target's exact
          // value. Refuse a raw method before mutating the source; otherwise
          // private fields and built-in receiver checks would break. A
          // descriptor reflected from this overlay carries the safe bound
          // value and remains accepted.
          return false;
        }
        if (!Reflect.defineProperty(context, property, descriptor)) {
          if (
            (!isCompatibleBoundMethodDefinition(property, currentDescriptor, descriptor) &&
              !isCompatibleBoundAccessorDefinition(currentDescriptor, descriptor)) ||
            !Reflect.defineProperty(target, property, descriptor)
          ) {
            return false;
          }
          materializedContextKeys.add(property);
          return true;
        }
        const contextDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (!contextDescriptor) return false;
        const materializedDescriptor = Object.prototype.hasOwnProperty.call(descriptor, "value")
          ? contextDescriptor
          : targetContextDescriptor(property, contextDescriptor);
        if (!Reflect.defineProperty(target, property, materializedDescriptor)) return false;
        materializedContextKeys.add(property);
        return true;
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
      synchronizeMaterializedContextDescriptor(property);
      const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (ownDescriptor) return ownDescriptor;

      const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
      if (!descriptor) return undefined;
      if (descriptor.configurable === false) {
        if (
          !Reflect.defineProperty(target, property, targetContextDescriptor(property, descriptor))
        ) {
          return undefined;
        }
        materializedContextKeys.add(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
      return { ...targetContextDescriptor(property, descriptor), configurable: true };
    },
    has(target, property) {
      synchronizeMaterializedContextDescriptor(property);
      return Reflect.has(target, property) || Reflect.has(context, property);
    },
    ownKeys(target) {
      for (const property of materializedContextKeys) {
        synchronizeMaterializedContextDescriptor(property);
      }
      return [...new Set([...Reflect.ownKeys(context), ...Reflect.ownKeys(target)])];
    },
    preventExtensions(target) {
      if (!synchronizeContextPrototype()) return false;
      for (const property of Reflect.ownKeys(context)) {
        if (Object.prototype.hasOwnProperty.call(target, property)) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (
          !descriptor ||
          !Reflect.defineProperty(target, property, targetContextDescriptor(property, descriptor))
        ) {
          return false;
        }
        materializedContextKeys.add(property);
      }

      if (!Reflect.preventExtensions(context)) return false;
      return Reflect.preventExtensions(target);
    },
  }) as TContext & PrachtContextExtensions;
  return proxy;
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

function isConstructableContext(context: ContextMethod): boolean {
  try {
    Reflect.construct(Object, [], context);
    return true;
  } catch {
    return false;
  }
}

function assertOverlayableContext(context: object | ContextMethod): void {
  if (typeof context === "function" || Array.isArray(context)) return;

  const nativeContext = nativeInternalSlotContext(context);
  if (!nativeContext) return;

  throw new TypeError(
    `Pracht cannot safely create a request-local overlay for an [object ${nativeContext}] request context because ` +
      "an overlay cannot preserve its native internal slots. Wrap the value in a fresh mutable " +
      "request context object.",
  );
}

function nativeInternalSlotContext(context: object): string | null {
  let prototype = Reflect.getPrototypeOf(context);
  while (prototype !== null) {
    const parent = Reflect.getPrototypeOf(prototype);
    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, "constructor");
    const constructor = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof constructor === "function") {
      const name = nativeConstructorName(prototype, constructor);
      // Every ordinary object eventually reaches its realm's Object.prototype.
      // Do not mistake that shared native root for an internal-slot prototype.
      if (parent === null && name === "Object") return null;
      if (
        isNativeConstructor(constructor) ||
        isRealmGlobalTaggedPrototype(prototype, constructor)
      ) {
        return name ?? "native";
      }
    }
    prototype = parent;
  }
  return null;
}

function nativeConstructorName(prototype: object, constructor: Function): string | null {
  const tag = Reflect.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
  if (tag && "value" in tag && typeof tag.value === "string") return tag.value;
  const name = Reflect.getOwnPropertyDescriptor(constructor, "name");
  return name && "value" in name && typeof name.value === "string" ? name.value : null;
}

function isNativeConstructor(constructor: Function): boolean {
  try {
    return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(constructor));
  } catch {
    return false;
  }
}

function isRealmGlobalTaggedPrototype(prototype: object, constructor: Function): boolean {
  const tag = Reflect.getOwnPropertyDescriptor(prototype, Symbol.toStringTag);
  if (!tag || !("value" in tag) || typeof tag.value !== "string") return false;
  const globalDescriptor = Reflect.getOwnPropertyDescriptor(globalThis, tag.value);
  return (
    !!globalDescriptor && "value" in globalDescriptor && globalDescriptor.value === constructor
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
