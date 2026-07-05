---
"@pracht/cli": minor
"@pracht/vite-plugin": minor
---

Add `pracht build --analyze` and per-route client JS budgets.

`pracht build --analyze` prints a per-route report of the client JavaScript each route loads: the transitive chunks (route module + shell) with raw and gzip sizes, a total row per route, and the shared entry chunks broken out. `--json` emits the same data as machine-readable JSON. Output respects `NO_COLOR` and routes are sorted by total gzip size, descending.

The pracht plugin accepts a new `budgets` option (e.g. `budgets: { "*": "120kb", "/dashboard": "200kb" }`) declaring per-route gzip client-JS ceilings; `"*"` applies to every route and explicit route paths override it. `pracht build` evaluates budgets after every build, prints pass/fail per route, writes `dist/server/budget-report.json`, and exits non-zero on exceeded budgets unless `--no-budget-fail` is passed. `pracht verify` and `pracht doctor` surface the last build's budget results when the report file is present.
