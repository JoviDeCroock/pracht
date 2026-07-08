import { createContext, h, options } from "preact";
import type { ComponentType, VNode } from "preact";
import { useContext } from "preact/hooks";

import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_STRATEGIES,
  ISLAND_STRATEGY_ATTRIBUTE,
} from "./islands-shared.ts";
import type { IslandStrategy } from "./types.ts";

/**
 * Server-side islands support.
 *
 * The vite plugin's `virtual:pracht/server` module eagerly imports every
 * module in the islands directory and registers each exported component here.
 * A Preact `options.vnode` hook (the same technique Deno Fresh uses) then
 * retypes any vnode whose type is a registered island component to a boundary
 * component. During an islands-mode render (detected via context, so
 * concurrent async renders never interfere) the boundary wraps the island's
 * SSR output in a `<pracht-island>` marker carrying the island's module path,
 * export name, hydration strategy, and JSON-serialized props. Outside
 * islands-mode renders the boundary renders the component unchanged, so
 * islands behave like plain components on full-hydration routes.
 */

export interface IslandDescriptor {
  /** Project-root-relative module path, e.g. "/src/islands/Counter.tsx". */
  file: string;
  /** Export name within the module ("default" for the default export). */
  exportName: string;
  /** Human-readable name used in error messages. */
  name: string;
}

export interface IslandUsage {
  descriptor: IslandDescriptor;
  strategy: IslandStrategy;
}

/** Mutable collector threaded through an islands-mode render via context. */
export interface IslandCapture {
  islands: IslandUsage[];
}

export const IslandCaptureContext = createContext<IslandCapture | null>(null);

const islandRegistry = new Map<ComponentType<any>, IslandDescriptor>();
let islandsClientEntryUrl: string | undefined;
let vnodeHookInstalled = false;

// Sentinel consumed synchronously by the vnode hook so the boundary can
// re-create a vnode for the original component without being re-wrapped.
// `h()` is synchronous, so set-then-consume is safe even under concurrent
// async renders.
let skipWrapForType: ComponentType<any> | null = null;

// Internal prop the vnode hook uses to hand the original component type to
// the boundary. Never reaches user components.
const ISLAND_TYPE_PROP = "__prachtIslandType";

/**
 * Register island components discovered from the islands directory. Called by
 * the generated `virtual:pracht/server` module with the eager
 * `import.meta.glob` result. Safe to call multiple times (dev reloads).
 */
export function registerServerIslands(modules: Record<string, unknown>): void {
  for (const [file, mod] of Object.entries(modules)) {
    if (!mod || typeof mod !== "object") continue;
    for (const [exportName, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      islandRegistry.set(value as ComponentType<any>, {
        file,
        exportName,
        name: exportName === "default" ? islandNameFromFile(file) : exportName,
      });
    }
  }

  if (islandRegistry.size > 0) {
    installIslandVnodeHook();
  }
}

export function setIslandsClientEntryUrl(url: string | undefined): void {
  islandsClientEntryUrl = url ?? undefined;
}

export function getIslandsClientEntryUrl(): string | undefined {
  return islandsClientEntryUrl;
}

export function hasRegisteredIslands(): boolean {
  return islandRegistry.size > 0;
}

/** @internal Reset module state for tests. */
export function _resetIslandsForTesting(): void {
  islandRegistry.clear();
  islandsClientEntryUrl = undefined;
  skipWrapForType = null;
}

function islandNameFromFile(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.[^.]+$/, "");
}

function installIslandVnodeHook(): void {
  if (vnodeHookInstalled) return;
  vnodeHookInstalled = true;

  const previousHook = options.vnode;
  options.vnode = (vnode: VNode<any>) => {
    const type = vnode.type;
    if (typeof type === "function" && islandRegistry.has(type as ComponentType<any>)) {
      if (skipWrapForType === type) {
        skipWrapForType = null;
      } else {
        vnode.props[ISLAND_TYPE_PROP] = type;
        (vnode as { type: unknown }).type = IslandBoundary;
      }
    }
    if (previousHook) previousHook(vnode);
  };
}

function renderOriginal(type: ComponentType<any>, props: Record<string, unknown>): VNode<any> {
  skipWrapForType = type;
  try {
    return h(type, props);
  } finally {
    skipWrapForType = null;
  }
}

