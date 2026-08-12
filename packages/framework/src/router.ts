import { installHydrationMismatchWarning } from "./hydration-mismatch.ts";
import { registerPrefetchTarget } from "./prefetch-api.ts";
import type { ModuleWarmFn } from "./prefetch-api.ts";
import type { ResolvedPrachtApp } from "./types.ts";
import type { PrachtHydrationState } from "./runtime-context.ts";
import { bootstrapInitialRoute } from "./router-bootstrap.ts";
import { createRouterHistoryController } from "./router-history.ts";
import { installRouterLinkInterceptor } from "./router-links.ts";
import { createClientNavigator, type InternalNavigateFn } from "./router-navigator.ts";
import { createClientRouteRenderer, type RouterModuleMap } from "./router-renderer.ts";

export { useNavigate } from "./router-navigation.ts";
export type { NavigateFn } from "./router-navigation.ts";

declare global {
  interface Window {
    __PRACHT_NAVIGATE__?: InternalNavigateFn;
    __PRACHT_ROUTER_READY__?: boolean;
  }
}

export interface InitClientRouterOptions {
  app: ResolvedPrachtApp;
  routeModules: RouterModuleMap;
  shellModules: RouterModuleMap;
  initialState: PrachtHydrationState;
  root: HTMLElement;
  findModuleKey: (modules: RouterModuleMap, file: string) => string | null;
}

export async function initClientRouter(options: InitClientRouterOptions): Promise<void> {
  const { app, routeModules, shellModules, root, findModuleKey } = options;

  if (import.meta.env?.DEV) {
    installHydrationMismatchWarning();
  }

  const historyController = createRouterHistoryController();
  let navigate: InternalNavigateFn;

  const renderer = createClientRouteRenderer({
    app,
    routeModules,
    shellModules,
    root,
    findModuleKey,
    getNavigate: () => navigate,
  });
  navigate = createClientNavigator({ app, history: historyController, renderer });

  await bootstrapInitialRoute({ app, initialState: options.initialState, renderer });

  installRouterLinkInterceptor({
    app,
    history: historyController,
    navigate: (url, navigationOptions) => {
      void navigate(url, navigationOptions);
    },
  });

  historyController.installPopstateHandler((url) => {
    void navigate(url, { _popstate: true });
  });

  window.__PRACHT_NAVIGATE__ = navigate;
  window.__PRACHT_ROUTER_READY__ = true;
  // Public hydration marker for test tooling: server-rendered pages look
  // interactive before the client router takes over, so tests (Playwright,
  // etc.) should wait for `html[data-pracht-hydrated]` before driving forms —
  // interacting earlier triggers native form submits instead of JS handlers.
  document.documentElement.setAttribute("data-pracht-hydrated", "true");

  historyController.restoreInitialScroll();

  const warmModules: ModuleWarmFn = renderer.warmModules;
  registerPrefetchTarget(app, warmModules);
  void import("./prefetch.ts").then(({ setupPrefetching }) => {
    setupPrefetching(app, warmModules);
  });
}
