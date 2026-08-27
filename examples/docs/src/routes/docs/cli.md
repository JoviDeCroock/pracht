---
title: CLI
lead: The `@pracht/cli` package covers development, production builds, inspection, verification, evaluation, scaffolding, previews, and agent integrations.
breadcrumb: CLI
prev:
  href: /docs/env
  title: Environment Variables
next:
  href: /docs/deployment
  title: Deployment
---

## create-pracht

`create-pracht` bootstraps a new application. It can run interactively, or fully non-interactively for agents and CI.

```sh
# Interactive
pnpm create pracht my-app

# Non-interactive manifest app for Node.js
pnpm create pracht my-app --adapter=node --router=manifest --yes

# Pages router, Cloudflare adapter, no install step
pnpm create pracht my-app --adapter=cf --router=pages --skip-install --yes

# Tailwind starter for Vercel
pnpm create pracht my-app --adapter=vercel --template=tailwind --yes
```

Options:

- `--adapter=node|cf|vercel` — choose Node.js, Cloudflare Workers, or Vercel output.
- `--router=manifest|pages` — choose explicit `src/routes.ts` routing or file-system `src/pages/` routing.
- `--template=minimal|tailwind`, `--tailwind`, `--no-tailwind` — control Tailwind setup.
- `--agent-tools`, `--no-agent-tools` — seed or skip the pracht Claude Code skills, `.mcp.json`, and `AGENTS.md`/`CLAUDE.md`.
- `--skip-install` — write files without installing dependencies.
- `--no-git` — skip `git init` and the initial commit.
- `--json` — print a machine-readable summary.
- `--dry-run` — list files without writing them.

Generated apps include `dev`, `build`, and `typecheck` scripts. Node and Cloudflare starters also include `preview`; Node starters include `start`; Cloudflare and Vercel starters include `deploy`.

---

## pracht dev

Starts the Vite dev server with SSR middleware, HMR, and instant feedback.

```sh
pracht dev

# Custom port
pracht dev --port 4000    # or PORT=4000 pracht dev

# Isolate Vite's optimizer cache for concurrent dev servers
pracht dev --cache-dir /tmp/pracht-vite-cache
```

Routes are rendered server-side on each request. Changes to routes, shells, loaders, and components are reflected immediately via HMR.

Vite normally writes its optimizer cache to `node_modules/.vite`. When multiple
dev servers use the same checkout, pass a distinct `--cache-dir` to each one so
their atomic cache updates cannot race.

The startup banner prints the resolved app graph: every route with its render mode, shell, and middleware, every API endpoint with its methods, and — when the app registers any — every [capability](/docs/capabilities) with its effect class, exposure, and dispatch path.

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

## pracht preview

Builds and serves the production target locally. Reuse an existing build for a
faster smoke test with `--skip-build`:

```sh
pracht preview
pracht preview --port 4000
pracht preview --skip-build
```

- **Node** runs `dist/server/server.js` and inherits the host environment.
- **Cloudflare** delegates to `wrangler dev` and requires Wrangler plus a
  Wrangler config whose `main` points at `dist/server/worker.js`. Put local
  Worker secrets in a gitignored `.dev.vars`; shell-prefixed host variables are
  not automatically Worker bindings.
- **Vercel** has no faithful local production runtime. The command exits 1 with
  guidance to use `vercel build` or `vercel dev` instead.

The command stays attached to the preview process and exits with that process's
status. It has no JSON mode because it is a long-running server command.

---

## pracht generate

Framework-native scaffolding keeps route, shell, middleware, and API module conventions in one place.

```sh
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
pracht generate api --path /health --methods GET,POST
```

> On Windows Git Bash/MSYS shells, leading `/` arguments may be rewritten as absolute Windows paths before Node sees them. If `--path /dashboard` reports that it would write outside `src/routes`, use PowerShell/CMD or pass `MSYS_NO_PATHCONV=1` when invoking the `pracht` binary directly.

- Manifest apps update `src/routes.ts` automatically for routes, shells, and middleware.
- Pages-router apps scaffold route files into `src/pages/`.
- Add `--json` when another tool or agent needs machine-readable output.

`generate route` also emits a Playwright smoke test at `e2e/<route-id>.spec.ts` whenever the app has a Playwright setup (a `playwright.config.*` file or an `e2e/` directory). The test visits the route with example values for dynamic params (`/blog/:slug` → `/blog/example-slug`), asserts the response status is below 400, and checks the `h1` text. `--test` forces the test, `--no-test` skips it. Generated tests import `@playwright/test`; if it is not installed, the generator prints the required follow-up (`pnpm add -D @playwright/test`).

---

## pracht typegen

Generates typed declarations from the same resolved app graph the dev banner and `pracht inspect` read, so navigation, API calls, and capability calls all check at compile time.

```sh
pracht typegen
pracht typegen --check    # fail instead of writing when a file is stale (CI)
```

It writes up to three files:

| File | Contents |
| --- | --- |
| `src/pracht.d.ts` | route ids, params, loader data, and typed [`apiFetch()`](/docs/api-routes) calls |
| `src/pracht-routes.ts` | the runtime [`href()`](/docs/routing) helper |
| `src/pracht-capabilities.d.ts` | each [capability](/docs/capabilities)'s input/output types, effect class, and exposure — written only when the app registers capabilities |

Override any path with `--out`, `--runtime-out`, and `--capabilities-out`; add `--json` for machine-readable output. Removing the last capability rewrites an existing declaration to the empty registration rather than leaving it stale.

