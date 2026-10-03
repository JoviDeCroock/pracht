import { render } from "preact";

import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_STRATEGY_ATTRIBUTE,
  ISLANDS_HYDRATED_MARKER,
  ISLANDS_NAVIGATION_DATA_ID,
  ISLANDS_NAVIGATION_OWNED_ATTRIBUTE,
  policyFingerprint,
} from "./islands-shared.ts";

/**
 * Client-side navigation between islands pages
 * (`pracht({ client: { islandsNavigation: true } })`). See docs/ISLANDS.md.
 *
 * Islands pages carry no client router, so by default every link between them
 * is a full document load. With this on, the islands bootstrap listens to the
 * Navigation API's `navigate` event and, for a destination the server's route
 * table says is an `islands` or `none` page, fetches it as ordinary HTML and
 * swaps it into the live document. Everything else is never fetched: the
 * browser loads it as usual.
 *
 * A fetched page is only swapped in when it is one this document can become
 * faithfully: same build, same document policy (the security headers the
 * document was loaded with stay in force, so they must match), no meta CSP.
 * Otherwise it is a full load of the address that served it.
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

/** What `ISLANDS_NAVIGATION_DATA_ID` holds; see islands-shared.ts. */
interface NavigationData {
  p: string;
  r: string[];
}

/** `info` carried by the fallback navigation so the listener lets it through. */
const FULL_LOAD = "pracht:full-load";

/**
 * `info` key carrying a redirected response into the navigation that moves the
 * entry to the address that served it, so it is not requested twice.
 */
const REDIRECTED = "pracht:redirected";

const META_CSP = 'meta[http-equiv="content-security-policy" i]';
const HOST_POLICY_KEY = "pracht:host-policy";

function hostChangesPolicy(policy: string): boolean {
  try {
    return sessionStorage.getItem(HOST_POLICY_KEY) === policy;
  } catch {
    return false;
  }
}
const OWNED = `[${ISLANDS_NAVIGATION_OWNED_ATTRIBUTE}]`;

export function installIslandsNavigation(options: IslandsNavigationOptions): void {
  const navigation = (globalThis as { navigation?: Navigation }).navigation;
  const live = readNavigationData(document);
  // The document's policy never changes after it loads, so it is the policy
  // every swapped-in page has to match. A framed document never swaps: a page
  // that refuses to be framed must get the chance to say so. A meta CSP stays
  // in force for the life of the document, whatever page it shows.
  if (
    !navigation ||
    !live ||
    window.top !== window ||
    document.querySelector(META_CSP) ||
    hostChangesPolicy(live.p)
  ) {
    return;
  }

  const knownModuleScripts = new Set(scriptUrls(document, '[type="module"]'));
  // External classic scripts already run in this document never run again.
  const executed = new Set(scriptUrls(document));

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

  // `<a data-pracht-reload>` always loads a new document.
  let reloadHref: string | undefined;
  addEventListener(
    "click",
    (event) => {
      reloadHref = (event.target as Element).closest?.<HTMLAnchorElement>(
        "a[data-pracht-reload]",
      )?.href;
    },
    true,
  );

  navigation.addEventListener("navigate", (event) => {
    const reload = reloadHref === event.destination.url;
    reloadHref = undefined;
    if (
      !event.canIntercept ||
      event.hashChange ||
      event.downloadRequest !== null ||
      event.formData ||
      event.info === FULL_LOAD ||
      event.navigationType === "reload" ||
      reload
    ) {
      return;
    }

    const redirected = (event.info as { [REDIRECTED]?: Response } | undefined)?.[REDIRECTED];
    let page: number;
    if (event.navigationType === "traverse") {
      const destinationPage = entryPages.get(event.destination.id);
      if (destinationPage === undefined || destinationPage === shownPage) return;
      page = destinationPage;
    } else {
      // `history.pushState()`/`replaceState()` are same-document navigations
      // the app makes on purpose; only real page loads are ours. A page the
      // browser has prerendered is faster to activate than to fetch again.
      if (
        event.destination.sameDocument ||
        (!redirected && (!isSwappableRoute(live.r, event.destination.url) || isPrerendered(event)))
      ) {
        return;
      }
      page = ++pageCounter;
      pendingEntryPage = page;
    }

    const url = new URL(event.destination.url);
    event.intercept({
      // Scrolled by hand with the swap below, not after the islands load.
      scroll: "manual",
      handler: async () => {
        const signal = event.signal;
        const state = event.destination.getState();
        const fallBack = (to: URL, error?: unknown) => {
          if (!signal.aborted) fullLoad(navigation, to, state, error);
        };

        let incoming: Document | null | false;
        try {
          const response =
            redirected ??
            (await fetch(url.href, {
              // Back/forward should be as fast as the browser's own history cache.
              cache: event.navigationType === "traverse" ? "force-cache" : "default",
              signal,
            }));
          const servedFrom = new URL(response.url || url.href);
          servedFrom.hash = url.hash;
          if (servedFrom.href !== url.href) {
            // A redirect. Only the address that served the page may show it —
            // relative URLs in it resolve against that one — and requesting the
            // original again could replay what the redirect consumed.
            if (
              servedFrom.origin === location.origin &&
              isSwappableRoute(live.r, servedFrom.href)
            ) {
              // Read the body first: it streams under this navigation's
              // signal, which the next navigation aborts.
              const body = await response.text();
              if (signal.aborted) return;
              navigation.navigate(servedFrom.href, {
                history: "replace",
                info: { [REDIRECTED]: new Response(body, response) },
                state,
              });
            } else {
              fallBack(servedFrom);
            }
            return;
          }
          incoming = await readIslandsPage(response, live.p, knownModuleScripts);
        } catch (error) {
          fallBack(url, error);
          return;
        }
        if (signal.aborted) return;
        if (incoming === false) {
          // Every page here would be fetched only to be loaded: stop for the
          // rest of the tab's session, until the policy changes.
          try {
            sessionStorage.setItem(HOST_POLICY_KEY, live.p);
          } catch {
            // No storage: keep trying, one extra request per link.
          }
        }
        const swap = incoming && prepareSwap(incoming);
        if (!swap) {
          fallBack(url);
          return;
        }

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
            const transition = document.startViewTransition(commit);
            // A newer navigation's transition skips this one; that is not an error.
            transition.ready.catch(() => {});
            await transition.updateCallbackDone;
          } else {
            commit();
          }
          if (signal.aborted || shownPage !== page) return;
          await swap.runScripts(executed, signal);
        } catch (error) {
          // A half-applied swap is worse than a reload.
          fallBack(url, error);
          return;
        }
        if (signal.aborted) return;

        options.onNavigate?.(incoming as Document);
        void options.hydrate();
      },
    });
  });
}

