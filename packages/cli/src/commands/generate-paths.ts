import { parseRouteSegments, routePathIsDynamic } from "@pracht/core";

export function normalizeRoutePathString(value: string): string {
  if (!value || value === "/") return "/";
  const normalized = `/${value}`.replace(/\/+/g, "/");
  return normalized !== "/" && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function normalizeApiPath(value: string): string {
  const normalized = normalizeRoutePathString(value).replace(/^\/api(?=\/|$)/, "");
  return normalized || "/";
}

export function hasDynamicSegments(routePath: string): boolean {
  return routePathIsDynamic(routePath);
}

/** The `params` keys a generated `getStaticPaths()` stub fills; a bare `*` is named `slug`. */
export function dynamicParamNames(routePath: string): string[] {
  return parseRouteSegments(routePath).flatMap((segment) => {
    if (segment.type === "static") return [];
    return [segment.type === "catchall" && segment.name === "*" ? "slug" : segment.name];
  });
}

export function routeIdFromPath(routePath: string): string {
  if (routePath === "/") return "index";
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^:/, "").replace(/\*/g, "splat"))
    .join("-");
}

export function titleFromPath(routePath: string): string {
  if (routePath === "/") return "Home";
  const lastSegment = routePath.split("/").filter(Boolean).at(-1) ?? "Page";
  return titleCase(lastSegment.replace(/^:/, "").replace(/\*/g, "slug"));
}

export function titleCase(value: string): string {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}
