---
"create-pracht": patch
---

Teach the starter about the verify / plan / report loop. Manifest scaffolds now include a commented-out `constraints` example in `src/routes.ts` (enforced by `pracht verify` once uncommented), the generated `.gitignore` notes that `.pracht/app-graph.json` — the `pracht plan` snapshot — should stay committed, the generated README gains a short Checks section, and the agent instructions list `pracht verify`, `pracht plan --write`, `pracht report`, and `pracht llms --write`.
