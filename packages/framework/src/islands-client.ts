import { h, hydrate } from "preact";
import type { ComponentType } from "preact";

import { CAPABILITY_SETTLED_EVENT } from "@pracht/capabilities";

import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ELEMENT,
  ISLAND_SLOT_END,
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
 * Build-time proof that the app has no agent surface at all — no registered
 * capabilities and no `defineApp({ agents })`. The Vite plugin defines it as
 * `false` only when it can read the manifest and see both are absent; anything
 * it cannot prove leaves it undefined and the listener stays wired.
 *
 * Without it, every islands page paid for the capability-settled listener and
 * the `@pracht/capabilities` import behind it, whether or not a capability
 * could ever settle.
 */
declare const __PRACHT_AGENT_SURFACE__: boolean | undefined;

/**
 * Keep the hydration-mismatch reporter in a production islands bundle, opted
 * into with `client: { hydrationWarnings: true }`. Declared here rather than
 * imported so this bundle folds its own `false` and drops the reporter's
 * dynamic import with the branch around it.
 */
declare const __PRACHT_HYDRATION_WARNINGS__: boolean | undefined;

const HYDRATION_WARNINGS_FORCED =
  typeof __PRACHT_HYDRATION_WARNINGS__ !== "undefined" && __PRACHT_HYDRATION_WARNINGS__ === true;

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
  // Islands routes call `hydrate()` here rather than through the client
  // router, so the router's copy of this install never runs for them — and
  // `hydration: "islands"` is the configuration that ships the least
  // JavaScript, so it is also the one most apps reach for. Dynamically
  // imported behind the branch: unless the app opts into production warnings,
  // the module is dropped from the islands bundle along with the branch.
  if (import.meta.env?.DEV || HYDRATION_WARNINGS_FORCED) {
    const { installHydrationMismatchWarning } = await import("./hydration-mismatch.ts");
    installHydrationMismatchWarning();
  }
  if (typeof __PRACHT_AGENT_SURFACE__ === "undefined" || __PRACHT_AGENT_SURFACE__) {
    bindCapabilityRevalidation();
  }
  const immediate: Promise<void>[] = [];
  scheduleIslands(document, options, immediate);

  await Promise.all(immediate);
  document.documentElement.setAttribute(ISLANDS_HYDRATED_MARKER, "true");
}

const scheduled = new WeakSet<Element>();

function scheduleIslands(
  root: ParentNode,
  options: HydrateIslandsOptions,
  immediate?: Promise<void>[],
): void {
  for (const element of root.querySelectorAll(ISLAND_ELEMENT)) {
    if (scheduled.has(element)) continue;
    scheduled.add(element);
    const strategy = element.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load";

    if (strategy === "visible") {
      scheduleWhenVisible(element, () => hydrateIsland(element, options));
    } else if (strategy === "idle") {
      scheduleWhenIdle(() => hydrateIsland(element, options));
    } else {
      const hydrated = hydrateIsland(element, options);
      if (immediate) immediate.push(hydrated);
    }
  }
}

/**
 * Children the page passed into an island arrive as server-rendered nodes in
 * slot elements the island owns (`<pracht-slot>`, or `<g pracht-slot>` /
 * `<mrow pracht-slot>` in SVG and MathML), or in a `<template pracht-slot>`
 * when the island did not place them. The island receives one slot vnode as
 * its children: hydration leaves the existing nodes alone, and when the island
 * mounts a fresh slot (after hiding it, say) the ref moves in the current
 * nodes of a detached holder, so the content and any island inside it keep
 * their state.
 *
 * Returns `false` when the HTML parser moved nodes out of a slot: hydrating
 * would delete them, so the island stays server HTML.
 */
function slotChildren(element: Element, options: HydrateIslandsOptions) {
  const nodes = [
    ...element.querySelectorAll(`${ISLAND_SLOT_ELEMENT},[${ISLAND_SLOT_ELEMENT}]`),
  ].filter((node) => node.parentElement!.closest(ISLAND_ELEMENT) === element);
  // Only the <template> has `content`.
  const holders: ParentNode[] = nodes.map((node) => (node as HTMLTemplateElement).content || node);
  if (holders.some((holder) => (holder.lastChild as Comment | null)?.data !== ISLAND_SLOT_END)) {
    return false;
  }
  let type = ISLAND_SLOT_ELEMENT;
  nodes.forEach((node, i) => {
    if (holders[i] !== node) node.remove();
    else type = node.localName;
  });

  return (
    holders[0] &&
    h(type, {
      ...(type === ISLAND_SLOT_ELEMENT && { style: "display:contents" }),
      dangerouslySetInnerHTML: { __html: "" },
      ref(slot: Element | null) {
        if (!slot || holders.includes(slot)) return;
        const i = holders.findIndex((holder) => !holder.isConnected);
        if (i < 0) return;
        slot.append(...holders[i].childNodes);
        holders[i] = slot;
        // Islands that shipped inside a <template> were never scheduled.
        scheduleIslands(slot, options);
      },
    })
  );
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

  const children = slotChildren(element, options);
  if (children === false) {
    console.error(
      `[pracht] Island "${file}" was not hydrated: the HTML parser moved its children ` +
        "(a <div> inside a <p>, or unbalanced raw HTML?)",
    );
    return;
  }
  if (children) props.children = children;
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

function boxedChildren(element: Element): Element[] {
  return [...element.children].flatMap((child) =>
    child.localName === ISLAND_ELEMENT || child.localName === ISLAND_SLOT_ELEMENT
      ? boxedChildren(child)
      : [child],
  );
}

function scheduleWhenVisible(element: Element, task: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    task();
    return;
  }

  // The <pracht-island> wrapper uses display:contents and therefore has no
  // box of its own — IntersectionObserver would never report it as
  // intersecting. Observe the island's rendered children instead, looking
  // through slots and nested islands, which have no box either. With nothing
  // to observe, the nearest ancestor stands in.
  const targets = boxedChildren(element);
  if (!targets.length) targets.push(element.parentElement!);

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
