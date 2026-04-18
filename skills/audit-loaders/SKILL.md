---
name: audit-loaders
version: 1.0.0
description: |
  Audit pracht route loaders for serializability, leaked secrets,
  browser-only API misuse, and missing AbortSignal plumbing.
  Use when asked to "audit loaders", "check loader data", "find serialization
  bugs", "are my loaders safe", or "loader security review".
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

```bash
pracht inspect routes --json
```

For every route entry, read the `file` it resolves to and inspect the `loader`
export.

## Step 2: Run the four checks

For each `loader` (and `getStaticPaths` when present):

### 2a. Serializability

Flag returns that contain any of:

| Construct                    | Why it breaks                       |
| ---------------------------- | ----------------------------------- |
| `Date`, `Map`, `Set`, `URL`  | Not preserved by `JSON.stringify`   |
| Class instances              | Lose prototype on the client        |
| `Function` / arrow values    | Stripped silently                   |
| `Promise`                    | Becomes `{}`                        |
| Circular refs                | Throws at serialize time            |
| `Buffer` / typed arrays      | Becomes `{}` or numeric keys        |
| `bigint`                     | `JSON.stringify` throws             |
| `undefined` in arrays/object | Drops keys; arrays become `null`    |

Recommend converting to `string` (ISO for dates), plain arrays, or plain objects
before return.

### 2b. Secret leaks

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
