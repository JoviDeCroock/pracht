import { h, render } from "preact";
import type { ComponentChild, ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { loadServerIsland } from "./server-islands-client.ts";
import {
  SERVER_ISLAND_ELEMENT,
  SERVER_ISLAND_FILE_ATTRIBUTE,
  SERVER_ISLAND_PENDING_ATTRIBUTE,
  SERVER_ISLAND_REFRESH_EVENT,
  SERVER_ISLANDS_READY_MARKER,
} from "./server-islands-shared.ts";

// Fetches in flight across every server island on the page: the ready marker is
// set whenever the last one settles.
let inFlight = 0;

/**
 * The client stand-in for a server island module on full-hydration pages.
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
export function createClientServerIsland(file: string) {
  function ServerIsland(props: Record<string, unknown> & { fallback?: ComponentChildren }) {
    const { fallback, children: _children, ...serverIslandProps } = props;
    const serialized = JSON.stringify(serverIslandProps);
    const pageUrl = location.pathname + location.search;
    const ref = useRef<HTMLElement>(null);
    const loads = useRef(0);
    // The fallback, when shown, is its own Preact root inside the element.
    const fallbackMounted = useRef(false);
    const [refreshes, setRefreshes] = useState(0);

    useEffect(() => {
      const refresh = () => setRefreshes((count) => count + 1);
      window.addEventListener(SERVER_ISLAND_REFRESH_EVENT, refresh);
      return () => {
        window.removeEventListener(SERVER_ISLAND_REFRESH_EVENT, refresh);
        if (fallbackMounted.current && ref.current) render(null, ref.current);
      };
    }, []);

    useEffect(() => {
      const element = ref.current;
      if (!element) return;
      const load = ++loads.current;
      // Only the server's markup carries the `serverIsland` attribute: this
      // component never renders it.
      const fromServer = load === 1 && element.hasAttribute(SERVER_ISLAND_FILE_ATTRIBUTE);
      if (fromServer && !element.hasAttribute(SERVER_ISLAND_PENDING_ATTRIBUTE)) return;
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
      const target = document.createElement(SERVER_ISLAND_ELEMENT);
      inFlight += 1;
      void loadServerIsland(target, file, serialized === "{}" ? null : serialized).then(
        (result) => {
          if (--inFlight === 0) {
            document.documentElement.setAttribute(SERVER_ISLANDS_READY_MARKER, "true");
          }
          if (load !== loads.current) return;
          if (result === "loaded") {
            if (fallbackMounted.current) render(null, element);
            fallbackMounted.current = false;
            element.innerHTML = target.innerHTML;
            element.removeAttribute(SERVER_ISLAND_PENDING_ATTRIBUTE);
          } else if (result === "empty" && !fromServer) {
            // A refresh that no longer yields a server island (signed out, say) must
            // not leave the previous visitor's HTML on screen.
            showFallback();
          }
        },
      );
    }, [serialized, pageUrl, refreshes]);

    return h(SERVER_ISLAND_ELEMENT, {
      ref,
      style: "display:contents",
      dangerouslySetInnerHTML: { __html: "" },
    });
  }
  const name = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  ServerIsland.displayName = `ServerIsland(${name})`;
  return ServerIsland;
}