function readNavigationData(doc: Document): NavigationData | null {
  try {
    return JSON.parse(doc.getElementById(ISLANDS_NAVIGATION_DATA_ID)!.textContent!);
  } catch {
    return null;
  }
}

/**
 * Whether the server would answer `href` with an `islands` or `none` page,
 * matched against its route table the way the server matches: first match
 * wins, statics compare raw, a parameter takes one segment, a catch-all the
 * rest. A URL outside the deploy base is not this app's.
 */
export function isSwappableRoute(table: readonly string[], href: string): boolean {
  const { origin, pathname } = new URL(href);
  const path = routePath(pathname);
  if (origin !== location.origin || path === null) return false;
  const target = path
    .replace(/\/{2,}/g, "/")
    .split("/")
    .filter(Boolean);
  for (const entry of table) {
    const segments = entry.slice(1).split("/").filter(Boolean);
    let matched = true;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === "*" || (segment[0] === ":" && segment.endsWith("*"))) {
        matched = target.slice(i).every(decodes);
        i = segments.length;
        break;
      }
      const part = target[i];
      if (part === undefined || (segment[0] === ":" ? !decodes(part) : segment !== part)) {
        matched = false;
        break;
      }
    }
    if (matched && (segments.length === target.length || entry.endsWith("*"))) {
      return entry[0] === "+";
    }
  }
  return false;
}

/**
 * URL path → route path, or null outside the deploy base: `stripBase()` from
 * base.ts, spelled out because importing it splits a chunk shared with the
 * client router out of both bundles.
 */
function routePath(pathname: string): string | null {
  const raw: unknown = import.meta.env?.BASE_URL;
  const base =
    typeof raw !== "string" || /^\.?\/?$|:\/\/|^\/\//.test(raw)
      ? "/"
      : `/${raw.replace(/^\/|\/$/g, "")}/`;
  if (pathname.startsWith(base)) return pathname.slice(base.length - 1);
  return `${pathname}/` === base ? "/" : null;
}

