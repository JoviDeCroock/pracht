export const ROUTE_STATE_REQUEST_HEADER = "x-pracht-route-state-request";

export function isRouteStateRequest(request: Request, url: URL): boolean {
  return (
    request.headers.get(ROUTE_STATE_REQUEST_HEADER) === "1" || url.searchParams.get("_data") === "1"
  );
}

export function normalizePathname(pathname: string): string {
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  return pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
}
