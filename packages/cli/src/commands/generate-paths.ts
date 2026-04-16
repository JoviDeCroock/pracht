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
  return routePath.split("/").some((segment) => segment.startsWith(":") || segment === "*");
}

export function dynamicParamNames(routePath: string): string[] {
  return routePath
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) return segment.slice(1);
      if (segment === "*") return "slug";
      return null;
    })
    .filter((s): s is string => s !== null);
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
