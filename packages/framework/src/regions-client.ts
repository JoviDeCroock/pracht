import { withBase } from "./base.ts";
import {
  PRACHT_REGION_ENDPOINT,
  REGION_ELEMENT,
  REGION_FILE_ATTRIBUTE,
  REGION_ISLANDS_HEADER,
  REGION_PENDING_ATTRIBUTE,
  REGION_PROPS_ATTRIBUTE,
  REGION_QUERY_FILE,
  REGION_QUERY_PATH,
  REGION_QUERY_PROPS,
  REGION_REQUEST_HEADER,
  REGION_SWAP_EVENT,
  REGIONS_READY_MARKER,
} from "./regions-shared.ts";

/**
 * Browser half of request-time regions.
 *
 * - `swapRegions()` is the whole of `virtual:pracht/regions-client`, the swap
 *   script islands and `hydration: "none"` pages load when they rendered a
 *   pending region. It is the only JavaScript such a `"none"` page ships, so
 *   this module imports no Preact.
 * - `createClientRegion()` (`regions-component.ts`, its own package entry so
 *   the swap script never shares a chunk with it) is what a region module
 *   compiles to in the client bundle, so full-hydration pages never download
 *   a region's code or its loader.
 */

/**
 * How a region fetch ended:
 *
 * - `"loaded"` — the endpoint's fragment is in `element`;
 * - `"empty"` — the server answered without one (no region for this visitor,
 *   a failing loader, a route that does not render it): show the fallback;
 * - `"failed"` — the request never completed: keep whatever is on screen.
 */
export type RegionLoadResult = "loaded" | "empty" | "failed";

/**
 * Fetch one region's request-time HTML for the current page and swap it into
 * `element`. Anything but `"loaded"` leaves `element` untouched.
 */
export async function loadRegion(
  element: Element,
  file: string,
  props: string | null,
): Promise<RegionLoadResult> {
  const query = new URLSearchParams({
    [REGION_QUERY_FILE]: file,
    [REGION_QUERY_PATH]: location.pathname + location.search,
  });
  if (props) query.set(REGION_QUERY_PROPS, props);
  try {
    const response = await fetch(`${withBase(PRACHT_REGION_ENDPOINT)}?${query}`, {
      headers: { [REGION_REQUEST_HEADER]: "1" },
    });
    // Only the endpoint's own fragment is swapped in. A static host that
    // answers unknown URLs with its SPA fallback document also says 200.
    if (response.status !== 200 || response.headers.get(REGION_REQUEST_HEADER) !== "1") {
      return "empty";
    }
    element.innerHTML = await response.text();
    element.removeAttribute(REGION_PENDING_ATTRIBUTE);
    const islandsEntryUrl = response.headers.get(REGION_ISLANDS_HEADER);
    if (islandsEntryUrl) {
      // Load the islands bootstrap, or reuse the page's copy: a module runs
      // once per URL, so a second tag only fires `load`. A fresh bootstrap
      // hydrates every island it finds; one that already ran hears the event.
      // A script element rather than `import()` keeps the bundler's preload
      // helper out of the swap script.
      const script = document.createElement("script");
      script.type = "module";
      script.src = islandsEntryUrl;
      script.onload = () => element.dispatchEvent(new Event(REGION_SWAP_EVENT, { bubbles: true }));
      document.head.append(script);
    }
    return "loaded";
  } catch {
    return "failed";
  }
}

/** Fill every pending region on the page. */
export function swapRegions(): Promise<void> {
  const pending = [...document.querySelectorAll(`${REGION_ELEMENT}[${REGION_PENDING_ATTRIBUTE}]`)];
  return Promise.all(
    pending.map((element) =>
      loadRegion(
        element,
        element.getAttribute(REGION_FILE_ATTRIBUTE)!,
        element.getAttribute(REGION_PROPS_ATTRIBUTE),
      ),
    ),
  ).then(() => {
    document.documentElement.setAttribute(REGIONS_READY_MARKER, "true");
  });
}
