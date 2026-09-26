---
name: audit-loaders
version: 1.1.1
description: |
  Audit pracht route loaders for serializability, leaked secrets, unsafe
  `loaderCache`, browser-only API use, and missing `AbortSignal` plumbing.
  Use for "audit loaders", "check loader data", "find serialization bugs", "loader
  security review".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Loaders

Static analysis of every loader in the project. The framework serializes loader
return values to the client via `window.__PRACHT_STATE__`, so anything returned
ends up in the browser — including secrets you never meant to expose.

## Step 1: Enumerate routes

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify` tools over
shelling out.

```bash
pracht inspect routes --json
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up.

For every route entry, read `loaderFile ?? file` and inspect the `loader`
export there. Loaders may live in a separate data module wired via the
manifest (`RouteConfig.loader`); the inspect JSON surfaces that as
`loaderFile` (null when the loader lives in the route module itself). Reading
only `file` misses every externalized loader.

## Step 2: Run the five checks

For each `loader` (and `getStaticPaths` when present):

### 2a. Serializability

Loader data reaches the browser through pracht's route-data encoding, not bare
JSON. It round-trips JSON values plus `undefined`, `NaN`, `±Infinity`, `-0`,
`bigint`, `Date`, `RegExp`, `URL`, `Map`, `Set`, and shared or circular
references (identity preserved) — do not flag those. Objects with a `toJSON()`
method are sent as its result, as with `JSON.stringify`.

Flag returns that contain any of:

| Construct                         | Why it breaks                                   |
| --------------------------------- | ----------------------------------------------- |
| Class instances without `toJSON`  | The request fails naming the path               |
| Class instances with `toJSON`     | Arrive as `toJSON()` output; the type lies      |
| `Function` / arrow values         | The request fails naming the path               |
| `Symbol` values                   | The request fails naming the path               |
| `Promise` (bare)                  | Not serializable — wrap in `defer()`            |
| `Buffer` / typed arrays           | The request fails naming the path               |
| `defer()` inside a `Map`/`Set`    | Never resolved; fails as an unresolved marker   |

These failures happen in production too (a 500 on the route). Routes with
`hydration: "islands"` or `"none"` ship no loader data, so their returns are
not checked — skip 2a for them.

A bare promise in loader data is always a bug — it fails the request. The fix
is `defer(promise)`, which marks the field as deferred and is read in the
component with `use()` inside a `<Suspense>` boundary. Flag a bare promise as an
`error` and point at `defer()`; a `defer()`ed field is correct and must not be
flagged.

Two `defer()` rules worth checking while you are in the loader:

- A deferred value must not redirect, throw `PrachtHttpError`, or set response
  status or headers — by the time it settles the response is already committed.
  Auth belongs in middleware or the awaited part of the loader.
- `defer(await …)` defeats the point and throws at runtime. Flag it.
- `defer()` must be returned from an enumerable data property, not hidden
  behind a getter. An unresolved marker throws during serialization.

Recommend converting unsupported values to plain objects or one of the
supported types before return.

### 2b. Secret leaks

Ownership note: deep secret scanning is owned by `/audit-secrets` and by
`pracht verify`'s env scan — keep this check brief and point the user there
rather than triple-reporting the same findings. Here, only flag what falls
out of reading the return value anyway:

Grep the loader body and anything it returns for:

- `process.env.*` references that flow into the return value.
- `context.env.*` (Cloudflare bindings) flowing into the return value.
- Variables named `*SECRET*`, `*TOKEN*`, `*KEY*`, `*PASSWORD*`, `*PRIVATE*`,
  `*API_KEY*` reaching the return.
- Spreads of full DB rows containing `password_hash`, `mfa_secret`, etc.

Loaders run server-side but **the return value crosses the wire**. Always
project to a smaller shape before returning.

### 2c. Browser-only APIs at module top level or in loader

Flag any of these accessed unconditionally inside `loader` or at the top level
of a route module that is rendered SSR/SSG/ISG:

- `window`, `document`, `navigator`, `localStorage`, `sessionStorage`,
  `IntersectionObserver`, `matchMedia`, `requestAnimationFrame`.

These crash on the server. For SPA-only routes (`render: "spa"`) it's fine
inside the component — but never inside `loader`.

### 2d. AbortSignal plumbing

For loaders that call `fetch` or any I/O:

- The framework passes `signal` in `LoaderArgs`.
- Verify it is forwarded to outbound `fetch(url, { signal })` calls and to any
  database client that accepts cancellation.
- A loader that ignores `signal` keeps work running after the client navigates
  away.

### 2e. Loader cache safety

For routes with a positive `loaderCache` value, flag loader data whose freshness
or visibility depends on cookies, authorization headers, sessions, user identity,
permissions, or request-specific context. Route-state HTTP caching is `private`,
so shared proxies cannot reuse it, but a stale response can still survive logout,
account switching, or permission changes in the same browser.

Recommend `loaderCache: false`/`0` for personalized or authorization-sensitive
loaders. Use a positive duration only when every field in the returned data can be
safely reused for that long. Do not confuse `loaderCache` with ISG `revalidate` or
the short-lived in-memory prefetch cache; they are independent policies.

## Step 3: Report

Produce a markdown table:

| Route | File | Severity | Finding | Suggested fix |
| ----- | ---- | -------- | ------- | ------------- |

Severities: `error` (secret leak, crash), `warn` (serialization risk, missing
signal), `info` (style nit).

## Rules

1. Use `pracht inspect routes --json` as the source of truth — do not glob
   `src/routes/**` and risk missing manifest wiring or catching orphan files.
2. Read the actual loader source — do not infer from names.
3. For each finding, point at the file and line.
4. Do not auto-fix. Hand the user the report; let them choose.
5. If the loader returns a typed shape from a DB ORM, recommend an explicit
   `select` or projection step rather than spreading the row.

$ARGUMENTS
