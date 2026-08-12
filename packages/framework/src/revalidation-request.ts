import { serverEnv } from "./env-server.ts";

export const PRACHT_REVALIDATE_ENDPOINT = "/__pracht/revalidate";
export const PRACHT_REVALIDATE_TOKEN_ENV = "PRACHT_REVALIDATE_TOKEN";
export const PRACHT_REVALIDATE_TOKEN_HEADER = "x-pracht-revalidate-token";

const MAX_REVALIDATION_PATHS = 64;

/**
 * The configured webhook revalidation token, read through `serverEnv` so it
 * resolves on every runtime pracht targets.
 *
 * Adapters must not reach for `process.env` (or `globalThis.process.env`)
 * themselves. Vite defines `process.env` away in edge SSR builds, and a
 * single-use local alias is inlined by the package bundler before Vite sees
 * it — which silently compiled the Vercel adapter's read down to
 * `return {}[PRACHT_REVALIDATE_TOKEN_ENV]` and made webhook revalidation
 * unauthenticatable in production. `serverEnv` centralises that hazard behind
 * one define-proof accessor that also picks up Cloudflare's request-scoped
 * bindings.
 */
export function resolveRevalidationToken(): string | undefined {
  try {
    const token = serverEnv[PRACHT_REVALIDATE_TOKEN_ENV];
    return typeof token === "string" && token !== "" ? token : undefined;
  } catch {
    // Cloudflare installs its bindings when a request enters the adapter.
    // Before that there is intentionally no ambient environment.
    return undefined;
  }
}

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

  if (hasTooManyRevalidationPaths(body)) {
    return {
      ok: false,
      response: jsonResponse(
        { error: `Expected at most ${MAX_REVALIDATION_PATHS} revalidation paths.` },
        400,
      ),
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

/**
 * Build the request an ISG render runs on. The rendered HTML lands in a shared
 * cache and is replayed to every later visitor, so the render must not see the
 * triggering visitor's cookies, credentials, or query string — only the path.
 * `base` supplies the origin (a `Request`, `URL`, or absolute URL string).
 */
export function createISGRegenerationRequest(
  pathname: string,
  base?: Request | URL | string,
): Request {
  const baseUrl =
    base === undefined
      ? new URL("http://localhost")
      : new URL(base instanceof Request ? base.url : base);
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
  const value = getRevalidationPathsValue(body);
  const paths = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!paths || paths.length === 0) return null;

  const unique = new Set<string>();
  for (const path of paths) {
    if (!isValidRevalidationPath(path)) return null;
    unique.add(path);
  }
  return [...unique];
}

function hasTooManyRevalidationPaths(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const value = getRevalidationPathsValue(body);
  return Array.isArray(value) && value.length > MAX_REVALIDATION_PATHS;
}

function getRevalidationPathsValue(body: object): unknown {
  return (body as { paths?: unknown; path?: unknown }).paths ?? (body as { path?: unknown }).path;
}

function isValidRevalidationPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !value.includes("\\") &&
    !value.split("/").includes("..")
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
