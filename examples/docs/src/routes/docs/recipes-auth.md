---
title: Authentication
lead: Protect routes with session-based auth using middleware, loaders, and API routes. This recipe covers login/logout flows, session management, and route guards.
breadcrumb: Authentication
prev:
  href: /docs/recipes/i18n
  title: i18n
next:
  href: /docs/recipes/forms
  title: Forms
---

## Architecture

Auth in pracht follows a simple pattern: middleware checks the session before any loader runs. If there's no valid session, redirect to login. Loaders can read the authenticated user. API routes handle login/logout mutations.

- **Middleware** — gate access, redirect unauthenticated users
- **Loaders** — read session data, pass user to components
- **API routes** — handle login/logout mutations
- **Cookies** — store session tokens (set via API route response headers)

---

## 1. Session Utilities

Create a small session module that reads/writes signed cookies. This example uses a simple HMAC approach — swap in your preferred session library.

```ts [src/server/session.ts]
const SECRET = process.env.SESSION_SECRET!;

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
  return `session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

export function clearSessionCookie(): string {
  return "session=; Path=/; HttpOnly; Max-Age=0";
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

---

## 2. Auth Middleware

This middleware redirects unauthenticated users to the login page. Apply it to any route group that requires auth.

```ts [src/middleware/auth.ts]
import type { MiddlewareFn } from "@pracht/core";
import { getSession } from "../server/session";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) {
    const loginUrl = `/login?redirect=${encodeURIComponent(new URL(request.url).pathname)}`;
    return { redirect: loginUrl };
  }

  // Pass user info downstream via a header (loaders can read it)
  request.headers.set("x-user-id", session.userId);
  request.headers.set("x-user-email", session.email);
};
```

---

## 3. Login Page

The login page renders the form, while an API route handles credential validation and sets the session cookie:

```ts [src/api/auth/login.ts]
import { createSessionCookie } from "../../server/session";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const redirectTo = String(form.get("redirect") ?? "/dashboard");

  // Replace with your actual auth logic
  const user = await verifyCredentials(email, password);
  if (!user) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const cookie = await createSessionCookie({
    userId: user.id,
    email: user.email,
  });

  return new Response(null, {
    status: 302,
    headers: {
      location: redirectTo,
      "set-cookie": cookie,
    },
  });
}

async function verifyCredentials(email: string, password: string) {
  // Your DB lookup here
  return null as any;
}
```

```ts [src/routes/login.tsx]
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { Form } from "@pracht/core";

export async function loader({ url }: LoaderArgs) {
  return { redirect: url.searchParams.get("redirect") ?? "/dashboard" };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div class="login-page">
      <h1>Log in</h1>
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
    </div>
  );
}
```

---

## 4. Logout

```ts [src/api/auth/logout.ts]
import { clearSessionCookie } from "../../server/session";

export async function POST(_args: ApiRouteArgs) {
  return new Response(null, {
    status: 302,
    headers: {
      location: "/",
      "set-cookie": clearSessionCookie(),
    },
  });
}
```

Trigger logout from anywhere with a form:

```tsx
<Form method="post" action="/api/auth/logout">
  <button type="submit">Log out</button>
</Form>
```

---

## 5. Reading the User in Loaders

Behind the auth middleware, loaders can safely read user info from the headers set by middleware:

```ts [src/routes/dashboard.tsx]
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader({ request }: LoaderArgs) {
  const userId = request.headers.get("x-user-id")!;
  const projects = await db.projects.findMany({ userId });
  return { userId, projects };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  return (
    <div>
      <h1>Dashboard</h1>
      <ul>
        {data.projects.map((p) => (
          <li key={p.id}>{p.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

---

## 6. Wire It Up

```ts [src/routes.ts]
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
    // Public routes — no auth
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/login", "./routes/login.tsx", { render: "ssr" }),
    ]),

    // Protected routes — auth middleware applied
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/settings", "./routes/settings.tsx", { render: "ssr" }),
    ]),
  ],
});
```

---

## Tips

- Use `render: "ssr"` for all auth-related routes — they depend on cookies which are per-request.
- For OAuth flows, handle the callback in an API route (`src/api/auth/callback.ts`) that sets the session cookie and redirects.
- For role-based access, extend the middleware to check permissions and return a `403` or redirect.
- Never store passwords or secrets in loader data — it gets serialized to the client. Only return what the component needs.

---

## CSRF Protection

Session cookies are the ambient credential a CSRF attack abuses: a malicious site submits a form to your API and the browser attaches the cookie automatically. Pracht does not ship CSRF middleware — the defense depends on your cookie strategy and threat model. Pick the layers you want:

### 1. `SameSite` on the session cookie (primary defense)

The session cookie in the snippet above already sets `SameSite=Lax`. That blocks cross-site `POST`/`PUT`/`PATCH`/`DELETE` submissions in every modern browser and is enough for most apps. Use `SameSite=Strict` if you don't need inbound links from other sites to arrive authenticated.

```ts
`session=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
```

### 2. Origin check middleware (defense in depth)

For extra hardening — or if you run older browsers where `SameSite` is unreliable — add a middleware that rejects unsafe-method requests whose `Origin` header does not match the request's own origin:

```ts [src/middleware/origin-check.ts]
import type { MiddlewareFn } from "@pracht/core";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED = new Set<string>([
  // add trusted cross-origin callers here (e.g. "https://admin.example.com")
]);

export const middleware: MiddlewareFn = ({ request, url }) => {
  if (!UNSAFE.has(request.method)) return;

  const origin = request.headers.get("origin");
  if (origin === null) {
    // No Origin header: either a non-browser client or an attacker dodging
    // the check. Sec-Fetch-Site tells us when the browser itself marked the
    // request as same-origin or user-initiated.
    const site = request.headers.get("sec-fetch-site");
    if (site === "same-origin" || site === "none") return;
    return new Response("Forbidden: missing Origin", { status: 403 });
  }

  if (origin === url.origin) return;
  if (ALLOWED.has(origin)) return;

  return new Response(`Forbidden: origin ${origin} not allowed`, { status: 403 });
};
```

Wire it to the whole API (or just mutation groups) in `routes.ts`:

```ts
defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    originCheck: "./middleware/origin-check.ts",
  },
  api: { middleware: ["originCheck"] },
  routes: [...],
});
```

This is a pure header check — it doesn't issue or validate tokens. Pair it with `SameSite` cookies; skip synchronizer tokens unless you explicitly need them (e.g. you allow `SameSite=None` for embedding).

### 3. Token-based CSRF

Only reach for per-request CSRF tokens if your cookies must be `SameSite=None` (e.g. you embed the app in a third-party iframe). For first-party apps, the two layers above are sufficient.
