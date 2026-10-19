---
"@pracht/cli": patch
---

`pracht inspect --json` prints a `{ ok: false, error }` object instead of a stack trace when the app graph fails, and `verify`, `doctor`, `inspect` and `typegen` errors carry no colour codes when the output is not a terminal or `NO_COLOR` is set.
