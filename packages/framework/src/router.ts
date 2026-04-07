import { createContext, h } from "preact";
import { hydrate, render } from "preact";
import { useContext } from "preact/hooks";
import type { VNode } from "preact";

import { matchAppRoute } from "./app.ts";
import { getCachedRouteState, setupPrefetching } from "./prefetch.ts";
import type { ResolvedPreviteApp, RouteMatch } from "./types.ts";
import { fetchPreviteRouteState, PreviteRuntimeProvider } from "./runtime.ts";
import type { SerializedRouteError, PreviteHydrationState } from "./runtime.ts";

declare global {
  interface Window {
    __PREVITE_NAVIGATE__?: NavigateFn;
    __PREVITE_ROUTER_READY__?: boolean;
  }
}

type ModuleMap = Record<string, () => Promise<any>>;

export type NavigateFn = (to: string, options?: { replace?: boolean }) => Promise<void>;

const NavigateContext = createContext<NavigateFn>(async () => {});

export function useNavigate(): NavigateFn {
  return useContext(NavigateContext);
}

export interface InitClientRouterOptions {
  app: ResolvedPreviteApp;
  routeModules: ModuleMap;
  shellModules: ModuleMap;
  initialState: PreviteHydrationState;
  root: HTMLElement;
  findModuleKey: (modules: ModuleMap, file: string) => string | null;
}

export async function initClientRouter(options: InitClientRouterOptions): Promise<void> {
  const { app, routeModules, shellModules, root, findModuleKey } = options;

  // ------------------------------------------------------------------
  // Build a Preact VNode tree for a matched route
  // ------------------------------------------------------------------

  async function buildRouteTree(
    match: RouteMatch,
    state: { data: unknown; error?: SerializedRouteError | null },
  ): Promise<VNode<any> | null> {
    const routeKey = findModuleKey(routeModules, match.route.file);
    if (!routeKey) return null;
    const routeMod = await routeModules[routeKey]();

    let Shell: any = null;
    if (match.route.shellFile) {
      const shellKey = findModuleKey(shellModules, match.route.shellFile);
      if (shellKey) {
        const shellMod = await shellModules[shellKey]();
        Shell = shellMod.Shell;
      }
    }

    const Component = (state.error ? routeMod.ErrorBoundary : routeMod.Component) as any;
    if (!Component) return null;

    const props: Record<string, unknown> = state.error
      ? { error: deserializeRouteError(state.error) }
      : { data: state.data, params: match.params };
    const componentTree = Shell ? h(Shell, null, h(Component, props)) : h(Component, props);

    return h(
      NavigateContext.Provider as any,
      { value: navigate },
      h(
        PreviteRuntimeProvider as any,
        {
          data: state.data,
          params: match.params,
          routeId: match.route.id ?? "",
          url: match.pathname,
        },
        componentTree,
      ),
    );
  }

  // ------------------------------------------------------------------
  // Navigate to a new pathname
  // ------------------------------------------------------------------

  async function navigate(
    to: string,
    opts?: { replace?: boolean; _popstate?: boolean },
  ): Promise<void> {
    const match = matchAppRoute(app, to);
    if (!match) {
      // No client route — fall back to full page load
      window.location.href = to;
      return;
    }

    // Check prefetch cache, then fetch route state from server
    let state: { data: unknown; error?: SerializedRouteError | null } = {
      data: undefined,
      error: null,
    };
    try {
      const result = await (getCachedRouteState(to) ?? fetchPreviteRouteState(to));
      if (result.type === "redirect") {
        if (result.location) {
          await navigate(result.location, opts);
          return;
        }
        window.location.href = to;
        return;
      }

      if (result.type === "error") {
        state = {
          data: undefined,
          error: result.error,
        };
      } else {
        state = {
          data: result.data,
          error: null,
        };
      }
    } catch {
      // Network error — full page load as fallback
      window.location.href = to;
      return;
    }

    // Update browser history
    if (!opts?._popstate) {
      if (opts?.replace) {
        history.replaceState(null, "", to);
      } else {
        history.pushState(null, "", to);
      }
    }

    // Render the new route
    const tree = await buildRouteTree(match, state);
    if (tree) {
      render(tree, root);
      window.scrollTo(0, 0);
    } else {
      window.location.href = to;
    }
  }

  // ------------------------------------------------------------------
  // Dev-mode hydration mismatch monitor (Preact options.__m hook)
  // ------------------------------------------------------------------

  if ((import.meta as any).env?.DEV) {
    const prev = (options as any).__m;
    (options as any).__m = (vnode: VNode, s: string) => {
      const component =
        typeof vnode.type === "function" ? vnode.type.displayName || vnode.type.name : vnode.type;
      const message = `Hydration mismatch in <${component || "Unknown"}>: ${s}`;
      console.warn(`[previte] ${message}`);
      appendHydrationWarning(message);
      if (prev) prev(vnode, s);
    };
  }

  // ------------------------------------------------------------------
  // Initial hydration — includes NavigateContext so useNavigate works
  // ------------------------------------------------------------------

  const initialMatch = matchAppRoute(app, options.initialState.url);
  if (initialMatch) {
    let state = {
      data: options.initialState.data,
      error: options.initialState.error ?? null,
    };

    if (initialMatch.route.render === "spa" && state.data == null && !state.error) {
      try {
        const result = await fetchPreviteRouteState(options.initialState.url);
        if (result.type === "redirect") {
          window.location.href = result.location;
          return;
        }

        if (result.type === "error") {
          state = {
            data: undefined,
            error: result.error,
          };
        } else {
          state = {
            data: result.data,
            error: null,
          };
        }
      } catch {
        window.location.href = options.initialState.url;
        return;
      }
    }

    const tree = await buildRouteTree(initialMatch, state);
    if (tree) {
      if (initialMatch.route.render === "spa") {
        render(tree, root);
      } else {
        hydrate(tree, root);
      }
    }
  }

  // ------------------------------------------------------------------
  // Global click interception for <a> elements
  // ------------------------------------------------------------------

  document.addEventListener("click", (e: MouseEvent) => {
    const anchor = (e.target as Element).closest?.("a");
    if (!anchor) return;

    // Skip modified clicks (new tab, etc.)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.defaultPrevented) return;
    if (e.button !== 0) return;

    // Skip if target opens a new window
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return;

    // Skip download links
    if (anchor.hasAttribute("download")) return;

    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;

    // Resolve relative URLs
    let url: URL;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return;
    }

    // Skip external origins
    if (url.origin !== window.location.origin) return;

    e.preventDefault();
    navigate(url.pathname + url.search);
  });

  // ------------------------------------------------------------------
  // Back / forward navigation
  // ------------------------------------------------------------------

  window.addEventListener("popstate", () => {
    navigate(window.location.pathname + window.location.search, {
      _popstate: true,
    });
  });

  window.__PREVITE_NAVIGATE__ = navigate;
  window.__PREVITE_ROUTER_READY__ = true;

  // Start prefetching after hydration is complete
  setupPrefetching(app);
}

