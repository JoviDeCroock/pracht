# Upgrades and deprecations

Contributor reference for the deprecation mechanism behind `pracht upgrade`.
The user-facing page is
[examples/docs/src/routes/docs/upgrading.md](../examples/docs/src/routes/docs/upgrading.md)
(published at <https://pracht.resynapse.dev/docs/upgrading>).

## Why the manifests live in the packages

Before this existed, the upgrade path was `skills/upgrade-pracht/SKILL.md`:
prose telling a human or an agent to fetch a dozen `CHANGELOG.md` files from
GitHub, read every section between installed and target, and grep the app for
whatever the entries happened to name. That has three problems. The changelogs
are not published in most tarballs (only `@pracht/cli` ships one), so the
instructions had to hard-code raw GitHub URLs and a package→directory table
that drifts. The mapping from a prose entry to an actual API is re-derived by
whoever is reading. And the skill is versioned separately from the packages it
describes, so it is wrong the moment a package moves.

A `deprecations.json` in the tarball inverts all three: it ships and versions
with the package that owns it, it names the API precisely enough to locate in
source, and any package in the `@pracht/*` scope — including third-party ones —
is read by the same reader.

## Layout

| Path | Role |
| ---- | ---- |
| `packages/cli/src/deprecations.ts` | Manifest schema, validation, package inventory, source scan, codemod runner, formatter |
| `packages/cli/src/commands/upgrade.ts` | `pracht upgrade` — flags, exit codes, JSON shape |
| `packages/framework/deprecations.json` | `@pracht/core`'s records |
| `packages/framework/codemods/` | `@pracht/core`'s codemods |

## Adding a record

When a change removes or renames a public API, add a record in the same PR as
the change, alongside the changeset.

1. Add an entry to the owning package's `deprecations.json`. If the package has
   none, create one, add `deprecations.json` (and `codemods` if applicable) to
   `files`, and add `"pracht": { "deprecations": "./deprecations.json" }` to its
   `package.json`.
2. Give it an `id` of `<package-short>.<slug>`. Ids are permanent: reports, CI
   output, and review comments cite them.
3. Set `since` to the version that deprecated the API and `removedIn` to the
   version that removes it. While a removal is unscheduled, omit `removedIn`.
4. Write a `detect.pattern` specific enough that it cannot match unrelated app
   code. Comments and string literals are masked before matching, so a mention
   in a comment does not count as usage; set `detect.matchStrings` when the API
   genuinely lives in a string (a config value, a package.json field).
5. Ship a codemod when the migration is mechanical.

### Severity is derived, not declared

A record is reported as `error` only when the installed version is at or past
its `removedIn` — the app is calling something that no longer exists. Everything
else is `warn`. This is what lets `pracht upgrade --check` be a safe CI gate: a
deprecation announced today cannot turn a green build red, only a missed
migration can.

Records whose `since` is newer than the installed version are skipped entirely,
so a downgrade does not produce noise about a future version's deprecations.

### Codemod contract

A codemod is a plain ES module with a default export:

```js
export default {
  id: "core.use-revalidate-route",
  transform(source, { path }) {
    return rewritten; // or null when there is nothing to change
  },
};
```

Text in, text out, so publishing one adds no dependency to the tarball. It runs
once per file the record's detector matched. `resolveCodemodPath` refuses any
path that resolves outside the publishing package, so a manifest cannot point
the runner at an arbitrary file on disk.

## Scanning

`buildUpgradeReport(root)`:

1. Reads the app's `package.json` for `@pracht/*` dependencies, then walks up
   from the app root collecting `node_modules/@pracht/*` so hoisted transitive
   packages are included too.
2. Resolves each package by walking parent `node_modules` directories rather
   than through `require.resolve` — most packages do not export
   `./package.json`, which would make resolution fail for the majority.
3. Loads and validates each manifest. A malformed manifest or record is a
   warning and a skip, never a failure: a bad record in one dependency must not
   hide the good records in another.
4. Walks the app tree once (skipping `node_modules`, `dist`, and the adapter
   output directories) and runs every applicable detector against each file.

Because resolution walks upward, tests must use fixtures **outside** the repo —
a fixture under `packages/` resolves the workspace's own packages. Both test
files create their apps in the OS temp directory for this reason.

## What is deliberately not built

- **Target-version manifests.** The report reads installed packages only, so it
  answers "did I miss a migration" rather than "what will break if I upgrade".
  Previewing needs registry fetches; the loader is structured so a second
  manifest source can be added without touching the scan or the report.
- **Running the package manager.** `pracht upgrade` prints the command for the
  detected lockfile and stops. Installing is not something a report command
  should do behind your back.
- **Wiring into `pracht verify`.** A deprecation is not a broken build, and
  `verify` is a gate. `pracht upgrade --check` is the opt-in gate instead.
