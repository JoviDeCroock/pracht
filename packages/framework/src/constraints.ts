/**
 * Declarative app-level constraints.
 *
 * Constraints are invariants over the resolved route graph — "everything under
 * /app requires the auth middleware", "no SSG under /account" — declared once
 * in `defineApp({ constraints })` and enforced deterministically by
 * `pracht verify` (and the MCP `verify` tool). They turn review-time hopes
 * ("did anyone forget the middleware?") into machine-checked guarantees.
 *
 * Patterns match route paths segment-wise against the declared path string:
 * `*` matches exactly one segment (including `:param` segments), `**` matches
 * zero or more trailing segments, and any other segment must match literally.
 * `"**"` on its own matches every route.
 */

import type { RenderMode } from "./types.ts";

export interface RequireMiddlewareConstraint {
  kind: "require-middleware";
  pattern: string;
  middleware: string[];
}

export interface RequireShellConstraint {
  kind: "require-shell";
  pattern: string;
  shells: string[];
}

export interface RequireRenderModeConstraint {
  kind: "require-render-mode";
  pattern: string;
  modes: RenderMode[];
}

export interface ForbidRenderModeConstraint {
  kind: "forbid-render-mode";
  pattern: string;
  modes: RenderMode[];
}

export interface RequireHeadConstraint {
  kind: "require-head";
  pattern: string;
}

export type RouteConstraint =
  | RequireMiddlewareConstraint
  | RequireShellConstraint
  | RequireRenderModeConstraint
  | ForbidRenderModeConstraint
  | RequireHeadConstraint;

/** Every route matching `pattern` must include all of the given middleware names. */
export function requireMiddleware(
  pattern: string,
  ...middleware: string[]
): RequireMiddlewareConstraint {
  assertValidPattern(pattern);
  assertNonEmpty(middleware, "requireMiddleware", "middleware name");
  return { kind: "require-middleware", pattern, middleware };
}

/** Every route matching `pattern` must use one of the given shells. */
export function requireShell(pattern: string, ...shells: string[]): RequireShellConstraint {
  assertValidPattern(pattern);
  assertNonEmpty(shells, "requireShell", "shell name");
  return { kind: "require-shell", pattern, shells };
}

/** Every route matching `pattern` must use one of the given render modes. */
export function requireRenderMode(
  pattern: string,
  ...modes: RenderMode[]
): RequireRenderModeConstraint {
  assertValidPattern(pattern);
  assertNonEmpty(modes, "requireRenderMode", "render mode");
  return { kind: "require-render-mode", pattern, modes };
}

/** No route matching `pattern` may use any of the given render modes. */
export function forbidRenderMode(
  pattern: string,
  ...modes: RenderMode[]
): ForbidRenderModeConstraint {
  assertValidPattern(pattern);
  assertNonEmpty(modes, "forbidRenderMode", "render mode");
  return { kind: "forbid-render-mode", pattern, modes };
}

/** Every route matching `pattern` must export `head()` (directly or via its shell). */
export function requireHead(pattern: string): RequireHeadConstraint {
  assertValidPattern(pattern);
  return { kind: "require-head", pattern };
}

/**
 * Match a route path against a constraint pattern. Segment-wise: `*` matches
 * exactly one segment, a trailing `**` matches zero or more segments, other
 * segments compare literally against the declared path (so `/blog/*` matches
 * `/blog/:slug`).
 */
export function matchRoutePattern(pattern: string, routePath: string): boolean {
  const patternSegments = splitSegments(pattern);
  const pathSegments = splitSegments(routePath);

  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];

    if (patternSegment === "**") {
      if (index !== patternSegments.length - 1) {
        throw new Error(
          `Invalid constraint pattern ${JSON.stringify(pattern)}: "**" is only supported as the final segment.`,
        );
      }
      return true;
    }

    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return false;
    if (patternSegment === "*") continue;
    if (patternSegment !== pathSegment) return false;
  }

  return patternSegments.length === pathSegments.length;
}

