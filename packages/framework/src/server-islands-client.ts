import { withBase } from "./base.ts";
import {
  PRACHT_SERVER_ISLAND_ENDPOINT,
  SERVER_ISLAND_ELEMENT,
  SERVER_ISLAND_FILE_ATTRIBUTE,
  SERVER_ISLAND_ISLANDS_HEADER,
  SERVER_ISLAND_PENDING_ATTRIBUTE,
  SERVER_ISLAND_PROPS_ATTRIBUTE,
  SERVER_ISLAND_QUERY_FILE,
  SERVER_ISLAND_QUERY_PATH,
  SERVER_ISLAND_QUERY_PROPS,
  SERVER_ISLAND_REQUEST_HEADER,
  SERVER_ISLAND_SCAN_EVENT,
  SERVER_ISLAND_SWAP_EVENT,
  SERVER_ISLANDS_READY_MARKER,
} from "./server-islands-shared.ts";

/**
 * Browser half of server islands.
 *
 * - `startServerIslands()` is the whole of `virtual:pracht/server-islands-client`, the swap
 *   script islands and `hydration: "none"` pages load when they rendered a
 *   pending server island. It is the only JavaScript such a `"none"` page ships, so
 *   this module imports no Preact.
 * - `createClientServerIsland()` (`server-islands-component.ts`, its own package entry so
 *   the swap script never shares a chunk with it) is what a server island module
 *   compiles to in the client bundle, so full-hydration pages never download
 *   a server island's code or its loader.
 */

/**
 * How a server island fetch ended:
 *
 * - `"loaded"` — the endpoint's fragment is in `element`;
 * - `"empty"` — the server answered without one (no server island for this visitor,
 *   a failing loader, a route that does not render it): show the fallback;
 * - `"failed"` — the request never completed: keep whatever is on screen.
 */
export type ServerIslandLoadResult = "loaded" | "empty" | "failed";

/**
 * Fetch one server island's request-time HTML for the current page and swap it into
 * `element`. Anything but `"loaded"` leaves `element` untouched.
 */
export async function loadServerIsland(
  element: Element,
  file: string,
  props: string | null,
): Promise<ServerIslandLoadResult> {
  const query = new URLSearchParams({
    [SERVER_ISLAND_QUERY_FILE]: file,
    [SERVER_ISLAND_QUERY_PATH]: location.pathname + location.search,
  });
  if (props) query.set(SERVER_ISLAND_QUERY_PROPS, props);
  try {
    const response = await fetch(`${withBase(PRACHT_SERVER_ISLAND_ENDPOINT)}?${query}`, {
      headers: { [SERVER_ISLAND_REQUEST_HEADER]: "1" },
    });
    // Only the endpoint's own fragment is swapped in. A static host that
    // answers unknown URLs with its SPA fallback document also says 200.
    if (response.status !== 200 || response.headers.get(SERVER_ISLAND_REQUEST_HEADER) !== "1") {
      return "empty";
    }
    element.innerHTML = await response.text();
    element.removeAttribute(SERVER_ISLAND_PENDING_ATTRIBUTE);
    const islandsEntryUrl = response.headers.get(SERVER_ISLAND_ISLANDS_HEADER);
    if (islandsEntryUrl) {
      // Load the islands bootstrap, or reuse the page's copy: a module runs
      // once per URL, so a second tag only fires `load`. A fresh bootstrap
      // hydrates every island it finds; one that already ran hears the event.
      // A script element rather than `import()` keeps the bundler's preload
      // helper out of the swap script.
      const script = document.createElement("script");
      script.type = "module";
      script.src = islandsEntryUrl;
      script.onload = () =>
        element.dispatchEvent(new Event(SERVER_ISLAND_SWAP_EVENT, { bubbles: true }));
      document.head.append(script);
    }
    return "loaded";
  } catch {
    return "failed";
  }
}

// Server island elements already fetched (or being fetched): a later pass, after
// a same-document navigation, only fetches elements that page brought in.
const fetched = new WeakSet<Element>();

/** Fill every pending server island on the page. */
export function swapServerIslands(): Promise<void> {
  const pending = [
    ...document.querySelectorAll(`${SERVER_ISLAND_ELEMENT}[${SERVER_ISLAND_PENDING_ATTRIBUTE}]`),
  ].filter((element) => !fetched.has(element));
  return Promise.all(
    pending.map((element) => {
      fetched.add(element);
      return loadServerIsland(
        element,
        element.getAttribute(SERVER_ISLAND_FILE_ATTRIBUTE)!,
        element.getAttribute(SERVER_ISLAND_PROPS_ATTRIBUTE),
      );
    }),
  ).then(() => {
    document.documentElement.setAttribute(SERVER_ISLANDS_READY_MARKER, "true");
  });
}

/**
 * The swap script's entry: fill the page's pending server islands, and again
 * after every same-document navigation, which can swap in a page with pending
 * server islands of its own without loading this module again, and whenever
 * an island first shows server islands it shipped in a `<template>`.
 */
export function startServerIslands(): void {
  const swap = () => void swapServerIslands();
  swap();
  (window as { navigation?: EventTarget }).navigation?.addEventListener("navigatesuccess", swap);
  // An island showing children it shipped in a <template> for the first time.
  document.addEventListener(SERVER_ISLAND_SCAN_EVENT, swap);
}
