import { render } from "preact";

import {
  ISLAND_ELEMENT,
  ISLAND_EXPORT_ATTRIBUTE,
  ISLAND_FILE_ATTRIBUTE,
  ISLAND_HYDRATED_ATTRIBUTE,
  ISLAND_PROPS_ATTRIBUTE,
  ISLAND_SLOT_ELEMENT,
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
  p?: string;
  r?: string[];
}

/** `info` carried by the fallback navigation so the listener lets it through. */
const FULL_LOAD = "pracht:full-load";

/**
 * `info` key carrying a redirected response into the navigation that moves the
 * entry to the address that served it, so it is not requested twice.
 */
const REDIRECTED = "pracht:redirected";

/**
 * Document-level `<meta>` a swap cannot take back: a meta CSP stays in force
 * for the document's life, a refresh keeps its timer, a referrer policy
 * outlives its page. A document that has one never swaps, and a page that has
 * one is loaded.
 */
const DOCUMENT_META = 'meta[http-equiv]:not([http-equiv="content-type" i]),meta[name="referrer" i]';

/**
 * Request header asking a pracht server to answer a redirect with its target
 * (`CAPABILITY_FORM_REQUEST_HEADER`/`CAPABILITY_FORM_REDIRECT_HEADER`, spelled
 * out to keep the protocol module out of the bootstrap), so the browser loads
 * the target itself: following it in `fetch` would CORS-fail on another origin
 * and spend a one-time redirect.
 */
const REDIRECT_REQUEST_HEADER = "x-pracht-capability-form";
const REDIRECT_TARGET_HEADER = "x-pracht-capability-redirect";

/** Route table entries known not to answer with a swappable page this session. */
const SKIP_KEY = "pracht:nav-skip:";

const OWNED = `[${ISLANDS_NAVIGATION_OWNED_ATTRIBUTE}]`;

