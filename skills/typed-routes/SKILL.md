---
name: typed-routes
version: 1.0.0
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

The resolved app graph is the source of truth — not a manual glob of `src/`:

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

For pages-router apps, fallback ids come from the route path (`/` → `index`,
`/blog/:slug` → `blog-slug`, `/*` → `splat`).

## Step 2: Generate route types and helpers

Run:

```bash
pracht typegen
```

This writes:

- `src/pracht-routes.d.ts` — module augmentation for route ids, params, and
  loader data types.
- `src/pracht-routes.ts` — runtime `href()` helper backed by the same route map.

Do not hand-edit generated files. If they are stale, update the route graph and
run typegen again. In CI, prefer:

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
same-origin anchor.

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

## Step 4: Param and search rules

- `:id` requires `params: { id: string }`.
- `*` requires `params: { "*": string }`.
- `:path*` requires `params: { path: string }`.
- Routes with no dynamic segments should omit `params`.
- Missing and extra params should fail at typecheck time.
- `search` currently accepts `string`, `URLSearchParams`, or an object of
  primitive values/arrays; route-specific search schemas can be added later.

## Step 5: Verify

Run at least:

```bash
pracht typegen --check
pnpm typecheck
```

If navigation changed, add or update Playwright coverage for both the rendered
anchor `href` and client-side navigation without a full page reload.

## Rules

1. Always start from `pracht inspect routes --json` or `pracht typegen`; do not
   infer the full route map from files by hand.
2. Prefer adding explicit ids before converting links for important routes.
3. Never edit `src/pracht-routes.d.ts` or `src/pracht-routes.ts` manually.
4. Keep plain `<a href="...">` where a URL is genuinely external, opaque, or
   user-provided.
5. After adding/removing/renaming routes, run `pracht typegen` and include the
   generated file changes in the same commit.

$ARGUMENTS
