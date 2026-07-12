# API Validation and Typed Fetch

End-to-end type safety for API routes: define a route with a
[Standard Schema](https://standardschema.dev) validator (zod, valibot,
arktype, or any other implementation), get runtime validation on the server,
and call it from the client with a fetch helper that knows every route's
paths, methods, request shapes, and response types.

Three pieces work together:

1. **`defineApi()`** wraps an API route handler with schema validation.
2. **`pracht typegen`** registers every API route's request/response types on
   `Register["apiRoutes"]` (the same mechanism that types route ids and
   loader data).
3. **`apiFetch()`** reads those registered types so requests are checked at
   compile time and responses come back typed.

Each piece degrades gracefully: `defineApi` works without typegen (runtime
validation only), and `apiFetch` works without registered types (every path
accepted, payloads `unknown`).

---

## Validated Routes with `defineApi()`

```typescript
// src/api/items.ts
import { defineApi } from "@pracht/core";
import * as z from "zod";

export const POST = defineApi({
  body: z.object({ name: z.string().min(1) }),
  handler: ({ body }) => ({ created: body.name }),
});

export const GET = defineApi({
  query: z.object({ page: z.coerce.number().optional() }),
  handler: async ({ query, context }) => {
    return { items: await context.db.items.list({ page: query.page ?? 1 }) };
  },
});
```

`defineApi` accepts up to three schemas, all optional:

| Schema   | Validates                | Input handed to the schema                                                                                     |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `body`   | Request body             | Parsed JSON (default), or a record built from `FormData` for form/multipart submissions, or raw text otherwise |
| `query`  | Query string             | Record with one string per key; repeated keys (`?tag=a&tag=b`) become string arrays                            |
| `params` | Route params (`[id]` …)  | The raw string param record                                                                                     |

The handler receives the regular `ApiRouteArgs` (request, context, url,
signal, route) plus the **validated** `body` and `query` values, with `params`
replaced by the params schema's output when one is given. Schema output types
flow through — `z.coerce.number()` gives the handler a `number`.

> **Query and params schemas receive strings.** The wire format for query
> strings and route params is text: every value the schema sees is a string
> (or a string array for repeated query keys). Write schemas that accept
> string input — `z.coerce.number()`, `z.enum([...])`, transforms — never
> `z.number()`, which could not validate any request. `apiFetch()` rejects
> query keys whose schema input has no string representation at compile time.
> A repeated key (`?tag=a&tag=b`) arrives as an array but a single `?tag=a`
> arrives as a plain string, so accept both:
> `z.union([z.string(), z.array(z.string())])`.

Handlers may return:

- a `Response` for full control over status and headers, or
- a JSON value made from strings, finite numbers, booleans, null, arrays, and
  plain objects, sent as `Response.json(value)` — this is what makes response
  types inferable on the client.

The JSON shape must survive serialization without changing type. Values such
as `Date`, `BigInt`, `undefined`, class instances, sparse arrays, and circular
objects are rejected (at compile time where TypeScript can identify them, and
again at runtime for JavaScript callers and value-level cases such as `NaN`).
Serialize them explicitly or return a `Response` when you need custom wire
formats.

When a handler only needs a different status code or extra headers, return
`json(value, init)` — it behaves like `Response.json()` but keeps the payload
type visible to `apiFetch()`:

```typescript
import { defineApi, json } from "@pracht/core";

export const POST = defineApi({
  body: itemSchema,
  handler: ({ body }) => json({ created: body.name }, { status: 201 }),
});
```

If a handler can return a plain `Response` on any branch, its client output is
`unknown`: status, content type, and body cannot be inferred from the
`Response` type. Use `json()` or keep JSON-returning handlers separate when
callers need a precise result type.

### Validation failures

Invalid requests never reach the handler. The route answers with a
standardized JSON body:

```json
// HTTP 422 (schema rejected) or 400 (unparseable body)
{
  "error": "validation",
  "issues": [{ "in": "body", "path": ["name"], "message": "Required" }]
}
```

`in` is `"body"`, `"query"`, or `"params"`. Query and params issues from the
same request are reported together. `isApiValidationErrorBody(value)` type
guards this shape, and `apiValidationErrorResponse(issues)` builds the same
response from your own handlers or middleware.

Plain handlers (`export function GET(args)`) keep working unchanged —
`defineApi` is opt-in per export, and both styles can mix in one module.

---

## Registered API Types with `pracht typegen`

```bash
pracht typegen
```

