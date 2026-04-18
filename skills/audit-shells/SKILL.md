---
name: audit-shells
version: 1.0.0
description: |
  Audit pracht shells for composition bugs: missing `Loading()` on SPA-using
  shells, accidental `<html>`/`<head>`/`<body>` rendering, broken error
  bubbling, unused shells, and shells that swallow children.
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

```bash
pracht inspect routes --json
```

For every shell registered in the manifest, read its source file. Also list
which routes use which shell (the JSON output includes resolved `shell` per
route).

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
- Verify return shape matches `{ title?, lang?, meta?, link? }`.
- Flag shells whose `head()` returns `undefined` unconditionally — delete the
  export.

### 2e. Error boundary chain

Errors bubble route → shell → global handler. Flag shells that:
- Have an `ErrorBoundary` export but never re-throw or render fallback UI.
- Catch errors and `return null` (silent failure).

## Step 3: Coverage and waste

- **Unused shells**: any shell registered in `defineApp({ shells })` that no
  route or group references. Recommend removal.
- **Single-use shells**: shells used by exactly one route — sometimes a
  signal the layout should be inlined. Flag as `info`.
- **Routes without shells**: routes resolved to no shell. Usually intentional
  for raw HTML responses, but worth listing.

## Step 4: Report

| Shell | File | Used by | Issue | Severity |
| ----- | ---- | ------- | ----- | -------- |

Severities: `error` (document tags, missing children), `warn` (no Loading on
SPA routes, broken ErrorBoundary), `info` (unused, single-use).

## Rules

1. Source of truth is `pracht inspect routes --json` — it shows resolved
   shell-per-route after group inheritance.
2. Read the shell source — do not infer from names.
3. Distinguish `Loading()` (SPA-only fallback) from `ErrorBoundary` (error
   surface). Both are independent shell exports.
4. Recommend deletions for unused shells; do not delete automatically.
5. When in doubt about render mode interaction, cross-reference with
   `tune-render-mode`.

$ARGUMENTS