function decodes(segment: string): boolean {
  try {
    decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a fetched response and decide whether it can be swapped in. Null means
 * a full load instead; false means the host rewrites policy headers, so no page
 * here can be proven to match and none should be fetched again.
 */
async function readIslandsPage(
  response: Response,
  policy: string,
  knownModuleScripts: Set<string>,
): Promise<Document | null | false> {
  if (!/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return null;
  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  const data = readNavigationData(doc);
  if (!data || data.p !== policy) return null;
  // The page's own fingerprint must match what actually arrived: something
  // between the server and the browser (a static host, a CDN, a proxy) that
  // sets or drops policy headers makes the document's real policy unknowable.
  if (policyFingerprint(response.headers) !== policy) return false;
  if (doc.querySelector(META_CSP) || !canSwapDocument(doc, knownModuleScripts)) {
    return null;
  }
  // The parser ran with scripting disabled, which turns `<noscript>` content
  // into live elements. With scripting on it is text.
  for (const noscript of doc.querySelectorAll("noscript")) {
    noscript.replaceChildren(noscript.innerHTML);
  }
  return doc;
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
  for (const src of scriptUrls(doc, '[type="module"]')) {
    if (!knownModuleScripts.has(src)) return false;
  }
  return true;
}

function scriptUrls(doc: Document, filter = ""): string[] {
  return [...doc.querySelectorAll<HTMLScriptElement>(`script[src]${filter}`)].map(
    (script) => new URL(script.getAttribute("src")!, location.href).href,
  );
}

function fullLoad(navigation: Navigation, url: URL, state: unknown, error?: unknown): void {
  if (error) console.error("[pracht] Islands navigation failed, loading the page instead:", error);
  // The soft navigation already committed its URL. Replace that entry with a
  // real load; one that differs from the current URL only by its fragment
  // would just scroll, so reload it instead.
  if (url.hash && url.href.split("#")[0] === location.href.split("#")[0]) {
    location.reload();
  } else {
    navigation.navigate(url.href, { history: "replace", info: FULL_LOAD, state });
  }
}

export interface PreparedSwap {
  /** Resolves once the incoming page's new stylesheets have loaded. */
  ready: Promise<void>;
  /** Swap the incoming page in. */
  apply(): void;
  /**
   * Run the incoming page's scripts in document order, each external one
   * loaded before the next starts, skipping external scripts `executed`
   * already holds.
   */
  runScripts(executed: Set<string>, signal?: AbortSignal): Promise<void>;
  /** Undo the stylesheets inserted ahead of an abandoned swap. */
  cancel(): void;
}

/**
 * Plan the swap of `incoming` into the live document, or null when its
 * stylesheets would cascade differently from a full load. New stylesheets go
 * in right away, disabled through `media`, so they are loaded by the time the
 * content appears without restyling the old page meanwhile; everything else
 * waits for `apply()`.
 */
export function prepareSwap(incoming: Document): PreparedSwap | null {
  const head = mergeHead(document.head, incoming.head);
  if (!head) return null;
  const preloaded: [HTMLLinkElement, string | null][] = [];
  const loads: Promise<void>[] = [];
  for (const { node, before } of head.added) {
    if (node instanceof HTMLLinkElement && /(^|\s)stylesheet(\s|$)/i.test(node.rel)) {
      preloaded.push([node, node.getAttribute("media")]);
      node.media = "not all";
      loads.push(
        new Promise<void>((resolve) => {
          node.addEventListener("load", () => resolve(), { once: true });
          node.addEventListener("error", () => resolve(), { once: true });
        }),
      );
      document.head.insertBefore(node, before);
    }
  }

  let applied = false;
  let scripts: Element[] = [];
  return {
    ready: Promise.all(loads).then(() => {}),
    cancel() {
      if (applied) return;
      for (const [node] of preloaded) node.remove();
    },
    apply() {
      applied = true;
      head.apply(preloaded.map(([node]) => node));
      for (const [node, media] of preloaded) {
        if (media === null) node.removeAttribute("media");
        else node.media = media;
      }

      const root = document.getElementById("pracht-root");
      const incomingRoot = incoming.getElementById("pracht-root");
      scripts = head.added.flatMap(({ node }) => (node instanceof HTMLScriptElement ? [node] : []));
      if (root && incomingRoot) scripts.push(...swapRoot(root, incomingRoot));

      const lang = incoming.documentElement.getAttribute("lang");
      if (lang === null) document.documentElement.removeAttribute("lang");
      else document.documentElement.setAttribute("lang", lang);
      document.title = incoming.title;
    },
    async runScripts(executed, signal) {
      for (const inert of scripts) {
        if (signal?.aborted) return;
        if (!inert.isConnected) continue;
        const src = inert.getAttribute("src");
        const url = src === null ? null : new URL(src, location.href).href;
        if (url !== null && executed.has(url)) continue;
        // Moved over from the parsed document, the script is marked as
        // already started and never runs; a fresh one does.
        const fresh = document.createElement("script");
        for (const attribute of inert.attributes)
          fresh.setAttribute(attribute.name, attribute.value);
        fresh.textContent = inert.textContent;
        let loaded: Promise<unknown> | undefined;
        if (url !== null) {
          executed.add(url);
          if (!fresh.hasAttribute("async") && !fresh.hasAttribute("defer")) {
            fresh.async = false;
            loaded = new Promise((resolve) => {
              fresh.addEventListener("load", resolve, { once: true });
              fresh.addEventListener("error", resolve, { once: true });
            });
          }
        }
        inert.replaceWith(fresh);
        await loaded;
      }
    },
  };
}

interface HeadPlan {
  added: { node: Node; before: Node | null }[];
  apply(alreadyInserted: Node[]): void;
}

/**
 * Plan the live head becoming the incoming one. Only server-owned nodes take
 * part: an incoming node equal to a live one reuses it in place, the rest are
 * inserted ahead of the next reused node, and owned nodes nothing reused are
 * removed. Null when two stylesheets both pages share are in a different
 * order, since moving them would reload them.
 */
function mergeHead(live: HTMLHeadElement, incoming: HTMLHeadElement): HeadPlan | null {
  const candidates = [...live.querySelectorAll(`:scope > ${OWNED}`)];
  const reused = new Set<Node>();
  const order: { node: Node; isNew: boolean }[] = [];
  let lastStyle = -1;
  for (const node of incoming.querySelectorAll(`:scope > ${OWNED}`)) {
    const index = candidates.findIndex(
      (candidate) => !reused.has(candidate) && candidate.isEqualNode(node),
    );
    if (index === -1) {
      order.push({ node: document.importNode(node, true), isNew: true });
      continue;
    }
    const match = candidates[index];
    if (match.matches('style, link[rel~="stylesheet" i]')) {
      if (index < lastStyle) return null;
      lastStyle = index;
    }
    reused.add(match);
    order.push({ node: match, isNew: false });
  }

  // Each new node goes in front of the next reused node in incoming order;
  // with none after it, it goes where the owned nodes ended.
  const tail = candidates.length > 0 ? candidates[candidates.length - 1].nextSibling : null;
  const added: HeadPlan["added"] = [];
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
        if (alreadyInserted.includes(node)) continue;
        live.insertBefore(node, anchor?.parentNode === live ? anchor : end);
      }
      for (const candidate of candidates) {
        if (!reused.has(candidate)) candidate.remove();
      }
    },
  };
}