export function installIslandsNavigation(options: IslandsNavigationOptions): void {
  const navigation = (globalThis as { navigation?: Navigation }).navigation;
  const live = readNavigationData(document);
  const table = live?.r;
  // A framed document never swaps: a page that refuses to be framed must get
  // the chance to say so.
  if (
    !navigation ||
    !table ||
    window.top !== window ||
    document.querySelector(DOCUMENT_META) ||
    !parsesHtml()
  ) {
    return;
  }
  // Before any island hydrates: what the server put in their slots.
  for (const island of document.querySelectorAll(ISLAND_ELEMENT)) islandKey(island);

  // The document's policy — its security headers — never changes after it
  // loads, so every swapped-in page has to arrive with exactly the same ones.
  // Pages a pracht server rendered say which headers it set; for static output
  // the browser asks the host what it sends for this very page. A document the
  // HTTP cache answered arrived with headers the host may no longer send.
  let policy = live.p;
  if (policy === undefined) {
    const timing = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (!timing?.transferSize) return;
    fetch(location.href, { method: "HEAD", cache: "no-store" }).then(
      (response) => {
        if (response.ok) policy = policyFingerprint(response.headers);
      },
      () => {},
    );
  }

  const skipKey = SKIP_KEY + (live.p ?? "");
  let skipped: string[] = [];
  try {
    skipped = JSON.parse(sessionStorage.getItem(skipKey) ?? "[]");
  } catch {
    // No storage: every route keeps being tried.
  }
  const skip = (href: string) => {
    const entry = matchRoute(table, href);
    if (!entry || skipped.includes(entry)) return;
    skipped.push(entry);
    try {
      sessionStorage.setItem(skipKey, JSON.stringify(skipped));
    } catch {
      // Remembered for this document only.
    }
  };
  const swappable = (href: string) => {
    const entry = matchRoute(table, href);
    return entry?.[0] === "+" && !skipped.includes(entry);
  };

  const knownModuleScripts = new Set(scriptUrls(document, '[type="module"]'));
  // External classic scripts already run in this document never run again.
  const executed = new Set(scriptUrls(document));

  // Which page's content each history entry shows. Entries created by the
  // app's own `history.pushState()` belong to the page that was showing, so
  // traversing between them stays the app's business; traversing to an entry
  // of another page swaps that page back in.
  const entryPages = new Map<string, number>();
  // Where each page was scrolled when a swap left it, by entry key.
  const positions = new Map<string, [number, number]>();
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
    const traverse = event.navigationType === "traverse";
    let page: number;
    // A traversal to an entry whose page can only be loaded.
    let load = false;
    if (traverse) {
      const destinationPage = entryPages.get(event.destination.id);
      if (destinationPage === shownPage) return;
      if (destinationPage === undefined) {
        // An entry this document never showed — one an earlier document of
        // this tab made, before a reload. The browser treats it as part of
        // this document and would change only the address, so its page is
        // fetched like any other, or loaded where it cannot be swapped.
        if (!event.destination.sameDocument) return;
        page = ++pageCounter;
        pendingEntryPage = page;
        load = policy === undefined || !swappable(event.destination.url);
      } else {
        page = destinationPage;
      }
    } else {
      // `history.pushState()`/`replaceState()` are same-document navigations
      // the app makes on purpose; only real page loads are ours. A page the
      // browser has prerendered is faster to activate than to fetch again.
      if (
        policy === undefined ||
        event.destination.sameDocument ||
        (!redirected && (!swappable(event.destination.url) || isPrerendered(event)))
      ) {
        return;
      }
      page = ++pageCounter;
      pendingEntryPage = page;
    }

    const url = new URL(event.destination.url);
    const leaving = navigation.currentEntry?.key;
    const signal = event.signal;
    const state = event.destination.getState();
    // Where supported, the address commits only once the page is known to be
    // swappable, so a fallback (a download, say) never leaves the wrong one
    // behind. Elsewhere the committed address is put back first.
    const precommit = !traverse && "NavigationPrecommitController" in globalThis;
    const previous = navigation.currentEntry?.url;
    let committed = false;
    // Before the address commits, a fallback takes the navigation's own place
    // in history; after, it replaces the entry the navigation made.
    const historyMode = () =>
      precommit && !committed && event.navigationType === "push" ? "push" : "replace";
    const fallBack = (to: URL, error?: unknown) => {
      if (signal.aborted) return;
      pendingEntryPage = undefined;
      if (error) {
        console.error("[pracht] Islands navigation failed, loading the page instead:", error);
      }
      if (!precommit && !traverse && !committed && previous) {
        history.replaceState(history.state, "", previous);
      }
      navigation.navigate(to.href, { history: historyMode(), info: FULL_LOAD, state });
    };

    // Fetch and decide; undefined once it has fallen back or been abandoned.
    const decide = async () => {
      if (load) {
        fallBack(url);
        return;
      }
      let incoming: Document | null | false;
      try {
        const response =
          redirected ??
          (await fetch(url.href, {
            // Back/forward should be as fast as the browser's own history cache.
            cache: traverse ? "force-cache" : "default",
            headers: { [REDIRECT_REQUEST_HEADER]: "1" },
            signal,
          }));
        // A pracht server names a redirect's target; other hosts' redirects
        // (a static host's trailing slash) are followed.
        const target = response.headers.get(REDIRECT_TARGET_HEADER);
        const servedFrom = new URL(target ?? (response.url || url.href), url.href);
        if (target === null || !servedFrom.hash) servedFrom.hash = url.hash;
        if (target !== null) {
          // Never fetched here: an islands page there is a navigation of its
          // own, anything else is loaded. A redirect back to this address, or
          // to a scheme no redirect may take, gets the browser's own answer.
          if (servedFrom.href === url.href || !/^https?:$/.test(servedFrom.protocol)) {
            fallBack(url);
          } else if (servedFrom.origin === location.origin && swappable(servedFrom.href)) {
            if (!signal.aborted) {
              navigation.navigate(servedFrom.href, { history: historyMode(), state });
            }
          } else {
            fallBack(servedFrom);
          }
          return;
        }
        if (servedFrom.href !== url.href) {
          // A redirect. Only the address that served the page may show it —
          // relative URLs in it resolve against that one — and requesting the
          // original again could replay what the redirect consumed.
          if (servedFrom.origin === location.origin && swappable(servedFrom.href)) {
            // Read the body first: it streams under this navigation's signal,
            // which the next navigation aborts.
            const body = await response.text();
            if (!signal.aborted) {
              navigation.navigate(servedFrom.href, {
                history: historyMode(),
                info: { [REDIRECTED]: new Response(body, response) },
                state,
              });
            }
          } else {
            fallBack(servedFrom);
          }
          return;
        }
        incoming = await readIslandsPage(response, policy!, live.p, knownModuleScripts);
      } catch (error) {
        fallBack(url, error);
        return;
      }
      if (signal.aborted) return;
      // Answered with another policy, or with something that is not a page
      // that takes part: do not fetch that route again this session.
      if (incoming === false) skip(url.href);
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
      return { incoming: incoming as Document, swap };
    };

    const finish = async (decision: Awaited<ReturnType<typeof decide>>) => {
      if (!decision || signal.aborted) return;
      committed = true;
      const { incoming, swap } = decision;
      const commit = () => {
        if (signal.aborted) {
          swap.cancel();
          return;
        }
        const focused = document.activeElement;
        if (leaving) positions.set(leaving, [scrollX, scrollY]);
        swap.apply();
        shownPage = page;
        document.documentElement.removeAttribute(ISLANDS_HYDRATED_MARKER);
        // The browser restores a traversal's position and finds a fragment,
        // but leaves a new page without one wherever the old one was.
        if (!traverse && !url.hash) scrollTo(0, 0);
        else event.scroll();
        // Not every browser restores a swapped page's position itself.
        const saved = traverse ? positions.get(event.destination.key) : undefined;
        if (saved && (scrollX !== saved[0] || scrollY !== saved[1])) scrollTo(saved[0], saved[1]);
        settleFocus(focused);
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

      options.onNavigate?.(incoming);
      void options.hydrate();
    };

    if (precommit) {
      let decision: Awaited<ReturnType<typeof decide>>;
      event.intercept({
        scroll: "manual",
        focusReset: "manual",
        precommitHandler: async () => {
          decision = await decide();
        },
        handler: () => finish(decision),
      } as NavigationInterceptOptions);
    } else {
      // Scrolled and focused by hand with the swap, not after the islands
      // load: the browser's own focus reset would take focus out of an island
      // the swap carried over.
      event.intercept({
        scroll: "manual",
        focusReset: "manual",
        handler: async () => finish(await decide()),
      });
    }
  });
}

