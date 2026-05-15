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

For Node.js targets, run the built server with:

```bash
node dist/server/server.js
```

### `pracht verify`

Run fast framework-aware verification checks without paying for a full build or
test loop. Use `--changed` to focus on changed manifest-managed files and
`--json` for machine-readable output.

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
helpers. Route metadata can include a typegen-only `search` schema so generated
helpers also type query-string keys and values. Use `--check` in CI to fail
when generated files are stale.

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
