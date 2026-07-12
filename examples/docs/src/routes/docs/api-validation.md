---
title: API Validation & Typed Fetch
lead: Validate API inputs once on the server, generate route contracts, and call them from the client with path, method, body, query, params, and response types connected end to end.
breadcrumb: API Validation
prev:
  href: /docs/api-routes
  title: API Routes
next:
  href: /docs/middleware
  title: Middleware
---

## Define a validated handler

`defineApi()` accepts any [Standard Schema](https://standardschema.dev) validator, including Zod,
Valibot, and ArkType. Invalid input never reaches the handler.

```ts [src/api/items.ts]
import { defineApi, json } from "@pracht/core";
import * as z from "zod";

const item = z.object({ name: z.string().min(1) });

export const POST = defineApi({
  body: item,
  handler: ({ body }) => json({ created: body.name }, { status: 201 }),
});

export const GET = defineApi({
  query: z.object({ page: z.coerce.number().optional() }),
  handler: ({ query }) => ({ page: query.page ?? 1, items: [] }),
});
```

Schemas can validate `body`, `query`, and route `params`. Query and param values cross the wire as
strings, so numeric inputs need coercion or a transform. Repeated query keys arrive as string arrays.

Handlers can return JSON-safe values directly. Use `json(value, init)` when you need a custom status
or headers without losing the response payload type. Values that change during JSON serialization —
such as `Date`, `BigInt`, `undefined`, class instances, sparse arrays, and `NaN` — are rejected. Convert
them to an explicit wire shape, or return a plain `Response` for a custom format.

## Generate the route contract

Run type generation once after adding pracht to a project:

```bash
pracht typegen
```

This creates `src/pracht.d.ts` and `src/pracht-routes.ts`. Once those default files exist,
`pracht dev` keeps them current when route files are added, removed, or renamed and when the route
manifest changes. Run `pracht typegen --check` in CI to catch stale generated files.

## Call the route with `apiFetch()`

```ts
import { apiFetch } from "@pracht/core";

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "Pracht" },
});
// created is { created: string }

const page = await apiFetch("/api/items", {
  query: { page: 2 },
});
```

Generated types reject unknown paths, unsupported methods, missing params, and mismatched body or
query values. Without generated types, `apiFetch()` still works but accepts any path and returns
`unknown`.

Plain object bodies are JSON encoded. Send `FormData` when a schema contains `File` or `Blob` values.
For other binary data or streams, use a plain API handler and read the `Request` body directly.

Non-2xx responses throw `ApiFetchError`. Validation failures expose normalized issues for field-level
UI:

```ts
import { ApiFetchError, apiFetch } from "@pracht/core";

try {
  await apiFetch("/api/items", { method: "POST", body: { name: "" } });
} catch (error) {
  if (error instanceof ApiFetchError && error.issues) {
    showFieldErrors(error.issues);
  }
}
```

## Use the same issues with `<Form>`

`<Form schema>` validates before submitting. `onValidationIssues` receives both client-side failures
and the standardized server response (HTTP 400 or 422). `onResponse` receives every non-redirect
fetch response without consuming its body.

```tsx
import { Form } from "@pracht/core";

<Form
  action="/api/items"
  method="post"
  schema={item}
  onValidationIssues={showFieldErrors}
  onResponse={async (response) => {
    if (response.ok) showCreated(await response.json());
  }}
>
  <input name="name" />
  <button type="submit">Create</button>
  <button type="submit" formAction="/api/items/draft">Save draft</button>
</Form>;
```

Enhanced submissions honor the clicked button's `formaction` and `formmethod`, so multi-action forms
keep the same behavior they have with native browser submission.