After the first run, `pracht dev` refreshes the generated types automatically when route files are added, removed, or renamed and when the manifest or an imported definition module changes. Re-run it after upgrading pracht — a declaration file generated by an older version keeps working but misses newer checks.

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

## pracht inspect

Reads the resolved app graph instead of inferring application structure from
file names:

```sh
pracht inspect                 # all targets
pracht inspect routes
pracht inspect api
pracht inspect capabilities
pracht inspect agents
pracht inspect build
pracht inspect all --json
```

Targets are `routes`, `api`, `capabilities`, `agents`, `build`, and `all`. The
`agents` target summarizes the configured agent surface rather than one graph
slice: the Web Bot Auth policy and trusted keys, the destructive-confirmation
mode, whether remote MCP and `llms.txt` are enabled, and which capabilities are
exposed on which transports (with capabilities that have no `expose` config
counted as `private`). The `llms.txt` state comes from the Vite plugin's resolved
production server-build configuration, so computed, build-only, and
production-only options are reported accurately. If the CLI is newer than the
installed Vite plugin and that plugin does not expose the resolved flag, JSON
reports `null` and text reports `unknown` instead of incorrectly saying the
feature is off; upgrade `@pracht/vite-plugin` to resolve it. It also flags
capabilities that set `expose.mcp` while the manifest leaves `agents.mcp`
unconfigured — exposure recorded in the graph that nothing serves. An empty
capability list means there are no capability operations; it does not erase the
separately reported `llms.txt`, MCP endpoint, or Web Bot Auth surfaces. The `build`
target reports the adapter, client entry, and asset manifests and is most useful
after `pracht build`; the other targets evaluate the live Vite app graph. Use
`--json` for stable machine-readable output. Unknown targets and graph-loading
errors exit non-zero. Registered API and capability modules are loaded strictly
for live inspection: a module initialization error, unsupported runtime import,
or invoked graph-only helper keeps its original route, file, module, or API name
instead of falling back to inferred or null metadata. The same fail-closed
behavior applies to `pracht plan`, MCP inspection tools, and the live graph checks
in `pracht verify`. Capability type generation also loads capability contracts
strictly; API type generation deliberately reads route paths without executing
API modules.

For Cloudflare apps, graph inspection provides fail-closed placeholders rather
than a fake Worker runtime. Importing `env`/`exports` and importing or subclassing
runtime classes is safe, but reading any binding property or constructing a
runtime class fails with the exact unavailable API. This is intentionally
stricter than Workers itself: capability and API modules that participate in the
app graph must read bindings inside `run()`, the API handler, or another
request-time function — never during module initialization. Graph tools cannot
supply authoritative bindings, and an opaque JavaScript value cannot intercept
Boolean checks, `typeof`, or strict equality without risking false graph metadata.

---

## pracht plan

Semantic app-graph diff against a base git ref. Prints added, removed, and changed routes, API endpoints, capabilities, and constraints — an intent-level changelog for reviewers.

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

Capability changes are marked `!` when they widen what agents can reach — a new exposure, a downgraded `agentPolicy`, dropped middleware, or a loosened input schema — and `--markdown` puts a callout above the diff so the line is not missed.

---

## pracht verify

Runs deterministic, framework-aware checks over adapter wiring, route and API
modules, capability contracts, declared graph constraints, environment safety,
and app-graph snapshot freshness:

```sh
pracht verify
pracht verify --changed
pracht verify --json
```

`--changed` narrows file-oriented checks for a fast local loop; use the default
full scope before committing. The command exits 1 when any blocking check
fails. `--json` emits the same checks, scope, and final `ok` value for CI and
agents. Adapter-specific checks use the target resolved from the app's Vite
configuration.

---

## pracht report

Assembles a PR-ready markdown report from machine truth: the `pracht plan` diff, `pracht verify` results, and per-route client JS budgets from the last build.

```sh
pracht report
pracht report --base origin/release --out report.md
```

Use it as the factual half of a PR description — the author adds the "why".

---

## pracht eval

Runs scripted agent-task scenarios against a live app's agent surface and
exits 1 when any scenario or expectation fails:

```sh
pracht eval                                  # evals/**/*.eval.json
pracht eval evals/notes.eval.json
pracht eval --url http://localhost:3000
pracht eval --start "pracht preview" --url http://localhost:3000
pracht eval --json
```

A scenario picks its transport: the capability HTTP projection by default, or
the app's [remote MCP endpoint](/docs/remote-mcp) with `"transport": "mcp"`,
where the runner performs an `initialize` handshake and issues each step as a
`tools/call`. See [Agent Trust](/docs/agent-trust) for the scenario format.

Each scenario may declare its own URL, or `--url` can override all of them.
`--start` launches one server for the entire run, waits for it to answer, and
stops its process group afterward. Choose a start command that matches the
adapter: `pracht preview` works for Node and Cloudflare, while Vercel needs a
deployed URL or a separately managed `vercel dev`. `--json` emits the overall
status and every scenario/step result.

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

## pracht mcp

Starts a Model Context Protocol server over stdio for coding agents:

```sh
pracht mcp
```

Configure the command as a local MCP server rather than running it as a human
interactive prompt. The protocol owns stdout; diagnostics go to stderr so they
cannot corrupt JSON-RPC frames. It serves docs, graph inspection, doctor,
verify, plan/report, and generation tools against the current app. The command
runs until its MCP client disconnects and exits non-zero on startup or protocol
failure. There is no `--json` flag because MCP frames are already structured
protocol output. It is adapter-independent, although individual inspection and
verification results reflect the configured target.

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
