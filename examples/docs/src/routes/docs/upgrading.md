---
title: Upgrading
lead: Every @pracht/* package ships a machine-readable deprecations manifest. `pracht upgrade` reads the manifests of what you have installed, finds the call sites in your app, and applies published codemods.
breadcrumb: Upgrading
prev:
  href: /docs/cli
  title: CLI
next:
  href: /docs/deployment
  title: Deployment
---

## The problem with changelog-driven upgrades

pracht packages are versioned independently and pin each other exactly, so an upgrade means moving the whole family at once and then working out which of the entries across a dozen changelogs actually touch your code. That reading is manual, easy to skip, and stale the moment a package moves.

`pracht upgrade` replaces the reading with data. Each package publishes a `deprecations.json` describing every API it renamed, changed, or removed — the versions each change spans, how to find it in source, and optionally a codemod that rewrites it. The CLI reads those manifests from the packages installed in your app, scans your source, and reports real call sites.

---

## Run it

```bash
pracht upgrade
```

```
Installed pracht packages
  @pracht/cli          1.12.0  (package.json: ^1.12.0)
  @pracht/core         0.16.0  (package.json: ^0.16.0)
  @pracht/vite-plugin  0.11.1  (package.json: ^0.11.1)

1 removed API and 0 deprecations in use.

REMOVED  core.use-revalidate-route — useRevalidateRoute() was replaced by useRevalidate()
  Removed in @pracht/core 0.2.7 (installed: 0.16.0).
  Replacement: useRevalidate()
  useRevalidateRoute was an alias for useRevalidate with the same signature and return value, so the change is a rename.
  https://pracht.resynapse.dev/docs/data-loading#userevalidate
    src/routes/dashboard.tsx:1  import { useRevalidateRoute } from "@pracht/core";
    src/routes/dashboard.tsx:4  const revalidate = useRevalidateRoute();
  Codemod available — run `pracht upgrade --fix`.

Move the family forward together (pracht packages pin each other exactly):
  pnpm up @pracht/cli@latest @pracht/core@latest @pracht/vite-plugin@latest
```

The command never installs anything. It prints the command for your package manager (detected from the lockfile) and leaves running it to you.

### Severities

| Label | Meaning |
| ----- | ------- |
| `REMOVED` | The installed version no longer has this API. The code is broken now. |
| `DEPRECATED` | Still present in the installed version, with removal scheduled or announced. |

Only `REMOVED` findings make `pracht upgrade --check` fail, so a deprecation that has not landed yet never breaks a build that was green.

### Options

```bash
pracht upgrade --json      # structured report for agents and scripts
pracht upgrade --check     # exit 1 when a removed API is still used (CI gate)
pracht upgrade --check --strict   # also fail on not-yet-removed deprecations
pracht upgrade --fix       # apply the published codemods, then re-report
```

`--fix` rewrites files in place and re-scans, so the report you see afterwards reflects the migrated source. Codemods are textual — review the diff and run your tests.

### In CI

```yaml
- run: pnpm pracht upgrade --check
```

This catches the case where an upgrade landed but one call site was missed, which otherwise shows up as a runtime error on a route nobody opened during review.

---

## For agents

`pracht upgrade --json` is the intended entry point for a coding agent asked to upgrade the framework:

```json
{
  "ok": false,
  "packageManager": "pnpm",
  "upgradeCommand": "pnpm up @pracht/core@latest",
  "packages": [{ "name": "@pracht/core", "declared": "^0.16.0", "version": "0.16.0", "deprecations": 1 }],
  "findings": [
    {
      "id": "core.use-revalidate-route",
      "package": "@pracht/core",
      "title": "useRevalidateRoute() was replaced by useRevalidate()",
      "severity": "error",
      "since": "0.0.1",
      "removedIn": "0.2.7",
      "installedVersion": "0.16.0",
      "replacement": "useRevalidate()",
      "docs": "https://pracht.resynapse.dev/docs/data-loading#userevalidate",
      "codemod": true,
      "occurrences": [{ "file": "src/routes/dashboard.tsx", "line": 4, "text": "const revalidate = useRevalidateRoute();" }]
    }
  ],
  "warnings": []
}
```

Every finding carries a stable `id`, so an agent (or a review comment) can name a migration precisely instead of quoting a changelog paragraph. The [upgrade-pracht skill](/docs/agent-skills) drives this command.

---

## What the report covers

The manifests come from the packages **installed in your app**, so the report answers "am I still using something these versions changed or removed?" — the check to run after an upgrade, and the one worth gating CI on.

It does not yet fetch manifests for versions you have not installed, so it cannot preview what a future release will break before you install it. Read the changelogs for that.

---

## Publishing deprecations from your own package

The manifest format is not private to first-party packages. Any package in the `@pracht/*` scope that an app depends on is read the same way, so an integration can ship its own migrations.

Add a `deprecations.json` at the package root, list it in `files`, and point `package.json` at it:

```json
{
  "files": ["dist", "deprecations.json", "codemods"],
  "pracht": { "deprecations": "./deprecations.json" }
}
```

```json
{
  "version": 1,
  "package": "@pracht/core",
  "deprecations": [
    {
      "id": "core.use-revalidate-route",
      "title": "useRevalidateRoute() was replaced by useRevalidate()",
      "since": "0.0.1",
      "removedIn": "0.2.7",
      "replacement": "useRevalidate()",
      "detail": "The alias had the same signature and return value, so the change is a rename.",
      "docs": "https://pracht.resynapse.dev/docs/data-loading#userevalidate",
      "detect": {
        "include": ["src/**/*.{ts,tsx,js,jsx,mts,mjs}"],
        "pattern": "\\buseRevalidateRoute\\b"
      },
      "codemod": "./codemods/use-revalidate-route.js"
    }
  ]
}
```

| Field | Meaning |
| ----- | ------- |
| `id` | Stable identifier, `<package-short>.<slug>`. Never reused or renamed. |
| `since` | Version that deprecated the API. Records the installed version predates are skipped. |
| `removedIn` | Version that removed it. Omit while removal is unscheduled. |
| `detect.include` | Globs relative to the app root (`**`, `*`, `?`, `{a,b}`). |
| `detect.pattern` | Regular expression source. Comments and string literals are masked out before matching unless `detect.matchStrings` is `true`. |
| `codemod` | Path, relative to the package root, of a codemod module. Paths that escape the package are ignored. |

A record with no `detect` is only reported once the API is actually removed, since there is no way to point at a call site.

### Codemods

A codemod is a plain ES module with a default export, so publishing one costs no extra dependencies:

```js [codemods/use-revalidate-route.js]
export default {
  id: "core.use-revalidate-route",
  transform(source, { path }) {
    if (!source.includes("useRevalidateRoute")) return null;
    return source.replace(/\buseRevalidateRoute\b/g, "useRevalidate");
  },
};
```

Return the rewritten source, or `null` when there is nothing to change in that file. `transform` is called once per file that the record's detector matched.

---

## Manual steps that remain

Some things a manifest cannot express, and that still belong in the changelog:

- **Peer ranges.** After a major bump, re-check `vite`, `preact`, `preact-render-to-string`, and `wrangler` ranges.
- **One resolved copy of the runtime.** pracht packages depend on their siblings at exact versions, so a partial upgrade can install two copies of `@pracht/core` and split the runtime. Confirm with `pnpm why @pracht/core`.
- **Behavioural changes with no API surface.** A changed default cannot be grepped for.

After any upgrade, walk the ladder: `pracht upgrade --check`, `pracht doctor`, `pracht typegen --check`, `pracht verify`, then your build and tests.