/**
 * Focus after a swap. Focus inside an island the swap carried over stays
 * there (put back where the browser has no `moveBefore()`), and focus the page
 * moved itself is left alone. Otherwise focus starts over the way the
 * Navigation API resets it after a navigation: on the page's `autofocus`
 * element, else on the body, so the next Tab starts at the top of the new page.
 */
export function settleFocus(focused: Element | null): void {
  const active = document.activeElement;
  const body = document.body;
  if (active && active !== body && (active !== focused || active.closest(ISLAND_ELEMENT))) return;
  if (focused !== active && focused?.isConnected && focused.closest(ISLAND_ELEMENT)) {
    (focused as HTMLElement).focus?.({ preventScroll: true });
    if (document.activeElement === focused) return;
  }
  const autofocus = document.querySelector<HTMLElement>("[autofocus]");
  autofocus?.focus({ preventScroll: true });
  if (!body || (autofocus && document.activeElement === autofocus)) return;
  // The body takes focus only while it has a tabindex; focusing it for that
  // instant moves the sequential focus starting point to the top.
  const tabindex = body.getAttribute("tabindex");
  if (tabindex === null) body.tabIndex = -1;
  body.focus({ preventScroll: true });
  if (tabindex === null) body.removeAttribute("tabindex");
}

/**
 * A Trusted Types policy that refuses string HTML makes every fetched page
 * unparseable; such a document keeps plain navigation.
 */
function parsesHtml(): boolean {
  try {
    new DOMParser().parseFromString("", "text/html");
    return true;
  } catch {
    return false;
  }
}

