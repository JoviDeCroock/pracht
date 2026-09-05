import { createContext, h } from "preact";
import type { ComponentChildren, VNode } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";

import { useIsHydrationComplete } from "./hydration.ts";
import { escapeScriptChildren } from "./script-escape.ts";
import type { HeadScriptDescriptor, HydrationMode } from "./types.ts";

/**
 * First-party `<Script>` component with loading strategies — the framework's
 * next/script analogue for third-party scripts.
 *
 * Strategies:
 * - `"beforeHydration"` — the script is collected during the server render and
 *   emitted into the document `<head>` alongside `head()` scripts, so it runs
 *   before the client runtime hydrates. This strategy only applies to
 *   server-rendered documents: on a client-side navigation the document head
 *   is not re-rendered, so the script is injected immediately instead (with a
 *   dev warning).
 * - `"afterHydration"` (default) — injected once the full hydration pass,
 *   including suspended boundaries, has completed.
 * - `"idle"` — injected in `requestIdleCallback` (setTimeout fallback).
 * - `"visible"` — a zero-size placeholder is rendered in place and the script
 *   is injected when the placeholder enters the viewport
 *   (IntersectionObserver; immediate fallback where unsupported).
 *
 * A script identified by `id`, `src`, or its inline content is never injected
 * twice — across re-renders, client navigations, and server-emitted
 * `beforeHydration` tags already present in the document.
 *
 * On `hydration: "none"` routes no client JavaScript ships, so only
 * `"beforeHydration"` (and `head()` scripts) can run; client strategies warn
 * in dev and render nothing.
 */

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
  /**
   * True when the document is streamed. `<head>` is already on the wire by the
   * time a component renders, so there is nothing left to merge into and
   * `beforeHydration` scripts are emitted in place instead — a body script in
   * SSR HTML still runs before hydration, which is the guarantee the strategy
   * actually makes.
   */
  streaming?: boolean;
}

export const ScriptCaptureContext = createContext<ScriptCapture | null>(null);

export function createScriptCapture(
  hydration: HydrationMode,
  streaming = false,
  existingScripts: readonly HeadScriptDescriptor[] = [],
): ScriptCapture {
  return {
    scripts: [],
    keys: new Set(
      existingScripts
        .map((script) => scriptKey(script, script.children))
        .filter((key): key is string => key !== null),
    ),
    hydration,
    streaming,
  };
}

/** Merge captured scripts into the document head without duplicating head() entries. */
export function withCapturedScripts<T extends { script?: HeadScriptDescriptor[] }>(
  head: T,
  capture: ScriptCapture,
): T {
  if (capture.scripts.length === 0) return head;
  const headScripts = head.script ?? [];
  const headKeys = new Set(
    headScripts
      .map((script) => scriptKey(script, script.children))
      .filter((key): key is string => key !== null),
  );
  const captured = capture.scripts.filter((script) => {
    const key = scriptKey(script, script.children);
    if (key === null || headKeys.has(key)) return false;
    headKeys.add(key);
    return true;
  });
  if (captured.length === 0) return head;
  return { ...head, script: [...headScripts, ...captured] };
}

/**
 * Module-level registry of scripts already injected in this document. Keyed by
 * `id`, then `src`, then inline content, so the same script is never injected
 * twice across navigations or re-renders.
 */
const injectedScripts = new Set<string>();

/** @internal Reset module state for tests. */
export function _resetScriptRegistryForTesting(): void {
  injectedScripts.clear();
}

const DEV: boolean = Boolean(
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production"),
);

