/** Stable facade for runtime response and error-view helpers. */

export { renderApiErrorResponse } from "./runtime-api-error-response.ts";
export { getRenderToStringAsync } from "./runtime-rendering.ts";
export { renderRouteErrorResponse } from "./runtime-route-error-response.ts";
export type { RuntimeResponseOptions } from "./runtime-response-types.ts";
export {
  jsonErrorResponse,
  jsonRedirectResponse,
  normalizePageResponse,
} from "./runtime-route-state-response.ts";
