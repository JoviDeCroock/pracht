---
name: add-auth
version: 2.1.0
description: |
  Wire session-based auth into a pracht app with `@pracht/session`: encrypted
  cookie sessions, gate middleware, login/logout/signup API routes, `<Form>`
  pages, and public vs. protected route groups.
  Use for "add auth", "set up login", "wire authentication", "add session
  middleware", "I need users".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Add Auth

Stamps out the auth pattern documented in
`examples/docs/src/routes/docs/recipes-auth.md`, on top of `@pracht/session`.
The user replaces `verifyCredentials()` with a real DB lookup.

Never hand-roll the session cookie. `@pracht/session` already handles
encryption, expiry inside the payload, secret rotation, the `Secure`/`HttpOnly`
attributes, and the 4 KB size ceiling — every one of which the hand-rolled
version got wrong.

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify`/`generate_*`
tools over shelling out. `pracht inspect` needs the pracht plugin in the vite
config.

## Step 1: Confirm the scope

Use `AskUserQuestion` for:

1. **Flavor** — session cookie + email/password (default), magic link, or OAuth
   (out of scope: keep `@pracht/session` for the session half and use
   `arctic`/`openid-client`/the provider SDK for the protocol half).
2. **Where credentials live** — an existing DB, or none yet? If none, run
   `/add-db` first.
3. **Where sessions live** — in the cookie (default, no infrastructure, 4 KB
   ceiling, no server-side logout) or in a store (KV/D1/Redis/Postgres).
4. **Cookie posture** — `SameSite=Lax` (default, recommended), `Strict`, or
   `None` + token. See `/audit-csrf`.

## Step 2: Install and define the storage

```bash
pnpm add @pracht/session
```

`src/server/session.ts`:

```ts
import { serverEnv } from "@pracht/core/env/server";
import { createSessionStorage, type SessionRequestContext, type SessionStorage } from "@pracht/session";

export interface AppSession extends Record<string, unknown> {
  userId: string;
  email: string;
  name: string;
  notice: string;
}

export type SessionContext = SessionRequestContext<AppSession>;

let storage: SessionStorage<AppSession> | undefined;

// Built lazily, NOT at module scope. On Cloudflare Workers env bindings only
// exist per request, so reading `serverEnv` while the module evaluates throws
// and bricks the worker at import time.
export function sessions(): SessionStorage<AppSession> {
  storage ??= createSessionStorage<AppSession>({
    cookie: {
      // Newest first: the first secret seals, all of them open.
      secrets: [serverEnv.SESSION_SECRET as string],
      // `__Host-` is browser-enforced (Secure, Path=/, host-only) and is
      // validated at construction. Prefer it unless the cookie must be shared
      // across subdomains.
      name: "__Host-session",
      maxAge: 60 * 60 * 24 * 7,
    },
  });
  return storage;
}
```

Defaults you do not have to configure: `HttpOnly`, `SameSite=Lax`, `Path=/`,
AES-256-GCM with an HKDF-derived key, expiry sealed into the payload, and a
throw instead of an oversized cookie. `Secure` is on for every request except
plain http from localhost — it fails closed, because a TLS-terminating proxy
makes a production request look like http.

Expiry is absolute from the *last write*, and the middleware commits only when
the session changed. Add `rolling: true` to `createSessionStorage()` if the
app wants `maxAge` as an idle timeout instead; the cost is a `Set-Cookie` per
response and, with a store, a write per request.

For a store, pass `store: { get, set, delete }` — three methods over KV, D1,
Redis, or Postgres. `createMemorySessionStore()` is for tests only.

Type `context.session` once, in `src/env.d.ts`:

```ts
import type { SessionRequestContext } from "@pracht/session";
import type { AppSession } from "./server/session.ts";

declare module "@pracht/core" {
  interface Register {
    context: SessionRequestContext<AppSession>;
  }
}
```

## Step 3: Middleware

Two factories, and the difference is the whole point:

- `sessionMiddleware(storage)` — loads `context.session`, never blocks
  (an **Augmenter**, in `/audit-auth` terms).
- `requireSession(storage)` — loads **and gates**: pages redirect to
  `loginPath`, API routes get `401` (a **Gate**).

`src/middleware/auth.ts`:

```ts
import type { MiddlewareFn } from "@pracht/core";
import { requireSession } from "@pracht/session";

import { sessions } from "../server/session.ts";

let gate: MiddlewareFn | undefined;

export const middleware: MiddlewareFn = (args, next) => {
  gate ??= requireSession(sessions(), { loginPath: "/login" });
  return gate(args, next);
};
```

Generate `src/middleware/session.ts` the same way with `sessionMiddleware` when
public routes or the API also need to read a session.

Both commit after `next()`, so a loader downstream can `context.session.set(…)`
and the cookie still lands on that loader's response. **Never** write user info
onto `args.request.headers` — the client controls those, and the incoming
`Request` is immutable on Cloudflare Workers.

## Step 4: Password hashing

```ts
// src/server/users.ts
import { hashPassword, verifyPassword } from "@pracht/session";