export function Script(props: ScriptProps): VNode | null {
  const capture = useContext(ScriptCaptureContext);
  const strategy = validateStrategy(props.strategy);
  const inline = normalizeInlineChildren(props.children);
  const key = scriptKey(props, inline);

  if (DEV && props.src && inline !== undefined) {
    console.warn(
      `[pracht] <Script> (${describeScript(props)}) received both "src" and inline children; ` +
        "the inline content is ignored. Use two <Script> elements to load both.",
    );
  }
  const placeholderRef = useRef<HTMLElement | null>(null);

  // Hooks must run unconditionally; the capture branch below only short-
  // circuits on the server, where this component renders exactly once.
  const hydrated = useIsHydrationComplete();

  // A streamed beforeHydration script occupies this component's body slot in
  // the server HTML. Hydration removes that node because the client component
  // renders nothing, so remember it while it is still present instead of
  // waiting for the effect below and injecting the script a second time.
  if (
    capture === null &&
    strategy === "beforeHydration" &&
    key !== null &&
    !injectedScripts.has(key) &&
    existsInDocument(props, inline)
  ) {
    injectedScripts.add(key);
  }

  useEffect(() => {
    // Server captures never reach effects; this is the client-only path.
    if (!hydrated || key === null) return;

    if (injectedScripts.has(key)) return;
    if (existsInDocument(props, inline)) {
      // Server-emitted beforeHydration tag (or a hand-written head() script):
      // record it so client navigations do not inject it again.
      injectedScripts.add(key);
      return;
    }

    let cancelled = false;
    const inject = () => {
      if (cancelled || injectedScripts.has(key)) return;
      injectedScripts.add(key);
      injectScriptElement(props, inline);
    };

    if (strategy === "beforeHydration") {
      if (DEV) {
        console.warn(
          `[pracht] <Script strategy="beforeHydration"> (${describeScript(props)}) mounted in ` +
            "the browser without a matching server-emitted tag. beforeHydration only applies " +
            "to server-rendered documents; on client-side navigations the script is injected " +
            "immediately instead.",
        );
      }
      inject();
      return;
    }

    if (strategy === "afterHydration") {
      inject();
      return;
    }

    if (strategy === "idle") {
      const cancel = scheduleWhenIdle(inject);
      return () => {
        cancelled = true;
        cancel();
      };
    }

    // strategy === "visible"
    const cancel = scheduleWhenVisible(placeholderRef.current, inject);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [hydrated, key, strategy]);

  if (key === null) {
    if (DEV) {
      console.warn('[pracht] <Script> requires either a "src" prop or inline string children.');
    }
    return null;
  }

  // Server render inside the pracht runtime: the capture context is provided
  // by the renderer for every documented render path.
  if (capture) {
    if (strategy === "beforeHydration") {
      // Streamed documents have no head left to merge into; emit in place.
      if (capture.streaming) {
        if (capture.keys.has(key)) return null;
        capture.keys.add(key);
        return renderInlineScriptTag(props, inline);
      }
      if (!capture.keys.has(key)) {
        capture.keys.add(key);
        capture.scripts.push(toHeadScriptDescriptor(props, inline));
      }
    } else if (DEV && capture.hydration === "none") {
      console.warn(
        `[pracht] <Script strategy="${strategy}"> (${describeScript(props)}) rendered on a ` +
          'hydration: "none" route. These routes ship no client JavaScript, so client ' +
          'strategies can never run — use strategy: "beforeHydration" or a head() script ' +
          "entry instead.",
      );
    } else if (DEV && capture.hydration === "islands" && !capture.insideIsland) {
      console.warn(
        `[pracht] <Script strategy="${strategy}"> (${describeScript(props)}) rendered outside ` +
          'any island on a hydration: "islands" route. Only islands hydrate on these routes, ' +
          "so this script can never run — move it inside an island, or use " +
          'strategy: "beforeHydration".',
      );
    }
    return strategy === "visible" ? renderPlaceholder(key, placeholderRef) : null;
  }

  // Server render outside the pracht runtime (no capture context): there is no
  // document head to merge into, so emit beforeHydration scripts in place —
  // body scripts in SSR HTML still execute before hydration.
  if (typeof document === "undefined" && strategy === "beforeHydration") {
    return renderInlineScriptTag(props, inline);
  }

  return strategy === "visible" ? renderPlaceholder(key, placeholderRef) : null;
}

function renderPlaceholder(key: string, ref: { current: HTMLElement | null }): VNode {
  return h("span", {
    [SCRIPT_PLACEHOLDER_ATTRIBUTE]: key,
    // Absolutely positioned at its static position: a zero-size box that is
    // removed from the flow entirely — it cannot split inline content the way
    // a block box would, and it never becomes a flex/grid item consuming a
    // `gap` slot — while remaining observable by IntersectionObserver (edge
    // intersection counts for zero-area targets).
    style: "position:absolute;width:0;height:0;overflow:hidden",
    ref,
  } as Record<string, unknown>);
}

function validateStrategy(strategy: ScriptStrategy | undefined): ScriptStrategy {
  if (strategy == null) return "afterHydration";
  if ((SCRIPT_STRATEGIES as readonly string[]).includes(strategy)) return strategy;
  throw new Error(
    `<Script> received an invalid strategy ${JSON.stringify(strategy)}. Expected one of: ` +
      SCRIPT_STRATEGIES.map((s) => `"${s}"`).join(", ") +
      ".",
  );
}

function normalizeInlineChildren(children: ScriptProps["children"]): string | undefined {
  if (children == null) return undefined;
  const parts = Array.isArray(children) ? children : [children];
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    if (typeof part !== "string") {
      throw new Error(
        "<Script> inline children must be a string of script source. JSX children are not " +
          "supported — pass the code as a template literal string.",
      );
    }
  }
  return parts.join("");
}

