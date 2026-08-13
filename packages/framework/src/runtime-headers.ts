/**
 * Stable response-header facade. Primitive values, security defaults, cache
 * policy, route-state negotiation, and enhanced-form redirects live in
 * focused sibling modules.
 */

export { withEnhancedCapabilityFormRedirect } from "./runtime-capability-form-redirect.ts";
export { appendVaryHeader, applyHeaders, assertSafeHeaderValue } from "./runtime-header-values.ts";
export { preventHeuristicCaching } from "./runtime-response-cache.ts";
export {
  applyDefaultSecurityHeaders,
  isProtocolSwitchResponse,
  withDefaultSecurityHeaders,
} from "./runtime-response-security.ts";
export {
  applySecurityAndRouteHeaders,
  withRouteResponseHeaders,
} from "./runtime-route-response-headers.ts";