/**
 * Replace the root's content with the incoming page's, keeping the live
 * element of every island the two pages share. The new content goes in first
 * so a kept island moves between two connected places — with `moveBefore()`
 * where the browser has it, which keeps an iframe loaded, focus, and scroll
 * positions inside the island. Returns the new content's scripts, still inert.
 */
function swapRoot(root: Element, incomingRoot: Element): Element[] {
  const liveIslands = new Map<string, Element[]>();
  for (const island of root.querySelectorAll(ISLAND_ELEMENT)) {
    const key = islandKey(island);
    const list = liveIslands.get(key);
    if (list) list.push(island);
    else liveIslands.set(key, [island]);
  }

  const content = document.importNode(incomingRoot, true);
  const placeholders = content.querySelectorAll(ISLAND_ELEMENT);
  const scripts = content.querySelectorAll("script");
  const previous = [...root.childNodes];
  root.append(...content.childNodes);

  const kept = new Set<Element>();
  for (const placeholder of placeholders) {
    const live = liveIslands.get(islandKey(placeholder))?.shift();
    if (!live) continue;
    kept.add(live);
    const parent = placeholder.parentNode as Element & {
      moveBefore?: (node: Node, child: Node | null) => void;
    };
    try {
      parent.moveBefore!(live, placeholder);
    } catch {
      parent.insertBefore(live, placeholder);
    }
    placeholder.remove();
  }

  for (const list of liveIslands.values()) {
    for (const island of list) {
      if (!kept.has(island) && island.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "true") {
        // Run effect cleanups before the element leaves the document.
        render(null, island);
      }
    }
  }
  for (const node of previous) {
    if (!kept.has(node as Element)) node.parentNode?.removeChild(node);
  }
  return [...scripts].filter((script) => script.isConnected);
}

function islandKey(island: Element): string {
  return [
    island.getAttribute(ISLAND_FILE_ATTRIBUTE),
    island.getAttribute(ISLAND_EXPORT_ATTRIBUTE) ?? "default",
    island.getAttribute(ISLAND_PROPS_ATTRIBUTE) ?? "",
    island.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load",
  ].join("\n");
}
