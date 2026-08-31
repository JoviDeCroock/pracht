---
"@pracht/cli": minor
---

Add `pracht upgrade`, which reports `@pracht/*` APIs the app still uses that the installed versions have deprecated or removed, and applies the codemods those packages publish. Findings come from a `deprecations.json` shipped by each package rather than from the CLI, so `--check` gates CI and `--json` gives agents a stable id, severity, replacement, and call sites per migration.