Alongside the route id/param/loader registrations (see
[docs/ROUTING.md](ROUTING.md#typed-routes-and-links)), the generated
`src/pracht.d.ts` now registers every API route:

```typescript
declare module "@pracht/core" {
  interface Register {
    routes: { /* ... */ };
    apiRoutes: {
      "/api/items": {
        path: "/api/items";
        params: Record<never, never>;
        methods: ApiRouteMethodMap<typeof import("./api/items")>;
      };
      "/api/items/:id": {
        path: "/api/items/:id";
        params: { "id": RouteParamInput; };
        methods: ApiRouteMethodMap<typeof import("./api/items/[id]")>;
      };
    };
  }
}
```

`ApiRouteMethodMap` extracts `{ body, query, output }` per exported HTTP
method: `defineApi` handlers carry their schema input types and handler
return type when every branch returns JSON; handlers that can return a
`Response` and plain handlers register with `unknown` response types.
Routes that only export a `default` handler accept every method, untyped.

Run `pracht typegen --check` in CI to fail when the generated files are
stale. Type generation discovers API paths without importing the API modules,
so top-level route code and runtime service initialization do not execute
during codegen.

While `pracht dev` runs, the generated files refresh automatically whenever
route files are added, removed, or renamed, and whenever the route manifest
changes (opt-in by having run `pracht typegen` once — the watcher activates
when `src/pracht.d.ts` exists). Handler signature changes need no regeneration:
the declaration references route modules with `typeof import(...)`, so those
types update live.

---

## Typed Requests with `apiFetch()`

```typescript
import { apiFetch } from "@pracht/core";

// GET is the default method; the response type is the handler's return type.
const list = await apiFetch("/api/items", { query: { page: 2 } });
//    ^? { items: Item[] }

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "Pracht" }, // type error if it doesn't match the body schema
});

const item = await apiFetch("/api/items/:id", { params: { id: "42" } });
```

With registered types, the compiler rejects unknown paths, methods a route
does not export, missing or mismatched bodies, unknown query keys, and
missing params. Params are substituted into the path template with proper
segment encoding. Method unions remain correlated with their request shapes:
when POST and PUT accept different bodies, a dynamic `"POST" | "PUT"` value
must be paired with a correspondingly discriminated options object.

Runtime behavior:

- Plain objects passed as `body` are JSON-encoded with
  `Content-Type: application/json`; `FormData`, `URLSearchParams`, `Blob`,
  typed arrays, streams, and strings pass through unchanged. Routes whose
  body schema contains `File`/`Blob` values accept `FormData` in their typed
  `body` — JSON-encoding a `File` would silently drop it, so send multipart.
  For other binary payloads and streams, use a plain handler and read
  `request.body` or the appropriate `Request` method directly; `defineApi()`
  parses non-JSON, non-form bodies as text before passing them to a schema.
- `GET` and `HEAD` requests are bodyless; passing `body` for either method is
  rejected by generated types and at runtime.
- 2xx JSON responses are parsed; `text/*` responses resolve to the text;
  `HEAD`, 204, and 205 responses resolve to `undefined`; anything else resolves to the raw
  `Response`.
- Non-2xx responses throw `ApiFetchError` carrying `status`, `response`, the
  parsed `body`, and — when the server sent the standardized validation
  failure — the normalized `issues`.

```typescript
import { apiFetch, ApiFetchError } from "@pracht/core";

try {
  await apiFetch("/api/items", { method: "POST", body: { name: "" } });
} catch (error) {
  if (error instanceof ApiFetchError && error.issues) {
    showFieldErrors(error.issues); // [{ in: "body", path: ["name"], message: "..." }]
  }
}
```

`ApiFetchOptions` also accepts `headers`, `signal`, a custom `fetch`
implementation, and a `baseUrl` prefix for absolute-origin calls during SSR
or in tests.

> **Calling APIs during SSR.** Relative URLs only resolve in the browser —
> server-side `fetch` throws on them. In loaders and other server code, pass
> an absolute `baseUrl`. Better: calling your own origin over HTTP from a
> single-process server wastes a round trip and can deadlock, so extract the
> shared logic into a function that both the API route and the loader call
> directly.

---

## Form Validation

`<Form>` accepts the same Standard Schema validators for progressive
enhancement:

```tsx
import { Form, type ApiValidationIssue } from "@pracht/core";
import { itemSchema } from "../schemas/item";

function NewItem() {
  const [issues, setIssues] = useState<ApiValidationIssue[]>([]);

  return (
    <Form
      action="/api/items"
      method="post"
      schema={itemSchema}
      onValidationIssues={setIssues}
      onSubmit={() => setIssues([])}
    >
      <input name="name" />
      {issues.map((issue) => (
        <p class="error">{issue.message}</p>
      ))}
      <button>Create</button>
    </Form>
  );
}
```

- `action` autocompletes API route paths registered by `pracht typegen`
  (any URL string still works).
- `schema` validates the form's data client-side before submitting (one entry
  per field, arrays for repeated fields, `File` values untouched). On
  failure the request is skipped and `onValidationIssues` fires.
- `onValidationIssues` also fires when the server answers with the
  standardized 400/422 validation body — so a `defineApi` route with the same
  schema gives identical error shapes whether JavaScript validated first or
  the server did. Share one schema module between the API route and the form.
- `onResponse` receives the `Response` for every non-redirect fetch
  submission — read a success payload with `response.json()`, or branch on
  `response.ok`/`response.status` to surface non-validation failures (500s
  would otherwise pass silently). The body is never consumed before the
  callback runs.

Without JavaScript the form still submits natively and the server-side
schema remains the source of truth.

---

## Choosing a Validator

`@pracht/core` depends only on `@standard-schema/spec` — a types-only package
with **zero runtime bytes**. The validator library is yours to pick, and where
its weight lands matters:

- **Server-only schemas** (`defineApi` without a shared `<Form>` schema) never
  reach the browser — API modules are excluded from client bundles entirely.
  Any validator works; pick for DX.
- **Client-shared schemas** (`<Form schema>`, schema modules imported by
  components) ship to the browser. Prefer a light validator there:
  [valibot](https://valibot.dev) (modular, ~1-2 KB gz for typical schemas) or
  `zod/mini` (Zod 4's tree-shakable build) instead of the full `zod` import.
  Hand-rolled schemas are also fine — the spec is a single
  `~standard.validate` method, implementable in a dozen lines with no
  dependency at all.

The docs use zod in examples for familiarity; nothing in pracht assumes it.

---

## Notes

- Validation runs inside the wrapped handler, after API middleware — a
  middleware short-circuit still prevents body parsing.
- `formDataToRecord`, `searchParamsToRecord`, and `validateStandardSchema`
  are exported for reuse in custom handlers or middleware.