/**
 * The route shape constraint evaluation needs. Matches both the framework's
 * `ResolvedRoute` and the serialized `AppGraphRoute` the CLI works with.
 */
export interface ConstraintRoute {
  path: string;
  middleware: string[];
  render?: string | null;
  shell?: string | null;
}

export interface ConstraintViolation {
  constraint: RouteConstraint;
  message: string;
  routePath: string;
}

export interface EvaluateConstraintsOptions {
  /**
   * Whether the route (or its shell) exports `head()`. Required to evaluate
   * `requireHead` constraints — it needs module source access the evaluator
   * doesn't have. Returning `undefined` skips the route.
   */
  routeHasHead?: (route: ConstraintRoute) => boolean | undefined;
}

export function evaluateConstraints(
  routes: readonly ConstraintRoute[],
  constraints: readonly RouteConstraint[],
  options: EvaluateConstraintsOptions = {},
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  for (const constraint of constraints) {
    for (const route of routes) {
      if (!matchRoutePattern(constraint.pattern, route.path)) continue;

      const message = evaluateConstraintForRoute(constraint, route, options);
      if (message) {
        violations.push({ constraint, message, routePath: route.path });
      }
    }
  }

  return violations;
}

function evaluateConstraintForRoute(
  constraint: RouteConstraint,
  route: ConstraintRoute,
  options: EvaluateConstraintsOptions,
): string | null {
  switch (constraint.kind) {
    case "require-middleware": {
      const missing = constraint.middleware.filter((name) => !route.middleware.includes(name));
      if (missing.length === 0) return null;
      return `Route "${route.path}" is missing required middleware ${missing
        .map((name) => JSON.stringify(name))
        .join(", ")} (constraint pattern ${JSON.stringify(constraint.pattern)}).`;
    }
    case "require-shell": {
      const shell = route.shell ?? null;
      if (shell !== null && constraint.shells.includes(shell)) return null;
      return `Route "${route.path}" uses shell ${shell === null ? "none" : JSON.stringify(shell)} but must use ${formatOneOf(constraint.shells)} (constraint pattern ${JSON.stringify(constraint.pattern)}).`;
    }
    case "require-render-mode": {
      const render = route.render ?? null;
      if (render !== null && constraint.modes.includes(render as RenderMode)) return null;
      return `Route "${route.path}" renders as ${render === null ? "the default mode" : JSON.stringify(render)} but must use ${formatOneOf(constraint.modes)} (constraint pattern ${JSON.stringify(constraint.pattern)}).`;
    }
    case "forbid-render-mode": {
      const render = route.render ?? null;
      if (render === null || !constraint.modes.includes(render as RenderMode)) return null;
      return `Route "${route.path}" renders as ${JSON.stringify(render)}, which is forbidden here (constraint pattern ${JSON.stringify(constraint.pattern)}).`;
    }
    case "require-head": {
      const hasHead = options.routeHasHead?.(route);
      if (hasHead !== false) return null;
      return `Route "${route.path}" does not export head() and neither does its shell (constraint pattern ${JSON.stringify(constraint.pattern)}).`;
    }
  }
}

function formatOneOf(values: readonly string[]): string {
  if (values.length === 1) return JSON.stringify(values[0]);
  return `one of ${values.map((value) => JSON.stringify(value)).join(", ")}`;
}

function splitSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

function assertValidPattern(pattern: string): void {
  if (typeof pattern !== "string" || (pattern !== "**" && !pattern.startsWith("/"))) {
    throw new Error(
      `Invalid constraint pattern ${JSON.stringify(pattern)}: expected "**" or a route path pattern starting with "/".`,
    );
  }
}

function assertNonEmpty(values: readonly string[], helper: string, noun: string): void {
  if (values.length === 0) {
    throw new Error(`${helper}() expects at least one ${noun}.`);
  }
}
