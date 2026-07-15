---
name: upgrade-pracht
version: 1.0.0
description: |
  Upgrade the @pracht/* packages in an app safely: inventory installed
  versions, read the changelogs between installed and target, map breaking
  changes to actual usage in the codebase, apply the upgrade, and walk the
  verification ladder (doctor, typegen, verify, build, tests).
  Use when asked to "upgrade pracht", "update @pracht packages", "bump the
  framework", "what changed in the new pracht version", or "is this pracht
  upgrade safe".
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Pracht Upgrade

Upgrade `@pracht/*` dependencies with the changelog read *before* the install,
not after the build breaks.

## Step 1: Inventory

List every installed pracht package and its resolved version:

```bash
pnpm list --depth 1 --json | grep -A2 '@pracht/'   # or read package.json + lockfile
```

The family: `@pracht/core`, `@pracht/cli`, `@pracht/vite-plugin`,
`@pracht/adapter-node`, `@pracht/adapter-cloudflare`, `@pracht/adapter-vercel`,
`@pracht/preact-ssr-precompile`. Get the latest published versions with
`npm view <pkg> version`.

## Step 2: Understand the versioning model

Pracht packages are **independently versioned** (the repo's changesets config
has empty `fixed`/`linked` groups) — `@pracht/core` can be at 0.9.x while
`@pracht/cli` is at 1.6.x. There is no "one framework version". Two
consequences:

1. **Internal dependencies are pinned exact.** Published packages depend on
   their siblings at exact versions (e.g. `@pracht/vite-plugin@0.5.0` depends
   on `@pracht/core@0.9.0`, not a range). Upgrade the whole family in one
   move; upgrading only one package can drag in a second copy of
   `@pracht/core` and split the runtime.
2. **Most packages are 0.x**, so under semver a *minor* bump may be breaking —
   treat `### Minor Changes` entries on 0.x packages with the same care as
   majors.

After any upgrade, confirm a single core resolution:

```bash
pnpm why @pracht/core   # exactly one version may appear
```

## Step 3: Read the changelogs between installed and target

Only `@pracht/cli` ships `CHANGELOG.md` in its npm tarball
(`node_modules/@pracht/cli/CHANGELOG.md`); the other packages publish `dist/`
only. Fetch their changelogs from the repo instead:

```
https://raw.githubusercontent.com/JoviDeCroock/pracht/main/packages/<dir>/CHANGELOG.md
```

| Package | Repo directory |
| ------- | -------------- |
| `@pracht/core` | `packages/framework` |
| `@pracht/cli` | `packages/cli` |
| `@pracht/vite-plugin` | `packages/vite-plugin` |
| `@pracht/adapter-node` / `-cloudflare` / `-vercel` | `packages/adapter-*` |
| `@pracht/preact-ssr-precompile` | `packages/preact-ssr-precompile` |

Changelogs are changesets-generated: `## X.Y.Z` sections containing
`### Major Changes` / `### Minor Changes` / `### Patch Changes`. Read every
section between the installed and target version of every installed package.

## Step 4: Map changes onto this app

Classify each entry as **breaking** / **feature** / **fix**. For each breaking
(or 0.x minor) entry, grep the app for the APIs, exports, config options, and
generated-file shapes it names, and record: affected files, the migration the
changelog prescribes, and whether it can be applied mechanically. Also
re-check peer ranges after a major target bump — `@pracht/vite-plugin`
requires `vite` (^8), `@pracht/adapter-cloudflare` requires `vite` and
`wrangler` (^4.81), `@pracht/core` requires `preact` (^10) and
`preact-render-to-string` (^6).

Present the plan as a table:

| Package | Installed → Target | Breaking entries | App impact | Migration |
| ------- | ------------------ | ---------------- | ---------- | --------- |

## Step 5: Confirm, then apply

Use `AskUserQuestion` before touching anything when breaking migrations are
required: confirm the target versions and which migrations to apply. Then:

```bash
pnpm up '@pracht/core@<v>' '@pracht/cli@<v>' '@pracht/vite-plugin@<v>' <adapters...>
```

Upgrade every installed `@pracht/*` package in the same command. Apply the
agreed code migrations with minimal diffs, one changelog entry at a time.

## Step 6: Verification ladder

Run in order; stop and fix at the first failure:

```bash
pracht doctor --json          # wiring still valid
pracht typegen --check        # generated route types up to date?
pracht typegen                # regenerate if --check failed or routes changed
pracht verify --json          # framework-aware checks
pracht build                  # full production build (budgets included)
pnpm test                     # the app's own suite
```

`pracht doctor`, `verify`, and `typegen --check` exit non-zero on failure, so
they gate CI cleanly.

## Step 7: Rollback note

If the ladder cannot be made green, roll back rather than shipping a
half-upgrade:

```bash
git restore package.json pnpm-lock.yaml && pnpm install
git checkout -- <migrated files>   # or revert the upgrade commit
```

Because internal deps are exact-pinned, a *partial* rollback (one package
back, the rest forward) recreates the duplicate-core problem from Step 2 —
roll the whole family back together.

## Rules

1. Never mix `@pracht/*` versions from different release waves — upgrade and
   roll back the family as a unit, and verify with `pnpm why @pracht/core`.
2. Read changelogs before installing, not after something breaks.
3. Never apply a breaking-change migration without explicit user confirmation
   via `AskUserQuestion`.
4. Treat 0.x minor bumps as potentially breaking.
5. Do not hand-edit lockfiles; let the package manager resolve.

$ARGUMENTS
