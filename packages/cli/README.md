# @pracht/cli

Command-line tool for developing, building, validating, and scaffolding pracht apps.

## Install

```bash
npm install @pracht/cli
```

## Commands

### `pracht dev`

Start the local development server with SSR and HMR.

### `pracht build`

Create a production build with client/server output and SSG/ISG prerendering.

```bash
pracht build
pracht build --analyze          # per-route client JS report (gzip + raw)
pracht build --json             # same report as JSON (agent-friendly)
pracht build --no-budget-fail   # report exceeded budgets without failing
```

`--analyze` prints, per route (pattern + render mode), the transitive client
chunks it loads with raw and gzip sizes, a total row, and the shared entry
chunks broken out. Output respects `NO_COLOR`.

When the pracht plugin config declares `budgets` (e.g.
`budgets: { "*": "120kb", "/dashboard": "200kb" }`), every build evaluates the
per-route gzip client-JS ceilings, writes `dist/server/budget-report.json`, and
exits non-zero on exceeded budgets unless `--no-budget-fail` is passed. See
[docs/PERFORMANCE.md](https://github.com/JoviDeCroock/pracht/blob/main/docs/PERFORMANCE.md).

For Node.js targets, run the built server with:

```bash
node dist/server/server.js
```

### `pracht preview`

Serve the production build locally. Runs `pracht build` first (skip with
`--skip-build`), then serves the output for the configured adapter:

- **Node**: runs `dist/server/server.js` on `--port` (or `$PORT`, default 3000).
- **Cloudflare**: delegates to `wrangler dev` against the built worker; requires
  wrangler in `node_modules` or on your PATH plus a wrangler config.
- **Vercel**: there is no faithful local production runtime — the command points
  you at `vercel build` / `vercel dev` instead.

```bash
pracht preview
pracht preview --port 4000
pracht preview --skip-build
```

### `pracht verify`

Run fast framework-aware verification checks without paying for a full build or
test loop. Use `--changed` to focus on changed manifest-managed files and
`--json` for machine-readable output. When `dist/server/budget-report.json`
exists (written by `pracht build` when budgets are configured), the last
build's client JS budget results are surfaced as checks.

When the app declares `defineApp({ constraints })` or commits a
`.pracht/app-graph.json` snapshot, verification also resolves the live app
graph, enforces every constraint, and fails if the snapshot is stale (fix with
`pracht plan --write`).

```bash
pracht verify
pracht verify --changed
pracht verify --json
```

### `pracht plan`

Semantic app-graph diff against a base git ref. Reads the
`.pracht/app-graph.json` snapshot committed at the base ref (a route-graph
lockfile), resolves the live graph, and prints the routes, API endpoints, and
constraints that were added, removed, or changed — an intent-level changelog
for reviewers. Per-route gzip sizes are annotated when the last build wrote a
budget report.

```bash
pracht plan                       # diff against origin/main
pracht plan --base main
pracht plan --markdown            # fenced diff for PR comments
pracht plan --json                # full structured payload
pracht plan --write               # refresh .pracht/app-graph.json (commit it)
```

### `pracht report`

Assemble a PR-ready markdown report from machine truth: the `pracht plan`
diff, `pracht verify` results, and the last build's client JS budget table.
Use it as the factual half of a PR description.

```bash
pracht report
pracht report --base main --out pr-report.md
```

### `pracht llms`

Print the embedded pracht authoring guide for coding agents (project layout,
conventions, the verify → plan → report loop). `--write` saves it as
`llms.txt` in the app root so agents pick it up automatically.

```bash
pracht llms
pracht llms --write
```

### `pracht generate route`

Create a new route module. In manifest apps this also updates `src/routes.ts`.
When the app has a Playwright setup (`playwright.config.*` or an `e2e/`
directory), a smoke test is emitted at `e2e/<route-id>.spec.ts` as well —
`--no-test` skips it, `--test` forces it.

```bash
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
pracht generate route --path /blog/:slug --render ssg --no-test
```

### `pracht generate shell`

Create a shell module and register it in the app manifest.

```bash
pracht generate shell --name app
```

### `pracht generate middleware`

Create a middleware module and register it in the app manifest.

```bash
pracht generate middleware --name auth
```

### `pracht generate api`

Create an API route under `src/api/`.

```bash
pracht generate api --path /health --methods GET,POST
```

### `pracht inspect`

Inspect the resolved app graph. Use `--json` for agent/tool consumption.

```bash
pracht inspect --json
pracht inspect routes --json
pracht inspect api --json
pracht inspect build --json
```

### `pracht typegen`

Generate `src/pracht.d.ts` and `src/pracht-routes.ts` from the resolved
route graph for typed `<Link>`, route-object `useNavigate()`, and `href()`
helpers, plus typed API route registrations for `apiFetch()`. API modules are
not executed during generation. Use `--check` in CI to fail when generated
files are stale. After the first generation, `pracht dev` keeps the default
outputs current; before it, the dev banner prints a one-line setup tip.

```bash
pracht typegen
pracht typegen --check
```

### `pracht doctor`

Validate the local app wiring across the whole project. Use `--json` for
machine-readable output.

```bash
pracht doctor
pracht doctor --json
```

### `pracht mcp`

Start a Model Context Protocol server on stdio that exposes inspect, doctor,
verify, plan, report, generate, and the authoring guide (`get_docs`) as native
tools for coding agents. See
[docs/MCP.md](https://github.com/JoviDeCroock/pracht/blob/main/docs/MCP.md)
for client registration and the tool reference.

```bash
pracht mcp
```
