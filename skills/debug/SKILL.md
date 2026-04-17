---
name: debug
version: 1.1.0
description: |
  Pracht framework-aware debugging. Systematically investigates route matching,
  loader/API route errors, rendering issues, middleware, API routes, HMR, and build
  problems. Uses pracht's architecture knowledge to find root causes fast.
  Use when asked to "debug this", "fix this bug", "why is this broken",
  "blank page", "hydration mismatch", or "404 on my route".
  Proactively suggest when the user reports errors or unexpected behavior
  in a pracht application.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Debug

Framework-aware debugging for pracht applications — a full-stack Preact framework built on Vite.

The user will describe a symptom (error, unexpected behavior, blank page, etc.). Investigate systematically using the checklist below, stopping when you find the root cause.

Before deep manual inspection, prefer running `pracht verify` for a fast agent loop or `pracht doctor` when the problem could be caused by broader broken app wiring or missing files.
When another agent/tool needs the framework's resolved graph, prefer `pracht inspect routes --json`, `pracht inspect api --json`, or `pracht inspect build --json` over reconstructing it from source files.

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

## Debugging Checklist

Work through these in order, stopping when you find the root cause:

### 1. Route matching

- Run `pracht verify` first if you want a cheap changed-file confidence check.
- Run `pracht doctor` if the route might be missing, miswired, or pointing at a missing module across the project.
- For machine-readable route wiring, run `pracht inspect routes --json`.
- Read `src/routes.ts` — is the route defined? Is the path correct?
- Check for typos in file paths (the manifest uses relative paths like `"./routes/home.tsx"`).
- For dynamic segments, verify bracket syntax: `route("/users/:id", ...)` in manifest, `[id].ts` in filenames.
- Grep for the route path across the manifest and check `matchAppRoute()` logic if needed.

### 2. Loader / API route errors

- Read the route module's `loader` function or the matching API route handler.
- Check that `loader` returns serializable data (no functions, no circular refs).
- Check that API route handlers return `Response` objects and branch on `request.method` when using a default export.
- Look for unhandled promise rejections or thrown errors.
- Verify `LoaderArgs` destructuring matches what the framework provides: `{ request, params, context, signal, url, route }`.

### 3. Rendering issues

- **Blank page**: Check if the route has `render: "spa"` (no SSR content expected) vs `"ssr"`.
- **Hydration mismatch**: In dev, pracht surfaces a fixed-position red banner at the top of the page listing each mismatched component (via Preact's `options.__m` hook). Compare server-rendered HTML vs client component output. Common causes:
  - Date/time rendering differences
  - Browser-only APIs used during SSR (`window`, `document`, `localStorage`)
  - Conditional rendering based on client state
- **Missing shell**: Verify the shell is registered in `defineApp({ shells: { ... } })` and assigned to the route/group.
- **404 page**: Route not matched — check manifest wiring (step 1).

### 4. Middleware issues

- Verify middleware is registered in `defineApp({ middleware: { ... } })`.
- Verify middleware is applied to the route/group: `middleware: ["name"]`.
- Check middleware return values:
  - `void` / `undefined` → continue to loader
  - `{ redirect: "/path" }` → redirect
  - `Response` object → short-circuit
  - `{ context: { ... } }` → augment context
- Middleware runs server-side only, before loaders.

### 5. API route issues

- API routes live in `src/api/` and are auto-discovered (no manifest entry needed).
- For machine-readable API inventory, run `pracht inspect api --json`.
- File path maps to URL: `src/api/health.ts` → `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`.
- Each file exports named HTTP method handlers (`GET`, `POST`, etc.) or one default handler.
- Missing method handler → 405 response when there is no default handler.
- Default handlers receive the same route args and can branch on `request.method`.
- Handlers must return `Response` objects.

### 6. Vite plugin / HMR issues

- Check `vite.config.ts` — is `pracht()` plugin included?
- Virtual modules: `virtual:pracht/client` (hydration), `virtual:pracht/server` (SSR).
- HMR: changes to `src/routes.ts` trigger full reload; changes to route/shell/middleware/API files invalidate the server module.
- If HMR seems broken, check that the file is in one of the watched directories (`src/routes/`, `src/shells/`, `src/middleware/`, `src/api/`).

### 7. Build / deployment issues

- `pracht build` runs client + server builds, then prerenders SSG/ISG routes.
- `pracht inspect build --json` reports the resolved adapter target plus client/CSS/JS manifests from the latest build output.
- Check `dist/client/` for client assets and `dist/server/` for server bundle.
- ISG manifest: `dist/client/pracht-isg-manifest.json`.
- Adapter mismatch: ensure `pracht({ adapter: nodeAdapter() })` or `cloudflareAdapter()` matches deployment target.

## Key Files

| File                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `src/routes.ts`       | App manifest — all route/shell/middleware definitions |
| `vite.config.ts`      | Vite config with `pracht()` plugin                    |
| `src/routes/*.tsx`    | Route modules (loader, Component)                     |
| `src/shells/*.tsx`    | Shell layout components                               |
| `src/middleware/*.ts` | Server-side middleware                                |
| `src/api/*.ts`        | API route handlers                                    |

## Framework Internals

- `handlePrachtRequest()` dispatches: API routes → middleware → loader → render → HTML assembly
- Route state JSON: returned when `x-pracht-route-state-request` header is present (client-side navigation)
- Hydration state: injected as `window.__PRACHT_STATE__` in the HTML
- Client router: `initClientRouter()` intercepts link clicks and fetches route state JSON

## Rules

1. Always read the relevant source files before diagnosing.
2. Start with the most likely cause based on the symptom, not a full audit.
3. When you find the root cause, explain _why_ it breaks and fix it.
4. If wiring looks suspicious, run `pracht verify` first, then `pracht doctor` if you need the full-project view. If running the dev server or tests would help, do so (`pracht dev`, `pnpm test`, `pnpm e2e`).
5. After fixing, verify the fix works (run relevant test or check dev server output).
6. Never say "this should fix it." Verify and prove it.

$ARGUMENTS
