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

### `pracht verify`

Run fast framework-aware verification checks without paying for a full build or
test loop. Use `--changed` to focus on changed manifest-managed files and
`--json` for machine-readable output. When `dist/server/budget-report.json`
exists (written by `pracht build` when budgets are configured), the last
build's client JS budget results are surfaced as checks.

```bash
pracht verify
pracht verify --changed
pracht verify --json
```

### `pracht generate route`

Create a new route module. In manifest apps this also updates `src/routes.ts`.

```bash
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
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

Generate `src/pracht-routes.d.ts` and `src/pracht-routes.ts` from the resolved
route graph for typed `<Link>`, route-object `useNavigate()`, and `href()`
helpers. Use `--check` in CI to fail when generated files are stale.

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
verify, and generate as native tools for coding agents. See
[docs/MCP.md](https://github.com/JoviDeCroock/pracht/blob/main/docs/MCP.md)
for client registration and the tool reference.

```bash
pracht mcp
```