function IslandBoundary(props: Record<string, unknown>) {
  const { [ISLAND_TYPE_PROP]: type, ...rest } = props as Record<string, unknown> & {
    [ISLAND_TYPE_PROP]: ComponentType<any>;
  };
  const capture = useContext(IslandCaptureContext);
  const descriptor = islandRegistry.get(type);

  if (!capture || !descriptor) {
    // Full-hydration render, client render, or an island nested inside
    // another island's subtree: render the component unchanged. The
    // framework-owned `client` prop is stripped so components never see it.
    const { client: _client, ...componentProps } = rest;
    return renderOriginal(type, componentProps);
  }

  const { client, children, ...componentProps } = rest;
  const strategy = validateIslandStrategy(client, descriptor);

  if (children != null && !(Array.isArray(children) && children.length === 0)) {
    throw new Error(
      `Island "${descriptor.name}" (${descriptor.file}) received children from a server ` +
        "component. Passing children/slots into islands is not supported in v1 — move the " +
        "content inside the island component, or pass it as a JSON-serializable prop.",
    );
  }

  validateIslandProps(componentProps, descriptor);
  capture.islands.push({ descriptor, strategy });

  const serializedProps = JSON.stringify(componentProps);
  const attributes: Record<string, string> = {
    [ISLAND_FILE_ATTRIBUTE]: descriptor.file,
    [ISLAND_EXPORT_ATTRIBUTE]: descriptor.exportName,
    // Unknown custom elements default to inline display; keep the wrapper
    // out of layout entirely.
    style: "display:contents",
  };
  if (strategy !== "load") {
    attributes[ISLAND_STRATEGY_ATTRIBUTE] = strategy;
  }
  if (serializedProps !== "{}") {
    attributes[ISLAND_PROPS_ATTRIBUTE] = serializedProps;
  }

  // Islands nested inside this island's subtree hydrate as part of this
  // island, so they must not emit their own markers: null out the capture
  // context for the wrapped subtree.
  return h(
    ISLAND_ELEMENT,
    attributes,
    h(IslandCaptureContext.Provider, { value: null }, renderOriginal(type, componentProps)),
  );
}

function validateIslandStrategy(client: unknown, descriptor: IslandDescriptor): IslandStrategy {
  if (client == null) return "load";
  if (typeof client === "string" && (ISLAND_STRATEGIES as readonly string[]).includes(client)) {
    return client as IslandStrategy;
  }
  throw new Error(
    `Island "${descriptor.name}" (${descriptor.file}) received an invalid client strategy ` +
      `${JSON.stringify(client)}. Expected one of: ${ISLAND_STRATEGIES.map((s) => `"${s}"`).join(", ")}.`,
  );
}

/**
 * Validate that island props survive a JSON round trip unchanged. Throws a
 * descriptive error naming the offending prop path so the failure is easy to
 * fix during development.
 */
export function validateIslandProps(
  props: Record<string, unknown>,
  descriptor: Pick<IslandDescriptor, "file" | "name">,
): void {
  for (const [key, value] of Object.entries(props)) {
    validateIslandPropValue(value, `props.${key}`, descriptor, new Set());
  }
}

function validateIslandPropValue(
  value: unknown,
  path: string,
  descriptor: Pick<IslandDescriptor, "file" | "name">,
  seen: Set<unknown>,
): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw islandPropError(path, `is ${String(value)}, which JSON cannot represent`, descriptor);
    }
    return;
  }

  if (value === undefined) {
    // JSON.stringify drops undefined object properties; the island simply
    // won't receive the prop, matching normal component semantics.
    return;
  }

  if (typeof value === "function") {
    throw islandPropError(path, "is a function", descriptor);
  }
  if (typeof value === "symbol") {
    throw islandPropError(path, "is a symbol", descriptor);
  }
  if (typeof value === "bigint") {
    throw islandPropError(path, "is a bigint", descriptor);
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      throw islandPropError(path, "contains a circular reference", descriptor);
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item === undefined) {
          throw islandPropError(
            `${path}[${index}]`,
            "is undefined inside an array (JSON serializes it as null)",
            descriptor,
          );
        }
        validateIslandPropValue(item, `${path}[${index}]`, descriptor, seen);
      });
      seen.delete(value);
      return;
    }

    // Preact vnodes set `constructor` to undefined; JSX passed as a prop
    // cannot be serialized and re-created on the client.
    if ((value as { constructor?: unknown }).constructor === undefined) {
      throw islandPropError(path, "is a JSX element", descriptor);
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const typeName =
        (value as { constructor?: { name?: string } }).constructor?.name ?? "class instance";
      throw islandPropError(path, `is a ${typeName} instance`, descriptor);
    }

    for (const [key, entry] of Object.entries(value)) {
      validateIslandPropValue(entry, `${path}.${key}`, descriptor, seen);
    }
    seen.delete(value);
    return;
  }

  throw islandPropError(path, `has unsupported type "${typeof value}"`, descriptor);
}

function islandPropError(
  path: string,
  reason: string,
  descriptor: Pick<IslandDescriptor, "file" | "name">,
): Error {
  return new Error(
    `Island "${descriptor.name}" (${descriptor.file}) received a prop that is not ` +
      `JSON-serializable: ${path} ${reason}. Island props are serialized into the HTML ` +
      "and revived in the browser, so they must be JSON-serializable values " +
      "(string, finite number, boolean, null, arrays, and plain objects).",
  );
}
