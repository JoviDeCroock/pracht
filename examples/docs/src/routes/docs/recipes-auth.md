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

- **`@pracht/session`** — reads and writes the session cookie. Encrypted with
  AES-256-GCM, expiry sealed into the payload, secret rotation built in.
- **Middleware** — loads the session onto `context.session` and gates the
  routes that need a user.
- **API routes** — log in, log out, sign up.
- **Loaders** — read `context.session` and pass what the page needs.

The session is server-side state that happens to travel in a cookie. It is
never a request header: the client controls those, so a middleware that writes
`x-user-id` onto the incoming request and trusts it downstream has gated
nothing. (On Cloudflare Workers it does not even run — the incoming `Request`
is immutable there.)

```bash
npm install @pracht/session
```

---

## 1. Session Storage

Define one storage instance for the app. The signing secret comes from
[`serverEnv`](/docs/env), which keeps it out of the client bundle and resolves
per adapter.

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
      // then a deploy — add the new one at the front, remove the old one on
      // the next release — instead of logging everybody out.
      secrets: [serverEnv.SESSION_SECRET as string],
      maxAge: 60 * 60 * 24 * 7,
    },
  });
  return storage;
}
```

Build it **lazily**, inside a function. On Cloudflare Workers env bindings only
exist per request, so reading `serverEnv` while the module is still evaluating
throws and takes the worker down at import time.

What the defaults give you, without configuration:

| | |
| --- | --- |
| `HttpOnly` | on — the cookie is invisible to JavaScript |
| `SameSite` | `Lax` |
| `Path` | `/` |
| `Secure` | on, except for plain http on `localhost`/`127.0.0.1`/`[::1]` |
| Encryption | AES-256-GCM, key derived from the secret with HKDF-SHA256 |
| Expiry | sealed into the payload, so a client that ignores `Max-Age` gains nothing |
| Size | over 4 KB throws instead of emitting a cookie the browser silently drops |

### `__Host-` and local development

The prefix forces `Secure` on, in development too. Chrome 89+ and Firefox 75+
treat `http://localhost` as a trustworthy origin and accept a `Secure` cookie
there, so `pracht dev` works unchanged in those browsers. A browser that does
not will drop the cookie and the app will look like it cannot log in — use an
unprefixed `name` for local development if you hit that, or run dev over
https.

Drop the prefix permanently only if the cookie genuinely has to be shared
across subdomains. It is what makes same-name duplicate cookies impossible: a
cookie is identified by its name *plus* its domain and path, and `__Host-`
pins both, so nothing can plant a second cookie of the same name for your app
to trip over.

The `Secure` default **fails closed**. It would be tempting to infer it from
`request.url` being https, but a production app behind a TLS-terminating proxy
sees `http://` there unless the adapter is told to trust the forwarding
headers — `@pracht/adapter-node` defaults to `trustProxy: false` — so that
inference would drop `Secure` on exactly the deployments that need it. The
attribute is therefore set for every request except plain http from a local
host. Pass `secure: false` only for http development on a non-localhost
hostname; it is refused outright for a `__Host-`/`__Secure-` name or
`sameSite: "None"`, because the browser would discard the result.

---

## 2. Session Middleware

Two middleware factories, and the difference matters:

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

Both run wrap-around: they load the session before `next()` and commit it
after. That is what lets a loader deep in the chain call
`context.session.set(...)` and still have the cookie land on the response that
loader produced — see [Middleware](/docs/middleware) for the contract. A
request that changes nothing emits no `Set-Cookie`.

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
PBKDF2-HMAC-SHA256 — the only password KDF WebCrypto exposes, and therefore
the only one that runs unchanged on Node, Cloudflare Workers, Netlify, and
Vercel.

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

The stored string records its own parameters
(`pbkdf2-sha256$<iterations>$<salt>$<hash>`), so raising the iteration count
later does not invalidate existing hashes.

- **Never** store a plain `SHA-256(password)`. A GPU tries billions of those
  per second; that is what the iteration count exists to prevent.
- Argon2id and scrypt are stronger primitives. Use them (native module, WASM
  build, or an identity provider) wherever the runtime allows it.
- PBKDF2 burns CPU time, which is the metered resource on Cloudflare Workers.
  Measure a login against your plan's CPU limit and lower `iterations` — or
  move hashing off the worker — if it does not fit.

---

## 4. Login and Logout

The login page renders the form; an API route validates and issues the
session.

