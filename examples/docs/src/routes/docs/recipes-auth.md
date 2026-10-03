---
title: Authentication
lead: Session-based auth with @pracht/session — encrypted cookies, middleware gates, login/logout API routes, and password hashing that works on every adapter.
breadcrumb: Authentication
prev:
  href: /docs/recipes/i18n
  title: i18n
next:
  href: /docs/recipes/csp
  title: Content Security Policy
---

## Architecture

Auth in pracht is four pieces, and only one of them is auth-specific:

- **`@pracht/session`** — reads and writes the encrypted session cookie, with
  secret rotation built in.
- **Middleware** — loads the session onto `context.session` and gates the
  routes that need a user.
- **API routes** — log in, log out, sign up.
- **Loaders** — read `context.session` and pass what the page needs.

Keep the user on `context.session`, never on a request header. The client
controls headers, so a middleware that writes `x-user-id` onto the request and
trusts it downstream gates nothing.

```bash
npm install @pracht/session
```

---

## 1. Session Storage

Define one storage instance for the app. The signing secret comes from
[`serverEnv`](/docs/env), which keeps it out of the client bundle.

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
      // The `__Host-` prefix is enforced by the *browser*: it rejects the
      // cookie unless it is Secure, `Path=/`, and host-only. That is what
      // stops a sibling subdomain — or anything that has taken one over —
      // from writing a cookie your app will read. It is also the default,
      // so you can omit `name` entirely.
      name: "__Host-session",
      // Newest first: the first secret seals, every secret opens. Rotating is
      // then a deploy — add the new one at the front, remove the old one once
      // cookies sealed with it have expired — instead of logging everybody out.
      secrets: [serverEnv.SESSION_SECRET as string],
      maxAge: 60 * 60 * 24 * 7,
    },
  });
  return storage;
}
```

Build it **lazily**, inside a function. On Cloudflare Workers, env bindings
exist only per request, so reading `serverEnv` at module load throws.

What the defaults give you:

| | |
| --- | --- |
| `HttpOnly` | on — the cookie is invisible to JavaScript |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | always on with the default `__Host-` name; with an unprefixed name, on except for plain http from a loopback host (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`) |
| Encryption | AES-256-GCM, key derived from the secret with HKDF-SHA256 |
| Expiry | sealed into the encrypted payload, not just `Max-Age` |
| Size | over 4 KB throws instead of emitting a cookie the browser drops |

### `__Host-` and local development

The `__Host-` prefix forces `Secure`, in development too. Chrome 89+ and
Firefox 75+ accept a `Secure` cookie on `http://localhost`, so `pracht dev`
works there. If your browser drops the cookie and login seems broken, use an
unprefixed `name` in development, or run dev over https.

Drop the prefix in production only if the cookie must be shared across
subdomains: the prefix stops other hosts from planting a same-name cookie.

Pass `secure: false` only for http development on a non-localhost hostname. It
throws with a `__Host-`/`__Secure-` name or `sameSite: "None"`.

---

## 2. Session Middleware

Two middleware factories:

- `sessionMiddleware(storage)` **loads** the session onto `context.session`.
  It never blocks.
- `requireSession(storage)` loads it **and gates**: a page request without a
  user is redirected to the login page, an API request gets a `401`.

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

Both load the session before `next()` and commit it after, so a loader can
call `context.session.set(...)` and the cookie lands on its response. A request
that changes nothing emits no `Set-Cookie`. See [Middleware](/docs/middleware)
for the contract.

Type `context.session` once and every loader, API route, and capability sees
it:

```ts [src/env.d.ts]
import type { SessionRequestContext } from "@pracht/session";

import type { AppSession } from "./server/session.ts";

declare module "@pracht/core" {
  interface Register {
    context: SessionRequestContext<AppSession>;
  }
}
```

---

## 3. Password Hashing

`@pracht/session` ships `hashPassword()` / `verifyPassword()` over
PBKDF2-HMAC-SHA256, the one password KDF WebCrypto exposes. They run unchanged
on every adapter.

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

