import type { NetlifyExecutionContext } from "./types.ts";

const SHARED_CONTEXT_FIELDS = [
  "account",
  "deploy",
  "json",
  "log",
  "params",
  "server",
  "site",
  "waitUntil",
] as const;

const EMPTY_NETLIFY_GEO = Object.freeze({});
const EMPTY_NETLIFY_COOKIES = Object.freeze({
  delete: rejectSharedContextCookieMutation,
  get: () => undefined,
  set: rejectSharedContextCookieMutation,
});

export function createNetlifyISGContext<TContext extends NetlifyExecutionContext>(
  context: TContext,
  request: Request,
): TContext {
  const shared: NetlifyExecutionContext = Object.create(null);

  for (const field of SHARED_CONTEXT_FIELDS) {
    const value = context[field];
    if (value === undefined) continue;
    shared[field] = typeof value === "function" ? value.bind(context) : value;
  }

  // Netlify exposes these values outside the Request object. Mask them as
  // deliberately as createISGRegenerationRequest() strips visitor headers and
  // query data, or a context factory could still personalize shared output.
  shared.cookies = EMPTY_NETLIFY_COOKIES;
  shared.geo = EMPTY_NETLIFY_GEO;
  shared.ip = "";
  shared.requestId = "";
  shared.url = new URL(request.url);

  return shared as TContext;
}

function rejectSharedContextCookieMutation(): never {
  throw new Error("Netlify cookies cannot be changed while rendering a shared ISG response.");
}
