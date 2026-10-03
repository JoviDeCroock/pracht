import { render } from "preact";

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
 * Client-side navigation between islands pages
 * (`pracht({ client: { islandsNavigation: true } })`).
 *
 * Islands pages carry no client router, so by default every link between them
 * is a full document load. With this on, the islands bootstrap listens to the
 * Navigation API's `navigate` event, fetches the destination as ordinary HTML
 * (the same request a document load makes, so static hosts, ISG, and edge
 * caches serve it unchanged), and swaps it into the live document:
 *
 * - `<head>`: nodes equal to one already present stay where they are, new
 *   stylesheets are inserted and loaded before the swap, new scripts run, and
 *   nodes the server put there for the old page are removed.
 * - `#pracht-root`: replaced by the new page's content, except that an island
 *   present on both pages (same module, export, props, and strategy, matched
 *   by occurrence) keeps its live element, so its state survives.
 * - Islands that disappear are unmounted; new ones hydrate with their own
 *   `client` strategy.
 *
 * Anything the swap cannot reproduce faithfully is a full document load
 * instead: a full-hydration page (it carries hydration state or a client entry
 * this document never loaded), a non-HTML or failed response, a cross-origin
 * redirect, or a response with a nonce-based CSP (the current document's
 * policy stays in force, so the new nonces would be refused). Browsers without
 * the Navigation API keep plain document navigation.
 */

export interface IslandsNavigationOptions {
  /**
   * Hydrate the islands on the page that are not hydrated or scheduled yet,
   * then mark the document hydrated.
   */
  hydrate(): Promise<void>;
  /** Called with the incoming document once it has been swapped in. */
  onNavigate?: (doc: Document) => void;
}

/** `info` carried by the fallback navigation so the listener lets it through. */
const FULL_LOAD = "pracht:full-load";

/**
 * Nodes that came from server HTML, the only ones a swap may remove. Islands
 * and dev tooling also put nodes in `<head>` and `<body>` (injected CSS,
 * portals); those belong to their owners.
 */
const serverNodes = new WeakSet<Node>();