function readNavigationData(doc: Document): NavigationData | null {
  try {
    return JSON.parse(doc.getElementById(ISLANDS_NAVIGATION_DATA_ID)!.textContent!);
  } catch {
    return null;
  }
}

/**
 * The route table entry the server would answer `href` with, matched the way
 * the server matches: first match wins, statics compare raw, a parameter takes
 * one decodable segment, a catch-all the rest. Undefined for a URL outside the
 * app (another origin, outside the deploy base) or one no entry matches.
 */
export function matchRoute(table: readonly string[], href: string): string | undefined {
  const { origin, pathname } = new URL(href);
  const path = routePath(pathname);
  if (origin !== location.origin || path === null) return undefined;
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
        break;
      }
      const part = target[i];
      if (part === undefined || (segment[0] === ":" ? !decodes(part) : segment !== part)) {
        matched = false;
        break;
      }
    }
    if (matched && (segments.length === target.length || entry.endsWith("*"))) return entry;
  }
  return undefined;
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
    // The result is compared, not discarded: a minifier drops a call to a
    // built-in whose result is unused, and with it the throw this relies on.
    return decodeURIComponent(segment) !== "\0";
  } catch {
    return false;
  }
}

/**
 * Decide on a fetched response. Null means a full load; false means a full
 * load and that the route answers with another policy or with a page that
 * does not take part, so it is not worth fetching again this session.
 */
async function readIslandsPage(
  response: Response,
  policy: string,
  serverPolicy: string | undefined,
  knownModuleScripts: Set<string>,
): Promise<Document | null | false> {
  if (!/^text\/html\b/i.test(response.headers.get("content-type") ?? "")) return null;
  // The headers decide before the body is read: they must be exactly the ones
  // this document was loaded with.
  if (policyFingerprint(response.headers) !== policy) {
    response.body?.cancel().catch(() => {});
    return false;
  }
  const doc = new DOMParser().parseFromString(await response.text(), "text/html");
  // And the server must have meant the same policy for it (a page with a
  // nonce-based CSP carries no data at all).
  const data = readNavigationData(doc);
  if (!data || data.p !== serverPolicy) return false;
  if (doc.querySelector(DOCUMENT_META) || !canSwapDocument(doc, knownModuleScripts)) return null;
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
 * where the browser has it, which keeps an iframe loaded and scroll
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
  // An island inside a kept one moved with it and stays where it is.
  const insideKept = (island: Element) => {
    for (const element of kept) if (element.contains(island)) return true;
    return false;
  };
  for (const placeholder of placeholders) {
    // Server markup nested in a placeholder a kept island already replaced
    // left the document with it.
    if (!placeholder.isConnected) continue;
    const list = liveIslands.get(islandKey(placeholder));
    const index = list?.findIndex((island) => !insideKept(island)) ?? -1;
    if (index === -1) continue;
    const [live] = list!.splice(index, 1);
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
      if (!insideKept(island) && island.getAttribute(ISLAND_HYDRATED_ATTRIBUTE) === "true") {
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

/**
 * The server HTML of each island's slots (the children its page passed in),
 * recorded before the island hydrates: afterwards the island may have hidden
 * them, and islands among them change their own markup.
 */
const slotContent = new WeakMap<Element, string>();

function islandKey(island: Element): string {
  let slots = slotContent.get(island);
  if (slots === undefined) {
    slots = [...island.querySelectorAll(`${ISLAND_SLOT_ELEMENT},[${ISLAND_SLOT_ELEMENT}]`)]
      .filter((slot) => slot.parentElement!.closest(ISLAND_ELEMENT) === island)
      .map((slot) => slot.innerHTML)
      .join("\n");
    slotContent.set(island, slots);
  }
  // An island whose page passes it other children is another island.
  return [
    island.getAttribute(ISLAND_FILE_ATTRIBUTE),
    island.getAttribute(ISLAND_EXPORT_ATTRIBUTE) ?? "default",
    island.getAttribute(ISLAND_PROPS_ATTRIBUTE) ?? "",
    island.getAttribute(ISLAND_STRATEGY_ATTRIBUTE) ?? "load",
    slots,
  ].join("\n");
}
