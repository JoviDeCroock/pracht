/**
 * The app root (`src/root.tsx`) on the server: load the module, run `setup()`
 * once per request, wrap rendered trees, and take the `dehydrate()` snapshot.
 *
 * The browser half lives in `router.ts`, which renders the same `Root` in the
 * same position (inside the runtime provider, above the shell) so hydration
 * sees an identical tree.
 *
 * @internal Not part of the published API.
 */
import { h } from "preact";
import type { FunctionComponent, VNode } from "preact";

import type { ModuleImporter, ModuleRegistry, RootModule } from "./types.ts";

export interface RequestRoot {
  module: RootModule;
  state: unknown;
}

const rootModuleCache = new WeakMap<object, Promise<RootModule | null>>();
const requestRootCache = new WeakMap<object, Promise<RequestRoot | null>>();

function loadRootModule(registry: ModuleRegistry): Promise<RootModule | null> {
  const modules = registry.rootModules;
  if (!modules) return Promise.resolve(null);

  let cached = rootModuleCache.get(modules);
  if (!cached) {
    const keys = Object.keys(modules);
    if (keys.length > 1) {
      cached = Promise.reject(
        new Error(
          `[pracht] Found more than one app root module (${keys.join(", ")}). Keep exactly one.`,
        ),
      );
    } else if (keys.length === 0) {
      cached = Promise.resolve(null);
    } else {
      const importer = modules[keys[0]] as ModuleImporter<RootModule>;
      cached = importer().then((mod) => mod ?? null);
    }
    rootModuleCache.set(modules, cached);
  }
  return cached;
}

/**
 * This request's root, created at most once however many renders the request
 * goes through (a thrown `notFound()` re-renders under the same state).
 * `requestKey` is the per-request context object.
 */
export function resolveRequestRoot(
  requestKey: object,
  registry: ModuleRegistry,
  request: Request,
): Promise<RequestRoot | null> {
  let cached = requestRootCache.get(requestKey);
  if (!cached) {
    cached = loadRootModule(registry).then((module) => {
      if (!module) return null;
      const state = module.setup ? module.setup({ request, isServer: true }) : undefined;
      return { module, state };
    });
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
