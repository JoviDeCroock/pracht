import type { ContextMethod } from "./runtime-context-overlay-types.ts";

export function isConstructableContext(context: ContextMethod): boolean {
  try {
    Reflect.construct(Object, [], context);
    return true;
  } catch {
    return false;
  }
}

export function assertOverlayableContext(context: object | ContextMethod): void {
  if (typeof context === "function" || Array.isArray(context)) return;

  const nativeContext = nativeInternalSlotContext(context);
  if (!nativeContext) return;

  throw new TypeError(
    `Pracht cannot safely bind agent identity to an immutable [object ${nativeContext}] request context because ` +
      "an overlay cannot preserve its native internal slots. Wrap the value in a fresh mutable " +
      "request context object.",
  );
}

/** Prototype accessors must keep the original class instance as `this`. */
export function hasPrototypeSetter(
  context: object | ContextMethod,
  property: PropertyKey,
): boolean {
  let prototype = Object.getPrototypeOf(context);
  while (prototype !== null) {
    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, property);
    if (descriptor) return typeof descriptor.set === "function";
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
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
