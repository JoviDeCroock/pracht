---
name: audit-deps
version: 1.0.0
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

## Step 1: Run the audit

Detect the package manager from the lockfile in repo root:

| Lockfile             | Command                          |
| -------------------- | -------------------------------- |
| `pnpm-lock.yaml`     | `pnpm audit --json`              |
| `package-lock.json`  | `npm audit --json`               |
| `yarn.lock`          | `yarn npm audit --json --recursive` |
| `bun.lockb` / `bun.lock` | `bun audit --json` (if available; otherwise note as gap) |

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

For each direct dependency identified in step 2:

1. Grep `src/` for `import .* from "<dep>"` and `require("<dep>")`.
2. For each hit file, classify it:
   - Route file under `src/routes/` → which routes use it (cross-reference
     with `pracht inspect routes --json`).
   - Middleware under `src/middleware/` → which routes/groups apply it.
   - API handler under `src/api/` → which API path it lives at.
   - Shell under `src/shells/` → which routes use the shell.
   - Other shared module under `src/` → trace upward to the importing route
     or API handler.

This produces a "blast radius" per advisory.

## Step 4: Categorize urgency

For each advisory, score:

| Factor                                  | Weight |
| --------------------------------------- | ------ |
| Severity (`critical`/`high`/`moderate`/`low`) | base |
| Reachable from a request handler        | +1 tier |
| Reachable from an unauthenticated route | +1 tier |
| Reachable only from build scripts / dev tools | -1 tier |

Build scripts that never ship to runtime (e.g., a Vite plugin used only at
build time) are lower priority than a package imported into a production
loader.

## Step 5: Report

```
## High-priority

- <pkg> @ <version> — <severity> — <CVE>
  Direct importer: <dep>
  Reachable from:
    - GET  /api/users          (src/api/users.ts)
    - SSR  /dashboard          (src/routes/dashboard.tsx → src/server/db.ts)
  Fix: upgrade to <range>
  Test after upgrade: <list of routes/APIs above>
```

End with a one-line verdict: `N critical, N high, N moderate, N low — N
reachable from runtime`.

## Step 6: Suggest the upgrade

For each fix:
- If the direct dependency has a non-breaking range covering the fix:
  `pnpm up <dep>` (or equivalent).
- If a major bump is required: link to the package's CHANGELOG, do not
  auto-upgrade.
- After upgrading, suggest running `pnpm test` and the route-targeted tests
  derived from step 3.

## Rules

1. Always determine the direct importer; transitive-only output is unhelpful.
2. Distinguish runtime vs. build-time exposure — they have very different
   urgency.
3. Do not auto-upgrade major versions.
4. If the audit tool reports zero advisories, still note the package counts
   and lockfile age — staleness is a precursor to advisories.
5. Cross-reference with `pre-deploy` before shipping any post-upgrade build.

$ARGUMENTS
