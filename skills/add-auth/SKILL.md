---
name: add-auth
version: 1.2.0
description: |
  Wire session-based auth into a pracht app: session utilities, auth middleware,
  login/logout/signup API routes, `<Form>` pages, and public vs. protected route
  groups.
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
`examples/docs/src/routes/docs/recipes-auth.md`; the user replaces
`verifyCredentials()` with a real DB lookup.

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify`/`generate_*`
tools over shelling out. `pracht inspect` needs the pracht plugin in the vite
config.

## Step 1: Confirm the scope

Use `AskUserQuestion` for:

1. **Flavor** — session cookie + email/password (default), magic link, or OAuth
   (out of scope: recommend a dedicated library).
2. **Where credentials live** — an existing DB, or none yet? If none, run
   `/add-db` first.
3. **Cookie posture** — `SameSite=Lax` (default, recommended), `Strict`, or
   `None` + token. See `/audit-csrf`.

## Step 2: Session utilities

`src/server/session.ts` — HMAC-signed cookie payload:

```ts
import { serverEnv } from "@pracht/core/env/server";

export interface Session {
  userId: string;
  email: string;
}

export async function getSession(request: Request): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return null;
  try {
    const [payload, signature] = match[1].split(".");
    if (!payload || !signature) return null;
    if (!(await verify(payload, signature))) return null;
    return JSON.parse(atob(payload));
  } catch {
    return null;
  }
}

export async function createSessionCookie(session: Session): Promise<string> {
  const payload = btoa(JSON.stringify(session));
  const signature = await sign(payload);
  return `session=${payload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

export function clearSessionCookie(): string {
  return "session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

async function getKey(usage: "sign" | "verify"): Promise<CryptoKey> {
  // Read the secret INSIDE the function, never at module scope. On Cloudflare
  // Workers env bindings only exist per request — a module-level read (or
  // throw) bricks the worker at import time. `serverEnv` resolves correctly
  // per adapter (docs/ENV.md).
  const secret = serverEnv.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required");
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function sign(data: string): Promise<string> {
  const key = await getKey("sign");
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verify(data: string, signature: string): Promise<boolean> {
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const key = await getKey("verify");
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(data));
}
```

- `crypto.subtle` works in Node 18+, Cloudflare Workers, and Vercel Edge.
- Verification goes through `crypto.subtle.verify`, which compares in constant
  time. Never compare signature strings with `===` — that leaks timing an
  attacker can use to forge signatures.
- Keep `HttpOnly`, `SameSite=Lax`, and `Secure` on the cookie. Drop `Secure`
  only for plain-HTTP local dev, conditionalized on `NODE_ENV`.

## Step 3: Auth middleware

`src/middleware/auth.ts` — a **Gate**: it short-circuits with a redirect rather
than merely augmenting context (see `/audit-auth` for that distinction).

```ts
import { redirect, type MiddlewareFn } from "@pracht/core";
import { getSession } from "../server/session";

export const middleware: MiddlewareFn = async ({ request, url }, next) => {
  const session = await getSession(request);
  if (!session) {
    const target = encodeURIComponent(url.pathname + url.search);
    return redirect(`/login?redirect=${target}`, { request });
  }
  request.headers.set("x-user-id", session.userId);
  request.headers.set("x-user-email", session.email);
  return next();
};
```

## Step 4: Auth API routes

`src/api/auth/login.ts`:

```ts
import type { ApiRouteArgs } from "@pracht/core";
import { createSessionCookie } from "../../server/session";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const requested = String(form.get("redirect") ?? "/dashboard");

  // The redirect field is user input — gate it, or this is an open redirect.
  const safeRedirect = requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : "/dashboard";

  const user = await verifyCredentials(email, password);
  if (!user) {
    // Redirect back with an error flag — do NOT return a 401 JSON body.
    // Pracht's <Form> only acts on 3xx (it follows `location`); a non-redirect
    // response is silently ignored and the user sees nothing happen.
    const back = new URLSearchParams({ error: "1", redirect: safeRedirect });
    return new Response(null, { status: 302, headers: { location: `/login?${back}` } });
  }

  const cookie = await createSessionCookie({ userId: user.id, email: user.email });
  return new Response(null, {
    status: 302,
    headers: { location: safeRedirect, "set-cookie": cookie },
  });
}

async function verifyCredentials(_email: string, _password: string) {
  // TODO: replace with a real DB lookup + password hash check (argon2 / bcrypt).
  return null as null | { id: string; email: string };
}
```

`src/api/auth/logout.ts` — `POST` returning a 302 to `/` with
`clearSessionCookie()` as `set-cookie`.

`src/api/auth/signup.ts` — same shape as login: validate (`email` present,
`password.length >= 8`), redirect to `/signup?error=1` on failure, otherwise
hash the password, insert the user, and issue `createSessionCookie()` with a
302 to `/dashboard`. Leave the hashing and insert as TODOs for the user.

**Never ship the skeleton without real password hashing (argon2 or bcrypt).**

## Step 5: Login and signup pages

`src/routes/login.tsx`:

```tsx
import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  return {
    redirect: url.searchParams.get("redirect") ?? "/dashboard",
    error: url.searchParams.get("error") === "1",
  };
}

export function head() {
  return { title: "Log in" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="login">
      <h1>Log in</h1>
      {data.error && <p class="error">Invalid email or password.</p>}
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

## Step 6: Wire the manifest

Public routes in one group, protected routes in a group carrying the middleware:

```ts
export const app = defineApp({
  shells: { public: "./shells/public.tsx", app: "./shells/app.tsx" },
  middleware: { auth: "./middleware/auth.ts" },
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

If the project already has a `defineApp({...})`, merge into it — preserve the
existing shells, middleware, and routes.

## Step 7: Env

Add `SESSION_SECRET=<generate with: openssl rand -base64 32>` to
`.env.example`, and confirm `.env*` is gitignored.

## Step 8: Verify

- `pracht typegen` (step 6 added routes); `pracht typegen --check` in CI.
- In `pracht dev`: `/dashboard` redirects to `/login?redirect=%2Fdashboard`; a
  successful login lands on `/dashboard`; a failed one lands back on
  `/login?error=1` with the message rendered; logout posts to
  `/api/auth/logout` and clears the cookie.
- `pnpm test`, `pnpm e2e`, and `pracht verify --json` all pass.
- Run `/audit-auth` and `/audit-csrf` to confirm the resulting posture.

$ARGUMENTS
