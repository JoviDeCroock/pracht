---
name: add-auth
version: 1.1.0
description: |
  Drop session-based auth into a pracht app following the framework's
  recommended pattern (middleware checks the session, loaders read user info,
  API routes mutate it). Generates session utilities, the auth middleware,
  login/logout/signup API routes, and the matching `<Form>`-driven pages —
  then wires the manifest with public vs. protected groups.
  Use when asked to "add auth", "set up login", "wire authentication",
  "add session middleware", or "I need users".
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

Implements the auth pattern documented in
`examples/docs/src/routes/docs/recipes-auth.md`. This skill stamps out the
files; the user replaces `verifyCredentials()` with a real DB lookup.

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`,
`generate_*`) over shelling out. Prerequisite: `pracht inspect` needs a vite
config with the pracht plugin registered.

## Step 1: Confirm the scope

Use `AskUserQuestion`:

1. **What flavor?** Session cookie + email/password (default) OR magic link
   OR OAuth (out of scope — recommend a separate skill / library).
2. **Where do credentials live?** A DB the user already has, or no DB yet?
   If no DB, recommend running `add-db` first.
3. **Cookie posture for CSRF**: `SameSite=Lax` (default, recommended) vs.
   `SameSite=Strict` vs. `SameSite=None` + token. (Cross-link `audit-csrf`.)

This skill defaults to: session cookie + email/password + `SameSite=Lax`.

## Step 2: Session utilities

`src/server/session.ts`:

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
  // Read the secret INSIDE the function, never at module scope. On
  // Cloudflare Workers env bindings only exist per request — a module-level
  // `process.env.SESSION_SECRET` read (or throw) bricks the worker at import
  // time. `serverEnv` resolves correctly per adapter (see docs/ENV.md).
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

Notes:
- `crypto.subtle` works in Node 18+, Cloudflare Workers, and Vercel Edge.
- Signature verification goes through `crypto.subtle.verify`, which is a
  constant-time comparison. Never compare signature strings with `===` — that
  leaks timing information an attacker can use to forge signatures.
- Drop `Secure` only if the user is on plain HTTP locally (recommend
  conditionalizing on `NODE_ENV`).

## Step 3: Auth middleware

`src/middleware/auth.ts`:

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

This is a **Gate** (short-circuits with a redirect on failure). Cross-reference
`audit-auth` for the distinction between Gate and Augmenter.

## Step 4: Login / logout API routes

`src/api/auth/login.ts`:

```ts
import type { ApiRouteArgs } from "@pracht/core";
import { createSessionCookie } from "../../server/session";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const requested = String(form.get("redirect") ?? "/dashboard");

  // Enforce same-origin redirect (defense against open-redirect via form input).
  const safeRedirect = requested.startsWith("/") && !requested.startsWith("//")
    ? requested
    : "/dashboard";

  const user = await verifyCredentials(email, password);
  if (!user) {
    // Redirect back to /login with an error flag — do NOT return a 401 JSON
    // body. Pracht's <Form> only acts on 3xx responses (it follows the
    // `location` header); a non-redirect response is silently ignored by the
    // client, so the user would see nothing happen. The login page loader
    // reads `?error=1` and renders the message.
    const back = new URLSearchParams({ error: "1", redirect: safeRedirect });
    return new Response(null, {
      status: 302,
      headers: { location: `/login?${back}` },
    });
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

`src/api/auth/logout.ts`:

```ts
import type { ApiRouteArgs } from "@pracht/core";
import { clearSessionCookie } from "../../server/session";

export async function POST(_args: ApiRouteArgs) {
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": clearSessionCookie() },
  });
}
```

`src/api/auth/signup.ts` (skeleton — user wires hashing + DB insert):

```ts
import type { ApiRouteArgs } from "@pracht/core";
import { createSessionCookie } from "../../server/session";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || password.length < 8) {
    // Same redirect-with-flag pattern as login — <Form> ignores non-3xx.
    return new Response(null, {
      status: 302,
      headers: { location: "/signup?error=1" },
    });
  }
  // TODO: hash password, insert user, set session.
  const user = { id: crypto.randomUUID(), email };
  const cookie = await createSessionCookie({ userId: user.id, email: user.email });
  return new Response(null, {
    status: 302,
    headers: { location: "/dashboard", "set-cookie": cookie },
  });
}
```

## Step 5: Login & signup pages

`src/routes/login.tsx`:

```tsx
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { Form } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  return {
    redirect: url.searchParams.get("redirect") ?? "/dashboard",
    // Set by the login API route on failed credentials (see Step 4 — the
    // API redirects back here because <Form> only acts on 3xx responses).
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

```ts
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/login", "./routes/login.tsx", { render: "ssr" }),
      route("/signup", "./routes/signup.tsx", { render: "ssr" }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      // any other protected routes…
    ]),
  ],
});
```

If the project already has `defineApp({...})`, merge — preserve existing
shells/middleware/routes.

## Step 7: Env vars

Add to `.env.example`:

```
SESSION_SECRET=<generate with: openssl rand -base64 32>
```

Confirm `.env*` is gitignored.

## Step 8: Verify

- Step 6 added routes — run `pracht typegen` to refresh
  `src/pracht.d.ts` / `src/pracht-routes.ts` (use
  `pracht typegen --check` in CI).
- `pracht dev`, navigate to `/dashboard` → redirects to
  `/login?redirect=%2Fdashboard`.
- After successful login, lands on `/dashboard`. After a failed login, lands
  back on `/login?error=1` with the error message rendered.
- Logout posts to `/api/auth/logout` and clears the cookie.
- Run `pnpm test` and `pnpm e2e`.
- Run `pracht verify --json` and confirm no failures.
- Run `audit-csrf` and `audit-auth` after wiring to confirm posture.

## Rules

1. Always set `HttpOnly`, `SameSite=Lax`, `Secure` on the session cookie.
2. The login form's `redirect` input is user-supplied — gate it server-side
   (`startsWith('/')` AND `!startsWith('//')`). Otherwise this is an open
   redirect.
3. `verifyCredentials` is a placeholder — never ship the skeleton without
   real password hashing (argon2 or bcrypt).
4. Read `SESSION_SECRET` via `serverEnv` (from `@pracht/core/env/server`)
   inside the signing/verifying functions and fail loudly there if missing.
   Never read or validate it at module scope — on Cloudflare Workers env
   bindings only exist per request, so a module-level throw bricks the worker
   at import time.
5. Failed form posts must answer with a 3xx redirect carrying an error flag —
   `<Form>` ignores non-redirect responses, so 4xx JSON bodies are invisible
   to the user.
6. After wiring, recommend running `audit-auth` to confirm protected routes
   are gated and `audit-csrf` for CSRF posture.

$ARGUMENTS
