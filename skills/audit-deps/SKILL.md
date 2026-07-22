---
name: audit-deps
version: 1.1.0
description: |
  Run a dependency vulnerability audit and map each finding to the pracht
  routes, loaders, middleware, or API handlers that import the affected
  package — so users know which surface area they need to test after upgrading.
  Use when asked to "audit deps", "scan for CVEs", "which routes use this
  vulnerable package", "npm audit", or "dependency security review".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Deps

`npm audit` (or `pnpm audit`) gives you a list of vulnerable packages. This
skill goes one step further: for each advisory, it tells you **which routes
and APIs touch the vulnerable code path** so you can prioritize and write
targeted regression tests after upgrading.

Prerequisites: `pracht inspect` requires a vite config that registers the
pracht plugin.

## Step 1: Run the audit

Detect the package manager from the lockfile in repo root; for yarn,
disambiguate Classic vs Berry via the `packageManager` field in
`package.json` (fall back to `yarn --version`):

| Lockfile             | Manager        | Command                          |
| -------------------- | -------------- | -------------------------------- |
| `pnpm-lock.yaml`     | pnpm           | `pnpm audit --json`              |
| `package-lock.json`  | npm            | `npm audit --json`               |
| `yarn.lock`          | yarn Classic (`yarn@1.x`) | `yarn audit --json`   |
| `yarn.lock`          | yarn Berry (`yarn@2+`)    | `yarn npm audit --json --recursive` |
| `bun.lockb` / `bun.lock` | bun        | `bun audit --json` (if available; otherwise note as gap) |

Capture the JSON. Track each advisory: package, severity, range, fixed-in.

## Step 2: Resolve "which package depends on the vulnerable one"

For transitive vulns, the direct importer matters more than the leaf. Use the
package manager:

```bash
pnpm why <package>
# or
npm ls <package>
```

Capture the dependency chain. The first non-pracht-internal direct dependency
is the one the user owns.

## Step 3: Map to routes/APIs

If the pracht MCP server is registered (see `docs/MCP.md`), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

For each direct dependency identified in step 2:

1. Grep `src/` for `import .* from "<dep>"` and `require("<dep>")`.
2. Classify each hit file against the resolved graph — do NOT classify by
   directory convention (pages mode uses a configurable `pagesDir`, and app
   layout is not fixed). From `pracht inspect routes --json`, match the hit
   against each route's `file`, `loaderFile`, and `shellFile`; resolve
   `middleware` names to files via the `defineApp({ middleware })` map in the
   manifest. From `pracht inspect api --json`, match against each API route's
   `file`.
3. A hit that matches none of those is a shared module — trace its importers
   upward until you reach a route, loader, shell, middleware, or API file
   from the graph.

This produces a "blast radius" per advisory.

## Step 4: Categorize urgency

For each advisory, score:

| Factor                                  | Weight |
| --------------------------------------- | ------ |
| Advisory severity (`critical`/`high`/`moderate`/`low`) | base |
| Reachable from a request handler        | +1 tier |
| Reachable from an unauthenticated route | +1 tier |
| Reachable only from build scripts / dev tools | -1 tier |

Build scripts that never ship to runtime (e.g., a Vite plugin used only at
build time) are lower priority than a package imported into a production
loader.

## Step 5: Report

Report severity is the primary scale — `error` (critical/high reachable from
runtime), `warn` (moderate, or high but build-time only), `info` (low, or
unreachable) — with the advisory's own severity as a secondary column:

```
## error

- <pkg> @ <version> — advisory: <severity> — <CVE>
  Direct importer: <dep>
  Reachable from:
    - GET  /api/users          (src/api/users.ts)
    - SSR  /dashboard          (src/routes/dashboard.tsx → src/server/db.ts)
  Fix: upgrade to <range>
  Test after upgrade: <list of routes/APIs above>
```

End with a one-line verdict: `N critical, N high, N moderate, N low — N
reachable from runtime`.

## Step 6: Recommend the upgrade

This skill is report-only — do not run any install or upgrade command. For
each fix:

- If the direct dependency has a non-breaking range covering the fix:
  recommend running `pnpm up <dep>` (or the equivalent for the detected
  package manager).
- If a major bump is required: link to the package's CHANGELOG and recommend
  a deliberate migration.
- Recommend running `pnpm test` and the route-targeted tests derived from
  step 3 after any upgrade.

## Rules

1. Always determine the direct importer; transitive-only output is unhelpful.
2. Distinguish runtime vs. build-time exposure — they have very different
   urgency.
3. Do not run any upgrade; propose commands only. The user applies them.
4. If the audit tool reports zero advisories, still note the package counts
   and lockfile age — staleness is a precursor to advisories.
5. Cross-reference with `pre-deploy` before shipping any post-upgrade build.

$ARGUMENTS
