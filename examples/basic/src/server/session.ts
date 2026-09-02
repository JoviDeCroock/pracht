import { serverEnv } from "@pracht/core/env/server";
import {
  createSessionStorage,
  type SessionRequestContext,
  type SessionStorage,
} from "@pracht/session";

export interface AppSession extends Record<string, unknown> {
  userId: string;
  email: string;
  name: string;
  /** Flash message, consumed by the first page that reads it. */
  notice: string;
}

/** Shape of `context.session` for loaders and API routes under the middleware. */
export type SessionContext = SessionRequestContext<AppSession>;

let storage: SessionStorage<AppSession> | undefined;

/**
 * Built lazily rather than at module top level: on Cloudflare Workers env
 * bindings only exist per request, so reading `serverEnv` while the module is
 * evaluating throws and takes the whole worker down at import time.
 */
export function sessions(): SessionStorage<AppSession> {
  storage ??= createSessionStorage<AppSession>({
    // `__Host-` is enforced by the browser: the cookie is rejected unless it
    // is Secure, Path=/, and host-only, so a sibling subdomain cannot write a
    // cookie this app would read. It also pins Secure on, which browsers
    // accept over http://localhost.
    cookie: { name: "__Host-session", secrets: [secret()] },
  });
  return storage;
}

function secret(): string {
  const configured = serverEnv.SESSION_SECRET;
  if (typeof configured === "string" && configured.length >= 16) return configured;
  // Example app only. This value is in a public repository, so anyone can
  // forge a session signed with it — a real deployment sets SESSION_SECRET
  // (`openssl rand -base64 32`) and this branch never runs.
  return "pracht-basic-example-development-session-secret";
}
