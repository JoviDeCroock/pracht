---
name: pre-deploy
version: 1.3.0
description: |
  Adapter-aware pre-deployment checklist for pracht apps targeting Node,
  Cloudflare Workers, Vercel, or a pure static export. Catches the issues that
  only surface in the production runtime: missing env vars, Node-only APIs in
  edge bundles, ISG manifest absence, oversized edge bundles, missing
  wrangler/vercel config, and static hosts missing clean-URL, 404, or security
  header configuration.
  Use when asked to "pre-deploy check", "ready to ship?", "deployment
  checklist", "is my build production-safe", or before running `wrangler
  deploy` / `vercel deploy`.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Pre-Deploy

Run this before every production deploy. Each adapter has a different runtime
contract; this skill enforces the contract that matches your build.

## Step 1: Detect the adapter

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

Read `vite.config.ts` and look for `nodeAdapter()`, `cloudflareAdapter()`,
`vercelAdapter()`, or `staticAdapter()`. Confirm with:

```bash
pracht inspect build --json
```

The `adapterTarget` field is authoritative. Prerequisites: `pracht inspect`
needs a vite config with the pracht plugin, and `inspect build` reads
artifacts from a prior build — if `pracht build` has not been run recently,
run it first:

```bash
pracht build
```

## Step 2: Run framework-wide checks

```bash
pracht doctor --json
pracht verify --json
```

If the app uses generated typed routes (`src/pracht-routes.ts` or
`src/pracht.d.ts` exists), also run:

```bash
pracht typegen --check
```

These catch app-graph wiring problems independent of the adapter — including
`defineApp({ constraints })` violations and a stale `.pracht/app-graph.json`
snapshot (fix the latter with `pracht plan --write`, then re-review the plan
output). Resolve all `status: "error"` entries before continuing.

When the deploy corresponds to a PR, `pracht report --base origin/main` produces
a markdown summary (graph diff + verify + budgets) worth attaching to it.

## Step 3: Adapter-specific checklist

### Node (`@pracht/adapter-node`)

- `dist/server/server.js` exists.
- `dist/client/.vite/manifest.json` exists.
- `dist/server/isg-manifest.json` exists if any route has `render: "isg"`.
- Smoke test: `pracht preview --skip-build` (or `node dist/server/server.js`) boots and `curl localhost:3000` returns 200.
- Required env vars (grep `process.env.*` across `src/`) are set in the
  deployment environment. List them for the user.
- If the app mounts `createImageHandler()` from `@pracht/image/node`, confirm
  `sharp` is installed and `localOrigin` is the same trusted public origin as
  `nodeAdapter({ canonicalOrigin })`. A relative image endpoint without both
  values is an error in every environment; loopback-looking request origins
  are intentionally not trusted.
- Reverse-proxy / TLS termination configured (out of scope for this skill —
  flag for confirmation).
- If the proxy strips Vite's deploy base, confirm
  `nodeAdapter({ basePathStripped: true })`; application code should still
  observe the public base in `request.url`, and the proxy must own the public
  bare-base redirect (`/app` to `/app/`).

### Cloudflare Workers (`@pracht/adapter-cloudflare`)

- `wrangler.toml` (or `wrangler.jsonc`) present at repo root.
- `main` points to `dist/server/worker.js` — the thin deploy wrapper that
  re-exports only the default handler and Cloudflare entrypoint classes.
  Pointing `main` at `dist/server/server.js` is an **error**: workerd
  validates every named export of the deploy entry and rejects the build
  metadata (`buildTarget`, manifests, `resolvedApp`, ...) that `server.js`
  exports for the prerender pass.
- `no_bundle` is `true`, with an `ESModule` rule whose globs include
  `"**/*.js"`. Pracht's Vite output is already bundled and may contain lazy
  server chunks; these settings make Wrangler upload the chunks as separate
  modules instead of folding them into the entry file.
- `assets.directory` points to `dist/client`.
- `compatibility_date` is set, and is a date the installed workerd supports.
  It must not be *newer* than the runtime: workerd refuses to start with
  "This Worker requires compatibility date X, but the newest date supported
  by this server binary is Y". Never set it to today's date — that is by
  construction at or beyond the newest released workerd.
- Bindings declared in wrangler config for every `context.env.*` access in
  loaders, middleware, and API routes (grep, then cross-check).
- **No Node-only APIs in the server bundle.** Grep the server files for:
  `fs`, `path` (Node form), `process.cwd`, `Buffer`, `__dirname`,
  `__filename`, `crypto.createHash` (use `crypto.subtle` instead),
  `child_process`, `cluster`, `worker_threads`. Two nuances before flagging:
  - Consult `compatibility_flags` in the wrangler config first — with
    `nodejs_compat`, `Buffer` and several `node:` modules are legal in
    workerd. Only flag APIs the active flags don't cover.
  - Dev already runs inside workerd via `@cloudflare/vite-plugin`, so most
    incompatibilities surface in dev; this check is the backstop for code
    paths dev never hit.
- An API route importing `@pracht/image/node` is an error on Workers because
  its optimizer requires `sharp`. Require `cloudflareLoader` (or
  `passthroughLoader`) instead.
- ISG: worker-managed ISG via the per-colo Workers Cache API works out of the
  box. If time-revalidated routes should use the edge-tier Workers Caching
  upgrade instead, confirm both sides — `cloudflareAdapter({ cache: true })`
  in vite config and `"cache": { "enabled": true }` in wrangler config.
- When Workers Caching is enabled, flag ISG routes reachable through unbounded
  query strings. Require a bounded allowlist/canonical redirect or an uncached
  gateway with a normalized `cf.cacheKey`; also check that markdown-capable
  routes normalize `Accept` at the gateway when variant fan-out matters.
- Bundle size: measure what actually deploys — `dist/server/worker.js` plus
  its `dist/server/server.js` import and lazy chunks (`no_bundle: true` plus
  the JavaScript `ESModule` rule uploads the pre-built module graph;
  `worker.js` alone is a few lines).
  Workers limit is ~1 MB
  compressed for free tier, ~10 MB on paid. Warn at 80% of the active limit.

### Vercel (`@pracht/adapter-vercel`)

- `.vercel/output/config.json` exists post-build.
- The render function exists at
  `.vercel/output/functions/<functionName>.func/server.js`. The name defaults
  to `render` but is configurable via `vercelAdapter({ functionName })` —
  read the configured name from `vite.config.ts` instead of hardcoding
  `render.func`.
- `.vercel/output/static/` populated.
- Required env vars are configured in the Vercel project (cannot verify from
  CLI without `vercel env pull` — run that and diff against `process.env.*`
  references).
- Edge runtime constraints: the render function's `.vc-config.json` is
  **always** written with `runtime: "edge"`, so run the same Node-only API
  check as Cloudflare **unconditionally** for Vercel builds. Do not skip it
  based on a runtime probe — ISG routes run the same bundle on Node, but any
  Node-only API still breaks the edge function.
- ISG functions: every `<route>.prerender-config.json` must sit next to a
  **Serverless** `<route>.func` (`.vc-config.json` with `launcherType:
  "Nodejs"`). Vercel rejects a prerender config paired with an edge function:
  `Unexpected function type "EdgeFunction" at path "<route>"`.
- Region configuration: `vercelAdapter({ regions: "all" })` is valid for the
  Edge render function, but generated Node ISG function configs must omit
  `regions` so the project's default Serverless region applies. Node configs
  may only contain arrays of concrete region identifiers.
- An API route importing `@pracht/image/node` is an error for the Vercel Edge
  function. Require `vercelLoader` (with aligned allowed sizes) or
  `passthroughLoader` instead.
- Build Output API v3 sanity: `config.json` has `version: 3`.

### Static export (`@pracht/adapter-static`)

`adapterTarget` is `"static"`. There is no server to get wrong, so the
checklist is about what the *host* must do and what the build cannot enforce.

- `dist/client/` exists and is the deploy root. `dist/server/` is build tooling
  only — it must not be uploaded (it contains the prerender bundle).
- The build itself is the gate: it fails closed on `ssr`/`isg` routes, SPA
  loaders, non-full SPA hydration, API routes, route/not-found middleware,
  network-exposed capabilities, and any Vite `base` that is not `/` or a
  root-absolute path (CDN and document-relative bases are rejected). If
  `pracht build` succeeded, those contracts already hold — do not re-derive
  them by hand. Report a failing build verbatim; the message names the routes.
- Host must serve `index.html` for directory URLs (clean URLs). Confirm the
  host's setting: S3 website endpoints need an index document, nginx needs
  `try_files $uri $uri/index.html`, GitHub Pages and Netlify do it by default.
- Host must map `404.html` as the error document, otherwise unknown URLs get
  the host's generic error page instead of the app's `notFound` route. Verify
  `dist/client/404.html` exists; if it does not, the app declares no `notFound`
  page — flag it as a `warn`.
- **Security headers are not applied.** Every other adapter sets the four
  default security headers at request time; a static host has no request
  runtime. `dist/server/headers-manifest.json` records the headers each route
  *would* have carried — mirror the ones you need in the host's own header
  config (`_headers` on Netlify, CloudFront response header policies, nginx
  `add_header`). This is an `error` for any app handling user input, and
  `warn` otherwise. HSTS and CSP are host-side decisions either way.
- If `staticAdapter({ fallback })` is configured, the host needs a rewrite of
  unmatched URLs to that file, and the rewrite must not shadow real files.
  Note that it makes unknown URLs answer `200` (soft 404s). Without the
  rewrite the fallback file is inert — deep links into dynamic `render: "spa"`
  routes will 404.
- Smoke test the real output, not the dev server:
  `pracht preview --skip-build` serves `dist/client/` the way a dumb host
  would. Check `/`, one dynamic SSG path, one deep link into a SPA route, and
  one unknown URL.
- Routes exporting `markdown` rely on server-side `Accept` negotiation, which
  a static host cannot do — agents asking for `text/markdown` get HTML. The
  build prints a note when this applies; publish `.md` files under `public/`
  if a raw-markdown corpus matters.
- Deploying to a sub-path (GitHub Pages *project* site, S3 key prefix) needs
  Vite `base` set to that path (`base: "/my-project/"`). Check it matches the
  deploy path exactly — a mismatch 404s every asset. Then check the app has no
  hand-written root-absolute internal links (`<a href="/about">`): those are
  not base-prefixed and will leave the deploy. `grep -rn 'href="/' src/` and
  confirm each hit is external, an asset under `public/`, or a `<Link route>`.
  Framework-owned URLs from `@pracht/image`'s `defaultLoader` and the OpenAPI
  companion UI/document already carry the base; do not flag their base-free
  route declarations. Custom image loaders and OpenAPI provider asset URLs
  still need to match the intended host.
  CDN bases (`https://cdn…`) and document-relative bases (`""` / `"./"`) are
  build errors, not sub-path deploys.

