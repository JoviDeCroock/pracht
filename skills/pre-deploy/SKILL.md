---
name: pre-deploy
version: 1.4.0
description: |
  Adapter-aware pre-deployment checklist (Node, Cloudflare Workers, Vercel, static)
  for the failures that only surface in production: missing env vars, Node-only
  APIs in edge bundles, absent ISG manifest, oversized bundles, missing
  wrangler/vercel config, and static hosts without clean URLs, 404, or security
  headers.
  Use for "pre-deploy check", "ready to ship?", "deployment checklist", "is my
  build production-safe", before `wrangler deploy` or `vercel deploy`.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Pre-Deploy

Run before every production deploy. Each adapter has a different runtime
contract; enforce the one that matches the build. Never deploy on the user's
behalf — end at the verdict.

MCP: when the pracht MCP server is registered (docs/MCP.md), prefer its
`inspect_routes`/`inspect_api`/`inspect_build`/`doctor`/`verify` tools over
shelling out.

## Step 1: Build, then detect the adapter

Always build first — never lint a stale `dist/`.

```bash
pracht build
pracht inspect build --json
```

`adapterTarget` is authoritative; `vite.config.ts` (`nodeAdapter()`,
`cloudflareAdapter()`, `vercelAdapter()`, `staticAdapter()`) is the
cross-check. Never assume the adapter.

## Step 2: Framework-wide checks

```bash
pracht doctor --json
pracht verify --json
pracht typegen --check   # only if src/pracht-routes.ts or src/pracht.d.ts exists
```

These catch app-graph wiring problems independent of the adapter, including
`defineApp({ constraints })` violations and a stale `.pracht/app-graph.json`
snapshot (fix that with `pracht plan --write`, then re-review the plan output).
Resolve every `status: "error"` before continuing — **if `pracht doctor`
reports errors, stop here**; the remaining checks will be noisy false
positives. Stale generated typed-route files block deployment; if the app does
not use them yet, note that `typegen --check` is optional.

For a PR deploy, `pracht report --base origin/main` produces a markdown summary
(graph diff + verify + budgets) worth attaching.

## Step 3: Adapter checklist

### Node (`@pracht/adapter-node`)

- `dist/server/server.js`, `dist/client/.vite/manifest.json`, and — if any
  route is `render: "isg"` — `dist/server/isg-manifest.json` all exist.
- `pracht preview --skip-build` (or `node dist/server/server.js`) boots and
  `curl localhost:3000` returns 200.
- Every env var the app reads (grep `process.env.*` across `src/`) is set in
  the deployment environment. List them for the user.
- If the app mounts `createImageHandler()` from `@pracht/image/node`, `sharp`
  is installed and `localOrigin` is the same trusted public origin as
  `nodeAdapter({ canonicalOrigin })`. A relative image endpoint without both is
  an error in every environment; loopback-looking request origins are
  intentionally not trusted.
- Reverse proxy / TLS termination configured — out of scope here, flag for
  confirmation.
