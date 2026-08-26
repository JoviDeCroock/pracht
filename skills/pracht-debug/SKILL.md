---
name: pracht-debug
version: 1.4.0
description: |
  Framework-aware debugging for pracht: route matching, loader and API errors,
  rendering and hydration, middleware, HMR, and build failures — root cause first.
  Use for "debug this", "fix this bug", "why is this broken", "blank page",
  "hydration mismatch", "404 on my route"; suggest it when the user reports
  unexpected pracht behavior.
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

**Iron law: no fixes without root-cause investigation first.** Read the
relevant source before diagnosing, start from the most likely cause for the
symptom rather than a full audit, and when you find the root cause explain
*why* it breaks. After fixing, prove the fix — run the test, check the dev
server. Never say "this should fix it."

## Instruments

Reach for these before deep manual inspection:

| Tool | Use |
| ---- | --- |
| `pracht verify` (`--changed` to scope to git-changed files) | Fast confidence check |
| `pracht doctor` | Broader broken wiring or missing files |
| `pracht inspect routes\|api\|build --json` | The resolved graph — never reconstruct it from source |
| `GET /_pracht` (JSON at `/_pracht.json`) | Same graph from a running dev server, no CLI needed |
| `Server-Timing` on dev SSR responses | `mw` / `loader` / `render` durations in ms — which phase is slow |

`pracht inspect` needs the pracht plugin in the vite config; `inspect build`
needs a prior `pracht build`. Under a Vite deploy base, prefix `/_pracht` with
that base (links from the devtools and dev-404 pages already do). When the
pracht MCP server is registered (docs/MCP.md), prefer the
`inspect_routes`/`inspect_api`/`doctor`/`verify` MCP tools — same payloads,
structured results.

## Checklist

Work in order; stop at the root cause.

### 1. Route matching

- `pracht inspect routes --json` (or `curl http://localhost:5173/_pracht.json`)
  for the resolved wiring; `pracht doctor` if a route may be missing, miswired,
  or pointing at a missing module.
- Is the route in `src/routes.ts` with the right path? The manifest uses
  relative paths like `"./routes/home.tsx"` — check for typos.
- Dynamic segments: `route("/users/:id", ...)` in the manifest, `[id].ts` in
  filenames.
- If needed, grep the route path across the manifest and check
  `matchAppRoute()`.

### 2. Typed routes and links

- A `<Link route="...">`, `href("...")`, or route-object `useNavigate()` that
  fails to typecheck usually means stale generated files: `pracht typegen
  --check`.
- Confirm the route id exists in `pracht inspect routes --json`. Fallback ids
  get renamed by path changes.
- `src/pracht.d.ts` carries the inferred params. `:id`, `*`, and `:path*` are
  required; extra params should fail at typecheck time.
- Runtime `Unknown pracht route id "..."`: dev appends `Did you mean "..."?`
  plus the registered ids (production tree-shakes that and throws bare). Check
  the typo first, then that `pracht typegen` ran and the component renders
  inside the pracht route tree.
- For unexpected URLs, reproduce with `href(routeId, options)` and compare
  against the route's resolved path and params.

### 3. Loader / API errors

- On slow pages, read `Server-Timing` before reading code.
- Loaders must return serializable data — no functions, no circular refs.
- API handlers must return `Response` objects, and a default export must branch
  on `request.method`.
- Look for unhandled rejections or thrown errors.
- `LoaderArgs` destructuring must match what the framework provides:
  `{ request, params, context, signal, url, route }`.

### 4. Rendering

- **Blank page** — check whether the route is `render: "spa"` (no SSR content
  expected) rather than `"ssr"`.
