---
name: typed-routes
version: 1.1.0
description: |
  Add or maintain pracht typed routes, typed links, route-object navigation,
  and generated href helpers. Use when asked to "add typed routes", "fix typed
  links", "replace hard-coded hrefs", "run typegen", or make navigation route-id
  based instead of string based.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Typed Routes

Use this workflow to keep route ids, params, links, and navigation type-safe.

## Step 1: Inspect the resolved graph

The resolved app graph is the source of truth — not a manual glob of `src/`.

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`,
`generate_*`) over shelling out. Prerequisite: `pracht inspect` needs a vite
config with the pracht plugin registered.

```bash
pracht inspect routes --json
```

Check every route has a stable id. Explicit `id` fields are preferred for routes
that app code links to, because fallback ids change when paths change.

```ts
route("/products/:id", () => import("./routes/products/[id].tsx"), {
  id: "product",
  render: "ssr",
});
```

Any route without an explicit `id` — manifest apps included, not just
pages-router apps — gets a fallback id derived from the route path (`/` →
`index`, `/blog/:slug` → `blog-slug`, `/*` → `splat`).

## Step 2: Generate route types and helpers

Run:

```bash
pracht typegen
```

This writes:

- `src/pracht.d.ts` — module augmentation for route ids, params, loader data
  types, and API route request/response types (consumed by `apiFetch()`).
- `src/pracht-routes.ts` — runtime `href()` helper backed by the same route map.

Earlier versions wrote the declaration to `src/pracht-routes.d.ts`; typegen
removes that stale file automatically (TypeScript silently ignored it next to
the same-named `.ts` helper).

Do not hand-edit generated files. If they are stale, update the route graph and
run typegen again — or rely on `pracht dev`, which refreshes them when route
files are added, removed, or renamed and when the route manifest or an imported
definition module changes. The dev banner prompts for the initial typegen run
when `src/pracht.d.ts` does not exist. In CI, prefer:

```bash
pracht typegen --check
```

## Step 3: Replace string navigation where it matters

### Components

```tsx
import { Link, useNavigate } from "@pracht/core";

export function ProductLink({ id }: { id: string }) {
  const navigate = useNavigate();

  return (
    <>
      <Link route="product" params={{ id }} search={{ ref: "home" }}>
        View product
      </Link>
      <button onClick={() => void navigate({ route: "product", params: { id } })}>
        Open product
      </button>
    </>
  );
}
```

`<Link>` renders a normal `<a>` and the client router intercepts it like any
same-origin anchor. It also accepts navigation-behavior props:
`prefetch="none" | "hover" | "intent" | "viewport" | "render"` (per-link
prefetch strategy, default `"intent"`), `preserveScroll` (keep the scroll
position), and `viewTransition` (animate the navigation with the View Transitions API
where supported). There is also an imperative `prefetch()` export and a
`useNavigation()` hook for pending navigation/submission state.

### Outside components

```ts
import { href } from "./pracht-routes";

const productUrl = href("product", {
  params: { id: "123" },
  search: { tab: "details" },
});
```

Use `href()` in loaders that return URLs, sitemap helpers, menu config, test
fixtures, and other non-component code.

### Loader data

After typegen, `useRouteData(routeId)` returns that route's loader data with
no generic — route ids autocomplete and the type follows the route's loader
(or its separate loader file from the manifest):

```tsx
import { useRouteData } from "@pracht/core";

export function Component() {
  const data = useRouteData("product");
  return <h1>{data.product.name}</h1>;
}
```

Prefer this over `useRouteData<typeof loader>()` when typegen runs; keep the
generic form for projects that do not generate route types. Routes without a
loader type their data as `undefined`. The id must be the active route — dev
mode warns on mismatches.

### API routes

After typegen, `apiFetch()` type-checks API calls end to end — paths,
methods, params, bodies and queries (for `defineApi()` routes), and response
types:

```ts
import { apiFetch } from "@pracht/core";

const item = await apiFetch("/api/items/:id", { params: { id: "42" } });
```

See docs/API_VALIDATION.md for `defineApi()` and validation error handling.
Typegen discovers API route files without importing them, so it is safe for
route modules that initialize runtime-only services at module scope.

Query and params values cross the wire as strings — write schemas that accept
string input (`z.coerce.number()`, not `z.number()`); `apiFetch()` rejects
query and params keys without a string representation at compile time when the
schema exposes a concrete input type. Handlers that need a custom status keep
typed payloads with `json(value, { status })`.

## Step 4: Param and search rules

Generated param types accept `RouteParamInput = string | number | boolean`
(values are stringified into the path), so:

- `:id` requires `params: { id: RouteParamInput }` — a `string` is typical,
  but `number`/`boolean` also typecheck.
- `*` requires `params: { "*": RouteParamInput }`.
- `:path*` requires `params: { path: RouteParamInput }`.
- Routes with no dynamic segments should omit `params`.
- Missing and extra params should fail at typecheck time.
- `search` currently accepts `string`, `URLSearchParams`, or an object of
  primitive values/arrays; route-specific search schemas can be added later.

## Step 5: Verify

Run at least:

```bash
pracht typegen --check
pnpm typecheck
pracht verify --json
```

If navigation changed, add or update Playwright coverage for both the rendered
anchor `href` and client-side navigation without a full page reload.

## Rules

1. Always start from `pracht inspect routes --json` or `pracht typegen`; do not
   infer the full route map from files by hand.
2. Prefer adding explicit ids before converting links for important routes.
3. Never edit `src/pracht.d.ts` or `src/pracht-routes.ts` manually.
4. Keep plain `<a href="...">` where a URL is genuinely external, opaque, or
   user-provided.
5. After adding/removing/renaming routes, run `pracht typegen` and include the
   generated file changes in the same commit.

$ARGUMENTS
