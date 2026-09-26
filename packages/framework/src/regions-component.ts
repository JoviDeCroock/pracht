import { h, render } from "preact";
import type { ComponentChild, ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

import { loadRegion } from "./regions-client.ts";
import {
  REGION_ELEMENT,
  REGION_FILE_ATTRIBUTE,
  REGION_PENDING_ATTRIBUTE,
} from "./regions-shared.ts";

/**
 * The client stand-in for a region module on full-hydration pages.
 *
 * Its element renders with an empty `dangerouslySetInnerHTML`, which Preact
 * leaves alone while hydrating and never re-applies, so the server's markup
 * is an opaque subtree that survives hydration and re-renders untouched.
 * After mount the component fills itself:
 *
 * - server markup marked `pending` (a cached page): fetch and swap;
 * - server markup without it (rendered inline by SSR): nothing to do;
 * - no server markup (mounted by a client navigation): show the fallback,
 *   then fetch and swap.
 *
 * It fetches again when its props or the page URL change.
 */
export function createClientRegion(file: string) {
  function Region(props: Record<string, unknown> & { fallback?: ComponentChildren }) {
    const { fallback, children: _children, ...regionProps } = props;
    const serialized = JSON.stringify(regionProps);
    const pageUrl = location.pathname + location.search;
    const ref = useRef<HTMLElement>(null);
    const loads = useRef(0);

    useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const load = ++loads.current;
      // Only the server's markup carries the `region` attribute: this
      // component never renders it.
      const fromServer = load === 1 && element.hasAttribute(REGION_FILE_ATTRIBUTE);
      if (fromServer && !element.hasAttribute(REGION_PENDING_ATTRIBUTE)) return;
      let fallbackRoot = false;
      if (load === 1 && !fromServer && fallback != null) {
        render(fallback as ComponentChild, element);
        fallbackRoot = true;
      }
      // Fetched into a detached element, so the fallback stays mounted (and
      // is unmounted properly) until the region's HTML is ready.
      const target = document.createElement(REGION_ELEMENT);
      void loadRegion(target, file, serialized === "{}" ? null : serialized).then((loaded) => {
        if (!loaded || load !== loads.current) return;
        if (fallbackRoot) render(null, element);
        fallbackRoot = false;
        element.innerHTML = target.innerHTML;
        element.removeAttribute(REGION_PENDING_ATTRIBUTE);
      });
      return () => {
        if (fallbackRoot) render(null, element);
      };
    }, [serialized, pageUrl]);

    return h(REGION_ELEMENT, {
      ref,
      style: "display:contents",
      dangerouslySetInnerHTML: { __html: "" },
    });
  }
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  Region.displayName = `Region(${name})`;
  return Region;
}
