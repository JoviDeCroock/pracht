---
title: API validation and typed fetch
lead: Validate request input on the server, then call API routes from the client with typed params, query, body, and response.
---

## Define a validated handler

Wrap an API handler with `defineApi()` and give it [Standard Schema](https://standardschema.dev) validators (Zod, Valibot, ArkType):

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

Invalid input never reaches the handler. The caller gets a `422` with `{ error: "validation", issues }`, where each issue has `in` (`"body"`, `"query"`, or `"params"`), `message`, and `path`.

| Option | Validates |
| ------ | --------- |
| `body` | JSON, `application/x-www-form-urlencoded`, or `multipart/form-data` request bodies |
| `query` | The query string; values are strings, and repeated keys arrive as string arrays |
| `params` | Route params; values are strings |
| `maxBodySize` | Largest body `body` validation reads, in bytes (default 1 MiB) |

Query and param values cross the wire as strings, so numeric inputs need coercion or a transform. Typed calls reject query or params schema keys that cannot accept a string. Page routes validate their query with a [`search` export](/docs/routing#search-params) instead.

A body that cannot be parsed gets a `400`, and one larger than `maxBodySize` gets a `413`. To accept larger uploads, raise `maxBodySize` on that handler and the Node adapter's [`maxBodySize`](/docs/adapters#origin-proxy-and-body-size-options) to match.

## Return values

Return a JSON-safe value and pracht sends it with `Response.json()`. Use `json(value, init)` for a custom status or headers without losing the payload type, or return any `Response` for full control.

Values that JSON would change, such as `Date`, `BigInt`, `undefined`, class instances, and `NaN`, are rejected at compile time and at runtime. Convert them first, or return a plain `Response`.

When the validator also implements Standard JSON Schema (Zod 4 does), the same schema can be a [capability](/docs/capabilities) `input` or `output`, so a validated API operation becomes an agent contract without a second schema.

## Generate the route contract

Run type generation once after adding pracht to a project:

```bash
pracht typegen
```

This writes `src/pracht.d.ts` and `src/pracht-routes.ts`. `pracht dev` then keeps them current as route files and the manifest change. Run `pracht typegen --check` in CI to catch stale files.

## Call the route with `apiFetch()`

```ts
import { apiFetch } from "@pracht/core";

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "pracht" },
});
// created: { created: string }

const page = await apiFetch("/api/items", {
  query: { page: 2 },
});
```

With generated types, unknown paths, unsupported methods, missing params, and mismatched body or query values are type errors. Without them, `apiFetch()` accepts any path and returns `unknown`.

| Option | Purpose |
| ------ | ------- |
| `method` | HTTP method; defaults to `GET` |
| `params` | Values for `:param` segments in the path |
| `query` | Query string values |
| `body` | Plain objects are JSON-encoded; pass `FormData` for `File` or `Blob` values |
| `headers`, `signal` | Passed to `fetch()` |
| `baseUrl` | Prefix for the request URL, such as an absolute origin during SSR |
| `fetch` | Custom fetch implementation for tests or server-to-server calls |

For other binary data or streams, use a plain API handler and read the `Request` body directly.

### Handle errors

Non-2xx responses throw `ApiFetchError` with `status`, `response`, and the parsed `body`. Validation failures also set `issues`:

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

Pass the schema to `<Form schema>` to validate before submitting:

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

`onValidationIssues` receives both client-side failures and the server's validation response (HTTP 400 or 422). `onResponse` receives every non-redirect response without consuming its body.

Enhanced submissions honor the clicked button's `formaction` and `formmethod`, so multi-action forms behave as they do with native submission.