```ts [src/api/auth/login.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";

import { sessions } from "../../server/session.ts";
import { verifyCredentials } from "../../server/users.ts";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");

  // The redirect target is user input. Anything that is not a plain
  // root-relative path is an open redirect waiting to happen.
  const requested = String(form.get("redirect") ?? "/dashboard");
  const target =
    requested.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard";

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

`storage.commit(session, response)` **appends** the `Set-Cookie` — it never
replaces one the response already carries, so a locale or consent cookie set
elsewhere survives.

### Session fixation

`session.regenerate()` issues a new id, keeps the data, and drops the record
the old id pointed at. Call it on **every privilege change** — right after
credentials verify, and again after anything else that raises what the session
can do (completing 2FA, assuming an admin role).

The attack it closes: anything that can write a cookie for your host — a
sibling subdomain, an XSS, plain http on a shared network — plants a session
id it already knows, waits for the victim to log in, and then uses its copy.
With a `store` the cookie is a *pointer*, so the planted pointer ends up
addressing an authenticated record. Rotating the id at login means it no
longer names anything.

Cookie sessions are not vulnerable to this: the cookie carries the sealed
*data*, not a pointer to it, so a replayed copy still decrypts to the
anonymous session it was sealed with. Call `regenerate()` anyway — it costs
nothing there, and it means the login path is already correct if you move to a
store later.

```tsx [src/routes/login.tsx]
import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  const requested = url.searchParams.get("redirect") ?? "/dashboard";
  return {
    error: url.searchParams.get("error") === "1",
    // Reflecting an unvalidated `?redirect=` back into the form hands an
    // attacker an open redirect through a legitimate-looking login link.
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

Trigger logout from anywhere with a form. It must be a `POST` — a `GET` logout
link is a one-click CSRF and gets pre-fetched by link scanners:

```tsx
<Form method="post" action="/api/auth/logout">
  <button type="submit">Log out</button>
</Form>
```

Signup is the same shape as login: validate (`email` present,
`password.length >= 8`), redirect back to `/signup?error=…` on failure,
otherwise `hashPassword()`, insert the user, and issue the session.

---

## 5. Reading the User in Loaders

Behind the middleware, loaders read `context.session`. Never a request header.

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

Use `render: "ssr"` for anything that reads the session — its output is
per-visitor, so it can never be prerendered. The middleware knows this: it
marks responses `Vary: Cookie`, and deliberately skips that on `ssg`/`isg`
routes, whose stored output must not depend on a cookie.

Run [`/audit-auth`](/docs/agent-skills) to confirm every route you expect to be
protected actually resolves the gate.

---

## 7. Server-Side Sessions

By default the (encrypted) session data travels in the cookie. Pass a `store`
and the cookie carries only a sealed 128-bit id instead. That is the right
shape when the session outgrows 4 KB, when logout has to invalidate the
session everywhere rather than just in the browser that asked, or when the
data must never leave the server.

```ts [src/server/session.ts]
import { createSessionStorage } from "@pracht/session";

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

`KV` above is a Workers binding, so build the storage inside the request (see
[Full-Stack Cloudflare](/docs/recipes/fullstack-cloudflare)). The same
three-method interface fits D1, Durable Objects, Redis, and Postgres —
`get`, `set(id, data, expiresAt)`, `delete`. `createMemorySessionStore()` is
exported for tests and single-process dev servers; it is not a production
store.

---

## 8. How Sessions Expire

The lifetime is **absolute from the last write**. `maxAge` counts from the most
recent `commitSession()`, and the expiry is sealed into the payload, so a
client that ignores `Max-Age` gains nothing.

The middleware commits **only when the session changed** during the request. A
page that just reads `context.session` emits no `Set-Cookie` — which keeps
read-only responses cacheable, but also means a user who browses for longer
than `maxAge` without changing anything is logged out mid-session.

If you want `maxAge` to behave as an **idle** timeout instead, pass `rolling`:

```ts
createSessionStorage<AppSession>({
  cookie: { name: "__Host-session", secrets: [serverEnv.SESSION_SECRET as string], maxAge: 60 * 30 },
  // Every request under sessionMiddleware() re-seals the cookie, so the
  // 30-minute window is measured from the last request rather than the last
  // write.
  rolling: true,
});
```

The cost is a `Set-Cookie` on every response and — with a `store` — a store
write per request. An anonymous visitor still receives no cookie either way:
`rolling` only re-commits a session that already exists.

**`rolling` and cached routes.** A response carrying a `Set-Cookie` is never
stored in a shared cache — pracht's own ISG check treats one as "this output
is specific to this visitor" — so putting `rolling` on a route group that
contains `ssg` or `isg` routes makes those routes stop being cached for every
signed-in visitor, while anonymous traffic still gets the cached copy. That is
correct behaviour (the alternative is serving one user's cookie to the next),
but it is easy to enable by accident. Keep `rolling` on the group that holds
the per-visitor `ssr` routes, not on one that spans your prerendered pages.

Independently of both, `destroySession()` ends a session immediately, and with
a `store` it ends it for every browser holding the cookie rather than only the
one that asked.

---

## 9. CSRF

Session cookies are the ambient credential a CSRF attack abuses: a malicious
site submits a form to your API and the browser attaches the cookie
automatically.

### Built in: same-origin enforcement (on by default)

Pracht ships this defense in the runtime. State-changing API requests
(`POST`/`PUT`/`PATCH`/`DELETE`) are rejected with a `403` unless the browser
signals an exact same-origin request — `Sec-Fetch-Site: same-origin`, or an
`Origin`/`Referer` header matching the request URL's origin.
`Sec-Fetch-Site: same-site` is deliberately **not** accepted, because sibling
subdomains can be attacker-controlled. Requests with no browser provenance
headers at all (curl, server-to-server, tests) are allowed — a browser form
can't produce those.

This runs before API middleware, is controlled by
[`ApiConfig.requireSameOrigin`](/docs/api-routes), and defaults to `true`. Opt
out only if you build your own CSRF protection into middleware:

```ts [src/routes.ts]
defineApp({
  api: {
    middleware: ["session"],
    requireSameOrigin: false, // default: true
  },
  routes: [...],
});
```

So for a first-party app, cross-site form CSRF is blocked out of the box. The
layers below still matter — here's when:

### 1. `SameSite` on the session cookie

`@pracht/session` sets `SameSite=Lax` by default, which keeps the cookie off
cross-site `POST`/`PUT`/`PATCH`/`DELETE` submissions in every modern browser,
so the attack fails before the server-side check even runs. Use
`sameSite: "Strict"` if you don't need inbound links from other sites to
arrive authenticated. Keep this layer — cookie scoping and origin enforcement
protect against different failure modes.

### 2. Custom origin middleware (allowlists)

The built-in check accepts exactly one origin: your own. If trusted
cross-origin callers need to hit your mutation endpoints (e.g. an admin app on
another domain), or you disabled `requireSameOrigin`, add a middleware with an
explicit allowlist:

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

Wire it to the whole API (or just mutation groups) in `routes.ts`, and turn the
stricter built-in check off since it would reject the allowlisted origins
first:

```ts
defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    originCheck: "./middleware/origin-check.ts",
  },
  api: { middleware: ["originCheck"], requireSameOrigin: false },
  routes: [...],
});
```

This is a pure header check — it doesn't issue or validate tokens. Pair it with
`SameSite` cookies; skip synchronizer tokens unless you explicitly need them
(e.g. you allow `sameSite: "None"` for embedding). Run
[`/audit-csrf`](/docs/agent-skills) to check the posture end to end.

---

## 10. Env

Add the secret to `.env.example`, and confirm `.env*` is gitignored:

```bash
SESSION_SECRET="$(openssl rand -base64 32)"
```

`createSessionStorage()` refuses secrets shorter than 16 characters — a short
one is brute-forceable offline from a single stolen cookie.

To rotate: put the new secret first and keep the old one for one release.

```ts
secrets: [serverEnv.SESSION_SECRET_V2 as string, serverEnv.SESSION_SECRET as string];
```

Every existing cookie still opens under the old secret and is re-sealed with
the new one on its next commit, so the old secret can be dropped in the next
deploy with nobody logged out.

---

## What This Does Not Cover

`@pracht/session` is session storage. It is deliberately not an auth
framework, and these are out of scope:

- **OAuth / OIDC providers** ("Sign in with GitHub"). Handle the callback in an
  API route (`src/api/auth/callback.ts`), verify the provider's response with
  a library that knows the protocol (`arctic`, `openid-client`, or the
  provider's SDK), then put the resulting user id in the session exactly like
  the password flow above. The session half is identical; the provider half is
  not something to hand-roll.
- **Multi-factor auth.** TOTP enrolment, recovery codes, and WebAuthn all need
  their own storage and UI. Keep a `mfaVerified` flag in the session and gate
  on it with `requireSession({ isAuthenticated })`.
- **Password reset and email verification.** Both need single-use, expiring,
  out-of-band tokens and an email sender.
- **Rate limiting.** A login endpoint without one is an online password oracle.
  Use the platform's (Cloudflare Rate Limiting, Vercel Firewall) or a counter
  in the same store the sessions use.
- **Authorization.** Sessions answer "who is this". Roles, permissions, and
  per-record ownership are app logic — enforce them in loaders and handlers,
  not only in the UI.
