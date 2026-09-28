import { h, render } from "preact";
import type { ComponentChild, ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { loadRegion } from "./regions-client.ts";
import {
  REGION_ELEMENT,
  REGION_FILE_ATTRIBUTE,
  REGION_PENDING_ATTRIBUTE,
  REGION_REFRESH_EVENT,
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
 * It fetches again when its props or the page URL change, and when route data
 * is refreshed in place (`useRevalidate()`, a capability call, a `<Form>`
 * submission), keeping the current HTML on screen until the new one arrives.
 */
export function createClientRegion(file: string) {
  function Region(props: Record<string, unknown> & { fallback?: ComponentChildren }) {
    const { fallback, children: _children, ...regionProps } = props;
    const serialized = JSON.stringify(regionProps);
    const pageUrl = location.pathname + location.search;
    const ref = useRef<HTMLElement>(null);
    const loads = useRef(0);
    // The fallback, when shown, is its own Preact root inside the element.
    const fallbackMounted = useRef(false);
    const [refreshes, setRefreshes] = useState(0);

    useEffect(() => {
      const refresh = () => setRefreshes((count) => count + 1);
      window.addEventListener(REGION_REFRESH_EVENT, refresh);
      return () => {
        window.removeEventListener(REGION_REFRESH_EVENT, refresh);
        if (fallbackMounted.current && ref.current) render(null, ref.current);
      };
    }, []);

    useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const load = ++loads.current;
      // Only the server's markup carries the `region` attribute: this
      // component never renders it.
      const fromServer = load === 1 && element.hasAttribute(REGION_FILE_ATTRIBUTE);
      if (fromServer && !element.hasAttribute(REGION_PENDING_ATTRIBUTE)) return;
      const showFallback = () => {
        if (fallbackMounted.current) return;
        element.textContent = "";
        if (fallback != null) render(fallback as ComponentChild, element);
        fallbackMounted.current = true;
      };
      // Mounted by a client navigation: nothing from the server to show yet.
      if (load === 1 && !fromServer) showFallback();
      // Fetched into a detached element, so what is on screen — the fallback,
      // or the previous HTML on a refresh — stays until the new HTML is ready.
      const target = document.createElement(REGION_ELEMENT);
      void loadRegion(target, file, serialized === "{}" ? null : serialized).then((result) => {
        if (load !== loads.current) return;
        if (result === "loaded") {
          if (fallbackMounted.current) render(null, element);
          fallbackMounted.current = false;
          element.innerHTML = target.innerHTML;
          element.removeAttribute(REGION_PENDING_ATTRIBUTE);
        } else if (result === "empty" && !fromServer) {
          // A refresh that no longer yields a region (signed out, say) must
          // not leave the previous visitor's HTML on screen.
          showFallback();
        }
      });
    }, [serialized, pageUrl, refreshes]);

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