function scriptKey(
  props: ScriptProps | HeadScriptDescriptor,
  inline: string | undefined,
): string | null {
  if (props.id) return `id:${props.id}`;
  if (props.src) return `src:${props.src}`;
  if (inline !== undefined) return `inline:${inline}`;
  return null;
}

function describeScript(props: ScriptProps): string {
  return props.id ?? props.src ?? "inline";
}

/**
 * Allowlisted attribute record. Unknown props — including any `on*` handler —
 * never pass through, matching the head-rendering safety posture in
 * runtime-html.ts.
 */
function toAttributeRecord(props: ScriptProps): Record<string, string> {
  const out: Record<string, string> = {};
  if (props.src) out.src = props.src;
  if (props.id) out.id = props.id;
  if (props.async) out.async = "";
  if (props.defer) out.defer = "";
  if (props.type) out.type = props.type;
  if (props.nonce) out.nonce = props.nonce;
  if (props.integrity) out.integrity = props.integrity;
  if (props.crossorigin) out.crossorigin = props.crossorigin;
  if (props.referrerpolicy) out.referrerpolicy = props.referrerpolicy;
  return out;
}

function toHeadScriptDescriptor(
  props: ScriptProps,
  inline: string | undefined,
): HeadScriptDescriptor {
  const descriptor: HeadScriptDescriptor = toAttributeRecord(props);
  if (!props.src && inline !== undefined) {
    descriptor.children = inline;
  }
  return descriptor;
}

function renderInlineScriptTag(props: ScriptProps, inline: string | undefined): VNode {
  const attributes: Record<string, unknown> = toAttributeRecord(props);
  if (!props.src && inline !== undefined) {
    attributes.dangerouslySetInnerHTML = { __html: escapeScriptChildren(inline, props.type) };
  }
  return h("script", attributes);
}

function existsInDocument(props: ScriptProps, inline: string | undefined): boolean {
  if (typeof document === "undefined") return false;
  if (props.id) {
    const el = document.getElementById(props.id);
    // Only a <script> holding the id counts as "already present": an
    // unrelated element that happens to share the id must not silently
    // swallow the script.
    if (el != null) return el.tagName === "SCRIPT";
  }
  const scripts = document.querySelectorAll("script");
  if (props.src) {
    for (const el of scripts) {
      if (el.getAttribute("src") === props.src) return true;
    }
    return false;
  }
  if (inline !== undefined) {
    const escaped = escapeScriptChildren(inline, props.type);
    for (const el of scripts) {
      if (el.textContent === inline || el.textContent === escaped) return true;
    }
  }
  return false;
}

function injectScriptElement(props: ScriptProps, inline: string | undefined): void {
  const element = document.createElement("script");
  for (const [name, value] of Object.entries(toAttributeRecord(props))) {
    element.setAttribute(name, value);
  }
  element.setAttribute(SCRIPT_INJECTED_ATTRIBUTE, "");
  if (props.src) {
    if (props.onLoad) element.addEventListener("load", props.onLoad);
    if (props.onError) element.addEventListener("error", props.onError);
  } else if (inline !== undefined) {
    element.textContent = inline;
  }
  document.head.appendChild(element);
}

function scheduleWhenIdle(task: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const handle = requestIdleCallback(() => task());
    return () => {
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
    };
  }
  const handle = setTimeout(task, 200);
  return () => clearTimeout(handle);
}

function scheduleWhenVisible(target: Element | null, task: () => void): () => void {
  if (typeof IntersectionObserver === "undefined" || target == null) {
    // Mirrors the islands `client="visible"` fallback: without an observer
    // (or a placeholder to observe) the script loads immediately.
    task();
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.disconnect();
      task();
      return;
    }
  });
  observer.observe(target);
  return () => observer.disconnect();
}
