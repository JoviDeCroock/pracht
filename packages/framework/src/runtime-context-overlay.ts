import type { PrachtAgentIdentity } from "@pracht/capabilities";

import type { PrachtContextExtensions } from "./registration.ts";
import { createContextOverlayReflection } from "./runtime-context-overlay-reflection.ts";
import { createContextOverlayTarget } from "./runtime-context-overlay-target.ts";
import type { ContextMethod } from "./runtime-context-overlay-types.ts";
import {
  assertOverlayableContext,
  hasPrototypeSetter,
} from "./runtime-context-overlay-validation.ts";

/**
 * Add framework-owned fields without manufacturing a fake class instance.
 * Copying descriptors onto `Object.create(instancePrototype)` loses private
 * fields. This overlay keeps application writes local while forwarding reads
 * to the original receiver; prototype methods are bound for the same reason.
 */
export function createImmutableContextOverlay<TContext>(
  context: TContext & (object | ContextMethod),
  agent: PrachtAgentIdentity | null,
): TContext & PrachtContextExtensions {
  assertOverlayableContext(context);
  const { materializedContextKeys, target } = createContextOverlayTarget(context, agent);
  const reflection = createContextOverlayReflection(context, target, materializedContextKeys);

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
      reflection.synchronizeContextPrototype();
      return Reflect.getPrototypeOf(target);
    },
    get(target, property, receiver) {
      if (
        Object.prototype.hasOwnProperty.call(target, property) &&
        !materializedContextKeys.has(property)
      ) {
        return Reflect.get(target, property, receiver);
      }

      if (property !== "agent") reflection.assertNoInheritedAgentField();

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

      return reflection.bindContextMethod(value as ContextMethod);
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
              reflection.targetContextDescriptor(property, contextDescriptor),
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
        if (
          !currentDescriptor ||
          reflection.locksRawContextMethod(property, currentDescriptor, descriptor)
        ) {
          return false;
        }
        if (!Reflect.defineProperty(context, property, descriptor)) {
          return (
            (reflection.isCompatibleBoundMethodDefinition(
              property,
              currentDescriptor,
              descriptor,
            ) ||
              reflection.isCompatibleBoundAccessorDefinition(currentDescriptor, descriptor)) &&
            Reflect.defineProperty(target, property, descriptor)
          );
        }
        const contextDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        return (
          !!contextDescriptor &&
          Reflect.defineProperty(
            target,
            property,
            reflection.targetContextDescriptor(property, contextDescriptor),
          )
        );
      }

      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.defineProperty(target, property, descriptor);
      }
      if (Object.prototype.hasOwnProperty.call(context, property)) {
        const currentDescriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (
          !currentDescriptor ||
          reflection.locksRawContextMethod(property, currentDescriptor, descriptor)
        ) {
          // A locked data property forces a Proxy to return the target's exact
          // value. Refuse a raw method before mutating the source; otherwise
          // private fields and built-in receiver checks would break. A
          // descriptor reflected from this overlay carries the safe bound
          // value and remains accepted.
          return false;
        }
        if (!Reflect.defineProperty(context, property, descriptor)) {
          if (
            (!reflection.isCompatibleBoundMethodDefinition(
              property,
              currentDescriptor,
              descriptor,
            ) &&
              !reflection.isCompatibleBoundAccessorDefinition(currentDescriptor, descriptor)) ||
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
          : reflection.targetContextDescriptor(property, contextDescriptor);
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
      reflection.synchronizeMaterializedContextDescriptor(property);
      const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
      if (ownDescriptor) return ownDescriptor;

      const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
      if (!descriptor) return undefined;
      if (descriptor.configurable === false) {
        if (
          !Reflect.defineProperty(
            target,
            property,
            reflection.targetContextDescriptor(property, descriptor),
          )
        ) {
          return undefined;
        }
        materializedContextKeys.add(property);
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
      return { ...reflection.targetContextDescriptor(property, descriptor), configurable: true };
    },
    has(target, property) {
      reflection.synchronizeMaterializedContextDescriptor(property);
      return Reflect.has(target, property) || Reflect.has(context, property);
    },
    ownKeys(target) {
      for (const property of materializedContextKeys) {
        reflection.synchronizeMaterializedContextDescriptor(property);
      }
      return [...new Set([...Reflect.ownKeys(context), ...Reflect.ownKeys(target)])];
    },
    preventExtensions(target) {
      if (!reflection.synchronizeContextPrototype()) return false;
      for (const property of Reflect.ownKeys(context)) {
        if (Object.prototype.hasOwnProperty.call(target, property)) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(context, property);
        if (
          !descriptor ||
          !Reflect.defineProperty(
            target,
            property,
            reflection.targetContextDescriptor(property, descriptor),
          )
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
