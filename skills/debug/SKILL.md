---
name: debug
version: 1.0.0
description: |
  Viact framework-aware debugging. Systematically investigates route matching,
  loader/action errors, rendering issues, middleware, API routes, HMR, and build
  problems. Uses viact's architecture knowledge to find root causes fast.
  Use when asked to "debug this", "fix this bug", "why is this broken",
  "blank page", "hydration mismatch", or "404 on my route".
  Proactively suggest when the user reports errors or unexpected behavior
  in a viact application.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Viact Debug

Framework-aware debugging for viact applications — a full-stack Preact framework built on Vite.

The user will describe a symptom (error, unexpected behavior, blank page, etc.). Investigate systematically using the checklist below, stopping when you find the root cause.

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

## Debugging Checklist

Work through these in order, stopping when you find the root cause:

### 1. Route matching

- Read `src/routes.ts` — is the route defined? Is the path correct?
- Check for typos in file paths (the manifest uses relative paths like `"./routes/home.tsx"`).
- For dynamic segments, verify bracket syntax: `route("/users/:id", ...)` in manifest, `[id].ts` in filenames.
- Grep for the route path across the manifest and check `matchAppRoute()` logic if needed.

### 2. Loader / action errors

- Read the route module's `loader` or `action` function.
- Check that `loader` returns serializable data (no functions, no circular refs).
- Check that `action` returns `ActionEnvelope` shape (`{ data, ok, revalidate, redirect }`) or plain data.
- Look for unhandled promise rejections or thrown errors.
- Verify `LoaderArgs` destructuring matches what the framework provides: `{ request, params, context, signal, url, route }`.

### 3. Rendering issues

- **Blank page**: Check if the route has `render: "spa"` (no SSR content expected) vs `"ssr"`.
- **Hydration mismatch**: Compare server-rendered HTML vs client component output. Common causes:
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
- File path maps to URL: `src/api/health.ts` → `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`.
- Each file exports named HTTP method handlers (`GET`, `POST`, etc.).
- Missing method handler → 405 response.
- Handlers must return `Response` objects.

### 6. Vite plugin / HMR issues

- Check `vite.config.ts` — is `viact()` plugin included?
- Virtual modules: `virtual:viact/client` (hydration), `virtual:viact/server` (SSR).
- HMR: changes to `src/routes.ts` trigger full reload; changes to route/shell/middleware/API files invalidate the server module.
- If HMR seems broken, check that the file is in one of the watched directories (`src/routes/`, `src/shells/`, `src/middleware/`, `src/api/`).

### 7. Build / deployment issues

- `viact build` runs client + server builds, then prerenders SSG/ISG routes.
- Check `dist/client/` for client assets and `dist/server/` for server bundle.
- ISG manifest: `dist/client/viact-isg-manifest.json`.
- Adapter mismatch: ensure `viact({ adapter: "node" })` or `"cloudflare"` matches deployment target.

## Key Files

| File                  | Purpose                                               |
| --------------------- | ----------------------------------------------------- |
| `src/routes.ts`       | App manifest — all route/shell/middleware definitions |
| `vite.config.ts`      | Vite config with `viact()` plugin                     |
| `src/routes/*.tsx`    | Route modules (loader, action, Component)             |
| `src/shells/*.tsx`    | Shell layout components                               |
| `src/middleware/*.ts` | Server-side middleware                                |
| `src/api/*.ts`        | API route handlers                                    |

## Framework Internals

- `handleViactRequest()` dispatches: API routes → middleware → loader → render → HTML assembly
- Route state JSON: returned when `x-viact-route-state-request` header is present (client-side navigation)
- Hydration state: injected as `window.__VIACT_STATE__` in the HTML
- Client router: `initClientRouter()` intercepts link clicks and fetches route state JSON

## Rules

1. Always read the relevant source files before diagnosing.
2. Start with the most likely cause based on the symptom, not a full audit.
3. When you find the root cause, explain _why_ it breaks and fix it.
4. If running the dev server or tests would help, do so (`viact dev`, `pnpm test`, `pnpm e2e`).
5. After fixing, verify the fix works (run relevant test or check dev server output).
6. Never say "this should fix it." Verify and prove it.

$ARGUMENTS
