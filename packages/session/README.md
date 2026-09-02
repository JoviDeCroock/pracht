# @pracht/session

First-party sessions for [Pracht](https://github.com/JoviDeCroock/pracht).
Encrypted cookie sessions out of the box, or a sealed session id backed by any
store you already run. WebCrypto only — the same build runs on Node,
Cloudflare Workers, Netlify, and Vercel.

```bash
npm install @pracht/session
```

## Quick start

```ts
// src/server/session.ts — one instance per app
import { serverEnv } from "@pracht/core/env/server";
import { createSessionStorage } from "@pracht/session";

export const sessions = createSessionStorage<{ userId: string; email: string }>({
  cookie: {
    // `__Host-` is browser-enforced: Secure, Path=/, host-only. It stops a
    // sibling subdomain from writing a cookie this app would read.
    name: "__Host-session",
    // Newest first. Every secret is tried on read, so rotation is a deploy
    // rather than a mass logout.
    secrets: [serverEnv.SESSION_SECRET],
  },
});
```

```ts
// src/middleware/session.ts — the manifest expects a `middleware` export
import { sessionMiddleware } from "@pracht/session";

import { sessions } from "../server/session.ts";

export const middleware = sessionMiddleware(sessions);
```

```ts
// src/env.d.ts — so `context.session` is typed everywhere
import type { SessionRequestContext } from "@pracht/session";

declare module "@pracht/core" {
  interface Register {
    context: SessionRequestContext<{ userId: string; email: string }>;
  }
}
```

Now any loader, API route, or capability under that middleware reads and
writes the session through `context`, and the cookie is committed onto the
response after the chain finishes:

```ts
export async function loader({ context }: LoaderArgs) {
  return { userId: context.session.get("userId") ?? null };
}
```

## Gating a route

`sessionMiddleware()` loads the session; it never blocks. `requireSession()`
does both — redirecting a page request to the login page and answering an API
request with `401`:

```ts
// src/middleware/require-user.ts
import { requireSession } from "@pracht/session";

import { sessions } from "../server/session.ts";

export const middleware = requireSession(sessions, { loginPath: "/login" });
```

## Cookie sessions vs. a store

|                        | Cookie (default)                 | With a `store`                     |
| ---------------------- | -------------------------------- | ---------------------------------- |
| Where the data lives   | In the cookie, AES-256-GCM sealed | In your store, keyed by session id |
| Size ceiling           | 4 KB total, enforced with a throw | Whatever the store allows          |
| Server-side logout     | No — the cookie expires on its own | Yes — delete the record          |
| Infrastructure         | None                             | KV / D1 / Redis / Postgres         |

```ts
import { createSessionStorage } from "@pracht/session";

export const sessions = createSessionStorage({
  cookie: { name: "__Host-session", secrets: [serverEnv.SESSION_SECRET] },
  store: {
    async get(id) {
      return await env.SESSIONS.get(`session:${id}`, "json");
    },
    async set(id, data, expiresAt) {
      await env.SESSIONS.put(`session:${id}`, JSON.stringify(data), {
        expiration: Math.floor(expiresAt / 1000),
      });
    },
    async delete(id) {
      await env.SESSIONS.delete(`session:${id}`);
    },
  },
});
```

`createMemorySessionStore()` is exported for tests and single-process dev
servers. It is not a production store: the sessions die with the process.

## What it guarantees

- **Confidentiality and integrity.** The payload is AES-256-GCM sealed with a
  key derived from your secret via HKDF-SHA256. A signed-but-readable cookie
  leaks whatever you put in it to anything that can read the cookie jar.
- **Expiry that the client cannot extend.** The lifetime is inside the sealed
  payload, not only in `Max-Age`. It is absolute from the last write, and the
  middleware commits only when the session changed; `rolling: true` re-commits
  every request to give an idle timeout instead.
- **Rotation without logging anyone out.** The first secret seals; every
  secret opens.
- **Cookie hygiene by default.** `HttpOnly`, `SameSite=Lax`, `Path=/`, and
  `Secure` on everything but plain-http localhost — it fails closed, because a
  TLS-terminating proxy makes a production request look like http. `__Host-`
  and `__Secure-` names are validated at construction.
- **A fix for session fixation.** `session.regenerate()` rotates the id and
  drops the old store record; call it the moment credentials verify.
- **Duplicate-cookie safety.** When several cookies share the name, each is
  tried until one unseals, so a planted duplicate cannot take precedence or
  deny the real session.
- **A size guard.** Over 4 KB, browsers silently drop the cookie; this throws
  instead, and names the fix.
- **No `node:` imports.** Enforced by a test against the built output.

## Passwords

`hashPassword()` / `verifyPassword()` wrap PBKDF2-HMAC-SHA256, the only
password KDF WebCrypto exposes. They exist because the alternative in practice
is a hand-rolled `SHA-256(password)`. Argon2id and scrypt are better
primitives — use them where the runtime allows.

```ts
const stored = await hashPassword(password);
const ok = await verifyPassword(candidate, stored);
```

The stored string records its own parameters, so raising the iteration count
later does not invalidate existing hashes.

## Documentation

- [Authentication recipe](https://pracht.resynapse.dev/docs/recipes/auth)
- [Middleware](https://pracht.resynapse.dev/docs/middleware)
- [API reference](https://pracht.resynapse.dev/docs/reference/api)
