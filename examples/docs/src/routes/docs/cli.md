---
title: CLI
lead: The <code>@pracht/cli</code> package provides development, build, scaffolding, and doctor commands for your app.
breadcrumb: CLI
prev:
  href: /docs/env
  title: Environment Variables
next:
  href: /docs/deployment
  title: Deployment
---

## pracht dev

Starts the Vite dev server with SSR middleware, HMR, and instant feedback.

```sh
pracht dev

# Custom port
PORT=4000 pracht dev
```

Routes are rendered server-side on each request. Changes to routes, shells, loaders, and components are reflected immediately via HMR.

---

## pracht build

Runs a production build: client bundle, server bundle, and SSG/ISG prerendering.

```sh
pracht build
```

Output:

- `dist/client/` — static assets with hashed filenames
- `dist/server/server.js` — server entry module
- SSG routes are pre-rendered as static HTML in `dist/client/`

---

After `pracht build`, Node.js targets can run the generated server with:

```sh
node dist/server/server.js
```

Cloudflare and Vercel targets should use their platform tooling against the
generated build output.

---

## pracht generate

Framework-native scaffolding keeps route, shell, middleware, and API module conventions in one place.

```sh
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
pracht generate api --path /health --methods GET,POST
```

- Manifest apps update `src/routes.ts` automatically for routes, shells, and middleware.
- Pages-router apps scaffold route files into `src/pages/`.
- Add `--json` when another tool or agent needs machine-readable output.

`generate route` also emits a Playwright smoke test at `e2e/<route-id>.spec.ts` whenever the app has a Playwright setup (a `playwright.config.*` file or an `e2e/` directory). The test visits the route with example values for dynamic params (`/blog/:slug` → `/blog/example-slug`), asserts the response status is below 400, and checks the `h1` text. `--test` forces the test, `--no-test` skips it.

---

## pracht doctor

Validate the current app wiring and surface missing files or configuration drift.

```sh
pracht doctor
pracht doctor --json
```

The doctor command checks:

- `vite.config.*` presence and `pracht()` registration
- App manifest or pages-router directory wiring
- Referenced shell, middleware, and route modules
- Package-level CLI and adapter dependencies

---

## pracht plan

Semantic app-graph diff against a base git ref. Prints added, removed, and changed routes, API endpoints, and constraints — an intent-level changelog for reviewers.

```sh
# Snapshot the resolved app graph to .pracht/app-graph.json (commit it)
pracht plan --write

# Diff the live graph against the snapshot committed at origin/main
pracht plan

# Custom base ref, machine-readable, or PR-comment output
pracht plan --base origin/release
pracht plan --json
pracht plan --markdown
```

The snapshot works like a lockfile for the route graph: `pracht verify` fails when `.pracht/app-graph.json` is stale, with the fix in the message (run `pracht plan --write`). See [AI-Assisted Authoring & Review](/docs/agent-workflow) for the full workflow.

---

## pracht report

Assembles a PR-ready markdown report from machine truth: the `pracht plan` diff, `pracht verify` results, and per-route client JS budgets from the last build.

```sh
pracht report
pracht report --base origin/release --out report.md
```

Use it as the factual half of a PR description — the author adds the "why".

---

## pracht llms

Prints an embedded authoring guide for coding agents: project layout, conventions, constraints, and the verify/plan/report loop.

```sh
pracht llms

# Write the guide to llms.txt in the app root
pracht llms --write
```

The same guide is available from the MCP server (`pracht mcp`) via the `get_docs` tool, alongside `plan` and `report` tools and the existing `inspect_*`, `doctor`, `verify`, and `generate_*` tools.

---

## Installation

The CLI is included in scaffolded projects. For existing projects, add it as a dev dependency:

```sh
pnpm add -D @pracht/cli
```

Then add scripts to your `package.json`:

```json [package.json]
{
  "scripts": {
    "dev": "pracht dev",
    "build": "pracht build",
    "doctor": "pracht doctor"
  }
}
```
