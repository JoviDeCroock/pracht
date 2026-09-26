import type { ApiValidationIssue } from "./api-validation.ts";
import type { PrachtHttpError, ResolvedApiRoute, ResolvedRoute } from "./types.ts";

export type PrachtRuntimeDiagnosticPhase =
  | "match"
  | "middleware"
  | "loader"
  | "action"
  | "render"
  | "api";

export interface PrachtRuntimeDiagnostics {
  phase: PrachtRuntimeDiagnosticPhase;
  routeId?: string;
  routePath?: string;
  routeFile?: string;
  loaderFile?: string;
  shellFile?: string;
  middlewareFiles?: string[];
  status: number;
}

/**
 * Route metadata handed to `onRouteError` or `onApiError` alongside the raw
 * error.
 *
 * The response body deliberately hides these details outside `debugErrors`,
 * so a caller that owns the surrounding surface — prerendering, the dev
 * server's error overlay — would otherwise have to re-derive which route
 * failed, in which phase, and, for a page route, whether a declared boundary
 * owns the response.
 * Unlike `PrachtRuntimeDiagnostics` it carries no status: the error has not
 * been normalized into a response yet.
 */
export interface RouteErrorContext {
  phase: PrachtRuntimeDiagnosticPhase;
  /** Which declared page ErrorBoundary will receive the failure, when present. */
  errorBoundary?: "route" | "shell";
  routeId?: string;
  routePath?: string;
  routeFile?: string;
  loaderFile?: string;
  shellFile?: string;
  middlewareFiles?: string[];
}

export interface SerializedRouteError {
  message: string;
  name: string;
  status: number;
  diagnostics?: PrachtRuntimeDiagnostics;
  /** Normalized issues from a rejected route `search` schema. */
  issues?: ApiValidationIssue[];
}

type DiagnosticRoute = ResolvedRoute | ResolvedApiRoute;

export function isPrachtHttpError(error: unknown): error is PrachtHttpError {
  return error instanceof Error && error.name === "PrachtHttpError" && "status" in error;
}

let warnedAboutProductionDebugErrors = false;

/**
 * `debugErrors: true` opts into surfacing stack traces, module paths,
 * and middleware names in error responses. That is great in dev and
 * dangerous in production — a misconfigured deploy would leak internals
 * to the public. When `NODE_ENV === "production"` we refuse to honor
 * the flag and emit a single console warning so the misconfiguration
 * is visible in logs.
 */
