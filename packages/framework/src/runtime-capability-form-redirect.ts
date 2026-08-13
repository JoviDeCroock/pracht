import {
  CAPABILITY_FORM_REDIRECT_HEADER,
  CAPABILITY_FORM_REQUEST_HEADER,
} from "@pracht/capabilities";

import { appendVaryHeader } from "./runtime-header-values.ts";

/**
 * Keep enhanced capability-form redirects inside the original same-origin
 * fetch. The client performs navigation after reading the target, so an
 * external login page is never fetched through CORS.
 */
export function withEnhancedCapabilityFormRedirect(response: Response, request: Request): Response {
  if (request.headers.get(CAPABILITY_FORM_REQUEST_HEADER) !== "1") return response;
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get("location");
  if (!location) return response;

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("location");
  let redirectTarget = location;
  try {
    redirectTarget = new URL(location, request.url).toString();
  } catch {
    // The client applies the shared safe-navigation check before using it.
  }
  headers.set(CAPABILITY_FORM_REDIRECT_HEADER, redirectTarget);
  headers.set("cache-control", "no-store");
  appendVaryHeader(headers, CAPABILITY_FORM_REQUEST_HEADER);
  return new Response(null, { status: 204, headers });
}
