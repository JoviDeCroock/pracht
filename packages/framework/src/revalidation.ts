import type { RouteRevalidate, RouteRevalidatePolicy } from "./types.ts";

export const PRACHT_REVALIDATE_ENDPOINT = "/__pracht/revalidate";
export const PRACHT_REVALIDATE_TOKEN_ENV = "PRACHT_REVALIDATE_TOKEN";
export const PRACHT_REVALIDATE_TOKEN_HEADER = "x-pracht-revalidate-token";

export interface ParsedRevalidationRequest {
  paths: string[];
}

export type RevalidationRequestResult =
  | {
      ok: true;
      paths: string[];
    }
  | {
      ok: false;
      response: Response;
    };

export function normalizeRouteRevalidate(revalidate: RouteRevalidate): RouteRevalidatePolicy[] {
  const policies = Array.isArray(revalidate) ? [...revalidate] : [revalidate];
  if (policies.length === 0) {
    throw new Error("Route revalidate policy arrays must contain at least one policy.");
  }

  const seen = new Set<string>();
  for (const policy of policies) {
    if (!policy || typeof policy !== "object") {
      throw new Error("Route revalidate policies must be objects.");
    }
    if (seen.has(policy.kind)) {
      throw new Error(
        `Route revalidate policies cannot include duplicate "${policy.kind}" entries.`,
      );
    }
    seen.add(policy.kind);

    if (policy.kind === "time") {
      if (!Number.isInteger(policy.seconds) || policy.seconds <= 0) {
        throw new Error("time revalidate policies expect a positive integer number of seconds.");
      }
      continue;
    }

    if (policy.kind === "webhook") {
      continue;
    }

    throw new Error(
      `Unsupported route revalidate policy "${String((policy as { kind?: unknown }).kind)}".`,
    );
  }

  return policies;
}

export function getTimeRevalidateSeconds(revalidate: RouteRevalidate | undefined): number | null {
  if (!revalidate) return null;
  for (const policy of normalizeRouteRevalidate(revalidate)) {
    if (policy.kind === "time") return policy.seconds;
  }
  return null;
}

export function hasWebhookRevalidate(revalidate: RouteRevalidate | undefined): boolean {
  if (!revalidate) return false;
  return normalizeRouteRevalidate(revalidate).some((policy) => policy.kind === "webhook");
}

export async function readRevalidationRequest(
  request: Request,
  token: string | undefined,
): Promise<RevalidationRequestResult> {
  if (request.method !== "POST") {
    return {
      ok: false,
      response: jsonResponse({ error: "Method Not Allowed" }, 405, {
        allow: "POST",
      }),
    };
  }

  if (!isAuthorizedRevalidationRequest(request, token)) {
    return {
      ok: false,
      response: jsonResponse({ error: "Unauthorized" }, 401),
    };
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return {
      ok: false,
      response: jsonResponse({ error: "Expected a JSON body." }, 400),
    };
  }

  const paths = parseRevalidationPaths(body);
  if (!paths) {
    return {
      ok: false,
      response: jsonResponse({ error: 'Expected body shape `{ "paths": ["/path"] }`.' }, 400),
    };
  }

  return {
    ok: true,
    paths,
  };
}

export function isAuthorizedRevalidationRequest(
  request: Request,
  token: string | undefined,
): boolean {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }

  const provided = getRevalidationToken(request);
  if (!provided) return false;
  return constantTimeEqual(provided, token);
}

export function createISGRegenerationRequest(pathname: string, originalRequest?: Request): Request {
  const baseUrl = originalRequest ? new URL(originalRequest.url) : new URL("http://localhost");
  const regenerationUrl = new URL(pathname, baseUrl);

  return new Request(regenerationUrl, {
    method: "GET",
    headers: { accept: "text/html" },
  });
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function getRevalidationToken(request: Request): string | null {
  const headerToken = request.headers.get(PRACHT_REVALIDATE_TOKEN_HEADER);
  if (headerToken) return headerToken;

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function parseRevalidationPaths(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const value =
    (body as { paths?: unknown; path?: unknown }).paths ?? (body as { path?: unknown }).path;
  const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!paths || paths.length === 0) return null;

  const unique = new Set<string>();
  for (const path of paths) {
    if (!isValidRevalidationPath(path)) return null;
    unique.add(path);
  }
  return [...unique];
}

function isValidRevalidationPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;

  for (let i = 0; i < length; i += 1) {
    diff |= (leftBytes[i] ?? 0) ^ (rightBytes[i] ?? 0);
  }

  return diff === 0;
}
