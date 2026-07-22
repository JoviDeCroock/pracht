---
name: audit-shells
version: 1.1.0
description: |
  Audit pracht shells for composition bugs: missing `Loading()` on SPA-using
  shells, accidental `<html>`/`<head>`/`<body>` rendering, shells that swallow
  children, unused shells, and redundant `ErrorBoundary` exports (shell-level
  boundaries are valid fallbacks; routes win when both declare one).
  Use when asked to "audit shells", "check shell composition", "find unused
  shells", or "is my layout structured correctly".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Shells

Shells in pracht are named layout components composed around routes. The
framework owns the document — shells must not render `<html>`, `<head>`, or
`<body>`. They sit between the framework's HTML scaffold and the route
component.

## Step 1: Enumerate

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

```bash
pracht inspect routes --json
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up; run it from the app root.

For every shell used by the app, read its source file. Also list which routes
use which shell (the JSON output includes resolved `shell` and `shellFile` per
route). The JSON's top-level `mode` field tells you which router the app uses
— see Step 3 for how that changes shell discovery.

## Step 2: Per-shell checks

For each shell file:

### 2a. Document-level tag misuse

Grep for `<html`, `<head>`, `<body>`, `<meta`, `<title>`, `<link rel`. Any of
these inside a shell is a bug — the framework injects them based on `head()`
exports. Recommend moving meta/title to the shell's `head()` export and
removing the JSX tags.

### 2b. `Shell` export shape

- Must be a function component named `Shell`.
- Must accept `{ children }: ShellProps`.
- Must render `{children}` somewhere — flag shells that never render
  `children` (hard to spot, blank page everywhere).

### 2c. `Loading()` for SPA routes

If any route assigned to this shell has `render: "spa"`, the shell SHOULD
export a `Loading()` function that renders a placeholder during the
client-only data fetch. Without it, users see blank content during navigation.

### 2d. `head()` export

- Optional, but recommended if the shell sets shared meta tags.
- Verify return shape matches `{ title?, lang?, meta?, link?, script? }`.
- Flag shells whose `head()` returns `undefined` unconditionally — delete the
  export.

### 2e. `ErrorBoundary` export

`ErrorBoundary` is a valid export on **both** shells and routes (see
`ShellModule` and `RouteModule` in `packages/framework/src/types.ts`). The
runtime resolves `routeMod.ErrorBoundary ?? shellModule.ErrorBoundary` — a
shell-level boundary is the fallback for every route under that shell when
the route doesn't declare its own.

- A shell exporting `ErrorBoundary` is fine — often the right place for a
  shared error fallback.
- If **both** the shell and a route declare one, the route wins. Flag as
  `info` at most, and only if the shell boundary is thereby unreachable for
  every route under it (dead code).

### 2f. `headers()` export

Shells may export `headers()` to contribute response headers (merged with
route `headers()`). Optional, but if present:
- Verify the return shape is a plain `HeadersInit`.
- Flag shells whose `headers()` returns `undefined` unconditionally — delete
  the export.

## Step 3: Coverage and waste

Shell registration is mode-aware — check the `mode` field from the Step 1
JSON first:

- **Manifest apps** (`mode: "manifest"`): shells are
  registered in `defineApp({ shells })`. Diff that registry against the
  per-route resolved `shell`/`shellFile` values from the inspect JSON — the
  JSON has no shell registry of its own, so "unused" means "registered in
  `defineApp` but referenced by no route or group".
- **Pages apps** (`mode: "pages"`): there is no `defineApp` shell registry.
  The shell is `src/pages/_app.tsx`, auto-registered under the name `"pages"`
  and applied to every route (see docs/ROUTING.md). "Unused shells" analysis
  does not apply; instead verify `_app.tsx` (if present) shows up as the
  resolved shell on every route.

Then report:

- **Unused shells** (manifest apps only): registered but referenced by no
  route or group. Recommend removal.
- **Single-use shells**: shells used by exactly one route — sometimes a
  signal the layout should be inlined. Flag as `info`.
- **Routes without shells**: routes resolved to no shell. Usually intentional
  for raw HTML responses, but worth listing.

## Step 4: Report

| Shell | File | Used by | Issue | Severity |
| ----- | ---- | ------- | ----- | -------- |

Severities: `error` (document tags, missing children), `warn` (no `Loading`
on SPA routes, empty `headers()`), `info` (unused, single-use, shell
`ErrorBoundary` shadowed by route-level boundaries on every route).

## Rules

1. Source of truth is `pracht inspect routes --json` — it shows resolved
   shell-per-route after group inheritance.
2. Read the shell source — do not infer from names.
3. `Loading()` is a shell export (SPA-only fallback). `ErrorBoundary` is
   valid on both shells and routes: the shell's boundary is the fallback,
   the route's wins when both exist. Do not flag shell boundaries as bugs.
4. Recommend deletions for unused shells; do not delete automatically.
5. When in doubt about render mode interaction, cross-reference with
   `tune-render-mode`.

$ARGUMENTS