export function installIslandsNavigation(options: IslandsNavigationOptions): void {
  const navigation = (globalThis as { navigation?: Navigation }).navigation;
  if (!navigation) return;

  markServerNodes(document);
  const knownModuleScripts = new Set(moduleScriptUrls(document));

  // Which page's content each history entry shows. Entries created by the
  // app's own `history.pushState()` belong to the page that was showing, so
  // traversing between them stays the app's business; traversing to an entry
  // of another page swaps that page back in.
  const entryPages = new Map<string, number>();
  let pageCounter = 0;
  let shownPage = 0;
  let pendingEntryPage: number | undefined;
  const currentId = () => navigation.currentEntry?.id;
  const initialId = currentId();
  if (initialId) entryPages.set(initialId, shownPage);
  navigation.addEventListener("currententrychange", () => {
    const id = currentId();
    if (id && !entryPages.has(id)) entryPages.set(id, pendingEntryPage ?? shownPage);
    pendingEntryPage = undefined;
  });

  navigation.addEventListener("navigate", (event) => {
    if (
      !event.canIntercept ||
      event.hashChange ||
      event.downloadRequest !== null ||
      event.formData ||
      event.info === FULL_LOAD ||
      event.navigationType === "reload"
    ) {
      return;
    }

    let page: number;
    if (event.navigationType === "traverse") {
      const destinationPage = entryPages.get(event.destination.id);
      if (destinationPage === undefined || destinationPage === shownPage) return;
      page = destinationPage;
    } else {
      // `history.pushState()`/`replaceState()` are same-document navigations
      // the app makes on purpose; only real page loads are ours. A page the
      // browser has prerendered is faster to activate than to fetch again.
      if (event.destination.sameDocument || isPrerendered(event)) return;
      page = ++pageCounter;
      pendingEntryPage = page;
    }

    const url = new URL(event.destination.url);
    event.intercept({
      // Scrolled by hand with the swap below, not after the islands load.
      scroll: "manual",
      handler: async () => {
        const signal = event.signal;
        let incoming: IncomingPage | null = null;
        try {
          incoming = await fetchIslandsPage(url, event.navigationType, signal, knownModuleScripts);
        } catch (error) {
          if (!signal.aborted) fullLoad(navigation, url, error);
          return;
        }
        if (signal.aborted) return;
        if (!incoming) {
          fullLoad(navigation, url);
          return;
        }

        const swap = prepareSwap(incoming.doc);
        // A stylesheet that never answers must not hold an abandoned swap's
        // stylesheets in the page.
        await new Promise<void>((resolve) => {
          void swap.ready.then(resolve);
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal.aborted) {
          swap.cancel();
          return;
        }

        const commit = () => {
          if (signal.aborted) {
            swap.cancel();
            return;
          }
          swap.apply();
          shownPage = page;
          document.documentElement.removeAttribute(ISLANDS_HYDRATED_MARKER);
          // The browser restores a traversal's position and finds a fragment,
          // but leaves a new page without one wherever the old one was.
          if (event.navigationType !== "traverse" && !url.hash) scrollTo(0, 0);
          else event.scroll();
        };
        try {
          if (
            typeof document.startViewTransition === "function" &&
            document.querySelector("style[data-pracht-view-transitions]")
          ) {
            await document.startViewTransition(commit).updateCallbackDone;
          } else {
            commit();
          }
        } catch (error) {
          // A half-applied swap is worse than a reload.
          fullLoad(navigation, url, error);
          return;
        }
        if (signal.aborted || shownPage !== page) return;

        if (incoming.redirectedTo) {
          // The response came from a same-origin redirect (a static host adding
          // a trailing slash, say): show the address that served it once this
          // navigation has settled, since changing it now would abort it.
          const finalUrl = incoming.redirectedTo;
          setTimeout(() => {
            if (shownPage === page && location.href === url.href) {
              history.replaceState(history.state, "", finalUrl);
            }
          });
        }

        options.onNavigate?.(incoming.doc);
        void options.hydrate();
      },
    });
  });
}

interface IncomingPage {
  doc: Document;
  redirectedTo?: string;
}

/**
 * Fetch the destination and decide whether it can be swapped in. Returns null
 * when it must be a full document load instead.
 */
async function fetchIslandsPage(
  url: URL,
  navigationType: NavigationType,
  signal: AbortSignal,
  knownModuleScripts: Set<string>,
): Promise<IncomingPage | null> {
  const response = await fetch(url.href, {
    headers: { accept: "text/html" },
    // Back/forward should be as fast as the browser's own history cache.
    cache: navigationType === "traverse" ? "force-cache" : "default",
    signal,
  });
  const finalUrl = new URL(response.url || url.href);
  if (
    !response.ok ||
    finalUrl.origin !== location.origin ||
    !/^text\/html\b/i.test(response.headers.get("content-type") ?? "") ||
    /'nonce-/i.test(response.headers.get("content-security-policy") ?? "")
  ) {
    return null;
  }

  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  if (!canSwapDocument(doc, knownModuleScripts)) return null;

  const redirected = response.redirected && stripHash(finalUrl) !== stripHash(url);
  if (redirected) finalUrl.hash = url.hash;
  return { doc, redirectedTo: redirected ? finalUrl.href : undefined };
}

/**
 * Whether the destination matches one of the page's own `prerender`
 * speculation rules (`runtime-speculation.ts` writes them), so the browser has
 * a prerendered document to activate. Anchors the rule excludes have none.
 */
function isPrerendered(event: NavigateEvent): boolean {
  if (typeof URLPattern !== "function") return false;
  const source = (event as { sourceElement?: Element | null }).sourceElement;
  for (const script of document.querySelectorAll('script[type="speculationrules"]')) {
    try {
      for (const rule of JSON.parse(script.textContent!).prerender ?? []) {
        const [matches, excluded] = rule.where.and;
        if (excluded && source?.matches(excluded.not.selector_matches.join())) continue;
        for (const pattern of matches.href_matches) {
          if (new URLPattern(pattern, location.href).test(event.destination.url)) return true;
        }
      }
    } catch {
      // Not rules this module wrote.
    }
  }
  return false;
}

function stripHash(url: URL): string {
  return url.href.replace(/#.*$/, "");
}

/**
 * Whether `doc` is a page this document can become without a reload: a pracht
 * islands or `hydration: "none"` page whose module scripts this document has
 * already run (the same build's islands bootstrap, or none at all).
 */
export function canSwapDocument(doc: Document, knownModuleScripts: Set<string>): boolean {
  if (!doc.getElementById("pracht-root")) return false;
  // `HYDRATION_STATE_ELEMENT_ID`, spelled out: importing runtime-constants
  // splits a chunk shared with the client router out of both bundles.
  if (doc.getElementById("pracht-state")) return false;
  for (const src of moduleScriptUrls(doc)) {
    if (!knownModuleScripts.has(src)) return false;
  }
  return true;
}

function moduleScriptUrls(doc: Document): string[] {
  return [...doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map(
    (script) => new URL(script.getAttribute("src")!, location.href).href,
  );
}

function fullLoad(navigation: Navigation, url: URL, error?: unknown): void {
  if (error) console.error("[pracht] Islands navigation failed, loading the page instead:", error);
  // The soft navigation already committed the URL. Replace that entry with a
  // real load of it; a URL with a fragment would only scroll, so reload it.
  if (url.hash) {
    location.reload();
  } else {
    navigation.navigate(url.href, { history: "replace", info: FULL_LOAD });
  }
}

/** @internal Exported for tests; `installIslandsNavigation` calls it once. */
export function markServerNodes(doc: Document): void {
  for (const node of doc.head.childNodes) serverNodes.add(node);
  for (const node of doc.body.childNodes) serverNodes.add(node);
}

export interface PreparedSwap {
  /** Resolves once the incoming page's new stylesheets have loaded. */
  ready: Promise<void>;
  /** Swap the incoming page in. */
  apply(): void;
  /** Undo the stylesheets inserted ahead of an abandoned swap. */
  cancel(): void;
}

/**
 * Plan the swap of `incoming` into the live document. New stylesheets go in
 * right away (so they are loaded by the time the content appears); everything
 * else waits for `apply()`.
 */
export function prepareSwap(incoming: Document): PreparedSwap {
  const head = mergeChildren(document.head, incoming.head);
  const preloaded: Element[] = [];
  const loads: Promise<void>[] = [];
  for (const { node, before } of head.added) {
    if (node instanceof HTMLLinkElement && /(^|\s)stylesheet(\s|$)/i.test(node.rel)) {
      loads.push(
        new Promise<void>((resolve) => {
          node.addEventListener("load", () => resolve(), { once: true });
          node.addEventListener("error", () => resolve(), { once: true });
        }),
      );
      document.head.insertBefore(node, before);
      preloaded.push(node);
    }
  }

  let applied = false;
  return {
    ready: Promise.all(loads).then(() => {}),
    cancel() {
      if (applied) return;
      for (const node of preloaded) node.remove();
    },
    apply() {
      applied = true;
      head.apply(preloaded);

      const root = document.getElementById("pracht-root");
      const incomingRoot = incoming.getElementById("pracht-root");
      if (root && incomingRoot) {
        swapRoot(root, incomingRoot);
      }
      // Body content outside the root (trailing scripts) follows the head's
      // rules.
      mergeChildren(document.body, incoming.body, root).apply([]);

      const lang = incoming.documentElement.getAttribute("lang");
      if (lang === null) document.documentElement.removeAttribute("lang");
      else document.documentElement.setAttribute("lang", lang);
      document.title = incoming.title;
    },
  };
}

interface MergePlan {
  added: { node: Node; before: Node | null }[];
  apply(alreadyInserted: Node[]): void;
}

/**
 * Plan `live` becoming `incoming`'s child list: incoming nodes equal to a
 * live server node reuse it in place, the rest are inserted ahead of the next
 * reused node, and server nodes nothing reused are removed. `skip` (the
 * swapped root) is left alone.
 */
function mergeChildren(live: Element, incoming: Element, skip?: Element | null): MergePlan {
  const candidates = [...live.childNodes].filter(
    (node) => node !== skip && serverNodes.has(node) && !isWhitespace(node),
  );
  const reused = new Set<Node>();
  const order: { node: Node; isNew: boolean }[] = [];
  for (const node of incoming.childNodes) {
    if (isWhitespace(node)) continue;
    if (node instanceof Element && node.id === "pracht-root") continue;
    const match = candidates.find(
      (candidate) => !reused.has(candidate) && candidate.isEqualNode(node),
    );
    if (match) {
      reused.add(match);
      order.push({ node: match, isNew: false });
    } else {
      order.push({ node: adopt(node), isNew: true });
    }
  }

  // Each new node goes in front of the next reused node in incoming order;
  // with none after it, it goes where the old run of server nodes ended.
  const tail = candidates.length > 0 ? candidates[candidates.length - 1].nextSibling : null;
  const added: MergePlan["added"] = [];
  let before: Node | null = tail;
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = order[i];
    if (entry.isNew) added.unshift({ node: entry.node, before });
    else before = entry.node;
  }

  return {
    added,
    apply(alreadyInserted) {
      // Anchors are checked again: a node someone else owns may have left.
      const end = tail?.parentNode === live ? tail : null;
      for (const { node, before: anchor } of added) {
        if (alreadyInserted.includes(node as Element)) continue;
        live.insertBefore(node, anchor?.parentNode === live ? anchor : end);
      }
      for (const candidate of candidates) {
        if (!reused.has(candidate)) candidate.parentNode?.removeChild(candidate);
      }
      for (const { node } of added) serverNodes.add(node);
    },
  };
}

function isWhitespace(node: Node): boolean {
  return node.nodeType === 3 && !node.textContent?.trim();
}

/**
 * Bring a node from the parsed document into this one. Scripts are recreated:
 * a parser-inserted script moved between documents never runs.
 */
function adopt(node: Node): Node {
  const imported = document.importNode(node, true);
  if (imported instanceof Element) {
    const scripts =
      imported instanceof HTMLScriptElement ? [imported] : [...imported.querySelectorAll("script")];
    for (const script of scripts) {
      const fresh = document.createElement("script");
      for (const attribute of script.attributes)
        fresh.setAttribute(attribute.name, attribute.value);
      fresh.textContent = script.textContent;
      if (script === imported) return fresh;
      script.replaceWith(fresh);
    }
  }
  return imported;
}

/**
 * Replace the root's content with the incoming page's, keeping the live
 * element of every island the two pages share.
 */
function swapRoot(root: Element, incomingRoot: Element): void {
  const liveIslands = new Map<string, Element[]>();
  for (const island of root.querySelectorAll(ISLAND_ELEMENT)) {
    const key = islandKey(island);
    const list = liveIslands.get(key);
    if (list) list.push(island);
    else liveIslands.set(key, [island]);
  }

  const content = adopt(incomingRoot) as Element;
  const kept = new Set<Element>();
  for (const placeholder of content.querySelectorAll(ISLAND_ELEMENT)) {
    const live = liveIslands.get(islandKey(placeholder))?.shift();
    if (live) {
      kept.add(live);
      placeholder.replaceWith(live);
    }
  }

  for (const list of liveIslands.values()) {
    for (const island of list) {
      if (!kept.has(island) && island.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "true") {
        // Run effect cleanups before the element leaves the document.
        render(null, island);
      }
    }
  }

  root.replaceChildren(...content.childNodes);
}

function islandKey(island: Element): string {
  return [
    island.getAttribute(ISLAND_FILE_ATTRIBUTE),
    island.getAttribute(ISLAND_EXPORT_ATTRIBUTE) ?? "default",
    island.getAttribute(ISLAND_PROPS_ATTRIBUTE) ?? "",
    island.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load",
  ].join("\n");
}
