---
name: pracht-debug
version: 1.3.0
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

Before deep manual inspection, prefer running `pracht verify` (add `--changed` to scope the checks to git-changed files) for a fast agent loop or `pracht doctor` when the problem could be caused by broader broken app wiring or missing files.
When another agent/tool needs the framework's resolved graph, prefer `pracht inspect routes --json`, `pracht inspect api --json`, or `pracht inspect build --json` over reconstructing it from source files. Prerequisites: `pracht inspect` needs the pracht plugin registered in the project's vite config, and `pracht inspect build` needs a prior `pracht build`.
If the pracht MCP server is registered (docs/MCP.md), prefer the `inspect_routes`/`inspect_api`/`doctor`/`verify` MCP tools over shelling out — same payloads, structured results.
While the dev server is running, `GET /_pracht` serves a devtools page with the same resolved route/API graph (raw JSON at `/_pracht.json`) — useful when you have a browser or `curl` handy but no CLI access. Dev SSR responses also carry a `Server-Timing` header (`mw`, `loader`, `render` durations in ms) — check it in the browser Network panel or with `curl -sI` to see which phase makes a route slow.

## Iron Law

**NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.**

## Debugging Checklist

Work through these in order, stopping when you find the root cause:

### 1. Route matching

- Run `pracht verify --changed` first if you want a cheap changed-file confidence check.
- Run `pracht doctor` if the route might be missing, miswired, or pointing at a missing module across the project.
- For machine-readable route wiring, run `pracht inspect routes --json`. With a running dev server, `curl http://localhost:5173/_pracht.json` returns the same graph.
- Read `src/routes.ts` — is the route defined? Is the path correct?
- Check for typos in file paths (the manifest uses relative paths like `"./routes/home.tsx"`).
- For dynamic segments, verify bracket syntax: `route("/users/:id", ...)` in manifest, `[id].ts` in filenames.
- Grep for the route path across the manifest and check `matchAppRoute()` logic if needed.

### 2. Typed route/link issues

- If `<Link route="...">`, `href("...")`, or route-object `useNavigate()` fails to typecheck, run `pracht typegen --check` to detect stale generated files.
- Run `pracht inspect routes --json` and confirm the route id exists. If it is a fallback id, remember path changes can rename it.
- Check generated `src/pracht.d.ts` for inferred params. `:id`, `*`, and `:path*` params are required; extra params should fail at typecheck time.
- If runtime navigation throws `Unknown pracht route id "..."`, in dev the error includes a `Did you mean "..."?` suggestion and the list of registered route ids (production builds tree-shake this and throw the bare error) — check for a typo first, then ensure `pracht typegen` was run and the component is rendered inside the pracht route tree.
- For unexpected URLs, reproduce with `href(routeId, options)` and compare against the route's resolved path and params.

### 3. Loader / API route errors

- For slow pages, read the dev `Server-Timing` response header (`mw`/`loader`/`render` in ms) to see which phase dominates before reading code.
- Read the route module's `loader` function or the matching API route handler.
- Check that `loader` returns serializable data (no functions, no circular refs).
- Check that API route handlers return `Response` objects and branch on `request.method` when using a default export.
- Look for unhandled promise rejections or thrown errors.
- Verify `LoaderArgs` destructuring matches what the framework provides: `{ request, params, context, signal, url, route }`.

### 4. Rendering issues

- **Blank page**: Check if the route has `render: "spa"` (no SSR content expected) vs `"ssr"`.
- **Hydration mismatch**: In dev, pracht surfaces a fixed-position red banner at the top of the page listing each mismatched component (via Preact's `options.__m` hook). Compare server-rendered HTML vs client component output. Common causes:
  - Date/time rendering differences
  - Browser-only APIs used during SSR (`window`, `document`, `localStorage`)
  - Conditional rendering based on client state
- **Missing shell**: Referencing an unregistered shell name throws at manifest resolution — `Unknown shell "..." for route "...". Did you mean "..."? Registered shells: ...` — and shows up in the dev error overlay as soon as the server loads the manifest. Verify the shell is registered in `defineApp({ shells: { ... } })` and assigned to the route/group.
- **404 page**: Route not matched — check manifest wiring (step 1). In `pracht dev`, unmatched navigations render a dev-only 404 page listing every registered route with its render mode; compare the requested path against that table. The route table is also printed on dev-server startup and available via `pracht inspect routes`.

### 5. Middleware issues

- Verify middleware is registered in `defineApp({ middleware: { ... } })`. An
  unregistered name (on a route, group, or `api.middleware`) throws at manifest
  resolution — `Unknown middleware "..." for route "...". Did you mean "..."? Registered middleware: ...`
- Verify middleware is applied to the route/group: `middleware: ["name"]`.
- Middleware is wrap-around: it must always return a `Response`, either by
  calling `await next()` (to continue down the chain) or short-circuiting.
- Common bugs:
  - Forgetting `return next()` → `Middleware "..." did not return a Response`
  - Calling `next()` twice → `Middleware "..." called next() multiple times`
  - Mutating a non-object `context` → mutations don't propagate; always pass
    an object as the request context.
- Middleware runs server-side only, wrapping loaders and API handlers.

### 6. API route issues

- API routes live in `src/api/` and are auto-discovered (no manifest entry needed).
- For machine-readable API inventory, run `pracht inspect api --json`.
- File path maps to URL: `src/api/health.ts` → `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`.
- Each file exports named HTTP method handlers (`GET`, `POST`, etc.) or one default handler.
- Missing method handler → 405 response when there is no default handler.
- Default handlers receive the same route args and can branch on `request.method`.
- Handlers must return `Response` objects.

### 7. Vite plugin / HMR issues

- Check `vite.config.ts` — is `pracht()` plugin included?
- Virtual modules: `virtual:pracht/client` (hydration), `virtual:pracht/server` (SSR), `virtual:pracht/islands-client` (islands hydration).
- HMR: changes to `src/routes.ts` restart the dev server (`server.restart()`, not a browser-side full reload); changes to route/shell/middleware/API/server/islands files invalidate the server module.
- If HMR seems broken, check that the file is in one of the watched directories (`src/routes/`, `src/shells/`, `src/middleware/`, `src/api/`, `src/server/`, `src/islands/`).

### 8. Build / deployment issues

- `pracht build` runs client + server builds, then prerenders SSG/ISG routes.
- `pracht preview` builds and serves the production output locally (Node runs `dist/server/server.js`, Cloudflare delegates to `wrangler dev`).
- `pracht inspect build --json` reports the resolved adapter target plus client/CSS/JS manifests from the latest build output (requires a prior `pracht build`).
- Check `dist/client/` for client assets and `dist/server/` for server bundle.
- ISG manifest: `dist/server/isg-manifest.json`. On Cloudflare the build also copies it to `dist/client/_pracht/isg.json` for the worker runtime to read via the assets binding.
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
