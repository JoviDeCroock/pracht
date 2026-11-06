---
title: Authentication
lead: "Session auth with `@pracht/session`: encrypted cookies, middleware gates, login and logout routes, and password hashing on every adapter."
---

This recipe adds password login: an encrypted session cookie, a middleware gate that sends anonymous visitors to `/login`, and login, logout, and signup endpoints.

> [!WARNING]
> Keep the user on `context.session`, never on a request header. The client controls headers, so a middleware that writes `x-user-id` onto the request and trusts it downstream gates nothing.

## 1. Install

```bash
pnpm add @pracht/session
```

Generate a secret into `.env`, and confirm `.env*` is gitignored:

```bash
echo "SESSION_SECRET=$(openssl rand -base64 32)" >> .env
```

`createSessionStorage()` throws if any secret is shorter than 16 characters.

## 2. Session storage

Define one storage instance for the app. Read the secret from [`serverEnv`](/docs/env) so it stays out of the client bundle.

```ts [src/server/session.ts]
import { serverEnv } from "@pracht/core/env/server";
import { createSessionStorage, type SessionRequestContext, type SessionStorage } from "@pracht/session";

export interface AppSession extends Record<string, unknown> {
  userId: string;
  email: string;
  name: string;
  /** Flash message — consumed by the first read after it is set. */
  notice: string;
}

export type SessionContext = SessionRequestContext<AppSession>;

let storage: SessionStorage<AppSession> | undefined;

export function sessions(): SessionStorage<AppSession> {
  storage ??= createSessionStorage<AppSession>({
    cookie: {
      // The default name. The browser rejects a `__Host-` cookie unless it is
      // Secure, `Path=/`, and host-only, so a sibling subdomain cannot plant one.
      name: "__Host-session",
      // Newest first: the first secret seals, every secret opens.
      secrets: [serverEnv.SESSION_SECRET as string],
      maxAge: 60 * 60 * 24 * 7,
    },
  });
  return storage;
}
```

Build the storage lazily inside a function: on Cloudflare Workers, env bindings exist only per request, so reading `serverEnv` at module load throws.

| Setting | Default |
| --- | --- |
| `name` | `__Host-session` |
| `maxAge` | One week, counted from the last write |
| `HttpOnly` | On; JavaScript cannot read the cookie |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | Always on with a `__Host-` or `__Secure-` name; otherwise on except for plain http from `localhost`, `*.localhost`, `127.0.0.1`, or `[::1]` |
| Encryption | AES-256-GCM, key derived from the secret with HKDF-SHA256 |
| Size | Over 4 KB throws |

### `__Host-` and local development

The `__Host-` prefix forces `Secure` in development too, which Chrome 89+ and Firefox 75+ accept on `http://localhost`. If login seems to do nothing because your browser drops the cookie, use an unprefixed `name` in development or run dev over https. In production, drop the prefix only when the cookie must be shared across subdomains.

`secure: false` is for http development on a non-localhost hostname; it throws with a `__Host-` or `__Secure-` name, or with `sameSite: "None"`.

## 3. Session middleware

Create two middleware files:

- `sessionMiddleware(storage)` loads the session onto `context.session` and never blocks.
- `requireSession(storage)` loads it and gates. A page request without a user is redirected to the login page with `?redirect=<route path>`; an API request gets `401` with `{"error":"unauthorized"}`.

```ts [src/middleware/session.ts]
import type { MiddlewareFn } from "@pracht/core";
import { sessionMiddleware } from "@pracht/session";

import { sessions } from "../server/session.ts";

let loader: MiddlewareFn | undefined;

export const middleware: MiddlewareFn = (args, next) => {
  loader ??= sessionMiddleware(sessions());
  return loader(args, next);
};
```

```ts [src/middleware/auth.ts]
import type { MiddlewareFn } from "@pracht/core";
import { requireSession } from "@pracht/session";

import { sessions } from "../server/session.ts";

let gate: MiddlewareFn | undefined;

export const middleware: MiddlewareFn = (args, next) => {
  gate ??= requireSession(sessions(), { loginPath: "/login" });
  return gate(args, next);
};
```

Both commit the session after `next()`, so a loader can call `context.session.set(...)` and the cookie lands on its response; a request that changes nothing gets no `Set-Cookie`. `requireSession` treats a session with a `userId` as authenticated; pass `isAuthenticated(session)` to change that. See [Middleware](/docs/middleware) for the contract.

Type `context.session` once for every loader, API route, and capability:

```ts [src/env.d.ts]
import type { SessionRequestContext } from "@pracht/session";

import type { AppSession } from "./server/session.ts";

declare module "@pracht/core" {
  interface Register {
    context: SessionRequestContext<AppSession>;
  }
}
```

## 4. Password hashing

Hash with `hashPassword()` and check with `verifyPassword()`. Both use PBKDF2-HMAC-SHA256 through WebCrypto, so they run on every adapter.

```ts [src/server/users.ts]
import { hashPassword, verifyPassword } from "@pracht/session";

export interface User {
  id: string;
  email: string;
  name: string;
}

export async function createUser(email: string, name: string, password: string) {
  const passwordHash = await hashPassword(password);
  return await db.users.insert({ email, name, passwordHash });
}

export async function verifyCredentials(email: string, password: string): Promise<User | null> {
  const row = await db.users.findByEmail(email.trim().toLowerCase());
  if (!row) return null;
  return (await verifyPassword(password, row.passwordHash)) ? row : null;
}
```

The stored hash records its own parameters, so raising the iteration count later keeps existing hashes valid.

- Never store a plain `SHA-256(password)`.
- Prefer Argon2id or scrypt (native module, WASM build, or an identity provider) where the runtime allows it.
- On Cloudflare Workers, PBKDF2 spends metered CPU time. If a login exceeds your plan's CPU limit, pass a lower `hashPassword(password, { iterations })` or hash off the worker.

## 5. Login and logout

The login page renders the form, and an API route validates and issues the session. Both read a `redirect` target from user input, so both pass it through one same-origin check:

```ts [src/server/redirects.ts]
// The redirect target is user input. Parse it before trusting it: URL parsing
// turns `\` into `/` and drops tabs, so `/\evil.com` starts with `/` but
// lands on another origin.
export function safeRedirectPath(value: unknown, base: URL, fallback: string): string {
  if (typeof value !== "string" || !value.startsWith("/")) return fallback;
  try {
    const target = new URL(value, base);
    return target.origin === base.origin
      ? `${target.pathname}${target.search}${target.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
```

```ts [src/api/auth/login.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";

import { safeRedirectPath } from "../../server/redirects.ts";
import { sessions } from "../../server/session.ts";
import { verifyCredentials } from "../../server/users.ts";

export async function POST({ request, url }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const target = safeRedirectPath(form.get("redirect"), url, "/dashboard");

  const user = await verifyCredentials(email, password);
  if (!user) {
    // `<Form>` acts on 3xx responses; a 401 JSON body leaves the page looking
    // like nothing happened.
    return redirect(`/login?error=1&redirect=${encodeURIComponent(target)}`, { request });
  }

  const storage = sessions();
  const session = await storage.getSession(request);
  // Rotate the session id at the moment of privilege change, before writing
  // the user onto it. See "Session fixation" below.
  await session.regenerate();
  session.set("userId", user.id);
  session.set("email", user.email);
  session.set("name", user.name);
  session.flash("notice", `Welcome back, ${user.name}.`);

  return storage.commit(session, redirect(target, { request }));
}
```

`storage.commit(session, response)` appends the `Set-Cookie`, so cookies set elsewhere on the response survive.

```tsx [src/routes/login.tsx]
import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

import { safeRedirectPath } from "../server/redirects.ts";

export async function loader({ url }: LoaderArgs) {
  return {
    error: url.searchParams.get("error") === "1",
    // Reflecting an unvalidated `?redirect=` back into the form hands an
    // attacker an open redirect through a legitimate-looking login link.
    redirect: safeRedirectPath(url.searchParams.get("redirect"), url, "/dashboard"),
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
        <label>
          Email
          <input type="email" name="email" required />
        </label>
        <label>
          Password
          <input type="password" name="password" required />
        </label>
        <button type="submit">Log in</button>
      </Form>
    </section>
  );
}
```

Submitting valid credentials sets the session cookie and redirects to the `redirect` target. Wrong credentials land back on `/login?error=1` with the alert shown.

```ts [src/api/auth/logout.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";

import { sessions } from "../../server/session.ts";

export async function POST({ request }: ApiRouteArgs) {
  const storage = sessions();
  const session = await storage.getSession(request);
  // Drops the store record (when one is configured) and puts an
  // immediately-expiring cookie on the response.
  return storage.destroy(session, redirect("/", { request }));
}
```

Log out with a `POST` form; a `GET` logout link is a one-click CSRF, and link scanners prefetch it.

```tsx
import { Form } from "@pracht/core";

<Form method="post" action="/api/auth/logout">
  <button type="submit">Log out</button>
</Form>
```

Signup has the same shape as login: validate, redirect to `/signup?error=…` on failure, otherwise `createUser()` and issue the session.

### Session fixation

Call `session.regenerate()` on every privilege change: after credentials verify, after completing 2FA, after assuming an admin role. It issues a new id, keeps the data, and drops the old store record. With a `store`, this stops an attacker who planted a known session id from inheriting the login; cookie-only sessions are not exposed, but the call keeps the login path correct if you add a store later.

## 6. Read the user in loaders

Behind the middleware, loaders read `context.session`:

```tsx [src/routes/dashboard.tsx]
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

import type { SessionContext } from "../server/session.ts";

export async function loader({ context }: LoaderArgs<SessionContext>) {
  const userId = context.session.get("userId") as string;
  return {
    // `get()` on a flashed key is the read that consumes it: the message
    // shows once after the redirect and is gone from the next request.
    notice: context.session.get("notice") ?? null,
    projects: await db.projects.findMany({ userId }),
    user: context.session.get("name") ?? "",
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      {data.notice && <p role="status">{data.notice}</p>}
      <h1>{data.user}</h1>
      <ul>
        {data.projects.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

Loader data is serialized to the client. Return only what the component renders, never the whole session.

## 7. Wire it up

Put public routes in one group and protected routes in a group carrying the gate:

```ts [src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
    session: "./middleware/session.ts",
  },
  // Every API route can see the session; only the gated group is gated.
  // Individual handlers still check what they need.
  api: { middleware: ["session"] },
  routes: [
    // Public — no gate.
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/login", "./routes/login.tsx", { render: "ssr" }),
      route("/signup", "./routes/signup.tsx", { render: "ssr" }),
    ]),

    // Protected — the gate redirects anonymous visitors to /login.
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/settings", "./routes/settings.tsx", { render: "ssr" }),
    ]),
  ],
});
```

Open `/dashboard` in a fresh browser: you are redirected to `/login?redirect=%2Fdashboard`, and after logging in you land back on `/dashboard` with the welcome notice.

Use `render: "ssr"` for anything that reads the session; per-visitor output cannot be prerendered. Run [`/audit-auth`](/docs/coding-agents) to confirm every route you expect to be protected resolves the gate.

## Server-side sessions

Pass a `store` and the cookie carries only a sealed session id instead of the data. Use one when the session outgrows 4 KB, when logout must end the session in every browser, or when the data must stay on the server.

```ts [src/server/session.ts]
import { createSessionStorage } from "@pracht/session";
import { serverEnv } from "@pracht/core/env/server";

export function sessions() {
  return createSessionStorage<AppSession>({
    cookie: { name: "__Host-session", secrets: [serverEnv.SESSION_SECRET as string] },
    store: {
      async get(id) {
        return await KV.get(`session:${id}`, "json");
      },
      async set(id, data, expiresAt) {
        await KV.put(`session:${id}`, JSON.stringify(data), {
          // Cloudflare KV takes an absolute expiration in seconds, at least 60
          // seconds out, and then reaps the record without a cron job. The
          // sealed cookie still ends the session at `expiresAt`.
          expiration: Math.max(Math.floor(expiresAt / 1000), Math.ceil(Date.now() / 1000) + 60),
        });
      },
      async delete(id) {
        await KV.delete(`session:${id}`);
      },
    },
  });
}
```

`KV` is a Workers binding, so build the storage inside the request (see [Full-stack Cloudflare](/docs/recipes/fullstack-cloudflare)). Any backend with `get`, `set(id, data, expiresAt)`, and `delete` works: D1, Durable Objects, Redis, Postgres. `createMemorySessionStore()` is for tests and single-process dev servers.

## Session expiry

`maxAge` counts from the last write, and the middleware writes only when the session changed, so a user who browses longer than `maxAge` without changing anything is logged out. Pass `rolling` to make `maxAge` an idle timeout:

```ts
import { serverEnv } from "@pracht/core/env/server";
import { createSessionStorage } from "@pracht/session";

createSessionStorage<AppSession>({
  cookie: { name: "__Host-session", secrets: [serverEnv.SESSION_SECRET as string], maxAge: 60 * 30 },
  // Every request under sessionMiddleware() re-seals the cookie, so the
  // 30-minute window is measured from the last request rather than the last
  // write.
  rolling: true,
});
```

Every response then carries a `Set-Cookie`, and with a `store` every request writes to it. Anonymous visitors still get no cookie.

Add `absoluteMaxAge` (seconds) to cap a rolling session's total lifetime: `absoluteMaxAge: 60 * 60 * 12` signs everyone out 12 hours after sign-in, however active. The cap counts from the first commit or the last `regenerate()`.

> [!WARNING]
> A response with a `Set-Cookie` is never cached, so `ssg` and `isg` routes under rolling-session middleware go uncached for every signed-in visitor. Put that middleware on the group holding your `ssr` routes.

`storage.destroySession(session)` ends a session immediately; with a `store`, in every browser holding the cookie.

## Rotate the secret

Put the new secret first and keep the old one until cookies sealed with it have expired: `maxAge` after you deploy the new secret, or longer if you pass a larger `maxAge` to `commit()`.

```ts
import { serverEnv } from "@pracht/core/env/server";

const secrets = [
  serverEnv.SESSION_SECRET_V2 as string,
  serverEnv.SESSION_SECRET as string,
];
```

New cookies are sealed with the first secret, every listed secret opens existing ones, and a cookie is re-sealed with the new secret the next time its session is written. Removing the old secret too early logs out everyone still holding a cookie sealed with it.

## CSRF protection

pracht rejects cross-site mutations by default. A `POST`, `PUT`, `PATCH`, or `DELETE` to an API route gets `403 Cross-origin request blocked` unless the browser marks it same-origin; `same-site` requests are rejected too. Requests without browser provenance headers (curl, server-to-server, tests) pass. The check runs before API middleware and is controlled by [`ApiConfig.requireSameOrigin`](/docs/api-routes), default `true`.

Keep the default `SameSite=Lax` cookie alongside it, or use `sameSite: "Strict"` if links from other sites need not arrive signed in.

### Allow trusted cross-origin callers

To accept mutations from another origin you trust (an admin app on another domain), replace the built-in check with a middleware that carries an allowlist:

```ts [src/middleware/origin-check.ts]
import type { MiddlewareFn } from "@pracht/core";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED = new Set<string>([
  // add trusted cross-origin callers here (e.g. "https://admin.example.com")
]);

export const middleware: MiddlewareFn = ({ request, url }, next) => {
  // WebSocket upgrades are GETs that carry the user's cookies, so they are
  // checked too: `requireSameOrigin: false` also turns off the built-in
  // upgrade check.
  const upgrade = request.headers.has("upgrade");
  if (!UNSAFE.has(request.method) && !upgrade) return next();

  const origin = request.headers.get("origin");
  if (origin === null) {
    // No Origin header: either a non-browser client or an attacker dodging
    // the check. Sec-Fetch-Site tells us when the browser itself marked the
    // request as same-origin or user-initiated.
    const site = request.headers.get("sec-fetch-site");
    if (site === "same-origin" || site === "none") return next();
    return new Response("Forbidden: missing Origin", { status: 403 });
  }

  if (origin === url.origin) return next();
  if (ALLOWED.has(origin)) return next();

  return new Response(`Forbidden: origin ${origin} not allowed`, { status: 403 });
};
```

Wire it to the API and turn off the built-in check, which would reject the allowlisted origins first:

```ts [src/routes.ts]
import { defineApp } from "@pracht/core";

defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    originCheck: "./middleware/origin-check.ts",
  },
  api: { middleware: ["originCheck"], requireSameOrigin: false },
  routes: [],
});
```

This checks headers and issues no tokens; add synchronizer tokens if you need them, for example with `sameSite: "None"` for embedding. Run [`/audit-csrf`](/docs/coding-agents) to check the posture end to end.

## Out of scope

`@pracht/session` is session storage, not an auth framework. Build these yourself:

- **OAuth / OIDC** ("Sign in with GitHub"). Handle the callback in an API route, verify it with a protocol library (`arctic`, `openid-client`, or the provider's SDK), then put the user id in the session.
- **Multi-factor auth.** Keep an `mfaVerified` flag in the session and gate on it with `requireSession(storage, { isAuthenticated })`.
- **Password reset and email verification.** Both need single-use, expiring, out-of-band tokens and an email sender.
- **Rate limiting.** Without it, a login endpoint is an online password oracle. Use the platform's (Cloudflare Rate Limiting, Vercel Firewall) or a counter in your store.
- **Authorization.** Sessions say who the user is. Enforce roles, permissions, and record ownership in loaders and handlers, not only in the UI.
