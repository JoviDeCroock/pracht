---
name: test-api
version: 1.0.0
description: |
  Auto-generate Vitest request/response tests for every handler in `src/api/`.
  Each test instantiates a `Request`, calls the exported HTTP method handler
  directly, and asserts on the returned `Response` — no server boot required.
  Use when asked to "test my API routes", "scaffold API tests", "generate
  tests for src/api", or "add tests for this endpoint".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Test API

Pracht API handlers are plain functions: `(args: BaseRouteArgs) => Response |
Promise<Response>`. They test cleanly in Vitest without booting the framework.

## Step 1: Confirm Vitest is installed

If the project has no `vitest` dependency, run `scaffold-tests` first (or
prompt the user to). This skill does not handle Vitest setup.

## Step 2: Enumerate API handlers

```bash
pracht inspect api --json
```

For each entry, capture: `path` (URL), `file` (source path), exported
`methods` (e.g., `["GET", "POST"]` or `["default"]`).

Ask the user which subset to scaffold or accept paths via `$ARGUMENTS`.

## Step 3: Generate one test per handler file

Place tests next to the handler with `.test.ts` suffix
(`src/api/users/[id].test.ts`). Use a small helper to construct
`BaseRouteArgs`:

```ts
import { describe, it, expect } from "vitest";
import { GET, POST /* import only what the handler exports */ } from "./<file>";

function args(url: string, init?: RequestInit, params: Record<string, string> = {}) {
  const request = new Request(url, init);
  return {
    request,
    params,
    context: {} as never,
    url: new URL(request.url),
    signal: AbortSignal.timeout(5000),
    route: {} as never,
  };
}

describe("<METHOD> <api-path>", () => {
  it("returns 200 on a valid request", async () => {
    const res = await GET(args("http://localhost<api-path>"));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
  });
});
```

## Step 4: Generate method-specific cases

For each exported method, emit the smallest realistic case:

| Method  | Default case                                                    |
| ------- | --------------------------------------------------------------- |
| `GET`   | Plain GET → `expect(res.status).toBeLessThan(400)`              |
| `POST`  | POST with empty `FormData` → assert validation behavior         |
| `PUT`   | PUT with JSON body → assert 200 or auth-required (401/403)      |
| `PATCH` | PATCH with partial body → assert 200 or 422                     |
| `DELETE`| DELETE on a real-shaped path → assert 200/204 or 401            |

For dynamic segments (`[id].ts` → `/api/users/:id`), pick a placeholder param
(e.g., `id: "test-1"`) and pass it via `params`. Surface in the report that
the user may need to provide a real fixture.

## Step 5: Detect auth-gated APIs

If `pracht inspect routes --json` shows the API path (or its group) under
auth middleware, scaffold an extra test:

```ts
it("rejects unauthenticated requests", async () => {
  const res = await POST(args("http://localhost<api-path>", { method: "POST" }));
  expect([401, 403, 302]).toContain(res.status);
});
```

Note: middleware does NOT run when calling the handler directly — this test
verifies the handler's own defense if it has one. If the only defense is
middleware, mention that in the report and recommend an integration test that
goes through the framework's request pipeline (out of scope for this skill).

## Step 6: Validate JSON shape

For handlers that return `Response.json(...)`, generate:

```ts
it("returns JSON with the expected keys", async () => {
  const res = await GET(args("http://localhost<api-path>"));
  expect(res.headers.get("content-type")).toMatch(/application\/json/);
  const body = await res.json();
  expect(body).toEqual(expect.objectContaining({ /* fill in */ }));
});
```

## Step 7: Default-handler dispatchers

If the handler exports `default` (one function dispatching on
`request.method`), generate a test per HTTP method the handler appears to
support (grep for `request.method ===` patterns inside the file).

## Step 8: Run

```bash
pnpm test
```

Report passes/failures. Mark generated assertions as TODO so the user knows
to tighten them.

## Rules

1. Use `pracht inspect api --json` as the inventory — do not glob.
2. Only import methods the handler actually exports; otherwise the test fails
   to load.
3. Direct-handler invocation skips middleware. Be explicit in the report.
4. Test files live next to handlers with `.test.ts` suffix unless the
   project already uses a `__tests__/` convention (detect and match).
5. Never overwrite existing test files; emit a `.next.test.ts` and tell the
   user to merge.

$ARGUMENTS
