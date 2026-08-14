import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { ContextMethod, ContextOverlayTarget } from "./runtime-context-overlay-types.ts";
import { isConstructableContext } from "./runtime-context-overlay-validation.ts";

export function createContextOverlayTarget(
  context: object | ContextMethod,
  agent: PrachtAgentIdentity | null,
): ContextOverlayTarget {
  const prototype = Object.getPrototypeOf(context);
  const materializedContextKeys = new Set<PropertyKey>();
  const isArrayContext = Array.isArray(context);
  let target: object | ContextMethod;
  if (typeof context === "function") {
    const callableContext = context as ContextMethod;
    target = isConstructableContext(callableContext)
      ? function (this: unknown, ...args: unknown[]) {
          return Reflect.apply(callableContext, this, args);
        }.bind(undefined)
      : (...args: unknown[]) => Reflect.apply(callableContext, undefined, args);
  } else {
    target = isArrayContext ? [] : Object.create(prototype);
  }

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
  Object.defineProperty(target, "agent", {
    configurable: false,
    enumerable: true,
    value: agent,
    writable: false,
  });

  return { materializedContextKeys, target };
}