- If the proxy strips Vite's deploy base, `nodeAdapter({ basePathStripped:
  true })` is set; application code should still observe the public base in
  `request.url`, and the proxy must own the bare-base redirect (`/app` →
  `/app/`).

### Cloudflare Workers (`@pracht/adapter-cloudflare`)

- `wrangler.toml`/`wrangler.jsonc` present at repo root, `assets.directory`
  pointing at `dist/client`, and bindings declared for every `context.env.*`
  access in loaders, middleware, and API routes (grep, then cross-check).
- `main` points at `dist/server/worker.js` — the thin deploy wrapper
  re-exporting only the default handler and Cloudflare entrypoint classes.
  Pointing it at `dist/server/server.js` is an **error**: workerd validates
  every named export of the deploy entry and rejects the build metadata
  (`buildTarget`, manifests, `resolvedApp`, …) that `server.js` exports for the
  prerender pass.
- `no_bundle: true` plus an `ESModule` rule whose globs include `"**/*.js"`.
  Pracht's Vite output is already bundled and may contain lazy server chunks;
  these settings make Wrangler upload them as separate modules instead of
  folding them into the entry.
- `compatibility_date` is set and is a date the installed workerd supports. It
  must not be *newer* than the runtime, or workerd refuses to start ("This
  Worker requires compatibility date X, but the newest date supported by this
  server binary is Y"). Never set it to today's date — that is by construction
  at or beyond the newest released workerd.
- **No Node-only APIs in the server bundle.** Grep the server files for `fs`,
  `path` (Node form), `process.cwd`, `Buffer`, `__dirname`, `__filename`,
  `crypto.createHash` (use `crypto.subtle`), `child_process`, `cluster`,
  `worker_threads`. Check `compatibility_flags` first — with `nodejs_compat`,
  `Buffer` and several `node:` modules are legal — and only flag what the
  active flags do not cover. Dev already runs inside workerd via
  `@cloudflare/vite-plugin`, so this is the backstop for code paths dev never
  hits.
- An API route importing `@pracht/image/node` is an error on Workers (its
  optimizer needs `sharp`). Require `cloudflareLoader` or `passthroughLoader`.
- ISG works out of the box via the per-colo Workers Cache API. If
  time-revalidated routes should use the edge-tier Workers Caching upgrade,
  confirm *both* sides: `cloudflareAdapter({ cache: true })` and
  `"cache": { "enabled": true }` in wrangler config. With it enabled, flag ISG
  routes reachable through unbounded query strings — require a bounded
  allowlist or canonical redirect, or an uncached gateway with a normalized
  `cf.cacheKey` — and check that markdown-capable routes normalize `Accept` at
  the gateway when variant fan-out matters.
- Bundle size: measure what actually deploys — `dist/server/worker.js` plus its
  `dist/server/server.js` import and lazy chunks (`worker.js` alone is a few
  lines; `no_bundle` uploads the pre-built module graph). The Workers limit is
  ~1 MB compressed on free, ~10 MB on paid. Warn at 80% of the active limit.

### Vercel (`@pracht/adapter-vercel`)

- `.vercel/output/config.json` exists with `version: 3`, and
  `.vercel/output/static/` is populated.
- The render function exists at
  `.vercel/output/functions/<functionName>.func/server.js`. The name defaults
  to `render` but is configurable via `vercelAdapter({ functionName })` — read
  it from `vite.config.ts` rather than hardcoding `render.func`.
- Env vars are configured in the Vercel project. This cannot be verified from
  the CLI alone: run `vercel env pull` and diff against `process.env.*` uses.
- **Run the Cloudflare Node-only API check unconditionally.** The render
  function's `.vc-config.json` is always written with `runtime: "edge"`. Do not
  skip it based on a runtime probe — ISG routes run the same bundle on Node,
  but a Node-only API still breaks the edge function.
- Every `<route>.prerender-config.json` sits next to a **Serverless**
  `<route>.func` (`.vc-config.json` with `launcherType: "Nodejs"`). Vercel
  rejects a prerender config paired with an edge function:
  `Unexpected function type "EdgeFunction" at path "<route>"`.
- `vercelAdapter({ regions: "all" })` is valid for the Edge render function,
  but generated Node ISG function configs must omit `regions` so the project
  default applies; Node configs may only contain arrays of concrete region
  identifiers.
- An API route importing `@pracht/image/node` is an error for the Edge
  function. Require `vercelLoader` (with aligned allowed sizes) or
  `passthroughLoader`.

### Static export (`@pracht/adapter-static`)

There is no server to get wrong, so this checklist is about what the *host*
must do and what the build cannot enforce.

- `dist/client/` exists and is the deploy root. `dist/server/` is build tooling
  and must not be uploaded — it contains the prerender bundle.
- The build is the gate: it fails closed on `ssr`/`isg` routes, SPA loaders,
  non-full SPA hydration, API routes, route/not-found middleware,
  network-exposed capabilities, and any Vite `base` that is not `/` or a
  root-absolute path. If `pracht build` succeeded, those contracts already hold
  — do not re-derive them by hand. Report a failing build verbatim; the message
  names the routes.
- The host serves `index.html` for directory URLs. Confirm the actual setting:
  S3 website endpoints need an index document, nginx needs
  `try_files $uri $uri/index.html`; GitHub Pages and Netlify do it by default.
- The host maps `404.html` as its error document, or unknown URLs get the
  host's generic error page instead of the app's `notFound` route. Verify
  `dist/client/404.html` exists — if it does not, the app declares no
  `notFound` page: `warn`.
- **Security headers are not applied.** Every other adapter sets the four
  default security headers at request time; a static host has no request
  runtime. `dist/server/headers-manifest.json` records what each route *would*
  have carried — mirror the ones you need into the host's own header config
  (`_headers` on Netlify, CloudFront response header policies, nginx
  `add_header`). `error` for any app handling user input, `warn` otherwise.
  HSTS and CSP are host-side decisions either way.
- If `staticAdapter({ fallback })` is configured, the host needs a rewrite of
  unmatched URLs to that file that does not shadow real files. It makes unknown
  URLs answer `200` (soft 404s), and without it the fallback file is inert —
  deep links into dynamic `render: "spa"` routes will 404.
- Smoke test the real output, not the dev server: `pracht preview --skip-build`
  serves `dist/client/` the way a dumb host would. Check `/`, one dynamic SSG
  path, one deep link into a SPA route, and one unknown URL.
- Routes exporting `markdown` rely on server-side `Accept` negotiation, which a
  static host cannot do — agents asking for `text/markdown` get HTML. The build
  prints a note; publish `.md` files under `public/` if a raw-markdown corpus
  matters.
- Sub-path deploys (GitHub Pages *project* site, S3 key prefix) need Vite
  `base` set to that path (`base: "/my-project/"`), matching the deploy path
  exactly — a mismatch 404s every asset. Then confirm no hand-written
  root-absolute internal links: `grep -rn 'href="/' src/` and check each hit is
  external, an asset under `public/`, or a `<Link route>`. Framework-owned URLs
  from `@pracht/image`'s `defaultLoader` and the OpenAPI companion
  UI/document already carry the base — do not flag their base-free route
  declarations — but custom image loaders and OpenAPI provider asset URLs still
  need to match the intended host. CDN bases (`https://cdn…`) and
  document-relative bases (`""` / `"./"`) are build errors, not sub-path
  deploys.

## Step 4: Cross-cutting

- `/audit-secrets` — no `process.env.*` or `context.env.*` value flows into a
  loader return value.
- `/audit-headers` — `applyDefaultSecurityHeaders` is in use on user-facing
  responses, or `headers()` exports cover the same ground. On a static export
  this moves entirely to the host config; see above.
- `git status` is clean. Deploying uncommitted work is a footgun.

## Step 5: Report

A checklist grouped by `Framework`, `Adapter`, `Cross-cutting`. Tag each item
with a primary severity — `error` (blocks deploy), `warn` (proceeds but risky),
`info` — keeping pass/fail as the secondary per-item status. End with one line:
`READY` / `BLOCKED (N errors)` / `READY WITH WARNINGS (N warnings)`.

For a static export, never report `READY` without naming the host settings the
deploy depends on — clean URLs, `404.html`, security headers, and the fallback
rewrite if configured. The build cannot verify any of them, so an unqualified
`READY` is the one way this skill can mislead.

$ARGUMENTS
