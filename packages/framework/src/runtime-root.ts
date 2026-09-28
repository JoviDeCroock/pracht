/**
 * The app root (`defineApp({ root })`) on the server: load the module, run
 * `setup()` once per request, wrap rendered trees, and take the `dehydrate()`
 * snapshot.
 *
 * The build reads `root` from the manifest source and registers that one
 * module as `registry.rootModules`; `defineApp()` itself never carries it, so
 * the manifest every client bundle ships stays the same size. An app without
 * a root has an empty registry here.
 *
 * The browser half lives in `router.ts`, which renders the same `Root` in the
 * same position (inside the runtime provider, above the shell) so hydration
 * sees an identical tree.
 *
 * @internal Not part of the published API.
 */
import { h } from "preact";
import type { FunctionComponent, VNode } from "preact";

import type { ModuleRegistry, RootModule } from "./types.ts";

export interface RequestRoot {
  module: RootModule;
  state: unknown;
}

const requestRootCache = new WeakMap<object, Promise<RequestRoot | null>>();

async function loadRootModule(registry: ModuleRegistry): Promise<RootModule | null> {
  const modules = registry.rootModules;
  if (!modules) return null;
  const keys = Object.keys(modules);
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    throw new Error(
      `[pracht] The module registry holds more than one app root (${keys.join(", ")}). ` +
        "defineApp({ root }) registers exactly one.",
    );
  }
  // Not cached here: the module system already caches the import, and
  // re-resolving it per request is what lets a dev edit to the root apply.
  return (await modules[keys[0]]()) ?? null;
}

/**
 * This request's root, created at most once however many renders the request
 * goes through (a thrown `notFound()` re-renders under the same state).
 * `requestKey` is the per-request context object.
 */
export function resolveRequestRoot(
  requestKey: object,
  registry: ModuleRegistry,
): Promise<RequestRoot | null> {
  let cached = requestRootCache.get(requestKey);
  if (!cached) {
    cached = loadRootModule(registry).then((module) =>
      module ? { module, state: module.setup?.({ isServer: true }) } : null,
    );
    requestRootCache.set(requestKey, cached);
  }
  return cached;
}

export function wrapWithRoot(root: RequestRoot | null | undefined, tree: VNode<any>): VNode<any> {
  const Root = root?.module.Root as FunctionComponent<Record<string, unknown>> | undefined;
  return Root ? h(Root, { state: root!.state }, tree) : tree;
}

/** The root's snapshot for the browser, or `undefined` when there is none. */
export async function dehydrateRoot(root: RequestRoot | null | undefined): Promise<unknown> {
  if (!root?.module.dehydrate) return undefined;
  return await root.module.dehydrate(root.state);
}
