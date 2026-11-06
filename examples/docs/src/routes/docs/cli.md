---
title: CLI
lead: "`pracht` commands for development, builds, previews, inspection, verification, evals, scaffolding, offline docs, and agent setup."
---

## Installation

Scaffolded projects include the CLI. In an existing project, add it as a dev dependency:

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

The CLI needs Node 22.18 or newer and exits with a one-line message on an older version. `pracht --version` prints the installed version.

## create-pracht

Create a new app, interactively or non-interactively for agents and CI:

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

| Flag | Effect |
| --- | --- |
| `--adapter=node\|cf\|netlify\|vercel\|static` | Node.js, Cloudflare Workers, Netlify, Vercel, or static output |
| `--router=manifest\|pages` | Explicit `src/routes.ts` routing or file-system `src/pages/` routing |
| `--template=minimal\|tailwind`, `--tailwind`, `--no-tailwind` | Tailwind setup |
| `--agent-tools[=core\|full]`, `--no-agent-tools` | Seed or skip the pracht Claude Code skills, `.mcp.json`, and `AGENTS.md`/`CLAUDE.md`. `core` (the default) seeds four skills, `full` the whole catalog; add more later with [`pracht skills add`](#pracht-skills) |
| `--yes`, `-y` | Skip the prompts. Anything not passed defaults to a `pracht-app` directory, Node, manifest router, no Tailwind, and core agent tools |
| `--skip-install` | Write files without installing dependencies |
| `--no-git` | Skip `git init` and the initial commit |
| `--json` | Print a machine-readable summary |
| `--dry-run` | List files without writing them |

Every generated app has `dev`, `build`, and `typecheck` scripts. Node, static, Cloudflare, and Netlify starters add `preview`; Node starters add `start`; Cloudflare, Netlify, and Vercel starters add `deploy`.

## pracht dev

Start the Vite dev server with SSR and HMR:

```sh
pracht dev

# Custom port (default: $PORT or 3000)
pracht dev --port 4000

# Isolate Vite's optimizer cache for concurrent dev servers
pracht dev --cache-dir /tmp/pracht-vite-cache
```

Routes render on the server for each request, and changes to routes, shells, loaders, and components apply through HMR.

A failing loader, middleware, or render prints one terminal line (phase, route id, request path, and message) next to the browser error overlay. Failures that name none of your files also print their stack; set `DEBUG` to print it for every failure.

When several dev servers share one checkout, give each its own `--cache-dir` (default `node_modules/.vite`) so they do not race on Vite's optimizer cache.

The startup banner prints the resolved app graph: routes with render mode, shell, and middleware; API endpoints with methods; and [capabilities](/docs/capabilities) with effect class, exposure, and dispatch path. Tables show their first 25 rows; `pracht inspect routes` lists the rest. The banner prints again after every `routes.ts` edit and server restart. When the graph cannot be resolved, for example because a route names an unknown shell, the banner shows the error and the number of routes in the manifest instead.

## pracht build

Run a production build: client bundle, server bundle, and SSG/ISG prerendering.

```sh
pracht build
pracht build --analyze          # per-route client JS report
pracht build --json             # the same report as JSON (implies --analyze)
pracht build --no-budget-fail   # warn instead of failing on an exceeded budget
```

| Output | Contents |
| --- | --- |
| `dist/client/` | Static assets with hashed filenames, plus prerendered SSG HTML |
| `dist/server/server.js` | Server entry module |

Run a Node build with `node dist/server/server.js`; other targets use their platform tooling (see [Deployment](/docs/deployment)). Set per-route client JS limits with [`budgets`](/docs/reference/config).

## pracht preview

Build and serve the production target locally. `--skip-build` reuses the existing build:

```sh
pracht preview
pracht preview --port 4000
pracht preview --skip-build
```

| Adapter | What runs |
| --- | --- |
| Node | `dist/server/server.js` with the host environment |
| Static | A static file server over `dist/client/` |
| Cloudflare | `wrangler dev` against the config `pracht build` generates from your `wrangler.jsonc`. Needs Wrangler and that file; local Worker secrets go in a gitignored `.dev.vars` |
| Netlify, Vercel | Nothing: the command exits 1 and points you to `netlify dev`, or `vercel build` and `vercel dev` |

The command stays attached to the preview process and exits with its status.

## pracht generate

Scaffold routes, shells, middleware, API routes, and capabilities:

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
| `shell` | `--name` (required), `--loader` (adds a [shell loader](/docs/shells#shell-data)) |
| `middleware` | `--name` (required) |
| `api` | `--path` (required), `--methods` (comma-separated, default `GET`) |
| `capability` | `--name` (required, e.g. `notes.search`), `--effect` (`read` default, `write`, `destructive`), `--expose` (comma-separated `http`, `webmcp`, `mcp`; omit to keep it private), `--title`, `--description` (required with `--expose`) |

Every subcommand accepts `--json` for machine-readable output.

- Manifest apps register routes, shells, middleware, and capabilities in `src/routes.ts`.
- Pages-router apps get route files in `src/pages/`. Capabilities are discovered from `src/capabilities/`, so the module declares its own `name`.
- In pages mode, `generate middleware --name _middleware` scaffolds the root `src/pages/_middleware.ts`, the only middleware seam; it needs a serverful adapter. `generate shell` is manifest-only; pages apps add an `_app.tsx` to the directory it should wrap.

`generate route` also writes a Playwright smoke test to `e2e/<route-id>.spec.ts` when the app has a Playwright setup. `--test` forces it and `--no-test` skips it. See [Generated Smoke Tests](/docs/coding-agents#generated-smoke-tests).

> [!NOTE]
> Git Bash/MSYS on Windows may rewrite a leading `/` in `--path /dashboard` into a Windows path. Use PowerShell or CMD, or set `MSYS_NO_PATHCONV=1` when invoking the `pracht` binary directly.

## pracht typegen

Generate typed declarations from the resolved app graph, so navigation, API calls, and capability calls are checked at compile time:

```sh
pracht typegen
pracht typegen --check    # fail instead of writing when a file is stale (CI)
```

| File | Contents | Override |
| --- | --- | --- |
| `src/pracht.d.ts` | Route ids, params, loader data, and typed [`apiFetch()`](/docs/api-routes) calls | `--out` |
| `src/pracht-routes.ts` | The runtime [`href()`](/docs/routing) helper | `--runtime-out` |
| `src/pracht-capabilities.d.ts` | Each [capability](/docs/capabilities)'s input and output types, effect class, and exposure; written only when the app registers capabilities | `--capabilities-out` |

Add `--json` for machine-readable output.

`--check` compares declarations, not bytes, so reformatting the generated files never fails it, and regenerating leaves a correct file untouched.

After the first run, `pracht dev` refreshes the types when route files, the manifest, or an imported definition module change. Re-run `pracht typegen` after upgrading pracht.

## pracht doctor

Validate app wiring and report missing files or configuration drift:

```sh
pracht doctor
pracht doctor --json
```

It checks:

- `vite.config.*` exists and registers `pracht()`.
- The app manifest or pages-router directory wiring.
- Referenced shell, middleware, and route modules.
- CLI and adapter package dependencies.
- `tsconfig.json` does not use a `moduleResolution` that predates package `exports` (`"node"`, `"node10"`, `"classic"`), which breaks `@pracht/core` imports under `tsc` while Vite still builds.

## pracht inspect

Print the resolved app graph:

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
| `agents` | The agent surface: Web Bot Auth policy and keys, confirmation mode, remote MCP, `llms.txt`, and per-transport exposure counts. Flags capabilities that set `expose.mcp` while `agents.mcp` is unconfigured |
| `build` | Adapter, client entry, and CSS/JS manifests, including CSS for routes that ship no JavaScript. Run it after `pracht build` |
| `all` | Everything (the default) |

For remote MCP, the JSON output includes `mcpEndpoint`, `mcpDestructive`, `mcpRuntimeStatus`, and `mcpUnavailableReasons`. Text output marks an exposure `mcp(unserved)` when a requirement is missing and `mcp(unverified)` when inspection cannot confirm it. See [Remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser).

Unknown targets and graph-loading errors exit non-zero. If a registered API or capability module fails to load, `inspect`, `plan`, `verify`, and the MCP inspection tools fail and name it rather than report partial metadata.

On Cloudflare, read bindings inside a handler or `run()`, never at module top level. Graph commands load your modules without real bindings, so a top-level binding read or Workers runtime-class construction fails with the API named. Importing `env` is fine. See [Accessing Cloudflare bindings](/docs/adapters#accessing-cloudflare-bindings).

## pracht plan

Diff the app graph against a base git ref. The output lists added, removed, and changed routes, API endpoints, capabilities, and constraints, for reviewers:

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

A `!` marks a capability change that widens what agents can reach. `pracht verify` fails when the committed snapshot is stale; run `pracht plan --write` to refresh it. See [The Route-Graph Lockfile](/docs/coding-agents#the-route-graph-lockfile) for the workflow.

## pracht verify

Run deterministic checks over adapter wiring, route and API modules, capability contracts, declared [constraints](/docs/coding-agents#constraints), environment safety, and app-graph snapshot freshness:

```sh
pracht verify
pracht verify --changed
pracht verify --json
```

`--changed` narrows file-oriented checks to changed files for a fast local loop; run the full scope before committing. The command exits 1 when a blocking check fails. `--json` emits the checks, scope, and final `ok` value.

### pracht verify webmcp

Check the page tools a live browser registers against the capability graph:

```sh
pracht verify webmcp --url http://localhost:3000
pracht verify webmcp --start "pracht preview" --json
pracht verify webmcp --start "pracht preview" --scenario evals/notes-webmcp.eval.json
```

It launches an installed Chrome 150+ with WebMCP testing enabled and visits each route that activates page tools. It exits 1 on startup failure, unsupported APIs, registration failure, or drift, including tools left behind after navigation. The dev-only `pracht_*` tools are ignored.

Add `playwright-core` as a dev dependency (`npm install -D playwright-core`). pracht never downloads a browser, so pin one in CI with `--browser`.

| Flag | Effect |
| --- | --- |
| `--url` | The running app (default `http://localhost:3000`) |
| `--start "<command>"` | Start the app, verify, then stop it, as in `pracht eval` |
| `--browser <path>` | Chrome or Chromium executable; auto-detected when omitted |
| `--timeout <ms>` | Browser, navigation, and startup timeout (default 10000) |
| `--scenario <files>` | Comma-separated WebMCP eval scenarios whose steps also run |
| `--json` | Machine-readable report |

## pracht report

Assemble a PR-ready Markdown report from the `pracht plan` diff, `pracht verify` results, and per-route client JS budgets from the last build:

```sh
pracht report
pracht report --base origin/release --out report.md
```

`--base` sets the git ref (default `origin/main`); `--out` writes to a file instead of stdout. See [PR Reports from Machine Truth](/docs/coding-agents#pr-reports-from-machine-truth).

## pracht eval

Run scripted agent-task scenarios against a live app's agent surface. The command exits 1 when any scenario or expectation fails:

```sh
pracht eval                                  # evals/**/*.eval.json
pracht eval evals/notes.eval.json
pracht eval --url http://localhost:3000
pracht eval --start "pracht preview" --url http://localhost:3000
pracht eval evals/notes-webmcp.eval.json --browser /pinned/path/to/chrome
pracht eval --json
```

| Transport | Scenario setting | Calls |
| --- | --- | --- |
| HTTP | default | The capability HTTP projection |
| MCP | `"transport": "mcp"` | The app's [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser) |
| WebMCP | `"transport": "webmcp"` and `"webmcpRoute"` | The browser's page tools |

See [pracht eval](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) for the scenario format.

| Flag | Effect |
| --- | --- |
| `--url` | Overrides every scenario's own URL |
| `--start "<command>"` | Launch one server for the run, wait for it to answer, and stop it afterward |
| `--browser <path>` | Pin Chrome for WebMCP scenarios |
| `--json` | Report every scenario and step |

`pracht preview` works with `--start` for Node, Cloudflare, and static apps. Netlify and Vercel need a deployed URL or your own `netlify dev` or `vercel dev`.

## pracht llms

Print the authoring guide for coding agents: project layout, conventions, constraints, and the verify/plan/report loop.

```sh
pracht llms

# Write the guide to llms.txt in the app root
pracht llms --write

# Write it somewhere else (implies --write)
pracht llms --out docs/pracht-guide.md
```

This guide is for an agent editing your app. It is a different file from the `llms.txt` your deployed site serves, so use `--out` when the project also publishes one. The `get_docs` tool of [`pracht dev-mcp`](#pracht-dev-mcp) serves the same guide.

## pracht docs

Print the pracht docs that ship inside your installed `@pracht/cli`, so you and your coding agent read the version the app uses, offline:

```sh
pracht docs                          # list pages by section
pracht docs routing                  # print a page as Markdown
pracht docs routing#route-manifest   # print one section
pracht docs --search "loader revalidate"
pracht docs --json                   # the page list as JSON
```

A topic is a page slug, its title, or its site path, such as `recipes/auth`. An unknown topic exits 1 and suggests close page names. `--search` takes one quoted query and returns `slug#section` targets with a snippet, best matches first. `--json` also works with a topic or `--search`.

Links between pages point at sibling files (`routing.md#…`), and the same files are in `node_modules/@pracht/cli/docs/`. The [`pracht dev-mcp`](#pracht-dev-mcp) tools `get_docs`, `list_docs`, and `search_docs` serve the same pages.

## pracht dev-mcp

Start the authoring Model Context Protocol server over stdio for coding agents:

```sh
pracht dev-mcp
```

It gives the agent writing your code your app's *graph*: docs, inspection, doctor, verify, plan, report, typegen, eval, and generators. Register it as a local MCP server in your client rather than running it by hand; it runs until the client disconnects. `pracht mcp` is a deprecated alias that prints a notice to stderr.

This is not your app's own [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser), which serves your app's *operations* to end-user agents in production. See [The Authoring MCP Server](/docs/coding-agents#the-authoring-mcp-server) for client registration and the tool reference.

## pracht skills

List and install the pracht Claude Code skills from the published [agent-skills index](https://pracht.resynapse.dev/.well-known/agent-skills/index.json):

```sh
# The catalog, with a marker on the ones this app already has
pracht skills list

# Install into .claude/skills/
pracht skills add audit-loaders add-db
```

`create-pracht` seeds four core skills; `pracht skills add` installs others. See [Context Cost](/docs/coding-agents#context-cost) for why the default set is small.

| Flag | Effect |
| --- | --- |
| `--force` | Reinstall a skill that is already installed, or write through a symlinked `.claude/skills` that stays inside the project |
| `--index <url>` | Use a different catalog (`https`, or `http` on `localhost` for an offline mirror) |
| `--json` | Machine-readable output; `add --json` reports `installed`, `skipped`, and `failed` |

`add` verifies every download against the index's SHA-256 digest and exits non-zero if any skill failed to install.
