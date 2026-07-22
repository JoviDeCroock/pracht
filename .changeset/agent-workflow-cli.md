---
"@pracht/cli": minor
---

Agent workflow tooling for provable authoring and cheap review:

- `pracht plan [--base ref] [--json|--markdown]` — semantic app-graph diff (routes, API endpoints, constraints) against the `.pracht/app-graph.json` snapshot committed at a base git ref; `--write` refreshes the snapshot.
- `pracht verify` now enforces `defineApp({ constraints })` and fails when the committed app-graph snapshot is stale. The graph is only resolved when an app opts in to either, so verification stays fast otherwise.
- `pracht report [--base ref] [--out file]` — PR-ready markdown assembled from the graph diff, verify results, and the last build's client JS budgets.
- `pracht generate route` emits a Playwright smoke test in `e2e/` when the app has a Playwright setup (`--test`/`--no-test` to override).
- `pracht llms [--write]` prints (or writes to `llms.txt`) an embedded authoring guide for coding agents.
- MCP server: new `plan`, `report`, and `get_docs` tools; `generate_route` accepts `test`.