- **Hydration mismatch** — dev shows a fixed red banner listing each mismatched
  component (via Preact's `options.__m` hook). Compare server HTML against
  client output. Usual causes: date/time differences, browser-only APIs during
  SSR (`window`, `document`, `localStorage`), conditional rendering on client
  state — or two copies of `@pracht/core` in the SSR module graph. The tell for
  that last one: in the server-rendered HTML of *every* page, `useLocation()`
  returns `/`, `useParams()` returns `{}`, and `useRouteData()` returns
  `undefined`, while the hydrated client is correct — provider and hooks hold
  different `createContext()` objects. The plugin prevents it by keeping
  `@pracht/*` in `ssr.noExternal`; listing a `@pracht/*` package in
  `ssr.external` overrides that and brings the split back.
- **Missing shell** — an unregistered shell name throws at manifest resolution
  (`Unknown shell "..." for route "...". Did you mean "..."? Registered shells:
  ...`) and appears in the dev error overlay as soon as the manifest loads.
  Check `defineApp({ shells })` and the route/group assignment.
- **404** — usually step 1, but a 404 on a URL you *do* expect means the loader
  threw `notFound()`, not that matching failed. In `pracht dev`, unmatched
  navigations render a dev-only 404 listing every registered route and its
  render mode (also printed at dev-server startup, also in `pracht inspect
  routes`). Apps declaring `defineApp({ notFound })` render their own 404 page
  in dev and production alike, so that table is not shown — read `pracht
  inspect routes` directly.

### 5. Middleware

- It must be registered in `defineApp({ middleware })` and applied via
  `middleware: ["name"]` on the route or group. An unregistered name (route,
  group, or `api.middleware`) throws at manifest resolution: `Unknown
  middleware "..." for route "...". Did you mean "..."? Registered middleware:
  ...`
- Middleware is wrap-around and server-side only, wrapping loaders and API
  handlers. It must always return a `Response`, either from `await next()` or
  by short-circuiting. Common failures:

| Bug | Error |
| --- | ----- |
| Forgetting `return next()` | `Middleware "..." did not return a Response` |
| Calling `next()` twice | `Middleware "..." called next() multiple times` |
| Mutating a non-object `context` | Silent — mutations don't propagate; always pass an object |

### 6. API routes

- They live in `src/api/`, auto-discovered, no manifest entry.
  `pracht inspect api --json` for the inventory.
- Path maps to URL: `src/api/health.ts` → `/api/health`,
  `src/api/users/[id].ts` → `/api/users/:id`.
- Each file exports named method handlers (`GET`, `POST`, …) or one default
  handler that branches on `request.method`. A missing method handler is a 405
  when there is no default.

### 7. Vite plugin and HMR

- Is `pracht()` in `vite.config.ts`? Virtual modules are
  `virtual:pracht/client` (hydration), `virtual:pracht/server` (SSR),
  `virtual:pracht/islands-client` (islands hydration).
- HMR only watches `src/routes/`, `src/shells/`, `src/middleware/`,
  `src/api/`, `src/server/`, `src/islands/`.
- What each change does: editing `src/routes.ts` restarts the dev server
  (`server.restart()`, not a browser reload). Route, shell, and island
  components use Preact Fast Refresh; route/shell edits and client-reachable
  loader dependencies also re-fetch active route data, with rapid saves
  coalesced so the newest result settles last and a failed latest refresh
  falling back to a reload. Adding or removing a route `loader` or route/shell
  `head` export reloads so generated client hints stay current, and editing a
  route/shell exporting document `headers()` reloads because CSP and other
  response headers cannot be patched. Compiled formats get refresh
  instrumentation after their companion Vite plugin runs, but Markdown, MDX,
  and configured additional formats reload conservatively because a transform
  may synthesize `headers()` from metadata; default `.tsrx` preserves state
  when its source is headerless. Everything else invalidates the server module.

### 8. Build and deployment

- `pracht build` runs the client and server builds, then prerenders SSG/ISG
  routes. On serverful adapters a failed path is warned about and skipped, but
  the build fails if *every* attempted prerender returns non-200 — use the
  reported underlying error to fix the shared loader/render dependency; partial
  output stays valid. Static exports fail on any bad path.
- `pracht preview` builds and serves production output locally (Node runs
  `dist/server/server.js`; Cloudflare delegates to `wrangler dev`).
- `pracht inspect build --json` reports the resolved adapter target plus the
  client/CSS/JS manifests from the last build.
- Client assets land in `dist/client/`, the server bundle in `dist/server/`.
  The ISG manifest is `dist/server/isg-manifest.json`; on Cloudflare the build
  also copies it to `dist/client/_pracht/isg.json` for the worker to read via
  the assets binding.
- Confirm the adapter in `pracht({ adapter: … })` matches the deployment
  target.

## Framework internals

- `handlePrachtRequest()` dispatches: API routes → middleware → loader →
  render → HTML assembly.
- Route-state JSON is returned when the `x-pracht-route-state-request` header
  is present (client-side navigation).
- Hydration state is injected as `window.__PRACHT_STATE__`.
- `initClientRouter()` intercepts link clicks and fetches that route state.

$ARGUMENTS
