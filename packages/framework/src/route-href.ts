import { formatUnknownNameError } from "./name-suggestions.ts";
import { normalizeRoutePath, parseRouteSegments } from "./route-pattern.ts";
import type {
  BuildHrefOptions,
  HrefArgs,
  HrefRouteDefinition,
  RouteId,
  RouteParams,
  RouteSegment,
  SearchParamsInput,
  UntypedRouteTarget,
} from "./types.ts";

export function buildPathFromSegments(
  segments: readonly RouteSegment[],
  params: RouteParams,
): string {
  const parts = segments.map((segment) => {
    if (segment.type === "static") return segment.value;
    if (segment.type === "param") return encodeDynamicPathSegment(params[segment.name] ?? "");
    const raw = params[segment.name] ?? params["*"] ?? "";
    return raw
      .split("/")
      .map((part) => encodeDynamicPathSegment(part))
      .join("/");
  });
  return normalizeRoutePath("/" + parts.join("/"));
}

export function buildHref<TRoute extends RouteId>(
  routes: readonly HrefRouteDefinition[],
  routeId: TRoute,
  ...args: HrefArgs<TRoute>
): string {
  return buildHrefUntyped(routes, String(routeId), args[0] as BuildHrefOptions | undefined);
}

/** @internal Build a route URL before application route registration narrows `RouteId`. */
export function buildHrefUntyped(
  routes: readonly HrefRouteDefinition[],
  routeId: string,
  options: Omit<UntypedRouteTarget, "route"> = {},
): string {
  const route = routes.find((candidate) => candidate.id === routeId);
  if (!route) {
    if (import.meta.env?.DEV !== false) {
      throw new Error(
        formatUnknownNameError({
          kind: "pracht route id",
          kindPlural: "route ids",
          name: routeId,
          registered: routes.flatMap((candidate) => (candidate.id ? [candidate.id] : [])),
        }),
      );
    }
    throw new Error(`Unknown pracht route id "${routeId}".`);
  }

  const segments = route.segments ?? parseRouteSegments(route.path);
  const params = normalizeHrefParams(segments, options.params ?? {});
  const path = buildPathFromSegments(segments, params);
  return `${path}${serializeSearch(options.search as SearchParamsInput | undefined)}${serializeHash(options.hash)}`;
}

export function normalizeHrefParams(
  segments: readonly RouteSegment[],
  params: Record<string, unknown>,
): RouteParams {
  const expected = new Set(
    segments
      .filter((segment) => segment.type === "param" || segment.type === "catchall")
      .map((segment) => segment.name),
  );
  for (const name of expected) {
    if (params[name] == null) throw new Error(`Missing route param: ${name}.`);
  }
  for (const name of Object.keys(params)) {
    if (!expected.has(name)) throw new Error(`Unexpected route param: ${name}.`);
  }
  return Object.fromEntries([...expected].map((name) => [name, String(params[name])]));
}

export function serializeSearch(search: SearchParamsInput | undefined): string {
  if (search == null) return "";
  if (typeof search === "string") {
    if (!search) return "";
    return search.startsWith("?") ? search : `?${search}`;
  }
  const params = search instanceof URLSearchParams ? search : objectToSearchParams(search);
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function objectToSearchParams(search: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) {
      for (const item of value) appendSearchValue(params, key, item);
    } else {
      appendSearchValue(params, key, value);
    }
  }
  return params;
}

function appendSearchValue(params: URLSearchParams, key: string, value: unknown): void {
  if (value != null) params.append(key, String(value));
}

function serializeHash(hash: string | undefined): string {
  if (!hash) return "";
  return hash.startsWith("#") ? hash : `#${hash}`;
}

function encodeDynamicPathSegment(part: string): string {
  if (part === "." || part === "..") {
    throw new Error(`Unsafe dynamic route param segment "${part}" is not allowed.`);
  }
  return encodeURIComponent(part);
}
