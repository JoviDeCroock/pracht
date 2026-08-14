import { h } from "preact";
import type { VNode } from "preact";
import { useContext, useEffect, useRef } from "preact/hooks";

import { useIsHydrationComplete } from "./hydration.ts";
import {
  hasInjectedScript,
  injectScriptElement,
  recordInjectedScript,
  scheduleScriptWhenIdle,
  scheduleScriptWhenVisible,
  scriptExistsInDocument,
} from "./script-client.ts";
import { ScriptCaptureContext } from "./script-capture.ts";
import { escapeScriptChildren } from "./script-escape.ts";
import {
  describeScript,
  getScriptKey,
  normalizeInlineScriptChildren,
  toHeadScriptDescriptor,
  toScriptAttributeRecord,
  validateScriptStrategy,
} from "./script-policy.ts";
import { SCRIPT_PLACEHOLDER_ATTRIBUTE, type ScriptProps } from "./script-types.ts";

export {
  createScriptCapture,
  ScriptCaptureContext,
  withCapturedScripts,
} from "./script-capture.ts";
export { resetScriptRegistryForTesting as _resetScriptRegistryForTesting } from "./script-client.ts";
export {
  SCRIPT_INJECTED_ATTRIBUTE,
  SCRIPT_PLACEHOLDER_ATTRIBUTE,
  SCRIPT_STRATEGIES,
} from "./script-types.ts";
export type { ScriptCapture, ScriptProps, ScriptStrategy } from "./script-types.ts";

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
export function Script(props: ScriptProps): VNode | null {
  const capture = useContext(ScriptCaptureContext);
  const strategy = validateScriptStrategy(props.strategy);
  const inline = normalizeInlineScriptChildren(props.children);
  const key = getScriptKey(props, inline);

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

  useEffect(() => {
    // Server captures never reach effects; this is the client-only path.
    if (!hydrated || key === null) return;

    if (hasInjectedScript(key)) return;
    if (scriptExistsInDocument(props, inline)) {
      // Server-emitted beforeHydration tag (or a hand-written head() script):
      // record it so client navigations do not inject it again.
      recordInjectedScript(key);
      return;
    }

    let cancelled = false;
    const inject = () => {
      if (cancelled || hasInjectedScript(key)) return;
      recordInjectedScript(key);
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
      const cancel = scheduleScriptWhenIdle(inject);
      return () => {
        cancelled = true;
        cancel();
      };
    }

    // strategy === "visible"
    const cancel = scheduleScriptWhenVisible(placeholderRef.current, inject);
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

const DEV: boolean = Boolean(
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV ??
  (typeof process !== "undefined" && process.env?.NODE_ENV !== "production"),
);

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

function renderInlineScriptTag(props: ScriptProps, inline: string | undefined): VNode {
  const attributes: Record<string, unknown> = toScriptAttributeRecord(props);
  if (!props.src && inline !== undefined) {
    attributes.dangerouslySetInnerHTML = { __html: escapeScriptChildren(inline, props.type) };
  }
  return h("script", attributes);
}