## Step 4: Cross-cutting checks

- Run `audit-secrets` to confirm no `process.env.*` or `context.env.*` values
  flow into loader return values.
- Run `audit-headers` to confirm `applyDefaultSecurityHeaders` is in use on
  user-facing responses (or that `headers()` exports cover the same ground).
  On a static export this check moves entirely to the host's header config —
  see the static section above.
- Confirm `git status` is clean (deploying uncommitted work is a footgun).

## Step 5: Report

Produce a checklist grouped by `Framework`, `Adapter`, `Cross-cutting`. Tag
each item with a primary severity — `error` (blocks deploy), `warn` (deploy
proceeds but risky), `info` — and keep pass/fail as the secondary per-item
status. End with a one-line verdict: `READY` / `BLOCKED (N errors)` /
`READY WITH WARNINGS (N warnings)`.

## Rules

1. Always run `pracht build` first. Do not lint a stale `dist/`.
2. Detect the adapter — never assume.
3. For Cloudflare/Vercel-edge, the Node-only API check is non-negotiable; an
   API not covered by the active compatibility flags will crash the worker on
   a code path that may never hit in dev.
4. For a static export, never report `READY` without naming the host settings
   the deploy depends on (clean URLs, `404.html`, security headers, and the
   fallback rewrite if configured). The build cannot verify any of them, so an
   unqualified `READY` is the one way this skill can mislead.
5. If the app does not use generated typed route files yet, note that `pracht typegen --check` is optional; if it does, stale generated files block deployment.
6. Do not deploy on the user's behalf. End the skill at the verdict.
7. If `pracht doctor` reports errors, do not run any other checks until those
   are resolved — they will produce noisy false positives.

$ARGUMENTS
