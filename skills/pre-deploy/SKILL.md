---
name: pre-deploy
version: 1.1.0
description: |
  Adapter-aware pre-deployment checklist for pracht apps targeting Node,
  Cloudflare Workers, or Vercel. Catches the issues that only surface in the
  production runtime: missing env vars, Node-only APIs in edge bundles,
  ISG manifest absence, oversized edge bundles, missing wrangler/vercel config.
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

Read `vite.config.ts` and look for `nodeAdapter()`, `cloudflareAdapter()`, or
`vercelAdapter()`. Confirm with:

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
- Reverse-proxy / TLS termination configured (out of scope for this skill —
  flag for confirmation).

### Cloudflare Workers (`@pracht/adapter-cloudflare`)

- `wrangler.toml` (or `wrangler.jsonc`) present at repo root.
- `main` points to `dist/server/worker.js` — the thin deploy wrapper that
  re-exports only the default handler and Cloudflare entrypoint classes.
  Pointing `main` at `dist/server/server.js` is an **error**: workerd
  validates every named export of the deploy entry and rejects the build
  metadata (`buildTarget`, manifests, `resolvedApp`, ...) that `server.js`
  exports for the prerender pass.
- `assets.directory` points to `dist/client`.
- `compatibility_date` is set and recent.
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
- ISG: worker-managed ISG via the per-colo Workers Cache API works out of the
  box. If time-revalidated routes should use the edge-tier Workers Caching
  upgrade instead, confirm both sides — `cloudflareAdapter({ cache: true })`
  in vite config and `"cache": { "enabled": true }` in wrangler config.
- When Workers Caching is enabled, flag ISG routes reachable through unbounded
  query strings. Require a bounded allowlist/canonical redirect or an uncached
  gateway with a normalized `cf.cacheKey`; also check that markdown-capable
  routes normalize `Accept` at the gateway when variant fan-out matters.
- Bundle size: measure what actually deploys — `dist/server/worker.js` plus
  its `dist/server/server.js` import (wrangler bundles the import graph of
  `main`; `worker.js` alone is a few lines). Workers limit is ~1 MB
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
- Edge runtime constraints: pracht **always** writes the function's
  `.vc-config.json` with `runtime: "edge"` — there is no Node runtime
  variant, so run the same Node-only API check as Cloudflare
  **unconditionally** for Vercel builds. Do not skip it based on a runtime
  probe.
- Build Output API v3 sanity: `config.json` has `version: 3`.

## Step 4: Cross-cutting checks

- Run `audit-secrets` to confirm no `process.env.*` or `context.env.*` values
  flow into loader return values.
- Run `audit-headers` to confirm `applyDefaultSecurityHeaders` is in use on
  user-facing responses (or that `headers()` exports cover the same ground).
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
4. If the app does not use generated typed route files yet, note that `pracht typegen --check` is optional; if it does, stale generated files block deployment.
5. Do not deploy on the user's behalf. End the skill at the verdict.
6. If `pracht doctor` reports errors, do not run any other checks until those
   are resolved — they will produce noisy false positives.

$ARGUMENTS
