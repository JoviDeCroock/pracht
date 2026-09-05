---
title: Forms & Validation
lead: Handle form submissions with progressive enhancement using pracht's `<Form>` component and API routes. Forms work without JavaScript and upgrade to fetch-based submissions when JS is available.
breadcrumb: Forms
prev:
  href: /docs/recipes/csp
  title: Content Security Policy
next:
  href: /docs/recipes/view-transitions
  title: View Transitions
---

## Basic Form

The simplest pattern: a `<Form>` that posts to an API route, with server-side validation.

```ts [src/api/contact.ts]
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required";
  if (!email || !email.includes("@")) errors.email = "Valid email is required";
  if (!message) errors.message = "Message is required";

  if (Object.keys(errors).length > 0) {
    return Response.json({ ok: false, errors, values: { name, email, message } }, { status: 400 });
  }

  await sendContactEmail({ name, email, message });
  return Response.json({ ok: true, sent: true });
}
```

```tsx [src/routes/contact.tsx]
import { Form } from "@pracht/core";
import { useState } from "preact/hooks";

interface ContactResult {
  ok: boolean;
  sent?: boolean;
  errors?: Record<string, string>;
  values?: { name?: string; email?: string; message?: string };
}

export function Component() {
  const [result, setResult] = useState<ContactResult | null>(null);

  if (result?.sent) {
    return <p class="success">Thanks! We'll be in touch.</p>;
  }

  const errors = result?.errors ?? {};
  const values = result?.values ?? {};

  return (
    <div>
      <h1>Contact Us</h1>
      <Form
        method="post"
        action="/api/contact"
        onResponse={async (response) => setResult(await response.json())}
      >
        <label>
          Name
          <input type="text" name="name" value={values.name} />
          {errors.name && <span class="field-error">{errors.name}</span>}
        </label>

        <label>
          Email
          <input type="email" name="email" value={values.email} />
          {errors.email && <span class="field-error">{errors.email}</span>}
        </label>

        <label>
          Message
          <textarea name="message">{values.message}</textarea>
          {errors.message && <span class="field-error">{errors.message}</span>}
        </label>

        <button type="submit">Send</button>
      </Form>
    </div>
  );
}
```

---

## How It Works

1. `<Form method="post" action="/api/contact">` intercepts the submit event and sends data via `fetch` (no full reload).
2. The API route handler runs server-side, validates, and returns a `Response`.
3. `onResponse` receives the raw `Response` — read the body yourself with `await response.json()` — and the component re-renders with the result.
4. Without JavaScript the browser performs a native form POST and navigates to whatever the handler returns. The handler above returns JSON, so that lands the visitor on a raw JSON page. See [Working without JavaScript](#working-without-javascript).

---

## Working without JavaScript

`<Form>` degrades to a native form POST, but degrading is not the same as
working: the browser *navigates to the response*, and a `Response.json()` is a
page of JSON.

Answer a document post with a redirect instead. Enhanced submissions carry
`x-pracht-capability-form`, so the handler can tell the two apart — and pracht
turns a 3xx into a handshake the client router follows, so the redirect branch
is correct for both:

```ts [src/api/contact.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";
import { CAPABILITY_FORM_REQUEST_HEADER } from "@pracht/capabilities";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();
  const enhanced = request.headers.get(CAPABILITY_FORM_REQUEST_HEADER) !== null;

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required";
  if (!email || !email.includes("@")) errors.email = "Valid email is required";
  if (!message) errors.message = "Message is required";

  if (Object.keys(errors).length > 0) {
    if (enhanced) {
      return Response.json({ ok: false, errors, values: { name, email, message } }, {
        status: 400,
      });
    }
    // No JS to render the errors, so hand them back through the URL and let
    // the route's loader put them on the page.
    return redirect(`/contact?invalid=${Object.keys(errors).join(",")}`, { request });
  }

  await sendContactEmail({ name, email, message });
  return enhanced ? Response.json({ ok: true, sent: true }) : redirect("/contact/thanks", {
    request,
  });
}
```

If you do not need the no-JS path, say so and keep the JSON-only handler — an
API that only ever answers `fetch` is a reasonable choice. What is not
reasonable is claiming both and shipping one.

---

## Posting to a Different API Route

Use the `action` prop to target any API route:

<!-- snippet: partial -->
```tsx
<Form method="post" action="/api/newsletter">
  <input type="email" name="email" placeholder="you@example.com" />
  <button type="submit">Subscribe</button>
</Form>
```

---

## Programmatic Submission

Use plain `fetch()` when you need to submit from code rather than a form element:

```ts
import { useRevalidate } from "@pracht/core";

export function Component() {
  const revalidate = useRevalidate();

  async function handleDelete(id: string) {
    if (!confirm("Are you sure?")) return;

    const res = await fetch("/api/items", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });

    if (res.ok) {
      // Refresh loader data after the mutation
      revalidate();
    }
  }

  return <button onClick={() => handleDelete("123")}>Delete</button>;
}
```

---

## Multiple Actions with Separate API Routes

You can use separate API routes for different mutations, or handle multiple intents in a single route:

### Separate API routes

<!-- snippet: partial -->
```tsx
<Form method="post" action="/api/settings/profile">
  <input name="name" value={data.user.name} />
  <button type="submit">Save Profile</button>
</Form>

<Form method="post" action="/api/settings/password">
  <input type="password" name="current" placeholder="Current password" />
  <input type="password" name="next" placeholder="New password" />
  <button type="submit">Change Password</button>
</Form>
```

### Single API route with intent

```ts [src/api/settings.ts]
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  switch (intent) {
    case "update-profile": {
      const name = String(form.get("name"));
      await db.users.update({ name });
      return Response.json({ ok: true });
    }
    case "change-password": {
      const current = String(form.get("current"));
      const next = String(form.get("next"));
      // validate and update...
      return Response.json({ ok: true, passwordChanged: true });
    }
    case "delete-account": {
      await db.users.delete();
      return new Response(null, {
        status: 302,
        headers: { location: "/" },
      });
    }
    default:
      return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
  }
}
```

---

## File Uploads

<!-- snippet: partial -->
```tsx
<Form method="post" action="/api/avatar" enctype="multipart/form-data">
  <input type="file" name="avatar" accept="image/*" />
  <button type="submit">Upload</button>
</Form>
```

```ts [src/api/avatar.ts]
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  const file = form.get("avatar") as File;

  if (!file || file.size === 0) {
    return Response.json({ ok: false, error: "No file selected" }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();
  const url = await uploadToStorage(file.name, buffer);
  return Response.json({ ok: true, url });
}
```

---

## Revalidation After Mutations

After a mutation via an API route, use `useRevalidate()` to refresh the current route's loader data:

```tsx
import { useRevalidate } from "@pracht/core";
import type { RouteComponentProps } from "@pracht/core";

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();

  async function handleAddTodo(text: string) {
    const res = await fetch("/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (res.ok) {
      revalidate(); // Re-runs this route's loader
    }
  }

  return (
    <div>
      <ul>{data.todos.map(t => <li key={t.id}>{t.text}</li>)}</ul>
      <button onClick={() => handleAddTodo("New task")}>Add</button>
    </div>
  );
}
```

---

## Tips

- Always validate on the server. Client-side validation is a UX nicety, not a security boundary.
- Return field values in error responses so users don't lose their input.
- Use `useRevalidate()` after mutations that change the current page's data.
- Use API routes (`src/api/`) for all mutation endpoints — they return standard `Response` objects and are easy to test independently.
