---
"create-pracht": minor
---

Seed Claude Code agent tooling into scaffolded apps. New projects now get the full pracht skill catalog copied into `.claude/skills/` and a `.mcp.json` registering the `pracht mcp` server, behind a yes-default "Set up Claude Code skills + MCP?" prompt (`--agent-tools` / `--no-agent-tools` for non-interactive runs; `--yes` includes the tooling). The skills ship inside the published package via a build-time sync from the repo's `skills/` directory.
