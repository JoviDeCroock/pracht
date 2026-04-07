---
title: Authentication
lead: Protect routes with session-based auth using middleware, loaders, and actions. This recipe covers login/logout flows, session management, and route guards.
breadcrumb: Authentication
prev:
  href: /docs/recipes/i18n
  title: i18n
next:
  href: /docs/recipes/forms
  title: Forms
---

## Architecture

Auth in viact follows a simple pattern: middleware checks the session before any loader runs. If there's no valid session, redirect to login. Loaders can read the authenticated user. Actions handle login/logout mutations.

- **Middleware** — gate access, redirect unauthenticated users
- **Loaders** — read session data, pass user to components
- **Actions** — handle login/logout form submissions
- **Cookies** — store session tokens (set via action response headers)

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
import type { MiddlewareFn } from "viact";
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

The login route has an action that validates credentials and sets the session cookie:

```ts [src/routes/login.tsx]
import type { ActionArgs, LoaderArgs, RouteComponentProps } from "viact";
import { Form } from "viact";
import { createSessionCookie } from "../server/session";

export async function loader({ url }: LoaderArgs) {
  return { redirect: url.searchParams.get("redirect") ?? "/dashboard" };
}

export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const redirectTo = String(form.get("redirect") ?? "/dashboard");

  // Replace with your actual auth logic
  const user = await verifyCredentials(email, password);
  if (!user) {
    return { ok: false, data: { error: "Invalid email or password" } };
  }

  const cookie = await createSessionCookie({
    userId: user.id,
    email: user.email,
  });

  return {
    redirect: redirectTo,
    headers: { "set-cookie": cookie },
  };
}

export function Component({ data, actionData }: RouteComponentProps<typeof loader>) {
  return (
    <div class="login-page">
      <h1>Log in</h1>
      {actionData?.error && <p class="error">{actionData.error}</p>}
      <Form method="post">
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

async function verifyCredentials(email: string, password: string) {
  // Your DB lookup here
  return null as any;
}
```

---

## 4. Logout Action

```ts [src/routes/logout.tsx]
import type { ActionArgs } from "viact";
import { clearSessionCookie } from "../server/session";

export async function action(_args: ActionArgs) {
  return {
    redirect: "/",
    headers: { "set-cookie": clearSessionCookie() },
  };
}

export function Component() {
  return null;
}
```

Trigger logout from anywhere with a form:

```tsx
<Form method="post" action="/logout">
  <button type="submit">Log out</button>
</Form>
```

---

## 5. Reading the User in Loaders

Behind the auth middleware, loaders can safely read user info from the headers set by middleware:

```ts [src/routes/dashboard.tsx]
import type { LoaderArgs, RouteComponentProps } from "viact";

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
import { defineApp, group, route } from "viact";

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
      route("/logout", "./routes/logout.tsx", { render: "ssr" }),
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