export function shouldExposeServerErrors(options: { debugErrors?: boolean }): boolean {
  if (options.debugErrors !== true) return false;

  const env =
    typeof process !== "undefined" && process.env
      ? process.env.NODE_ENV
      : typeof globalThis !== "undefined" &&
          (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process
        ? (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV
        : undefined;

  if (env === "production") {
    if (!warnedAboutProductionDebugErrors) {
      warnedAboutProductionDebugErrors = true;
      console.warn(
        "[pracht] debugErrors is ignored in production builds. Remove it to silence this warning.",
      );
    }
    return false;
  }

  return true;
}

export function createSerializedRouteError(
  message: string,
  status: number,
  options: {
    diagnostics?: PrachtRuntimeDiagnostics;
    name?: string;
  } = {},
): SerializedRouteError {
  return {
    message,
    name: options.name ?? "Error",
    status,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  };
}

export function buildRuntimeDiagnostics(options: {
  middlewareFiles?: string[];
  phase: PrachtRuntimeDiagnosticPhase;
  route?: DiagnosticRoute;
  loaderFile?: string;
  shellFile?: string;
  status: number;
}): PrachtRuntimeDiagnostics {
  const route = options.route;
  const routeId = route && "id" in route ? route.id : undefined;

  return {
    phase: options.phase,
    routeId,
    routePath: route?.path,
    routeFile: route?.file,
    loaderFile: options.loaderFile,
    shellFile: options.shellFile,
    middlewareFiles: options.middlewareFiles ? [...options.middlewareFiles] : [],
    status: options.status,
  };
}

export function normalizeRouteError(
  error: unknown,
  options: { exposeDetails: boolean },
): SerializedRouteError {
  if (isPrachtHttpError(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    if (status >= 400 && status < 500) {
      const issues = (error as { issues?: ApiValidationIssue[] }).issues;
      return {
        message: error.message,
        name: error.name,
        status,
        ...(issues ? { issues } : {}),
      };
    }

    if (options.exposeDetails) {
      return {
        message: error.message || "Internal Server Error",
        name: error.name || "Error",
        status,
      };
    }

    return {
      message: "Internal Server Error",
      name: "Error",
      status,
    };
  }

  if (error instanceof Error) {
    if (options.exposeDetails) {
      return {
        message: error.message || "Internal Server Error",
        name: error.name || "Error",
        status: 500,
      };
    }

    return {
      message: "Internal Server Error",
      name: "Error",
      status: 500,
    };
  }

  if (options.exposeDetails) {
    return {
      message: typeof error === "string" && error ? error : "Internal Server Error",
      name: "Error",
      status: 500,
    };
  }

  return {
    message: "Internal Server Error",
    name: "Error",
    status: 500,
  };
}

export function deserializeRouteError(error: SerializedRouteError): Error {
  const result = new Error(error.message) as Error &
    Pick<SerializedRouteError, "diagnostics" | "issues" | "status">;
  result.name = error.name;
  result.status = error.status;
  result.diagnostics = error.diagnostics;
  if (error.issues) result.issues = error.issues;
  return result;
}

/**
 * One line naming a request failure.
 *
 * Both reporters share it, so an operator reading a deployed app's logs and a
 * developer reading the `pracht dev` terminal are looking at the same sentence.
 * The dev server adds the overlay and decides when to append a stack; the
 * wording is here.
 */
export function formatRequestErrorLine(options: {
  file?: string;
  message: string;
  path: string;
  phase?: string;
  routeId?: string;
}): string {
  const route = options.routeId ? ` in route "${options.routeId}"` : "";
  const file = options.file ? ` (${options.file})` : "";
  return `[pracht] ${options.phase ?? "request"} error${route}${file} at ${options.path}: ${options.message}`;
}

/** The source module the runtime had matched when a request failed. */
export function describeRouteErrorModule(
  context: RouteErrorContext | undefined,
): string | undefined {
  if (!context) return undefined;
  if (context.phase === "middleware" && context.middlewareFiles?.length) {
    return context.middlewareFiles.join(", ");
  }
  if (context.phase === "loader" && context.loaderFile) return context.loaderFile;
  return context.routeFile;
}

/**
 * Report a request failure to the host, or log it when the host said nothing.
 *
 * `onRouteError`/`onApiError` are how a caller that owns the surrounding
 * surface takes over: the dev server swaps in its overlay, the prerenderer
 * blames a route in the build output. A deployed app has no such caller — the
 * generated server entry passes neither — and the default used to be silence,
 * so a 500 reached the visitor while the operator's log stayed empty. The
 * response body still says nothing beyond "Internal Server Error"; this is the
 * server-side half.
 *
 * A `throw notFound()` is a routing outcome rather than a crash, so only
 * failures that answer 5xx are logged — the same line dev applies. The stack
 * goes with it: production has no error overlay to open, and the message alone
 * rarely locates a throw inside a dependency.
 */
export function reportRequestError(
  hook: ((error: unknown, requestPath: string, context?: RouteErrorContext) => void) | undefined,
  error: unknown,
  requestPath: string,
  context: RouteErrorContext,
): void {
  if (hook) {
    hook(error, requestPath, context);
    return;
  }

  if (isPrachtHttpError(error) && error.status < 500) return;

  const line = formatRequestErrorLine({
    file: describeRouteErrorModule(context),
    message: error instanceof Error ? error.message : String(error),
    path: requestPath,
    phase: context.phase,
    routeId: context.routeId,
  });
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(stack ? `${line}\n${stack}` : line);
}
