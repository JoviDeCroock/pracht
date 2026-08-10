---
"create-pracht": patch
---

Make `--no-agent-tools` skip `AGENTS.md` and `CLAUDE.md` too.

Scaffolding with agent tooling disabled still wrote `AGENTS.md` and symlinked
`CLAUDE.md` at it, so opting out left agent instruction files behind. Opting out
now produces a project with no agent files at all; `README.md` documents the same
commands and project structure for humans.
