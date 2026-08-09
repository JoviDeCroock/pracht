import type { MiddlewareFn } from "@pracht/core";

/**
 * Pracht ships no built-in rate limiter; docs/AGENT_TRUST.md points at named
 * capability middleware instead, because it runs before `run()` on every
 * projection (HTTP, WebMCP, direct invocation), it can read `context.agent`,
 * and it can short-circuit with a 429.
 *
 * This is a per-principal fixed window, in memory. Enough to show the seam.
 */

const WINDOW_MS = 60_000;
const MAX_CALLS = 12;

const buckets = new Map<string, { count: number; resetAt: number }>();

export const middleware: MiddlewareFn = async ({ request, context }, next) => {
  const agent = (context as { agent?: { keyId?: string } | null }).agent;
  const principal = agent?.keyId
    ? `agent:${agent.keyId}`
    : `ip:${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}`;

  const now = Date.now();
  const bucket = buckets.get(principal);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(principal, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (bucket.count >= MAX_CALLS) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return Response.json(
      {
        ok: false,
        error: {
          code: "rate_limited",
          message: `Too many write calls for ${principal}. Retry in ${retryAfter}s.`,
        },
      },
      { status: 429, headers: { "retry-after": String(retryAfter) } },
    );
  }

  bucket.count += 1;
  return next();
};