The stored hash records its own parameters, so raising the iteration count
later keeps existing hashes valid.

- **Never** store a plain `SHA-256(password)`; a GPU tries billions per second.
- Prefer Argon2id or scrypt (native module, WASM build, or an identity
  provider) wherever the runtime allows it.
- On Cloudflare Workers, PBKDF2 spends metered CPU time. Measure a login
  against your plan's CPU limit. If it does not fit, pass a lower
  `hashPassword(password, { iterations })` or move hashing off the worker.

---

## 4. Login and Logout

The login page renders the form; an API route validates and issues the
session. Both read a `redirect` target from the request, so both pass it
through the same same-origin check.

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
  // the user onto it. See "Session fixation" below — this line is the fix.
  await session.regenerate();
  session.set("userId", user.id);
  session.set("email", user.email);
  session.set("name", user.name);
  session.flash("notice", `Welcome back, ${user.name}.`);

  return storage.commit(session, redirect(target, { request }));
}
```

`storage.commit(session, response)` **appends** the `Set-Cookie`, so cookies
set elsewhere on the response survive.

### Session fixation

Call `session.regenerate()` on **every privilege change**: right after
credentials verify, and after anything that raises what the session can do
(completing 2FA, assuming an admin role). It issues a new id, keeps the data,
and drops the old record.

It matters once you add a `store`, where the cookie is only a pointer. Someone
who can write a cookie for your host plants an id they know and waits for the
victim to log in. Cookie-only sessions are not exposed, but the call keeps the
login path correct if you add a store later.

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

Log out with a form. It must be a `POST`: a `GET` logout link is a one-click
CSRF, and link scanners prefetch it.

```tsx
import { Form } from "@pracht/core";

<Form method="post" action="/api/auth/logout">
  <button type="submit">Log out</button>
</Form>
```

Signup has the same shape as login: validate (`email` present,
`password.length >= 8`), redirect back to `/signup?error=…` on failure,
otherwise `hashPassword()`, insert the user, and issue the session.

---

## 5. Reading the User in Loaders

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

Loader data is serialized to the client. Return only what the component
renders — never the whole session, never a password hash.

---

## 6. Wire It Up

Public routes in one group, protected routes in a group carrying the gate:

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
  // Every mutation API route can see the session; only the gated group is
  // gated. Individual handlers still check what they need.
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

Use `render: "ssr"` for anything that reads the session: its output is
per-visitor, so it cannot be prerendered. The middleware adds `Vary: Cookie`
to responses, except on `ssg`/`isg` routes.

Run [`/audit-auth`](/docs/coding-agents) to confirm every route you expect to be
protected actually resolves the gate.

---

## 7. Server-Side Sessions

By default the encrypted session data travels in the cookie. Pass a `store` and
the cookie carries only a sealed session id. Use one when the session outgrows
4 KB, when logout must end the session in every browser, or when the data must
stay on the server.

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
          // Cloudflare KV takes an absolute expiration in seconds; the store
          // then reaps the record without a cron job.
          expiration: Math.floor(expiresAt / 1000),
        });
      },
      async delete(id) {
        await KV.delete(`session:${id}`);
      },
    },
  });
}
```

`KV` is a Workers binding, so build the storage inside the request (see
[Full-Stack Cloudflare](/docs/recipes/fullstack-cloudflare)). Any backend with
`get`, `set(id, data, expiresAt)`, and `delete` works: D1, Durable Objects,
Redis, Postgres. `createMemorySessionStore()` is for tests and single-process
dev servers, not production.

---

## 8. How Sessions Expire

`maxAge` counts from the last write, and the middleware writes only when the
session changed. A user who browses longer than `maxAge` without changing
anything is logged out mid-session.

To make `maxAge` an **idle** timeout instead, pass `rolling`:

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

The cost is a `Set-Cookie` on every response and, with a `store`, a write per
request. Anonymous visitors still get no cookie.

