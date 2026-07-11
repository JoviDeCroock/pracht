---
name: audit-secrets
version: 1.0.0
description: |
  Detect environment variables and secrets that leak from the server into
  the client bundle via loader return values, hydration state, or accidental
  imports of server-only modules from client code paths.
  Use when asked to "audit secrets", "find leaked env vars", "is my API key
  exposed", "check client bundle for secrets", or "scan for credential leaks".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Secrets

Pracht serializes loader return values into the `pracht-state` JSON script and
hydrates the client from them. Anything a loader returns ends up readable in the
browser. The Vite plugin also strips server-only exports from route files, but
it cannot save you from a value that flows into the return.

## Step 0: Run the native env safety check

Pracht has built-in env leak detection (see `docs/ENV.md`):

- `pracht build` fails when a client chunk references a non-public env var
  (anything not `PRACHT_PUBLIC_`-prefixed and not a Vite built-in),
  naming the variable, chunk, and likely source module.
- `pracht verify` checks the build-time env-safety report and re-runs the
  literal chunk scan against an existing `dist/client` output.
- Client-side imports of `@pracht/core/env/server` (`serverEnv`) fail the build.

Run `pracht verify` (or a build) first and fold its findings into the report.
Check `vite.config.*` for `envSafety: { allow: [...] }` / `envSafety: false` —
every allowlisted name and a disabled check are findings to review, since they
bypass the native gate. The native check detects _references_, not values, so
the dataflow steps below are still required.

## Step 1: Identify "secret-shaped" identifiers

Build a regex of variable names treated as sensitive:

```
SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|PASSWORD|PASSPHRASE|SESSION[_-]?SECRET|JWT[_-]?SECRET|WEBHOOK[_-]?SECRET|DATABASE[_-]?URL|DB[_-]?URL|CONNECTION[_-]?STRING|CLIENT[_-]?SECRET|REFRESH[_-]?TOKEN
```

Also flag any direct `process.env.X` or `context.env.X` reference where `X`
matches the above.

## Step 2: Server → client flow analysis

For every route file, trace whether a sensitive value reaches the loader's
return value. Steps:

1. Run `pracht inspect routes --json` to enumerate routes.
2. For each route, read the loader.
3. Build a small dataflow trace from sensitive identifiers (and `process.env.*`
   / `context.env.*` reads) to the `return` statement(s).
4. Flag any spread (`...row`, `...user`, `...env`) that originates from a
   source containing secrets.
5. Flag direct returns of objects that name sensitive keys.

This is heuristic — favor over-flagging over silent leaks. Note false-positive
risk in the report.

## Step 3: Module import boundaries

Grep client-rendered files (route components, shells, anything imported from
them) for imports of:

- `node:*` builtins
- `@pracht/adapter-*`
- Local `src/server/**` modules
- Modules whose top level reads `process.env.*`

The Vite plugin strips `loader`, `getStaticPaths`, `headers`, `middleware`
exports from route files when serving the client query — see commit 594407d.
But a component that imports `../server/db` will still pull `db` into the
client bundle. Flag those imports.

## Step 4: Hidden surfaces

Check for accidental exposure outside loaders:

- `head()` returns: rare, but a `meta` value containing a token leaks into HTML.
- `headers()` returns: flag values that look like secrets. For SSG/ISG pages,
  document headers can be copied into `dist/client/_pracht/headers.json`, which
  is public client output and may be replayed on static responses.
- `<Form>` `action` URLs containing tokens in the query string.
- `prefetchRouteState(url)` calls with sensitive query params.
- Inline `<script>` content emitted from custom shells.

## Step 5: `.env` discipline

- Confirm `.env*` is in `.gitignore`.
- Confirm generated starters preserve `!.env.example` if they ignore `.env*`.
- Grep tracked files for likely committed secrets (long random strings near
  identifier names from step 1).
- Confirm client-side env access goes through `publicEnv` (from
  `@pracht/core`) or `import.meta.env.PRACHT_PUBLIC_*`; `VITE_*` values are
  still exposed by Vite compatibility wiring, but Pracht does not treat them as
  intentionally public, so flag client-side `VITE_*` references unless they are
  explicitly allowlisted and reviewed. Warn loudly if a public env name has a
  secret-shaped name.
- Confirm server-side env access uses `serverEnv` (from
  `@pracht/core/env/server`) or `context.env` rather than ad-hoc globals.

## Step 6: Report

| File:Line | Identifier / source | Sink (loader return / client import / etc.) | Severity |
| --------- | ------------------- | ------------------------------------------- | -------- |

Severities:

- `error` — direct flow from `process.env.SECRET_*` / `serverEnv.SECRET_*` to
  loader return.
- `error` — `PRACHT_PUBLIC_*_SECRET` style client-public or allowlisted `VITE_*_SECRET`
  secret-shaped name.
- `error` — `envSafety: false` or an allowlisted name that looks secret-shaped.
- `warn` — spread of a row that may contain secret columns.
- `warn` — client component imports a module that reads `process.env`.
- `info` — header value that looks like a token.

## Rules

1. Heuristic-first; document false-positive risk per finding.
2. Recommend an explicit allowlist projection (`{ id, name, email }`) over
   blocklist filtering.
3. For Cloudflare apps, secrets live in `context.env` — same risk profile as
   `process.env`. Treat them identically.
4. Never print suspected secret values into the report — refer by name only.
5. If you find a likely committed secret, recommend immediate rotation in
   addition to removal from history.

$ARGUMENTS
