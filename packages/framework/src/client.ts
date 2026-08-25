export { resolveApp } from "./app.ts";
export { initClientRouter } from "./router.ts";
export { readHydrationState } from "./runtime-context.ts";
// Dev-only, reached from the generated client entry's HMR listener. `import.meta.env.DEV`
// folds the call site away in a production build, taking this binding with it.
export { DEV_ROUTE_DATA_STALE_EVENT, refreshDevRouteData } from "./dev-route-refresh.ts";

export type { InitClientRouterOptions, NavigateFn } from "./router.ts";
export type { PrachtHydrationState } from "./runtime-context.ts";
