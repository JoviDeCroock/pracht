---
title: Forms & Validation
lead: Handle form submissions with progressive enhancement using viact's <code>&lt;Form&gt;</code> component and API routes. Forms work without JavaScript and upgrade to fetch-based submissions when JS is available.
breadcrumb: Forms
prev:
  href: /docs/recipes/auth
  title: Authentication
next:
  href: /docs/recipes/testing
  title: Testing
---

## Basic Form

The simplest pattern: a `<Form>` that posts to an API route, with server-side validation.

```ts [src/api/contact.ts]
import type { BaseRouteArgs } from "viact";

export async function POST({ request }: BaseRouteArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required";
  if (!email || !email.includes("@")) errors.email = "Valid email is required";
  if (!message) errors.message = "Message is required";

  if (Object.keys(errors).length > 0) {
    return Response.json({ ok: false, errors, values: { name, email, message } });
  }

  await sendContactEmail({ name, email, message });
  return Response.json({ ok: true, sent: true });
}
```

```tsx [src/routes/contact.tsx]
import { Form } from "viact";

export function Component() {
  return (
    <div>
      <h1>Contact Us</h1>
      <Form method="post" action="/api/contact">
        <label>
          Name
          <input type="text" name="name" />
        </label>

        <label>
          Email
          <input type="email" name="email" />
        </label>

        <label>
          Message
          <textarea name="message"></textarea>
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
3. If JavaScript is disabled, the form still works — it falls back to a native form POST.

---

## Revalidating After Mutations

Use `useRevalidate()` to refresh the current route's loader data after a form submission:

```tsx
import { Form, useRevalidate } from "viact";

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const revalidate = useRevalidate();

  async function handleSubmit(e: Event) {
    // Form component handles the fetch — revalidate after
    await revalidate();
  }

  return (
    <Form method="post" action="/api/todos" onSubmit={handleSubmit}>
      <input name="text" placeholder="New todo" />
      <button type="submit">Add</button>
    </Form>
  );
}
```

---

## File Uploads

```tsx
<Form method="post" action="/api/upload" enctype="multipart/form-data">
  <input type="file" name="avatar" accept="image/*" />
  <button type="submit">Upload</button>
</Form>
```

```ts [src/api/upload.ts]
import type { BaseRouteArgs } from "viact";

export async function POST({ request }: BaseRouteArgs) {
  const form = await request.formData();
  const file = form.get("avatar") as File;

  if (!file || file.size === 0) {
    return Response.json({ error: "No file selected" }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();
  const url = await uploadToStorage(file.name, buffer);
  return Response.json({ url });
}
```

---

## Multiple Actions with Intent

Use a hidden `intent` field and handle it in your API route:

```ts [src/api/settings.ts]
import type { BaseRouteArgs } from "viact";

export async function POST({ request }: BaseRouteArgs) {
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
      return Response.json({ error: "Unknown intent" }, { status: 400 });
  }
}
```

In the component, use separate forms for each intent:

```tsx
<Form method="post" action="/api/settings">
  <input type="hidden" name="intent" value="update-profile" />
  <input name="name" value={data.user.name} />
  <button type="submit">Save Profile</button>
</Form>

<Form method="post" action="/api/settings">
  <input type="hidden" name="intent" value="change-password" />
  <input type="password" name="current" placeholder="Current password" />
  <input type="password" name="next" placeholder="New password" />
  <button type="submit">Change Password</button>
</Form>
```

---

## Tips

- Always validate on the server. Client-side validation is a UX nicety, not a security boundary.
- Return field values in error responses so users don't lose their input.
- Use `useRevalidate()` after mutations to refresh the current page's data.
- API routes give you full control over the response — status codes, headers, and body format.
