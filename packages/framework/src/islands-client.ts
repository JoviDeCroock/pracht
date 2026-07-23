import { h, hydrate } from "preact";
import type { ComponentType } from "preact";

import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";

import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_STRATEGY_ATTRIBUTE,
  ISLANDS_HYDRATED_MARKER,
} from "./islands-shared.ts";

/**
 * Minimal islands bootstrap for routes rendered with `hydration: "islands"`.
 *
 * Scans the document for `<pracht-island>` markers emitted by the server,
 * dynamically imports only the island modules actually present on the page,
 * and hydrates each island in place with its serialized props. The full
 * client runtime (router, prefetching, route-state fetching) is never loaded.
 */

export interface HydrateIslandsOptions {
  /**
   * Island module importers keyed by project-root-relative path, as produced
   * by `import.meta.glob("/src/islands/**")` in the generated bootstrap.
   */
  modules: Record<string, () => Promise<unknown>>;
}

let capabilityRevalidationBound = false;

/**
 * Islands routes render server-side and mount no client router, so there is no
 * route-data store to soft-refresh after a mutation the way full-hydration
 * routes do. Reload the document instead when a non-`read` capability settles
 * successfully, so loader-rendered content stays consistent with the mutation.
 */
function bindCapabilityRevalidation(): void {
  if (capabilityRevalidationBound || typeof window === "undefined") return;
  capabilityRevalidationBound = true;
  window.addEventListener(CAPABILITY_SETTLED_EVENT, (event) => {
    const detail = (event as CustomEvent).detail as
      | { ok?: boolean; effect?: string; revalidate?: boolean }
      | undefined;
    if (detail?.ok === true && detail.effect !== "read" && detail.revalidate !== false) {
      window.location.reload();
    }
  });
}

export async function hydrateIslands(options: HydrateIslandsOptions): Promise<void> {
  bindCapabilityRevalidation();
  const elements = document.querySelectorAll(ISLAND_ELEMENT);
  const immediate: Promise<void>[] = [];

  for (const element of elements) {
    const strategy = element.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load";

    if (strategy === "visible") {
      scheduleWhenVisible(element, () => hydrateIsland(element, options));
    } else if (strategy === "idle") {
      scheduleWhenIdle(() => hydrateIsland(element, options));
    } else {
      immediate.push(hydrateIsland(element, options));
    }
  }

  await Promise.all(immediate);
  document.documentElement.setAttribute(ISLANDS_HYDRATED_MARKER, "true");
}

async function hydrateIsland(element: Element, options: HydrateIslandsOptions): Promise<void> {
  if (element.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "true") return;

  const file = element.getAttribute(ISLAND_FILE_ATTRIBUTE);
  const exportName = element.getAttribute(ISLAND_EXPORT_ATTRIBUTE) ?? "default";
  if (!file) return;

  const importer = findIslandModule(options.modules, file);
  if (!importer) {
    console.error(`[pracht] No island module found for "${file}".`);
    return;
  }

  let Component: ComponentType<Record<string, unknown>> | undefined;
  let props: Record<string, unknown> = {};
  try {
    const mod = (await importer()) as Record<string, unknown> | undefined;
    const exported = mod?.[exportName];
    if (typeof exported !== "function") {
      console.error(`[pracht] Island module "${file}" has no "${exportName}" component export.`);
      return;
    }
    Component = exported as ComponentType<Record<string, unknown>>;

    const rawProps = element.getAttribute(ISLAND_PROPS_ATTRIBUTE);
    if (rawProps) {
      props = JSON.parse(rawProps) as Record<string, unknown>;
    }
  } catch (error) {
    console.error(`[pracht] Failed to load island "${file}":`, error);
    return;
  }

  hydrate(h(Component, props), element);
  element.setAttribute(ISLAND_HYDRATED_ATTRIBUTE, "true");
}

function findIslandModule(
  modules: Record<string, () => Promise<unknown>>,
  file: string,
): (() => Promise<unknown>) | null {
  if (file in modules) return modules[file];

  // Fallback: match ignoring leading "./" / "/" differences.
  const normalized = normalizeModuleKey(file);
  for (const key of Object.keys(modules)) {
    if (normalizeModuleKey(key) === normalized) return modules[key];
  }
  return null;
}

function normalizeModuleKey(key: string): string {
  return key.split("?")[0].replace(/^\.?\//, "");
}

function scheduleWhenIdle(task: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => task());
  } else {
    setTimeout(task, 200);
  }
}

function scheduleWhenVisible(element: Element, task: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    task();
    return;
  }

  // The <pracht-island> wrapper uses display:contents and therefore has no
  // box of its own — IntersectionObserver would never report it as
  // intersecting. Observe the island's rendered children instead.
  const targets = element.children.length > 0 ? [...element.children] : [element];

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.disconnect();
      task();
      return;
    }
  });
  for (const target of targets) {
    observer.observe(target);
  }
}
