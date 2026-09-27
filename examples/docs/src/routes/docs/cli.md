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

`create-pracht` bootstraps a new application, interactively or fully non-interactively for agents and CI.

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

- `--adapter=node|cf|netlify|vercel|static` — Node.js, Cloudflare Workers, Netlify, Vercel, or pure static output.
- `--router=manifest|pages` — explicit `src/routes.ts` routing or file-system `src/pages/` routing.
- `--template=minimal|tailwind`, `--tailwind`, `--no-tailwind` — Tailwind setup.
- `--agent-tools[=core|full]`, `--no-agent-tools` — seed or skip the pracht Claude Code skills, `.mcp.json`, and `AGENTS.md`/`CLAUDE.md`. `core` (the default) seeds five skills; `full` seeds the whole catalog. Add more later with [`pracht skills add`](#pracht-skills).
- `--yes` — skip the prompts and use the defaults for anything not passed: a `pracht-app` directory, Node, manifest router, no Tailwind, core agent tools.
- `--skip-install` — write files without installing dependencies.
- `--no-git` — skip `git init` and the initial commit.
- `--json` — print a machine-readable summary.
- `--dry-run` — list files without writing them.

Generated apps include `dev`, `build`, and `typecheck` scripts. Node and Cloudflare starters also include `preview`; Node starters include `start`; Cloudflare and Vercel starters include `deploy`.

---

## pracht dev

Starts the Vite dev server with SSR and HMR.

```sh
pracht dev

# Custom port (default: $PORT or 3000)
pracht dev --port 4000

# Isolate Vite's optimizer cache for concurrent dev servers
pracht dev --cache-dir /tmp/pracht-vite-cache
```

Routes render server-side on each request. Changes to routes, shells, loaders, and components apply via HMR.

A failing loader, middleware, or render prints one terminal line — phase, route id, request path, and message — next to the browser error overlay. Failures that name none of your files also print their stack; set `DEBUG` to print it for every failure.

When several dev servers share one checkout, give each its own `--cache-dir` so they do not race on Vite's optimizer cache (default `node_modules/.vite`).

The startup banner prints the resolved app graph: routes with render mode, shell, and middleware; API endpoints with methods; and any [capabilities](/docs/capabilities) with effect class, exposure, and dispatch path.

---

## pracht build

Runs a production build: client bundle, server bundle, and SSG/ISG prerendering.

```sh
pracht build
pracht build --analyze          # per-route client JS report
pracht build --json             # the same report as JSON (implies --analyze)
pracht build --no-budget-fail   # warn instead of failing on an exceeded budget
```

Output:

- `dist/client/` — static assets with hashed filenames, plus prerendered SSG HTML
- `dist/server/server.js` — server entry module

Node targets run the build with `node dist/server/server.js`. Cloudflare and Vercel targets use their platform tooling against the build output. Per-route client JS limits are set with [`budgets`](/docs/reference/config).

---

## pracht preview

Builds and serves the production target locally. `--skip-build` reuses an
existing build for a faster smoke test:

```sh
pracht preview
pracht preview --port 4000
pracht preview --skip-build
```

- **Node** runs `dist/server/server.js` with the host environment. **Static**
  serves `dist/client/`.
- **Cloudflare** runs `wrangler dev`. It needs Wrangler and a Wrangler config
  whose `main` is `dist/server/worker.js`. Put local Worker secrets in a
  gitignored `.dev.vars`; shell environment variables are not Worker bindings.
- **Netlify** and **Vercel** have no faithful local runtime. The command exits 1
  and points you to `netlify dev`, or `vercel build` and `vercel dev`.

The command stays attached to the preview process and exits with its status.

---

## pracht generate

Scaffolds routes, shells, middleware, API routes, and capabilities using the framework's own conventions.

```sh
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
pracht generate api --path /health --methods GET,POST
pracht generate capability --name notes.search --expose http --description "Find notes matching a query."
```

| Subcommand | Flags |
| --- | --- |
| `route` | `--path` (required), `--render` (`ssr` default, `spa`, `ssg`, `isg`), `--shell`, `--middleware` (comma-separated), `--loader`, `--error-boundary`, `--static-paths`, `--title`, `--revalidate <seconds>` (ISG only), `--test` / `--no-test` |
| `shell` | `--name` (required) |
| `middleware` | `--name` (required) |
| `api` | `--path` (required), `--methods` (comma-separated, default `GET`) |
| `capability` | `--name` (required, e.g. `notes.search`), `--effect` (`read` default, `write`, `destructive`), `--expose` (comma-separated `http`, `webmcp`, `mcp`; omit to keep it private), `--title`, `--description` (required with `--expose`) |

Every subcommand accepts `--json` for machine-readable output.

- Manifest apps register routes, shells, middleware, and capabilities in `src/routes.ts`.
- Pages-router apps get route files in `src/pages/`. Capabilities are auto-discovered from `src/capabilities/`, so the module declares its own `name`.
- In pages mode, `generate middleware --name _middleware` scaffolds the root `src/pages/_middleware.ts`, the only middleware seam; it needs a serverful adapter. `generate shell` is manifest-only; pages apps add an `_app.tsx` to the directory it should wrap.

`generate route` also writes a Playwright smoke test to `e2e/<route-id>.spec.ts` when the app has a Playwright setup. `--test` forces it and `--no-test` skips it. See [Generated Smoke Tests](/docs/coding-agents#generated-smoke-tests).

> [!NOTE]
> Git Bash/MSYS on Windows may rewrite a leading `/` in `--path /dashboard` into a Windows path. Use PowerShell or CMD, or set `MSYS_NO_PATHCONV=1` when invoking the `pracht` binary directly.

---

## pracht typegen

Generates typed declarations from the resolved app graph, so navigation, API calls, and capability calls check at compile time.

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

Override any path with `--out`, `--runtime-out`, and `--capabilities-out`; add `--json` for machine-readable output.

`--check` compares declarations, not bytes, so reformatting the generated files never fails it. Regenerating leaves a correct file untouched, so `pracht typegen` and your formatter do not undo each other.

After the first run, `pracht dev` refreshes the types when route files, the manifest, or an imported definition module change. Re-run `pracht typegen` after upgrading pracht to pick up newer checks.

---

## pracht doctor

Validates app wiring and reports missing files or configuration drift.

```sh
pracht doctor
pracht doctor --json
```

It checks:

- `vite.config.*` exists and registers `pracht()`
- The app manifest or pages-router directory wiring
- Referenced shell, middleware, and route modules
- CLI and adapter package dependencies
- A `tsconfig.json` whose `moduleResolution` predates package `exports` (`"node"`, `"node10"`, `"classic"`), which breaks `@pracht/core` imports under `tsc` while Vite still builds

---

## pracht inspect

Prints the resolved app graph instead of inferring structure from file names:

```sh
pracht inspect                 # all targets
pracht inspect routes
pracht inspect api
pracht inspect capabilities
pracht inspect agents
pracht inspect build
pracht inspect all --json
```

| Target | Reports |
| --- | --- |
| `routes` | Page routes: render and hydration mode, shell, middleware, loader |
| `api` | API endpoints and their methods |
| `capabilities` | Capabilities: effect class, exposure, HTTP path, middleware, remote MCP status |
| `agents` | The agent surface: Web Bot Auth policy and keys, confirmation mode, remote MCP, `llms.txt`, and per-transport exposure counts |
| `build` | Adapter, client entry, and CSS/JS manifests, including CSS for routes that ship no JavaScript. Run it after `pracht build` |
| `all` | Everything (the default) |

The `agents` target also flags capabilities that set `expose.mcp` while
`agents.mcp` is unconfigured, so nothing serves them.

For remote MCP, the JSON output includes `mcpEndpoint`, `mcpDestructive`,
`mcpRuntimeStatus`, and `mcpUnavailableReasons`. Text output marks an exposure
`mcp(unserved)` when a requirement is verifiably missing and `mcp(unverified)`
when inspection cannot confirm it. See [Remote
MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser).

Use `--json` for stable machine-readable output. Unknown targets and
graph-loading errors exit non-zero. If a registered API or capability module
fails to load, `inspect`, `plan`, `verify`, and the MCP inspection tools fail
and name it rather than report partial metadata.

On Cloudflare, read bindings inside a handler or `run()`, never at module top
level. Graph commands load your modules without real bindings, so a top-level
binding read or Workers runtime-class construction fails with the API named.
Importing `env` is fine. See [Accessing Cloudflare
bindings](/docs/adapters#accessing-cloudflare-bindings).

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

`pracht verify` fails when the committed snapshot is stale; run `pracht plan --write` to refresh it. A `!` marks a capability change that widens what agents can reach. See [The Route-Graph Lockfile](/docs/coding-agents#the-route-graph-lockfile) for the workflow.

---

## pracht verify

Runs deterministic checks over adapter wiring, route and API modules,
capability contracts, declared [constraints](/docs/coding-agents#constraints),
environment safety, and app-graph snapshot freshness:

```sh
pracht verify
pracht verify --changed
pracht verify --json
```

`--changed` narrows file-oriented checks to changed files for a fast local
loop; run the full scope before committing. The command exits 1 when a blocking
check fails. `--json` emits the checks, scope, and final `ok` value.

`pracht verify webmcp` checks the live browser against the capability graph:

```sh
pracht verify webmcp --url http://localhost:3000
pracht verify webmcp --start "pracht preview" --json
pracht verify webmcp --start "pracht preview" --scenario evals/notes-webmcp.eval.json
```

It launches an installed Chrome 150+ with WebMCP testing enabled, visits each
route that activates page tools, and exits 1 on startup failure, unsupported
APIs, registration failure, or drift — including tools left behind after
navigation. The dev-only `pracht_*` tools are ignored. Pracht never downloads a
browser; pin one in CI with `--browser`.

- `--url` — the running app (default `http://localhost:3000`).
- `--start "<command>"` — start the app, verify, then stop it, as in `pracht eval`.
- `--browser <path>` — Chrome/Chromium executable; auto-detected when omitted.
- `--timeout <ms>` — browser, navigation, and startup timeout (default 10000).
- `--scenario <files>` — comma-separated WebMCP eval scenarios whose listed steps also run.
- `--json` — machine-readable report.

---

## pracht report

Assembles a PR-ready markdown report from machine truth: the `pracht plan` diff, `pracht verify` results, and per-route client JS budgets from the last build.

```sh
pracht report
pracht report --base origin/release --out report.md
```

`--base` sets the git ref (default `origin/main`); `--out` writes to a file instead of stdout. See [PR Reports from Machine Truth](/docs/coding-agents#pr-reports-from-machine-truth).

---

## pracht eval

Runs scripted agent-task scenarios against a live app's agent surface and
exits 1 when any scenario or expectation fails:

```sh
pracht eval                                  # evals/**/*.eval.json
pracht eval evals/notes.eval.json
pracht eval --url http://localhost:3000
pracht eval --start "pracht preview" --url http://localhost:3000
pracht eval evals/notes-webmcp.eval.json --browser /pinned/path/to/chrome
pracht eval --json
```

A scenario calls the capability HTTP projection by default, the app's [remote
MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser)
with `"transport": "mcp"`, or the browser's page tools with `"transport":
"webmcp"` and a `"webmcpRoute"`. See [pracht
eval](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) for the scenario
format.

`--url` overrides every scenario's own URL. `--start` launches one server for
the run, waits for it to answer, and stops it afterward. `pracht preview` works
for Node, Cloudflare, and static; Netlify and Vercel need a deployed URL or your
own `netlify dev` / `vercel dev`.
`--browser` pins Chrome for WebMCP scenarios, and `--json` reports every
scenario and step.

---

## pracht llms

Prints an embedded authoring guide for coding agents: project layout, conventions, constraints, and the verify/plan/report loop.

```sh
pracht llms

# Write the guide to llms.txt in the app root
pracht llms --write

# Write it somewhere else (implies --write)
pracht llms --out docs/pracht-guide.md
```

The `get_docs` tool of [`pracht dev-mcp`](#pracht-dev-mcp) serves the same guide.

---

## pracht dev-mcp

Starts the authoring Model Context Protocol server over stdio for coding agents:

```sh
pracht dev-mcp
```

It gives the agent writing your code your app's *graph*: docs, inspection,
doctor, verify, plan, report, typegen, eval, and generators. Register it as a
local MCP server in your client instead of running it by hand; it runs until
the client disconnects. `pracht mcp` is a deprecated alias that behaves
identically and prints a notice to stderr.

This is not your app's own [remote MCP
endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser),
which serves your app's *operations* to end-user agents in production. See
[The Authoring MCP Server](/docs/coding-agents#the-authoring-mcp-server) for
client registration and the tool reference.

---

## pracht skills

Lists and installs the pracht Claude Code skills from the published
[agent-skills index](https://pracht.resynapse.dev/.well-known/agent-skills/index.json):

```sh
# The catalog, with a marker on the ones this app already has
pracht skills list

# Install into .claude/skills/
pracht skills add audit-loaders add-db
```

`create-pracht` seeds five core skills; `pracht skills add` installs others one
at a time. See [Context Cost](/docs/coding-agents#context-cost) for why the
default set is small.

`add` treats the index as untrusted:

- It verifies every download against the index's SHA-256 digest, and rejects
  the whole index if any entry lacks one.
- The index and skill URLs must use `https`; `http` is allowed only for
  `localhost`, e.g. an offline mirror.
- It refuses to write through a symlinked `.claude/skills` or skill directory.
  `--force` allows a link that stays inside the project; one that leaves it is
  always refused.

An installed skill is skipped unless you pass `--force`. `--index <url>` points
either subcommand at a different catalog. `--json` gives machine-readable
output; `add --json` reports `installed`, `skipped`, and `failed`, and exits
non-zero if anything failed.

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
