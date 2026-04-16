import type { RouteParams } from "./types.ts";

export const SAFE_METHODS = new Set(["GET", "HEAD"]);
export const HYDRATION_STATE_ELEMENT_ID = "pracht-state";
export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";
export const ROUTE_STATE_CACHE_CONTROL = "no-store";
export const EMPTY_ROUTE_PARAMS = {} as RouteParams;
