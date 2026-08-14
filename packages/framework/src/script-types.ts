import type { ComponentChildren } from "preact";

import type { HydrationMode } from "./route-policy-types.ts";
import type { HeadScriptDescriptor } from "./runtime-module-types.ts";

export const SCRIPT_STRATEGIES = ["beforeHydration", "afterHydration", "idle", "visible"] as const;

export type ScriptStrategy = (typeof SCRIPT_STRATEGIES)[number];

export interface ScriptProps {
  /** Loading strategy. Defaults to `"afterHydration"`. */
  strategy?: ScriptStrategy;
  /** External script URL. Mutually exclusive with inline children. */
  src?: string;
  /** Stable identifier used for deduplication and as the DOM `id`. */
  id?: string;
  async?: boolean;
  defer?: boolean;
  type?: string;
  nonce?: string;
  integrity?: string;
  crossorigin?: string;
  referrerpolicy?: string;
  /**
   * Client-only: fired when an external (`src`) script finishes loading via
   * one of the client strategies. Never serialized into SSR HTML, and not
   * fired for `beforeHydration` scripts the server already emitted.
   */
  onLoad?: (event: Event) => void;
  /** Client-only: fired when an external (`src`) script fails to load. */
  onError?: (event: Event) => void;
  /**
   * Inline script source, as an alternative to `src`. Must be a string (or an
   * array of strings) — JSX children throw a descriptive error.
   */
  children?: ComponentChildren;
}

/** Marker attribute set on client-injected script elements. */
export const SCRIPT_INJECTED_ATTRIBUTE = "data-pracht-script";
/** Marker attribute on the `strategy="visible"` placeholder element. */
export const SCRIPT_PLACEHOLDER_ATTRIBUTE = "data-pracht-script-placeholder";

/**
 * Mutable collector threaded through a server render via context (never
 * module state, so concurrent async renders — e.g. parallel SSG prerendering —
 * cannot attribute scripts to the wrong page). `beforeHydration` scripts land
 * here and are merged into the document head after the render.
 */
export interface ScriptCapture {
  scripts: HeadScriptDescriptor[];
  /** Dedupe keys of scripts already captured during this render. */
  keys: Set<string>;
  /** Hydration mode of the route being rendered; drives dev warnings. */
  hydration: HydrationMode;
  /**
   * True inside an island subtree during an islands-mode server render (the
   * island boundary re-provides the capture with this flag; scripts/keys are
   * shared by reference). Client strategies hydrate there — everywhere else
   * on an islands route they never run, which is worth a dev warning.
   */
  insideIsland?: boolean;
}