**`rolling` and cached routes.** A response with a `Set-Cookie` is never
cached, so `ssg` or `isg` routes under rolling-session middleware go uncached
for every signed-in visitor. Put that middleware on the group holding your
`ssr` routes, not on one that spans prerendered pages.

`destroySession()` ends a session immediately; with a `store`, in every
browser holding the cookie.

---

## 9. CSRF

In a CSRF attack, a malicious site submits a form to your API and the browser
attaches the session cookie.

### Built in: same-origin enforcement (on by default)

State-changing API requests (`POST`/`PUT`/`PATCH`/`DELETE`) get a `403` unless
the browser signals a same-origin request: `Sec-Fetch-Site: same-origin`, or an
`Origin`/`Referer` matching the request's origin. `same-site` is rejected,
since a sibling subdomain can be hostile. Requests without browser provenance
headers (curl, server-to-server, tests) pass.

The check runs before API middleware and is controlled by
[`ApiConfig.requireSameOrigin`](/docs/api-routes), default `true`. Turn it off
only if your own middleware provides CSRF protection:

```ts [src/routes.ts]
import { defineApp } from "@pracht/core";

defineApp({
  api: {
    middleware: ["session"],
    requireSameOrigin: false, // default: true
  },
  routes: [],
});
```

That blocks cross-site form CSRF for a first-party app. Two more layers:

### 1. `SameSite` on the session cookie

The default `SameSite=Lax` keeps the cookie off cross-site
`POST`/`PUT`/`PATCH`/`DELETE` requests in modern browsers. Keep it alongside
the built-in check. Use `sameSite: "Strict"` if links from other sites need not
arrive signed in.

### 2. Custom origin middleware (allowlists)

The built-in check accepts only your own origin. If trusted cross-origin
callers (an admin app on another domain) must reach your mutation endpoints,
or you disabled `requireSameOrigin`, add a middleware with an allowlist:

```ts [src/middleware/origin-check.ts]
import type { MiddlewareFn } from "@pracht/core";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED = new Set<string>([
  // add trusted cross-origin callers here (e.g. "https://admin.example.com")
]);

export const middleware: MiddlewareFn = ({ request, url }, next) => {
  if (!UNSAFE.has(request.method)) return next();

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

Wire it to the API and turn off the built-in check, which would reject the
allowlisted origins first:

```ts
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

This checks headers; it issues no tokens. Pair it with `SameSite` cookies, and
add synchronizer tokens only if you need them, for example with
`sameSite: "None"` for embedding. Run [`/audit-csrf`](/docs/coding-agents) to
check the posture end to end.

---

## 10. Env

Add the secret to `.env.example`, and confirm `.env*` is gitignored:

```bash
SESSION_SECRET="$(openssl rand -base64 32)"
```

`createSessionStorage()` throws on secrets shorter than 16 characters.

To rotate, put the new secret first and keep the old one until cookies sealed
with it have expired:

```ts
import { serverEnv } from "@pracht/core/env/server";

const secrets = [
  serverEnv.SESSION_SECRET_V2 as string,
  serverEnv.SESSION_SECRET as string,
];
```

Existing cookies still open under the old secret, and each is re-sealed with
the new one on its next commit.

---

## What This Does Not Cover

`@pracht/session` is session storage, not an auth framework. Out of scope:

- **OAuth / OIDC providers** ("Sign in with GitHub"). Handle the callback in an
  API route, verify the provider's response with a protocol library (`arctic`,
  `openid-client`, or the provider's SDK), then put the user id in the session
  as in the password flow.
- **Multi-factor auth.** Keep an `mfaVerified` flag in the session and gate on
  it with `requireSession(storage, { isAuthenticated })`.
- **Password reset and email verification.** Both need single-use, expiring,
  out-of-band tokens and an email sender.
- **Rate limiting.** Without it, a login endpoint is an online password oracle.
  Use the platform's (Cloudflare Rate Limiting, Vercel Firewall) or a counter
  in your session store.
- **Authorization.** Sessions say who the user is. Enforce roles, permissions,
  and record ownership in loaders and handlers, not only in the UI.
