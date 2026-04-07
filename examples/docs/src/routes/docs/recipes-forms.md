---
title: Forms & Validation
lead: Handle form submissions with progressive enhancement using viact's <code>&lt;Form&gt;</code> component and route actions. Forms work without JavaScript and upgrade to fetch-based submissions when JS is available.
breadcrumb: Forms
prev:
  href: /docs/recipes/auth
  title: Authentication
next:
  href: /docs/recipes/testing
  title: Testing
---

## Basic Form

The simplest pattern: a `<Form>` that posts to the current route's action, with server-side validation.

```ts [src/routes/contact.tsx]
import type { ActionArgs, RouteComponentProps } from "viact";
import { Form } from "viact";

export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const message = String(form.get("message") ?? "").trim();

  const errors: Record<string, string> = {};
  if (!name) errors.name = "Name is required";
  if (!email || !email.includes("@")) errors.email = "Valid email is required";
  if (!message) errors.message = "Message is required";

  if (Object.keys(errors).length > 0) {
    return { ok: false, data: { errors, values: { name, email, message } } };
  }

  await sendContactEmail({ name, email, message });
  return { ok: true, data: { sent: true } };
}

export function Component({ actionData }: RouteComponentProps) {
  if (actionData?.sent) {
    return <p class="success">Thanks! We'll be in touch.</p>;
  }

  const errors = actionData?.errors ?? {};
  const values = actionData?.values ?? {};

  return (
    <div>
      <h1>Contact Us</h1>
      <Form method="post">
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

1. `<Form method="post">` intercepts the submit event and sends data via `fetch` (no full reload).
2. The route's `action()` runs server-side, validates, and returns data.
3. The component re-renders with `actionData` containing the action's return value.
4. If JavaScript is disabled, the form still works — it falls back to a native form POST.

---

## Posting to a Different Route

Use the `action` prop to submit to a different route's action:

```tsx
<Form method="post" action="/api/newsletter">
  <input type="email" name="email" placeholder="you@example.com" />
  <button type="submit">Subscribe</button>
</Form>
```

---

## Programmatic Submission

Use `useSubmitAction()` when you need to submit from code rather than a form element:

```ts
import { useSubmitAction } from "viact";

export function Component() {
  const submit = useSubmitAction();

  async function handleDelete(id: string) {
    if (!confirm("Are you sure?")) return;

    const formData = new FormData();
    formData.set("id", id);
    formData.set("intent", "delete");

    await submit({ method: "POST", body: formData });
  }

  return <button onClick={() => handleDelete("123")}>Delete</button>;
}
```

---

## Multiple Actions with Intent

Use a hidden `intent` field to handle multiple actions in one route:

```ts [src/routes/settings.tsx]
export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");

  switch (intent) {
    case "update-profile": {
      const name = String(form.get("name"));
      await db.users.update({ name });
      return { ok: true, revalidate: ["route:self"] };
    }
    case "change-password": {
      const current = String(form.get("current"));
      const next = String(form.get("next"));
      // validate and update...
      return { ok: true, data: { passwordChanged: true } };
    }
    case "delete-account": {
      await db.users.delete();
      return { redirect: "/" };
    }
    default:
      return { ok: false, data: { error: "Unknown action" } };
  }
}
```

In the component, use separate forms for each action:

```tsx
<Form method="post">
  <input type="hidden" name="intent" value="update-profile" />
  <input name="name" value={data.user.name} />
  <button type="submit">Save Profile</button>
</Form>

<Form method="post">
  <input type="hidden" name="intent" value="change-password" />
  <input type="password" name="current" placeholder="Current password" />
  <input type="password" name="next" placeholder="New password" />
  <button type="submit">Change Password</button>
</Form>
```

---

## File Uploads

```tsx
<Form method="post" enctype="multipart/form-data">
  <input type="file" name="avatar" accept="image/*" />
  <button type="submit">Upload</button>
</Form>
```

```ts
export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  const file = form.get("avatar") as File;

  if (!file || file.size === 0) {
    return { ok: false, data: { error: "No file selected" } };
  }

  const buffer = await file.arrayBuffer();
  const url = await uploadToStorage(file.name, buffer);
  return { ok: true, data: { url } };
}
```

---

## Revalidation After Mutations

When an action modifies data, return `revalidate` hints so the page shows fresh content without a full reload:

```ts
export async function action({ request }: ActionArgs) {
  const form = await request.formData();
  await db.todos.create({ text: String(form.get("text")) });

  return {
    ok: true,
    revalidate: ["route:self"],  // Re-runs this route's loader
  };
}
```

The `<Form>` component handles this automatically — after the action responds, it re-fetches the loader data and updates the UI.

---

## Tips

- Always validate on the server. Client-side validation is a UX nicety, not a security boundary.
- Return field values in error responses so users don't lose their input.
- Use `revalidate: ["route:self"]` after mutations that change the current page's data.
- Actions have automatic CSRF protection — the framework validates the `Origin` header on non-GET requests.