export async function verifyCredentials(email: string, password: string) {
  const row = await db.users.findByEmail(email.trim().toLowerCase());
  if (!row) return null;
  return (await verifyPassword(password, row.passwordHash)) ? row : null;
}
```

`hashPassword()` is PBKDF2-HMAC-SHA256 — the only password KDF WebCrypto
exposes, so it runs on every adapter. The stored string records its own
parameters, so the iteration count can be raised later without invalidating
existing hashes. Never store a plain `SHA-256(password)`. On Cloudflare
Workers, measure a login against the plan's CPU limit.

## Step 5: Auth API routes

`src/api/auth/login.ts`:

```ts
import { redirect, type ApiRouteArgs } from "@pracht/core";

import { sessions } from "../../server/session.ts";
import { verifyCredentials } from "../../server/users.ts";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  // The redirect field is user input — gate it, or this is an open redirect.
  const requested = String(form.get("redirect") ?? "/dashboard");
  const target =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard";

  const user = await verifyCredentials(email, password);
  if (!user) {
    // `<Form>` only acts on 3xx (it follows `location`); a 401 JSON body is
    // silently ignored and the user sees nothing happen.
    return redirect(`/login?error=1&redirect=${encodeURIComponent(target)}`, { request });
  }

  const storage = sessions();
  const session = await storage.getSession(request);
  // Session fixation: rotate the id on every privilege change, before writing
  // the user. Without it, an attacker who planted a session cookie in the
  // victim's browser still holds a pointer to the session that just became
  // authenticated. Required with a store; harmless and future-proof without.
  await session.regenerate();
  session.set("userId", user.id);
  session.set("email", user.email);
  session.set("name", user.name);
  session.flash("notice", `Welcome back, ${user.name}.`);

  // `commit` appends Set-Cookie; it never replaces one already on the response.
  return storage.commit(session, redirect(target, { request }));
}
```

`src/api/auth/logout.ts` — `POST` returning
`storage.destroy(session, redirect("/", { request }))`. Never a `GET`.

`src/api/auth/signup.ts` — same shape as login: validate (`email` present,
`password.length >= 8`), redirect to `/signup?error=1` on failure, otherwise
`hashPassword()`, insert the user, and issue the session.

## Step 6: Login and signup pages

`src/routes/login.tsx`:

```tsx
import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  const requested = url.searchParams.get("redirect") ?? "/dashboard";
  return {
    error: url.searchParams.get("error") === "1",
    redirect: requested.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard",
  };
}

export function head() {
  return { title: "Log in" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="login">
      <h1>Log in</h1>
      {data.error && <p role="alert">Invalid email or password.</p>}
      <Form method="post" action="/api/auth/login">
        <input type="hidden" name="redirect" value={data.redirect} />
        <label>Email <input type="email" name="email" required /></label>
        <label>Password <input type="password" name="password" required /></label>
        <button type="submit">Log in</button>
      </Form>
    </section>
  );
}
```

Generate `signup.tsx` analogously, posting to `/api/auth/signup`.

Protected loaders read the session, never a header:

```ts
export async function loader({ context }: LoaderArgs<SessionContext>) {
  return { user: context.session.get("name") ?? "", notice: context.session.get("notice") ?? null };
}
```

`get()` on a flashed key is the read that consumes it.

## Step 7: Wire the manifest

Public routes in one group, protected routes in a group carrying the gate:

```ts
export const app = defineApp({
  shells: { public: "./shells/public.tsx", app: "./shells/app.tsx" },
  middleware: { auth: "./middleware/auth.ts", session: "./middleware/session.ts" },
  api: { middleware: ["session"] },
  routes: [
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/login", "./routes/login.tsx", { render: "ssr" }),
      route("/signup", "./routes/signup.tsx", { render: "ssr" }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
    ]),
  ],
});
```

Anything that reads the session must be `render: "ssr"` — its output is
per-visitor. If the project already has a `defineApp({...})`, merge into it and
preserve the existing shells, middleware, and routes.

## Step 8: Env

Add `SESSION_SECRET=<generate with: openssl rand -base64 32>` to
`.env.example`, and confirm `.env*` is gitignored. Secrets shorter than 16
characters are rejected. To rotate, put the new secret first and keep the old
one for one release.

## Step 9: Verify

- `pracht typegen` (step 7 added routes); `pracht typegen --check` in CI.
- In `pracht dev`: `/dashboard` redirects to `/login?redirect=%2Fdashboard`; a
  successful login lands on `/dashboard`; a failed one lands back on
  `/login?error=1` with the message rendered; logout posts to
  `/api/auth/logout` and clears the cookie.
- `pnpm test`, `pnpm e2e`, and `pracht verify --json` all pass.
- Run `/audit-auth` and `/audit-csrf` to confirm the resulting posture.

## Out of scope

OAuth/OIDC protocol handling, 2FA, password reset, email verification, rate
limiting on the login endpoint, and authorization (roles/permissions). Say so
rather than generating a weak version.

$ARGUMENTS
