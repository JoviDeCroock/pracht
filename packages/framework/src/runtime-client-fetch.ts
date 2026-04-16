import { ROUTE_STATE_REQUEST_HEADER } from "./runtime-constants.ts";
import type { SerializedRouteError } from "./runtime-errors.ts";

export type RouteStateResult =
  | { type: "data"; data: unknown }
  | { type: "redirect"; location: string }
  | { type: "error"; error: SerializedRouteError };

export function buildRouteStateUrl(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}_data=1`;
}

export async function fetchPrachtRouteState(
  url: string,
  options?: { useDataParam?: boolean },
): Promise<RouteStateResult> {
  const fetchUrl = options?.useDataParam ? buildRouteStateUrl(url) : url;
  const response = await fetch(fetchUrl, {
    headers: options?.useDataParam
      ? {}
      : { [ROUTE_STATE_REQUEST_HEADER]: "1", "Cache-Control": "no-cache" },
    redirect: "manual",
  });

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    const location = response.headers.get("location");
    return {
      location: location ?? url,
      type: "redirect",
    };
  }

  const json = (await response.json()) as {
    data?: unknown;
    error?: SerializedRouteError;
    redirect?: string;
  };
  if (json.redirect) {
    return {
      location: json.redirect,
      type: "redirect",
    };
  }

  if (!response.ok) {
    if (json.error) {
      return {
        error: json.error,
        type: "error",
      };
    }

    throw new Error(`Failed to fetch route state (${response.status})`);
  }

  return {
    data: json.data,
    type: "data",
  };
}

export async function navigateToClientLocation(
  location: string,
  options?: { replace?: boolean },
): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const targetUrl = new URL(location, window.location.href);
  const target = targetUrl.pathname + targetUrl.search + targetUrl.hash;
  if (targetUrl.origin === window.location.origin && window.__PRACHT_NAVIGATE__) {
    await window.__PRACHT_NAVIGATE__(target, options);
    return;
  }

  if (options?.replace) {
    window.location.replace(targetUrl.toString());
    return;
  }

  window.location.href = targetUrl.toString();
}
