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

export interface SerializedRouteError {
  message: string;
  name: string;
  status: number;
  diagnostics?: PrachtRuntimeDiagnostics;
}

type DiagnosticRoute = ResolvedRoute | ResolvedApiRoute;

export function isPrachtHttpError(error: unknown): error is PrachtHttpError {
  return error instanceof Error && error.name === "PrachtHttpError" && "status" in error;
}

export function shouldExposeServerErrors(options: { debugErrors?: boolean }): boolean {
  return options.debugErrors === true;
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
      return {
        message: error.message,
        name: error.name,
        status,
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
  const result = new Error(error.message);
  result.name = error.name;
  (result as Error & { diagnostics?: PrachtRuntimeDiagnostics; status?: number }).status =
    error.status;
  (result as Error & { diagnostics?: PrachtRuntimeDiagnostics; status?: number }).diagnostics =
    error.diagnostics;
  return result;
}
