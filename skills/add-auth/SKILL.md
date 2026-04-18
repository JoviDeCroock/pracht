---
name: add-auth
version: 1.0.0
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
const SECRET = process.env.SESSION_SECRET!;
if (!SECRET) throw new Error("SESSION_SECRET is required");

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
    const expected = await sign(payload);
    if (signature !== expected) return null;
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

async function sign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
```

Notes:
- `crypto.subtle` works in Node 18+, Cloudflare Workers, and Vercel Edge.
- Drop `Secure` only if the user is on plain HTTP locally (recommend
  conditionalizing on `NODE_ENV`).

## Step 3: Auth middleware

`src/middleware/auth.ts`:

```ts
import type { MiddlewareFn } from "@pracht/core";
import { getSession } from "../server/session";

export const middleware: MiddlewareFn = async ({ request, url }) => {
  const session = await getSession(request);
  if (!session) {
    const next = encodeURIComponent(url.pathname + url.search);
    return { redirect: `/login?redirect=${next}` };
  }
  request.headers.set("x-user-id", session.userId);
  request.headers.set("x-user-email", session.email);
};
```

This is a **Gate** (returns `redirect` on failure). Cross-reference
`audit-auth` for the distinction between Gate and Augmenter.

## Step 4: Login / logout API routes

`src/api/auth/login.ts`:

```ts
import type { BaseRouteArgs } from "@pracht/core";
import { createSessionCookie } from "../../server/session";

export async function POST({ request, url }: BaseRouteArgs) {
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
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
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
import type { BaseRouteArgs } from "@pracht/core";
import { clearSessionCookie } from "../../server/session";

export async function POST(_args: BaseRouteArgs) {
  return new Response(null, {
    status: 302,
    headers: { location: "/", "set-cookie": clearSessionCookie() },
  });
}
```

`src/api/auth/signup.ts` (skeleton — user wires hashing + DB insert):

```ts
import type { BaseRouteArgs } from "@pracht/core";
import { createSessionCookie } from "../../server/session";

export async function POST({ request }: BaseRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || password.length < 8) {
    return Response.json({ error: "Invalid input" }, { status: 400 });
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
  return { redirect: url.searchParams.get("redirect") ?? "/dashboard" };
}

export function head() {
  return { title: "Log in" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <section class="login">
      <h1>Log in</h1>
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

- `pracht dev`, navigate to `/dashboard` → redirects to
  `/login?redirect=%2Fdashboard`.
- After successful login, lands on `/dashboard`.
- Logout posts to `/api/auth/logout` and clears the cookie.
- Run `pnpm test` and `pnpm e2e`.
- Run `audit-csrf` and `audit-auth` after wiring to confirm posture.

## Rules

1. Always set `HttpOnly`, `SameSite=Lax`, `Secure` on the session cookie.
2. The login form's `redirect` input is user-supplied — gate it server-side
   (`startsWith('/')` AND `!startsWith('//')`). Otherwise this is an open
   redirect.
3. `verifyCredentials` is a placeholder — never ship the skeleton without
   real password hashing (argon2 or bcrypt).
4. `SESSION_SECRET` is required at boot — fail loudly if missing.
5. After wiring, recommend running `audit-auth` to confirm protected routes
   are gated and `audit-csrf` for CSRF posture.

$ARGUMENTS
