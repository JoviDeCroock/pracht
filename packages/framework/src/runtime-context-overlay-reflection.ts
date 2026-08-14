import type { ContextMethod } from "./runtime-context-overlay-types.ts";

export function createContextOverlayReflection(
  context: object | ContextMethod,
  target: object | ContextMethod,
  materializedContextKeys: Set<PropertyKey>,
) {
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
          assertNoInheritedAgentField();
          return Reflect.apply(target, context, args);
        },
        construct(_target, args, newTarget) {
          assertNoInheritedAgentField();
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
        assertNoInheritedAgentField();
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

  function assertNoInheritedAgentField(): void {
    if (!Object.prototype.hasOwnProperty.call(context, "agent") && Reflect.has(context, "agent")) {
      throw new TypeError(
        "Pracht detected an inherited application-owned agent field after binding the request " +
          "context. The agent field is reserved for the framework.",
      );
    }
  }

  return {
    assertNoInheritedAgentField,
    bindContextMethod,
    isCompatibleBoundAccessorDefinition,
    isCompatibleBoundMethodDefinition,
    locksRawContextMethod,
    synchronizeContextPrototype,
    synchronizeMaterializedContextDescriptor,
    targetContextDescriptor,
  };
}
