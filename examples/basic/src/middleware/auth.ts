import type { MiddlewareFn } from "@pracht/core";
import { requireSession } from "@pracht/session";

import { sessions } from "../server/session.ts";

let gate: MiddlewareFn | undefined;

/**
 * The gate for `/dashboard` and `/settings`: it reads the decrypted session
 * and short-circuits with a redirect when there is no user, rather than
 * augmenting the request and hoping the loader checks.
 *
 * Built on first use for the same reason `sessions()` is — the session secret
 * comes from `serverEnv`, which is request-scoped on Cloudflare Workers.
 */
export const middleware: MiddlewareFn = (args, next) => {
  gate ??= requireSession(sessions(), { loginPath: "/login" });
  return gate(args, next);
};
