---
title: Forms
lead: Submit forms with `<Form>` and API routes. Forms work without JavaScript and switch to fetch submissions once it loads.
---

This recipe builds a contact form that posts to an API route, shows field errors, and keeps working with JavaScript disabled.

## 1. Write the API route

Validate on the server and return a `Response`:

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

Return the submitted values with the errors so the user does not lose their input.

## 2. Render the form

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

Submit an empty form: the page does not reload, and each field shows its error. What happens on submit:

1. `<Form>` intercepts the submit event and sends the fields with `fetch`.
2. The API route validates and returns a `Response`.
3. A 3xx response navigates the client router to its target and reloads that route's data. Any other response goes to `onResponse` as a raw `Response`; read the body with `await response.json()`.
4. While the request is in flight, `useNavigation()` reports the submission.

Without JavaScript, the browser performs a native form POST and navigates to the response, so this JSON handler shows a page of raw JSON. Step 3 fixes that.

## 3. Work without JavaScript

Answer a document post with a redirect. Enhanced submissions carry the `x-pracht-capability-form` header, so the handler can tell the two apart:

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
    // No JS to render the errors, so hand them and the input back through
    // the URL and let the route's loader put them on the page.
    const query = new URLSearchParams({ invalid: Object.keys(errors).join(","), name, email });
    return redirect(`/contact?${query}`, { request });
  }

  await sendContactEmail({ name, email, message });
  return enhanced ? Response.json({ ok: true, sent: true }) : redirect("/contact?sent=1", {
    request,
  });
}
```

Read the outcome in the contact route's loader from `url.searchParams`, and fall back to it when no enhanced result is in state:

```tsx [src/routes/contact.tsx]
import { Form, type LoaderArgs, type RouteComponentProps } from "@pracht/core";
import { useState } from "preact/hooks";

const MESSAGES: Record<string, string> = {
  name: "Name is required",
  email: "Valid email is required",
  message: "Message is required",
};

interface ContactResult {
  ok: boolean;
  sent?: boolean;
  errors?: Record<string, string>;
  values?: { name?: string; email?: string; message?: string };
}

export function loader({ url }: LoaderArgs) {
  const query = url.searchParams;
  const invalid = (query.get("invalid") ?? "").split(",").filter((field) => field in MESSAGES);
  return {
    sent: query.has("sent"),
    errors: Object.fromEntries(invalid.map((field) => [field, MESSAGES[field]])),
    values: { name: query.get("name") ?? "", email: query.get("email") ?? "" },
  };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  const [result, setResult] = useState<ContactResult | null>(null);

  if (result?.sent ?? data.sent) {
    return <p class="success">Thanks! We'll be in touch.</p>;
  }

  const errors = result?.errors ?? data.errors;
  const values: ContactResult["values"] = result?.values ?? data.values;

  return (
    <Form method="post" action="/api/contact" onResponse={async (r) => setResult(await r.json())}>
      <label>
        Name <input type="text" name="name" value={values?.name} />
        {errors.name && <span class="field-error">{errors.name}</span>}
      </label>
      <label>
        Email <input type="email" name="email" value={values?.email} />
        {errors.email && <span class="field-error">{errors.email}</span>}
      </label>
      <label>
        Message <textarea name="message">{values?.message}</textarea>
        {errors.message && <span class="field-error">{errors.message}</span>}
      </label>
      <button type="submit">Send</button>
    </Form>
  );
}
```

Register `/contact` with `render: "ssr"` so the loader sees each request's query string. Disable JavaScript and submit a form with only a name: the page reloads at `/contact` with an error under email and message, and the name field keeps what you typed. A valid message lands on `/contact?sent=1` and shows the thank-you text. The message body stays out of the URL because query strings end up in browser history and server logs.

If you do not need the no-JS path, keep the JSON-only handler from step 1.

## Refresh loader data after a mutation

A JSON response does not reload the current route's data. Call `useRevalidate()` after a mutation that changes what the page shows:

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

The same pattern covers submissions from code rather than a form element, such as a delete button calling `fetch()`.

## Multiple actions on one page

Give each mutation its own API route:

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

Or post every form to one route and branch on a hidden `intent` field:

```ts [src/api/settings.ts]
import { redirect, type ApiRouteArgs } from "@pracht/core";

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
      return redirect("/", { request });
    }
    default:
      return Response.json({ ok: false, error: "Unknown intent" }, { status: 400 });
  }
}
```

## Share one validation contract

Pass any Standard Schema to `<Form schema>` for client-side feedback: an invalid submission is not sent, and `onValidationIssues` receives the issues. Pass the same object to `defineApi({ body })` so the server stays authoritative.

If the validator also implements Standard JSON Schema (Zod 4 does), it can be the `input` of a pracht capability too, so the form, API route, and agent tool share one contract. See [Capabilities](/docs/capabilities#define-the-contract).

Client-side validation is feedback, not a security boundary. Always validate on the server.

## File uploads

Set `enctype="multipart/form-data"` and read the file from `formData()`:

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

## Search forms

A `GET` `<Form>` submits like a plain HTML form: the browser loads the action with the fields as its query. Add `clientNavigation` to go through the client router instead; the page updates without a document reload, and `useNavigation()` reports the pending load.

```tsx
import { Form } from "@pracht/core";

<Form method="get" action="/search" clientNavigation>
  <input name="q" type="search" />
  <button type="submit">Search</button>
</Form>
```

The browser builds the query, replacing any query on the action. A cross-origin action, or a `target`/`formtarget` other than `_self`, still submits natively.