// ---------------------------------------------------------------------------
// Dev-only: in-page hydration mismatch warning banner
// ---------------------------------------------------------------------------

const HYDRATION_BANNER_ID = "__previte_hydration_warnings__";

function appendHydrationWarning(message: string): void {
  let container = document.getElementById(HYDRATION_BANNER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = HYDRATION_BANNER_ID;
    Object.assign(container.style, {
      position: "fixed",
      bottom: "0",
      left: "0",
      right: "0",
      maxHeight: "30vh",
      overflow: "auto",
      background: "#2d1b00",
      borderTop: "2px solid #f0ad4e",
      color: "#ffc107",
      fontFamily: "ui-monospace, Consolas, monospace",
      fontSize: "13px",
      padding: "12px 16px",
      zIndex: "2147483647",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: "8px",
    });
    header.innerHTML = '<strong style="color:#f0ad4e">⚠ Hydration Mismatches</strong>';

    const close = document.createElement("button");
    close.textContent = "×";
    Object.assign(close.style, {
      background: "none",
      border: "none",
      color: "#f0ad4e",
      fontSize: "18px",
      cursor: "pointer",
    });
    close.onclick = () => container!.remove();
    header.appendChild(close);

    container.appendChild(header);
    document.body.appendChild(container);
  }

  const entry = document.createElement("div");
  entry.textContent = message;
  Object.assign(entry.style, { padding: "2px 0" });
  container.appendChild(entry);
}

function deserializeRouteError(error: SerializedRouteError): Error {
  const result = new Error(error.message);
  result.name = error.name;
  (result as Error & { status?: number }).status = error.status;
  return result;
}
